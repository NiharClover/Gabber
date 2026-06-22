const pool = require("../db/pool");
const redis = require("../db/redis");
const { randomUUID } = require("crypto");
const { sendPushNotification } = require("../services/push");

function findSocketByUserId(io, userId) {
  for (const [, socket] of io.sockets.sockets) {
    if (socket.userId === userId) return socket;
  }
  return null;
}

function registerHandlers(io, socket) {

  console.log(`[socket] connected: ${socket.username} (${socket.userId})`);

  // Notify others this user is online
  socket.broadcast.emit("user:online", { userId: socket.userId });

  // ─── 1:1 message send ──────────────────────────────────────────────────────
  socket.on("message:send", async ({ to, text, replyTo }) => {
    try {
      if (!to || !text) return;

      // Prevent sending to yourself causing double-fire bugs
      if (to === socket.userId) {
        console.log(`[send] blocked self-message from ${socket.username}`);
        return;
      }

      // Check block status
      const blockCheck = await pool.query(
        `SELECT
          EXISTS(SELECT 1 FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2) AS i_blocked,
          EXISTS(SELECT 1 FROM blocked_users WHERE blocker_id = $2 AND blocked_id = $1) AS they_blocked`,
        [socket.userId, to]
      );
      if (blockCheck.rows[0].i_blocked || blockCheck.rows[0].they_blocked) {
        socket.emit("message:error", { error: "Cannot send message — user is blocked." });
        return;
      }

      // Find or create 1:1 chat
      let chatResult = await pool.query(
        `SELECT c.id FROM chats c
         JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = $1
         JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = $2
         WHERE c.type = 'direct'
         LIMIT 1`,
        [socket.userId, to]
      );

      let chatId;
      if (chatResult.rows.length > 0) {
        chatId = chatResult.rows[0].id;
      } else {
        chatId = `chat_${randomUUID().split("-")[0]}`;
        await pool.query(`INSERT INTO chats (id, type) VALUES ($1, 'direct')`, [chatId]);
        await pool.query(`INSERT INTO chat_members (chat_id, user_id) VALUES ($1,$2), ($1,$3)`, [chatId, socket.userId, to]);
      }

      const messageId = randomUUID();

      await pool.query(
        `INSERT INTO messages (id, chat_id, sender_id, text, status, reply_to_id, reply_to_text, reply_to_sender)
         VALUES ($1,$2,$3,$4,'sent',$5,$6,$7)`,
        [messageId, chatId, socket.userId, text, replyTo?.id || null, replyTo?.text || null, replyTo?.sender || null]
      );

      const payload = {
        id: messageId,
        chatId,
        from: socket.userId,
        fromName: socket.username,
        text,
        status: "sent",
        timestamp: new Date().toISOString(),
        replyTo: replyTo || null,
        reply_to_id: replyTo?.id || null,
        reply_to_text: replyTo?.text || null,
        reply_to_sender: replyTo?.sender || null,
      };

      // Confirm to sender
      socket.emit("message:sent", payload);

      // Deliver to recipient if online
      const recipientSocket = findSocketByUserId(io, to);

      if (recipientSocket && recipientSocket.id !== socket.id) {
        recipientSocket.emit("message:receive", payload);
        await pool.query("UPDATE messages SET status = 'delivered' WHERE id = $1", [messageId]);
        socket.emit("message:status", { id: messageId, status: "delivered" });
      } else {
        // Recipient offline — send push notification
        let notifBody = text;
        if (text.startsWith("[image]")) notifBody = "📷 Photo";
        else if (text.startsWith("[view-once]")) notifBody = "👁 View once photo";
        else if (text.startsWith("[voice]")) notifBody = "🎤 Voice message";
        else if (text.startsWith("[payment]")) notifBody = "💰 Payment sent";
        else if (text.startsWith("[payment-request]")) notifBody = "💰 Payment request";
        else if (text.startsWith("[bill]")) notifBody = "🧾 Order bill";
        else if (text.startsWith("[sticker]")) notifBody = "✨ Sticker";

        sendPushNotification(to, socket.username, notifBody, { chatId, type: "message" });
      }
    } catch (err) {
      console.error("[msg] Error:", err.message);
    }
  });

  // ─── Group message send ────────────────────────────────────────────────────
  socket.on("group:message:send", async ({ chatId, text, replyTo }) => {
    try {
      if (!chatId || !text) return;

      const messageId = randomUUID();

      await pool.query(
        `INSERT INTO messages (id, chat_id, sender_id, text, status, reply_to_id, reply_to_text, reply_to_sender)
         VALUES ($1,$2,$3,$4,'sent',$5,$6,$7)`,
        [messageId, chatId, socket.userId, text, replyTo?.id || null, replyTo?.text || null, replyTo?.sender || null]
      );

      const payload = {
        id: messageId,
        chatId,
        from: socket.userId,
        fromName: socket.username,
        sender_id: socket.userId,
        sender_name: socket.username,
        text,
        status: "sent",
        timestamp: new Date().toISOString(),
        replyTo: replyTo || null,
        reply_to_id: replyTo?.id || null,
        reply_to_text: replyTo?.text || null,
        reply_to_sender: replyTo?.sender || null,
      };

      // Confirm to sender
      socket.emit("message:sent", payload);

      // Deliver to all other online members, push to offline ones
      const members = await pool.query(
        "SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id != $2",
        [chatId, socket.userId]
      );

      for (const member of members.rows) {
        const memberSocket = findSocketByUserId(io, member.user_id);
        if (memberSocket && memberSocket.id !== socket.id) {
          memberSocket.emit("message:receive", payload);
        } else if (!memberSocket) {
          let notifBody = text;
          if (text.startsWith("[image]")) notifBody = "📷 Photo";
          else if (text.startsWith("[voice]")) notifBody = "🎤 Voice message";
          sendPushNotification(member.user_id, `${socket.username} (group)`, notifBody, { chatId, type: "group" });
        }
      }
    } catch (err) {
      console.error("[group msg] Error:", err.message);
    }
  });

  // ─── Sticker send ──────────────────────────────────────────────────────────
  socket.on("sticker:send", async ({ to, chatId, svg, isGroup }) => {
    try {
      const messageId = randomUUID();
      const text = `[sticker]${svg}`;
      let targetChatId = chatId;

      if (!isGroup) {
        let chatResult = await pool.query(
          `SELECT c.id FROM chats c
           JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = $1
           JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = $2
           WHERE c.type = 'direct' LIMIT 1`,
          [socket.userId, to]
        );
        if (chatResult.rows.length > 0) targetChatId = chatResult.rows[0].id;
      }

      await pool.query(
        `INSERT INTO messages (id, chat_id, sender_id, text, status) VALUES ($1,$2,$3,$4,'sent')`,
        [messageId, targetChatId, socket.userId, text]
      );

      const payload = {
        id: messageId,
        chatId: targetChatId,
        from: socket.userId,
        fromName: socket.username,
        sender_id: socket.userId,
        sender_name: socket.username,
        text,
        isSticker: true,
        status: "sent",
        timestamp: new Date().toISOString(),
      };

      socket.emit("message:sent", payload);

      if (isGroup) {
        const members = await pool.query(
          "SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id != $2",
          [targetChatId, socket.userId]
        );
        for (const member of members.rows) {
          const memberSocket = findSocketByUserId(io, member.user_id);
          if (memberSocket && memberSocket.id !== socket.id) {
            memberSocket.emit("message:receive", payload);
          }
        }
      } else {
        const recipientSocket = findSocketByUserId(io, to);
        if (recipientSocket && recipientSocket.id !== socket.id) {
          recipientSocket.emit("message:receive", payload);
        }
      }
    } catch (err) {
      console.error("[sticker] Error:", err.message);
    }
  });

  // ─── Message delete ────────────────────────────────────────────────────────
  socket.on("message:delete", async ({ messageId, chatId, forEveryone }) => {
    console.log(`[delete] received: messageId=${messageId}, chatId=${chatId}, forEveryone=${forEveryone}, from=${socket.username}`);
    try {
      if (forEveryone) {
        const check = await pool.query(
          "SELECT sender_id FROM messages WHERE id = $1",
          [messageId]
        );
        console.log(`[delete] sender_id in DB = ${check.rows[0]?.sender_id}, socket.userId = ${socket.userId}`);

        if (check.rows[0]?.sender_id !== socket.userId) {
          console.log(`[delete] BLOCKED - sender mismatch`);
          return;
        }

        const updateResult = await pool.query(
          "UPDATE messages SET deleted_for_everyone = true WHERE id = $1 RETURNING id, deleted_for_everyone",
          [messageId]
        );
        console.log(`[delete] update result:`, updateResult.rows);

        const members = await pool.query(
          "SELECT user_id FROM chat_members WHERE chat_id = $1",
          [chatId]
        );
        console.log(`[delete] notifying members:`, members.rows);

        for (const m of members.rows) {
          const memberSocket = findSocketByUserId(io, m.user_id);
          if (memberSocket) {
            memberSocket.emit("message:deleted", { messageId, chatId, forEveryone: true });
          }
        }
      } else {
        const result = await pool.query(
          "UPDATE messages SET deleted_for_sender = true WHERE id = $1 AND sender_id = $2 RETURNING id",
          [messageId, socket.userId]
        );
        console.log(`[delete] for-me update result:`, result.rows);
        socket.emit("message:deleted", { messageId, chatId, forEveryone: false });
      }
    } catch (err) {
      console.error("[delete] Error:", err.message);
    }
  });

  // ─── Messages read ─────────────────────────────────────────────────────────
  // Called when a user opens a chat — marks messages from `fromUserId` as read,
  // sends blue ticks back to the sender, and updates both users' chat list badges.
  socket.on("messages:read", async ({ chatId, fromUserId }) => {
    try {
      if (!chatId || !fromUserId) return;

      // Mark all unread messages sent by fromUserId in this chat as read
      const result = await pool.query(
        `UPDATE messages
         SET status = 'read'
         WHERE chat_id = $1
           AND sender_id = $2
           AND status != 'read'
         RETURNING id`,
        [chatId, fromUserId]
      );

      // Nothing changed — skip all emits
      if (result.rows.length === 0) return;

      // 1. Tell the SENDER their messages were read (blue ticks on each message)
      const senderSocket = findSocketByUserId(io, fromUserId);
      if (senderSocket) {
        for (const row of result.rows) {
          senderSocket.emit("message:status", { id: row.id, status: "read" });
        }
        // Let sender's chat list know this conversation was read
        senderSocket.emit("messages:read", { chatId, readBy: socket.userId });
      }

      // 2. Tell the READER's own socket to zero the unread badge in the chat list
      //    (hits the chat:updated listener in chats.js frontend)
      socket.emit("chat:updated", { chatId, unread_count: 0 });

      console.log(
        `[read] ${socket.username} read ${result.rows.length} msg(s) in chat ${chatId} (from ${fromUserId})`
      );
    } catch (err) {
      console.error("[read] Error:", err.message);
    }
  });

  // ─── Typing indicators ─────────────────────────────────────────────────────
  socket.on("typing:start", ({ to }) => {
    const targetSocket = findSocketByUserId(io, to);
    if (targetSocket) targetSocket.emit("typing:start", { from: socket.userId });
  });

  socket.on("typing:stop", ({ to }) => {
    const targetSocket = findSocketByUserId(io, to);
    if (targetSocket) targetSocket.emit("typing:stop", { from: socket.userId });
  });

  // ─── Disconnect ────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[disconnect] ${socket.username} went offline`);
    socket.broadcast.emit("user:offline", { userId: socket.userId });
  });
}

module.exports = { registerHandlers, findSocketByUserId };