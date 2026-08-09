const { randomUUID } = require("crypto");
const pool = require("../db/pool");
const redis = require("../db/redis");
const { sendPushNotification } = require("../services/push");

function findSocketByUserId(io, userId) {
  for (const [, socket] of io.sockets.sockets) {
    if (socket.userId === userId) return socket;
  }
  return null;
}

async function getPushToken(userId) {
  try {
    const result = await pool.query(
      "SELECT push_token FROM device_tokens WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1",
      [userId]
    );
    return result.rows[0]?.push_token || null;
  } catch {
    return null;
  }
}

function registerHandlers(io, socket) {
  console.log(`[socket] connected: ${socket.id} user: ${socket.userId}`);

  // ─── Presence ────────────────────────────────────────────
  // Tell everyone else this user just came online
  socket.broadcast.emit("user:online", { userId: socket.userId });

  // Tell the newly connected client who is already online right now,
  // since they only get FUTURE user:online/user:offline events otherwise.
  const onlineUserIds = new Set();
  for (const [, s] of io.sockets.sockets) {
    if (s.userId && s.userId !== socket.userId) onlineUserIds.add(s.userId);
  }
  socket.emit("users:list", [...onlineUserIds].map((userId) => ({ userId })));

  socket.on("presence:check", ({ userId }) => {
    const targetSocket = findSocketByUserId(io, userId);
    socket.emit("user:presence", {
      userId,
      online: !!targetSocket,
      lastSeen: targetSocket ? null : Date.now(),
    });
  });

  socket.on("disconnect", () => {
    console.log(`[socket] disconnected: ${socket.userId}`);
    io.emit("user:offline", { userId: socket.userId, lastSeen: Date.now() });
  });

  // ─── Typing ──────────────────────────────────────────────
  socket.on("typing:start", ({ to }) => {
    const recipientSocket = findSocketByUserId(io, to);
    recipientSocket?.emit("typing:start", { from: socket.userId });
  });

  socket.on("typing:stop", ({ to }) => {
    const recipientSocket = findSocketByUserId(io, to);
    recipientSocket?.emit("typing:stop", { from: socket.userId });
  });

  // ─── 1:1 Messages ────────────────────────────────────────
  socket.on("message:send", async ({ to, text, replyTo }) => {
    try {
      // Check block status
      const blockCheck = await pool.query(
        `SELECT 1 FROM blocked_users 
         WHERE (blocker_id = $1 AND blocked_id = $2) 
         OR (blocker_id = $2 AND blocked_id = $1)`,
        [socket.userId, to]
      );
      if (blockCheck.rows.length > 0) {
        socket.emit("message:error", { error: "Cannot send message." });
        return;
      }

      // Find or create chat
      let chatId;
      const existingChat = await pool.query(
        `SELECT c.id FROM chats c
         JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = $1
         JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = $2
         WHERE c.type = 'direct'`,
        [socket.userId, to]
      );

      if (existingChat.rows[0]) {
        chatId = existingChat.rows[0].id;
      } else {
        chatId = `chat_${randomUUID().split("-")[0]}`;
        await pool.query("INSERT INTO chats (id, type) VALUES ($1, 'direct')", [chatId]);
        await pool.query("INSERT INTO chat_members (chat_id, user_id) VALUES ($1,$2),($1,$3)", [chatId, socket.userId, to]);
      }

      const msgId = `msg_${randomUUID().split("-")[0]}`;
      const result = await pool.query(
        `INSERT INTO messages (id, chat_id, sender_id, text, reply_to_id, reply_to_text, reply_to_sender, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'sent') RETURNING *`,
        [msgId, chatId, socket.userId, text,
          replyTo?.id || null, replyTo?.text || null, replyTo?.sender || null]
      );

      const msg = result.rows[0];
      const senderResult = await pool.query("SELECT username FROM users WHERE id = $1", [socket.userId]);
      const senderName = senderResult.rows[0]?.username;

      const payload = {
        id: msg.id,
        chatId,
        from: socket.userId,
        to,
        text: msg.text,
        status: "sent",
        sender_name: senderName,
        reply_to_id: msg.reply_to_id,
        reply_to_text: msg.reply_to_text,
        reply_to_sender: msg.reply_to_sender,
        created_at: msg.created_at,
        timestamp: msg.created_at,
      };

      socket.emit("message:sent", payload);

      const recipientSocket = findSocketByUserId(io, to);
      if (recipientSocket) {
        recipientSocket.emit("message:receive", payload);
        await pool.query("UPDATE messages SET status='delivered' WHERE id=$1", [msg.id]);
        socket.emit("message:status", { id: msg.id, status: "delivered" });
      }

      // Always attempt a push notification — a live socket connection
      // does NOT mean the app is in the foreground (mobile sockets often
      // survive backgrounding), so gating push on "no socket" caused
      // notifications to silently never fire for backgrounded recipients.
      const pushToken = await getPushToken(to);
      if (pushToken) {
        await sendPushNotification(pushToken, {
          type: "message",
          senderName,
          text: msg.text,
          chatId,
          otherUserId: socket.userId,
        });
      }
    } catch (err) {
      console.error("[message:send]", err.message);
    }
  });

  // ─── Group Messages ──────────────────────────────────────
  socket.on("group:message:send", async ({ chatId, text, replyTo }) => {
    try {
      const memberCheck = await pool.query(
        "SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2",
        [chatId, socket.userId]
      );
      if (!memberCheck.rows[0]) return;

      const groupResult = await pool.query("SELECT name FROM chats WHERE id=$1", [chatId]);
      const groupName = groupResult.rows[0]?.name;

      const senderResult = await pool.query("SELECT username FROM users WHERE id=$1", [socket.userId]);
      const senderName = senderResult.rows[0]?.username;

      const msgId = `msg_${randomUUID().split("-")[0]}`;
      const result = await pool.query(
        `INSERT INTO messages (id, chat_id, sender_id, text, reply_to_id, reply_to_text, reply_to_sender, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'sent') RETURNING *`,
        [msgId, chatId, socket.userId, text,
          replyTo?.id || null, replyTo?.text || null, replyTo?.sender || null]
      );

      const msg = result.rows[0];
      const members = await pool.query(
        "SELECT user_id FROM chat_members WHERE chat_id=$1 AND user_id!=$2",
        [chatId, socket.userId]
      );

      const payload = {
        id: msg.id,
        chatId,
        from: socket.userId,
        text: msg.text,
        status: "sent",
        sender_id: socket.userId,
        sender_name: senderName,
        reply_to_id: msg.reply_to_id,
        reply_to_text: msg.reply_to_text,
        reply_to_sender: msg.reply_to_sender,
        created_at: msg.created_at,
        timestamp: msg.created_at,
        isGroup: true,
      };

      socket.emit("message:sent", payload);

      for (const member of members.rows) {
        const memberSocket = findSocketByUserId(io, member.user_id);
        if (memberSocket) {
          memberSocket.emit("message:receive", payload);
        }

        // Same fix as 1:1 messages — always attempt push, regardless of
        // whether the member currently has a live socket connection.
        const pushToken = await getPushToken(member.user_id);
        if (pushToken) {
          await sendPushNotification(pushToken, {
            type: "group_message",
            senderName,
            text: msg.text,
            chatId,
            otherUserId: socket.userId,
            groupName,
          });
        }
      }
    } catch (err) {
      console.error("[group:message:send]", err.message);
    }
  });

  // ─── Read receipts ───────────────────────────────────────
  socket.on("messages:read", async ({ chatId, fromUserId }) => {
    try {
      const result = await pool.query(
        `UPDATE messages SET status='read'
         WHERE chat_id=$1 AND sender_id=$2 AND status!='read'
         RETURNING id`,
        [chatId, fromUserId]
      );

      const senderSocket = findSocketByUserId(io, fromUserId);
      if (senderSocket) {
        for (const row of result.rows) {
          senderSocket.emit("message:status", { id: row.id, status: "read" });
        }
        senderSocket.emit("messages:read", { chatId, readBy: socket.userId });
      }

      socket.emit("chat:updated", { chatId, unread_count: 0 });
    } catch (err) {
      console.error("[messages:read]", err.message);
    }
  });

  // ─── Delete message ──────────────────────────────────────
  socket.on("message:delete", async ({ messageId, chatId, forEveryone }) => {
    try {
      if (forEveryone) {
        const msg = await pool.query(
          "SELECT sender_id FROM messages WHERE id=$1", [messageId]
        );
        if (msg.rows[0]?.sender_id !== socket.userId) return;
        await pool.query(
          "UPDATE messages SET deleted_for_everyone=true WHERE id=$1", [messageId]
        );
        const members = await pool.query(
          "SELECT user_id FROM chat_members WHERE chat_id=$1", [chatId]
        );
        for (const member of members.rows) {
          const memberSocket = findSocketByUserId(io, member.user_id);
          memberSocket?.emit("message:deleted", { messageId, chatId, forEveryone: true });
        }
      } else {
        await pool.query(
          "UPDATE messages SET deleted_for_sender=true WHERE id=$1 AND sender_id=$2",
          [messageId, socket.userId]
        );
        socket.emit("message:deleted", { messageId, chatId, forEveryone: false });
      }
    } catch (err) {
      console.error("[message:delete]", err.message);
    }
  });

  // ─── Stickers ────────────────────────────────────────────
  socket.on("sticker:send", async ({ to, chatId, svg, isGroup }) => {
    try {
      const msgId = `msg_${randomUUID().split("-")[0]}`;
      const text = `[sticker]${svg}`;

      if (isGroup) {
        const members = await pool.query(
          "SELECT user_id FROM chat_members WHERE chat_id=$1 AND user_id!=$2",
          [chatId, socket.userId]
        );
        await pool.query(
          "INSERT INTO messages (id, chat_id, sender_id, text) VALUES ($1,$2,$3,$4)",
          [msgId, chatId, socket.userId, text]
        );
        for (const member of members.rows) {
          const memberSocket = findSocketByUserId(io, member.user_id);
          memberSocket?.emit("message:receive", {
            id: msgId, chatId, from: socket.userId, text, isSticker: true,
          });
        }
      } else {
        let chatIdToUse = chatId;
        if (!chatIdToUse) {
          const existing = await pool.query(
            `SELECT c.id FROM chats c
             JOIN chat_members cm1 ON cm1.chat_id=c.id AND cm1.user_id=$1
             JOIN chat_members cm2 ON cm2.chat_id=c.id AND cm2.user_id=$2
             WHERE c.type='direct'`,
            [socket.userId, to]
          );
          chatIdToUse = existing.rows[0]?.id;
        }
        await pool.query(
          "INSERT INTO messages (id, chat_id, sender_id, text) VALUES ($1,$2,$3,$4)",
          [msgId, chatIdToUse, socket.userId, text]
        );
        const recipientSocket = findSocketByUserId(io, to);
        recipientSocket?.emit("message:receive", {
          id: msgId, chatId: chatIdToUse, from: socket.userId, text, isSticker: true,
        });
      }
    } catch (err) {
      console.error("[sticker:send]", err.message);
    }
  });

  // ─── WebRTC Signaling ────────────────────────────────────
  socket.on("call:offer", ({ to, offer, callType }) => {
    const recipientSocket = findSocketByUserId(io, to);
    console.log(`[call] offer from ${socket.userId} to ${to} — recipient found: ${!!recipientSocket}`);
    if (recipientSocket) {
      recipientSocket.emit("call:incoming", {
        from: socket.userId,
        fromName: socket.username,
        offer,
        callType,
      });
    } else {
      socket.emit("call:unavailable", { userId: to });
    }
  });

  socket.on("call:answer", ({ to, answer }) => {
    const recipientSocket = findSocketByUserId(io, to);
    recipientSocket?.emit("call:answered", { answer });
  });

  socket.on("call:ice", ({ to, candidate }) => {
    const recipientSocket = findSocketByUserId(io, to);
    recipientSocket?.emit("call:ice", { candidate });
  });

  socket.on("call:end", ({ to }) => {
    const recipientSocket = findSocketByUserId(io, to);
    recipientSocket?.emit("call:ended", { from: socket.userId });
  });

  socket.on("call:reject", ({ to }) => {
    const recipientSocket = findSocketByUserId(io, to);
    recipientSocket?.emit("call:rejected", { from: socket.userId });
  });

  // ─── In-call drawing overlay ─────────────────────────────────────
  // Pure relay, no DB persistence — annotations are ephemeral, live only
  // as long as the call does. Same "find the other party's socket and
  // forward" pattern as the ICE/offer/answer relays above.
  socket.on("call:draw:point", ({ to, strokeId, x, y, color }) => {
    const recipientSocket = findSocketByUserId(io, to);
    recipientSocket?.emit("call:draw:point", { from: socket.userId, strokeId, x, y, color });
  });

  socket.on("call:draw:end", ({ to, strokeId }) => {
    const recipientSocket = findSocketByUserId(io, to);
    recipientSocket?.emit("call:draw:end", { from: socket.userId, strokeId });
  });

  socket.on("call:draw:clear", ({ to }) => {
    const recipientSocket = findSocketByUserId(io, to);
    recipientSocket?.emit("call:draw:clear", { from: socket.userId });
  });
}

module.exports = { registerHandlers };