const { randomUUID } = require("crypto");
const pool = require("../db/pool");
const { getOrCreateDirectChat } = require("../db/queries");
const { sendPushToDeviceTokens } = require("../services/push");
const { emitToUser, isUserOnline } = require("./realtime");
const { assessMessageSafety, extractUrls, parseMediaReference, sha256 } = require("../utils/contentSafety");
const { createTraceCode, isTraceableMedia } = require("../services/mediaTrace");

function acknowledge(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function validClientMessageId(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 100 && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function validateText(text) {
  return typeof text === "string" && text.trim().length > 0 && text.length <= 20000;
}

function replyPreviewText(text) {
  if (!text) return "Message";
  if (text.startsWith("[image]")) return "Photo";
  if (text.startsWith("[view-once]")) return "View-once photo";
  if (text.startsWith("[voice]")) return "Voice message";
  if (text.startsWith("[document]")) return "Document";
  if (text.startsWith("[sticker]")) return "Sticker";
  if (text.startsWith("[payment]")) return "Payment";
  if (text.startsWith("[payment-request]")) return "Payment request";
  if (text.startsWith("[bill]")) return "Order";
  if (text.startsWith("[booking]")) return "Booking";
  return text.slice(0, 500);
}

function messagePayload(msg, extras = {}) {
  return {
    id: msg.id,
    clientMessageId: msg.client_message_id,
    client_message_id: msg.client_message_id,
    chatId: msg.chat_id,
    from: msg.sender_id,
    sender_id: msg.sender_id,
    text: msg.text,
    status: msg.status,
    reply_to_id: msg.reply_to_id,
    reply_to_text: msg.reply_to_text,
    reply_to_sender: msg.reply_to_sender,
    provenance_kind: msg.provenance_kind || "original",
    forward_depth: Number(msg.forward_depth || 0),
    safety_status: msg.safety_status || "safe",
    created_at: msg.created_at,
    timestamp: msg.created_at,
    ...extras,
  };
}

async function pushToUser(userId, data) {
  try {
    const result = await pool.query(
      `SELECT dt.push_token, dt.provider,
              COALESCE(np.hide_sender_name, FALSE) AS hide_sender_name
       FROM device_tokens dt
       LEFT JOIN notification_preferences np ON np.user_id=dt.user_id
       WHERE dt.user_id=$1 AND dt.provider IN ('fcm','expo')
       ORDER BY dt.updated_at DESC`,
      [userId]
    );
    await sendPushToDeviceTokens(result.rows, {
      ...data,
      hideSenderName: result.rows[0]?.hide_sender_name === true,
      categoryId: ["message", "group_message"].includes(data.type) ? "message_actions" : undefined,
    });
  } catch (err) {
    console.error("[push]", err.message);
  }
}

async function deriveAndNotifyStatus(io, messageId) {
  const result = await pool.query(
    `SELECT m.sender_id, m.client_message_id,
            COUNT(r.user_id)::int AS recipient_count,
            COUNT(*) FILTER (WHERE r.status IN ('delivered','read'))::int AS delivered_count,
            COUNT(*) FILTER (WHERE r.status='read')::int AS read_count
     FROM messages m
     LEFT JOIN message_receipts r ON r.message_id=m.id
     WHERE m.id=$1
     GROUP BY m.id, m.sender_id, m.client_message_id`,
    [messageId]
  );
  const row = result.rows[0];
  if (!row) return;
  const status = row.recipient_count > 0 && row.read_count === row.recipient_count
    ? "read"
    : row.recipient_count > 0 && row.delivered_count === row.recipient_count
      ? "delivered"
      : "sent";
  await pool.query("UPDATE messages SET status=$1 WHERE id=$2", [status, messageId]);
  emitToUser(io, row.sender_id, "message:status", {
    id: messageId,
    clientMessageId: row.client_message_id,
    status,
    recipientCount: row.recipient_count,
    deliveredCount: row.delivered_count,
    readCount: row.read_count,
  });
}

async function deriveAndNotifyStatuses(io, messageIds) {
  const ids = [...new Set(messageIds)].filter(Boolean);
  if (ids.length === 0) return;
  const result = await pool.query(
    `WITH receipt_totals AS (
       SELECT m.id, m.sender_id, m.client_message_id,
              COUNT(r.user_id)::int AS recipient_count,
              COUNT(*) FILTER (WHERE r.status IN ('delivered','read'))::int AS delivered_count,
              COUNT(*) FILTER (WHERE r.status='read')::int AS read_count
       FROM messages m
       LEFT JOIN message_receipts r ON r.message_id=m.id
       WHERE m.id=ANY($1::varchar[])
       GROUP BY m.id, m.sender_id, m.client_message_id
     ), statuses AS (
       SELECT *, CASE
         WHEN recipient_count > 0 AND read_count=recipient_count THEN 'read'
         WHEN recipient_count > 0 AND delivered_count=recipient_count THEN 'delivered'
         ELSE 'sent'
       END AS status
       FROM receipt_totals
     )
     UPDATE messages m SET status=s.status
     FROM statuses s WHERE m.id=s.id
     RETURNING m.id, s.sender_id, s.client_message_id, s.status, s.recipient_count,
               s.delivered_count, s.read_count`,
    [ids]
  );
  for (const row of result.rows) {
    emitToUser(io, row.sender_id, "message:status", {
      id: row.id,
      clientMessageId: row.client_message_id,
      status: row.status,
      recipientCount: row.recipient_count,
      deliveredCount: row.delivered_count,
      readCount: row.read_count,
    });
  }
}

async function markDelivered(io, messageId, recipientIds) {
  const onlineRecipients = recipientIds.filter((userId) => isUserOnline(io, userId));
  if (onlineRecipients.length === 0) return;
  await pool.query(
    `UPDATE message_receipts
     SET status=CASE WHEN status='read' THEN 'read' ELSE 'delivered' END,
         delivered_at=COALESCE(delivered_at, NOW())
     WHERE message_id=$1 AND user_id=ANY($2)`,
    [messageId, onlineRecipients]
  );
  await deriveAndNotifyStatus(io, messageId);
}

async function insertMessage(client, {
  chatId, senderId, text, replyTo, clientMessageId, recipientIds, forwardedFromMessageId,
}) {
  const messageId = `msg_${randomUUID().split("-")[0]}`;
  let resolvedText = typeof text === "string" ? text.trim() : "";
  let forwardedFrom = null;
  let provenanceRoot = null;
  let originSenderId = null;
  let provenanceKind = "original";
  let forwardDepth = 0;
  let contentHash = null;
  let safetyStatus = "safe";
  let safetyFlags = [];
  let mediaAssetId = null;

  if (forwardedFromMessageId) {
    const sourceResult = await client.query(
      `SELECT m.*
       FROM messages m
       JOIN chat_members viewer ON viewer.chat_id=m.chat_id AND viewer.user_id=$2
       WHERE m.id=$1 AND m.deleted_for_everyone=FALSE
         AND NOT EXISTS (
           SELECT 1 FROM message_user_deletions d
           WHERE d.message_id=m.id AND d.user_id=$2
         )`,
      [forwardedFromMessageId, senderId]
    );
    const source = sourceResult.rows[0];
    if (!source) {
      const error = new Error("Forward source is unavailable.");
      error.publicMessage = "The original message is unavailable.";
      throw error;
    }
    if (source.text?.startsWith("[view-once]")) {
      const error = new Error("View-once media cannot be forwarded.");
      error.publicMessage = "View-once media cannot be forwarded.";
      throw error;
    }
    if (Number(source.forward_depth || 0) >= 100) {
      const error = new Error("Forward chain limit reached.");
      error.publicMessage = "This message cannot be forwarded again.";
      throw error;
    }
    resolvedText = source.text;
    forwardedFrom = source.id;
    provenanceRoot = source.provenance_root_message_id || source.id;
    originSenderId = source.provenance_origin_sender_id || source.sender_id;
    forwardDepth = Number(source.forward_depth || 0) + 1;
    provenanceKind = "forwarded";
    contentHash = source.content_sha256 || sha256(source.text || "");
    safetyStatus = source.safety_status || "safe";
    safetyFlags = Array.isArray(source.safety_flags) ? source.safety_flags : [];
    mediaAssetId = source.media_asset_id || null;
  } else {
    const assessment = assessMessageSafety(resolvedText);
    safetyStatus = assessment.status;
    safetyFlags = assessment.flags;
    const media = parseMediaReference(resolvedText);
    if (media) {
      const assetResult = await client.query(
        `SELECT a.id, a.uploader_id, a.sha256, a.scan_status, a.origin_asset_id,
                COALESCE(root.uploader_id, a.uploader_id) AS origin_uploader_id
         FROM media_assets a
         LEFT JOIN media_assets root ON root.id=a.origin_asset_id
         WHERE a.url=$1`,
        [media.url]
      );
      const asset = assetResult.rows[0];
      if (!asset || !["sanitized", "clean"].includes(asset.scan_status)) {
        const error = new Error("Unverified media reference rejected.");
        error.publicMessage = "This media has not passed Gabber's safety checks.";
        throw error;
      }
      contentHash = asset.sha256;
      mediaAssetId = asset.id;
      originSenderId = asset.origin_uploader_id || senderId;
      provenanceKind = asset.origin_asset_id ? "copied_media" : "original";
      safetyStatus = "safe";
      safetyFlags = [];
    } else {
      contentHash = sha256(resolvedText);
      // Manual copy/paste cannot carry a client-supplied parent ID. For long
      // text and links, connect an exact copy only to an earlier message the
      // sender was entitled to read. This avoids searching private chats.
      if (resolvedText.length >= 80 || extractUrls(resolvedText).length > 0) {
        const priorResult = await client.query(
          `SELECT m.id, m.sender_id, m.provenance_root_message_id,
                  m.provenance_origin_sender_id, m.forward_depth
           FROM messages m
           JOIN chat_members viewer ON viewer.chat_id=m.chat_id AND viewer.user_id=$2
           WHERE m.content_sha256=$1 AND m.deleted_for_everyone=FALSE
             AND NOT EXISTS (
               SELECT 1 FROM message_user_deletions d
               WHERE d.message_id=m.id AND d.user_id=$2
             )
           ORDER BY m.created_at ASC
           LIMIT 1`,
          [contentHash, senderId]
        );
        const prior = priorResult.rows[0];
        if (prior) {
          forwardedFrom = prior.id;
          provenanceRoot = prior.provenance_root_message_id || prior.id;
          originSenderId = prior.provenance_origin_sender_id || prior.sender_id;
          forwardDepth = Number(prior.forward_depth || 0) + 1;
          provenanceKind = "copied_text";
        }
      }
    }
  }

  let verifiedReply = null;
  if (typeof replyTo?.id === "string" && replyTo.id.length <= 50) {
    const replyResult = await client.query(
      `SELECT m.id, m.text, u.username
       FROM messages m LEFT JOIN users u ON u.id=m.sender_id
       WHERE m.id=$1 AND m.chat_id=$2 AND m.deleted_for_everyone=FALSE`,
      [replyTo.id, chatId]
    );
    verifiedReply = replyResult.rows[0] || null;
  }
  const result = await client.query(
    `INSERT INTO messages
       (id, chat_id, sender_id, client_message_id, text, reply_to_id, reply_to_text,
        reply_to_sender, status, forwarded_from_message_id, provenance_root_message_id,
        provenance_origin_sender_id, provenance_kind, forward_depth, content_sha256,
        safety_status, safety_flags, media_asset_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sent',$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
     ON CONFLICT (sender_id, client_message_id) WHERE client_message_id IS NOT NULL
     DO UPDATE SET client_message_id=EXCLUDED.client_message_id
     RETURNING *, (xmax=0) AS inserted`,
    [messageId, chatId, senderId, clientMessageId, resolvedText,
      verifiedReply?.id || null, verifiedReply ? replyPreviewText(verifiedReply.text) : null,
      verifiedReply?.username || null, forwardedFrom, provenanceRoot, originSenderId,
      provenanceKind, forwardDepth, contentHash, safetyStatus, JSON.stringify(safetyFlags), mediaAssetId]
  );
  const msg = result.rows[0];
  if (recipientIds.length > 0) {
    await client.query(
      `INSERT INTO message_receipts (message_id, user_id, status)
       SELECT $1, unnest($2::varchar[]), 'sent'
       ON CONFLICT (message_id, user_id) DO NOTHING`,
      [msg.id, recipientIds]
    );
  }
  if (isTraceableMedia(msg.text)) {
    const viewers = [...new Set([senderId, ...recipientIds])];
    for (const viewerId of viewers) {
      const traceCode = createTraceCode(msg.id, viewerId);
      await client.query(
        `INSERT INTO message_trace_deliveries (message_id,recipient_id,trace_code)
         VALUES ($1,$2,$3)
         ON CONFLICT (message_id,recipient_id) DO UPDATE SET trace_code=EXCLUDED.trace_code`,
        [msg.id, viewerId, traceCode]
      );
    }
  }
  await client.query("UPDATE chats SET last_message_at=NOW() WHERE id=$1", [chatId]);
  return msg;
}

async function sendMessageInChat(io, { chatId, senderId, text, clientMessageId }) {
  if (!chatId || !validateText(text)) {
    throw Object.assign(new Error("Invalid message."), { status: 400 });
  }
  const chatResult = await pool.query(
    `SELECT c.type, c.name
     FROM chats c
     JOIN chat_members cm ON cm.chat_id=c.id AND cm.user_id=$2
     WHERE c.id=$1`,
    [chatId, senderId]
  );
  const chat = chatResult.rows[0];
  if (!chat) throw Object.assign(new Error("Not a chat member."), { status: 403 });

  const members = await pool.query(
    "SELECT user_id FROM chat_members WHERE chat_id=$1 AND user_id!=$2",
    [chatId, senderId]
  );
  const recipientIds = members.rows.map((row) => row.user_id);
  if (chat.type === "direct" && recipientIds[0]) {
    const blocked = await pool.query(
      `SELECT 1 FROM blocked_users
       WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)`,
      [senderId, recipientIds[0]]
    );
    if (blocked.rows[0]) throw Object.assign(new Error("Cannot send message."), { status: 403 });
  }

  const resolvedClientMessageId = validClientMessageId(clientMessageId)
    ? clientMessageId
    : `notification_${randomUUID()}`;
  const client = await pool.connect();
  let msg;
  try {
    await client.query("BEGIN");
    msg = await insertMessage(client, {
      chatId,
      senderId,
      text,
      clientMessageId: resolvedClientMessageId,
      recipientIds,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const sender = await pool.query("SELECT username FROM users WHERE id=$1", [senderId]);
  const outgoing = messagePayload(msg, {
    ...(chat.type === "group" ? { isGroup: true } : { to: recipientIds[0] }),
    sender_name: sender.rows[0]?.username,
  });
  emitToUser(io, senderId, "message:sent", outgoing);
  if (msg.inserted) {
    for (const userId of recipientIds) emitToUser(io, userId, "message:receive", outgoing);
    await markDelivered(io, msg.id, recipientIds);
    for (const userId of recipientIds) {
      await pushToUser(userId, {
        type: chat.type === "group" ? "group_message" : "message",
        senderName: sender.rows[0]?.username,
        text: msg.text,
        chatId,
        otherUserId: senderId,
        ...(chat.type === "group" ? { groupName: chat.name } : {}),
      });
    }
  }
  return outgoing;
}

function registerMessageHandlers(io, socket) {
  async function sendDirect(payload = {}, ack) {
    const { to, text, replyTo, forwardedFromMessageId } = payload;
    const validForward = typeof forwardedFromMessageId === "string"
      && forwardedFromMessageId.length > 0 && forwardedFromMessageId.length <= 50;
    if (!to || to === socket.userId || (!validForward && !validateText(text))) {
      return acknowledge(ack, { ok: false, error: "Invalid message." });
    }
    const clientMessageId = validClientMessageId(payload.clientMessageId)
      ? payload.clientMessageId
      : `legacy_${randomUUID()}`;

    try {
      const blockCheck = await pool.query(
        `SELECT 1 FROM blocked_users
         WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)`,
        [socket.userId, to]
      );
      if (blockCheck.rows[0]) return acknowledge(ack, { ok: false, error: "Cannot send message." });

      const target = await pool.query("SELECT id FROM users WHERE id=$1", [to]);
      if (!target.rows[0]) return acknowledge(ack, { ok: false, error: "Recipient not found." });

      const chatId = await getOrCreateDirectChat(socket.userId, to);
      const client = await pool.connect();
      let msg;
      try {
        await client.query("BEGIN");
        msg = await insertMessage(client, {
          chatId, senderId: socket.userId, text, replyTo, clientMessageId,
          recipientIds: [to], forwardedFromMessageId: validForward ? forwardedFromMessageId : null,
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      const sender = await pool.query("SELECT username FROM users WHERE id=$1", [socket.userId]);
      const outgoing = messagePayload(msg, { to, sender_name: sender.rows[0]?.username });
      emitToUser(io, socket.userId, "message:sent", outgoing);
      if (msg.inserted) {
        emitToUser(io, to, "message:receive", outgoing);
        await markDelivered(io, msg.id, [to]);
      }
      acknowledge(ack, { ok: true, message: outgoing });

      if (msg.inserted) {
        pushToUser(to, {
          type: "message", senderName: sender.rows[0]?.username, text: msg.text,
          chatId, otherUserId: socket.userId,
        });
      }
    } catch (err) {
      console.error("[message:send]", err.message);
      const publicError = err.publicMessage || "Message could not be sent.";
      acknowledge(ack, { ok: false, error: publicError });
      socket.emit("message:error", { clientMessageId, error: publicError });
    }
  }

  async function sendGroup(payload = {}, ack) {
    const { chatId, text, replyTo, forwardedFromMessageId } = payload;
    const validForward = typeof forwardedFromMessageId === "string"
      && forwardedFromMessageId.length > 0 && forwardedFromMessageId.length <= 50;
    if (!chatId || (!validForward && !validateText(text))) return acknowledge(ack, { ok: false, error: "Invalid message." });
    const clientMessageId = validClientMessageId(payload.clientMessageId)
      ? payload.clientMessageId
      : `legacy_${randomUUID()}`;
    try {
      const group = await pool.query(
        `SELECT c.name FROM chats c JOIN chat_members cm ON cm.chat_id=c.id
         WHERE c.id=$1 AND c.type='group' AND cm.user_id=$2`,
        [chatId, socket.userId]
      );
      if (!group.rows[0]) return acknowledge(ack, { ok: false, error: "Not a member of this group." });

      const members = await pool.query(
        "SELECT user_id FROM chat_members WHERE chat_id=$1 AND user_id!=$2",
        [chatId, socket.userId]
      );
      const recipientIds = members.rows.map((row) => row.user_id);
      const client = await pool.connect();
      let msg;
      try {
        await client.query("BEGIN");
        msg = await insertMessage(client, {
          chatId, senderId: socket.userId, text, replyTo, clientMessageId, recipientIds,
          forwardedFromMessageId: validForward ? forwardedFromMessageId : null,
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      const sender = await pool.query("SELECT username FROM users WHERE id=$1", [socket.userId]);
      const outgoing = messagePayload(msg, {
        isGroup: true, sender_name: sender.rows[0]?.username,
      });
      emitToUser(io, socket.userId, "message:sent", outgoing);
      if (msg.inserted) {
        for (const userId of recipientIds) {
          emitToUser(io, userId, "message:receive", outgoing);
        }
        await markDelivered(io, msg.id, recipientIds);
      }
      acknowledge(ack, { ok: true, message: outgoing });

      if (msg.inserted) {
        for (const userId of recipientIds) {
          pushToUser(userId, {
            type: "group_message", senderName: sender.rows[0]?.username, text: msg.text,
            chatId, otherUserId: socket.userId, groupName: group.rows[0].name,
          });
        }
      }
    } catch (err) {
      console.error("[group:message:send]", err.message);
      const publicError = err.publicMessage || "Message could not be sent.";
      acknowledge(ack, { ok: false, error: publicError });
      socket.emit("message:error", { clientMessageId, error: publicError });
    }
  }

  socket.on("message:send", sendDirect);
  socket.on("group:message:send", sendGroup);

  socket.on("messages:read", async ({ chatId } = {}, ack) => {
    try {
      const membership = await pool.query(
        "SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2",
        [chatId, socket.userId]
      );
      if (!membership.rows[0]) return acknowledge(ack, { ok: false, error: "Not a chat member." });

      const changed = await pool.query(
        `INSERT INTO message_receipts (message_id, user_id, status)
         SELECT m.id, $2::varchar, 'read'
         FROM messages m
         WHERE m.chat_id=$1 AND m.sender_id!=$2::varchar
         ON CONFLICT (message_id, user_id) DO UPDATE
         SET status='read',
             delivered_at=COALESCE(message_receipts.delivered_at, NOW()),
             read_at=COALESCE(message_receipts.read_at, NOW())
         RETURNING message_id`,
        [chatId, socket.userId]
      );
      await deriveAndNotifyStatuses(io, changed.rows.map((row) => row.message_id));
      socket.emit("chat:updated", { chatId, unread_count: 0 });
      acknowledge(ack, { ok: true });
    } catch (err) {
      console.error("[messages:read]", err.message);
      acknowledge(ack, { ok: false, error: "Could not update receipts." });
    }
  });

  socket.on("message:delete", async ({ messageId, chatId, forEveryone } = {}, ack) => {
    try {
      const message = await pool.query(
        `SELECT m.sender_id, m.chat_id FROM messages m
         JOIN chat_members cm ON cm.chat_id=m.chat_id
         WHERE m.id=$1 AND m.chat_id=$2 AND cm.user_id=$3`,
        [messageId, chatId, socket.userId]
      );
      if (!message.rows[0]) return acknowledge(ack, { ok: false, error: "Message not found." });
      if (forEveryone) {
        if (message.rows[0].sender_id !== socket.userId) {
          return acknowledge(ack, { ok: false, error: "Only the sender can delete for everyone." });
        }
        await pool.query("UPDATE messages SET deleted_for_everyone=TRUE WHERE id=$1", [messageId]);
        const members = await pool.query("SELECT user_id FROM chat_members WHERE chat_id=$1", [chatId]);
        for (const member of members.rows) {
          emitToUser(io, member.user_id, "message:deleted", { messageId, chatId, forEveryone: true });
        }
      } else {
        await pool.query(
          `INSERT INTO message_user_deletions (message_id, user_id) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [messageId, socket.userId]
        );
        socket.emit("message:deleted", { messageId, chatId, forEveryone: false });
      }
      acknowledge(ack, { ok: true });
    } catch (err) {
      console.error("[message:delete]", err.message);
      acknowledge(ack, { ok: false, error: "Message could not be deleted." });
    }
  });

  socket.on("sticker:send", (payload = {}, ack) => {
    const message = `[sticker]${payload.svg || ""}`;
    if (payload.isGroup) sendGroup({ ...payload, text: message }, ack);
    else sendDirect({ ...payload, text: message }, ack);
  });
}

async function reconcileUserMessages(io, userId) {
  try {
    await pool.query(
      `INSERT INTO message_receipts (message_id, user_id, status)
       SELECT m.id, $1, 'sent' FROM messages m
       JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=$1
       WHERE m.sender_id!=$1
       ON CONFLICT DO NOTHING`,
      [userId]
    );
    const delivered = await pool.query(
      `UPDATE message_receipts SET status='delivered', delivered_at=COALESCE(delivered_at, NOW())
       WHERE user_id=$1 AND status='sent' RETURNING message_id`,
      [userId]
    );
    await deriveAndNotifyStatuses(io, delivered.rows.map((row) => row.message_id));
  } catch (err) {
    console.error("[message reconcile]", err.message);
  }
}

module.exports = {
  registerMessageHandlers,
  reconcileUserMessages,
  deriveAndNotifyStatuses,
  sendMessageInChat,
};
