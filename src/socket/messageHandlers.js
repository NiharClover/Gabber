const { randomUUID } = require("crypto");
const pool = require("../db/pool");
const { getOrCreateDirectChat } = require("../db/queries");
const { sendPushNotification } = require("../services/push");
const { emitToUser, isUserOnline } = require("./realtime");

function acknowledge(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function validClientMessageId(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 100 && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function validateText(text) {
  return typeof text === "string" && text.trim().length > 0 && text.length <= 20000;
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
    created_at: msg.created_at,
    timestamp: msg.created_at,
    ...extras,
  };
}

async function pushToUser(userId, data) {
  try {
    const result = await pool.query(
      "SELECT push_token FROM device_tokens WHERE user_id=$1 ORDER BY updated_at DESC",
      [userId]
    );
    await Promise.all(result.rows.map((row) => sendPushNotification(row.push_token, data)));
  } catch (err) {
    console.error("[push]", err.message);
  }
}

async function deriveAndNotifyStatus(io, messageId) {
  const result = await pool.query(
    `SELECT m.sender_id,
            COUNT(r.user_id)::int AS recipient_count,
            COUNT(*) FILTER (WHERE r.status IN ('delivered','read'))::int AS delivered_count,
            COUNT(*) FILTER (WHERE r.status='read')::int AS read_count
     FROM messages m
     LEFT JOIN message_receipts r ON r.message_id=m.id
     WHERE m.id=$1
     GROUP BY m.id, m.sender_id`,
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
    status,
    recipientCount: row.recipient_count,
    deliveredCount: row.delivered_count,
    readCount: row.read_count,
  });
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

async function insertMessage(client, { chatId, senderId, text, replyTo, clientMessageId, recipientIds }) {
  const messageId = `msg_${randomUUID().split("-")[0]}`;
  const result = await client.query(
    `INSERT INTO messages
       (id, chat_id, sender_id, client_message_id, text, reply_to_id, reply_to_text, reply_to_sender, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sent')
     ON CONFLICT (sender_id, client_message_id) WHERE client_message_id IS NOT NULL
     DO UPDATE SET client_message_id=EXCLUDED.client_message_id
     RETURNING *, (xmax=0) AS inserted`,
    [messageId, chatId, senderId, clientMessageId, text.trim(),
      replyTo?.id || null, replyTo?.text || null, replyTo?.sender || null]
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
  await client.query("UPDATE chats SET last_message_at=NOW() WHERE id=$1", [chatId]);
  return msg;
}

function registerMessageHandlers(io, socket) {
  async function sendDirect(payload = {}, ack) {
    const { to, text, replyTo } = payload;
    if (!to || to === socket.userId || !validateText(text)) {
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
          chatId, senderId: socket.userId, text, replyTo, clientMessageId, recipientIds: [to],
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
      acknowledge(ack, { ok: false, error: "Message could not be sent." });
      socket.emit("message:error", { clientMessageId, error: "Message could not be sent." });
    }
  }

  async function sendGroup(payload = {}, ack) {
    const { chatId, text, replyTo } = payload;
    if (!chatId || !validateText(text)) return acknowledge(ack, { ok: false, error: "Invalid message." });
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
        for (const userId of recipientIds) emitToUser(io, userId, "message:receive", outgoing);
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
      acknowledge(ack, { ok: false, error: "Message could not be sent." });
      socket.emit("message:error", { clientMessageId, error: "Message could not be sent." });
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
        `INSERT INTO message_receipts (message_id, user_id, status, delivered_at, read_at)
         SELECT m.id, $2, 'read', NOW(), NOW()
         FROM messages m
         WHERE m.chat_id=$1 AND m.sender_id!=$2
         ON CONFLICT (message_id, user_id) DO UPDATE
         SET status='read', delivered_at=COALESCE(message_receipts.delivered_at, NOW()), read_at=NOW()
         RETURNING message_id`,
        [chatId, socket.userId]
      );
      for (const row of changed.rows) await deriveAndNotifyStatus(io, row.message_id);
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
    for (const row of delivered.rows) await deriveAndNotifyStatus(io, row.message_id);
  } catch (err) {
    console.error("[message reconcile]", err.message);
  }
}

module.exports = { registerMessageHandlers, reconcileUserMessages };
