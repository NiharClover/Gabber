const pool = require("../db/pool");
const { registerMessageHandlers, reconcileUserMessages } = require("./messageHandlers");
const { registerCallHandlers, handleUserOffline } = require("./callHandlers");
const { emitToUser, isUserOnline, userRoom } = require("./realtime");

async function getVisibleUsers(userId) {
  const result = await pool.query(
    `SELECT DISTINCT peer.user_id, u.last_seen
     FROM chat_members mine
     JOIN chat_members peer ON peer.chat_id=mine.chat_id AND peer.user_id<>mine.user_id
     JOIN users u ON u.id=peer.user_id
     WHERE mine.user_id=$1
       AND NOT EXISTS (
         SELECT 1 FROM blocked_users b
         WHERE (b.blocker_id=$1 AND b.blocked_id=peer.user_id)
            OR (b.blocker_id=peer.user_id AND b.blocked_id=$1)
       )`,
    [userId]
  );
  return result.rows;
}

async function canSharePresence(socket, targetUserId) {
  if (!targetUserId || targetUserId === socket.userId) return false;
  if (socket.data.visibleUserIds?.has(targetUserId)) return true;

  const result = await pool.query(
    `SELECT 1
     FROM chat_members mine
     JOIN chat_members peer ON peer.chat_id=mine.chat_id
     WHERE mine.user_id=$1 AND peer.user_id=$2
       AND NOT EXISTS (
         SELECT 1 FROM blocked_users b
         WHERE (b.blocker_id=$1 AND b.blocked_id=$2)
            OR (b.blocker_id=$2 AND b.blocked_id=$1)
       )
     LIMIT 1`,
    [socket.userId, targetUserId]
  );
  if (result.rows[0]) socket.data.visibleUserIds?.add(targetUserId);
  return Boolean(result.rows[0]);
}

function registerHandlers(io, socket) {
  console.log(`[socket] connected: ${socket.id} user: ${socket.userId}`);

  const alreadyOnline = isUserOnline(io, socket.userId);
  socket.join(userRoom(socket.userId));
  socket.data.visibleUserIds = new Set();
  getVisibleUsers(socket.userId)
    .then((visibleUsers) => {
      socket.data.visibleUserIds = new Set(visibleUsers.map(({ user_id }) => user_id));
      const onlineUsers = visibleUsers
        .filter(({ user_id }) => isUserOnline(io, user_id))
        .map(({ user_id }) => ({ userId: user_id }));
      socket.emit("users:list", onlineUsers);
      if (!alreadyOnline) {
        for (const { user_id } of visibleUsers) {
          emitToUser(io, user_id, "user:online", { userId: socket.userId });
        }
      }
    })
    .catch((err) => console.error("[presence]", err.message));
  reconcileUserMessages(io, socket.userId);

  socket.on("presence:check", async ({ userId } = {}) => {
    try {
      if (!(await canSharePresence(socket, userId))) return;
      const online = isUserOnline(io, userId);
      let lastSeen = null;
      if (!online) {
        const result = await pool.query("SELECT last_seen FROM users WHERE id=$1", [userId]);
        lastSeen = result.rows[0]?.last_seen || null;
      }
      socket.emit("user:presence", { userId, online, lastSeen });
    } catch (err) {
      console.error("[presence]", err.message);
    }
  });

  socket.on("typing:start", async ({ to } = {}) => {
    try {
      if (await canSharePresence(socket, to)) {
        emitToUser(io, to, "typing:start", { from: socket.userId });
      }
    } catch (err) {
      console.error("[typing]", err.message);
    }
  });
  socket.on("typing:stop", async ({ to } = {}) => {
    try {
      if (await canSharePresence(socket, to)) {
        emitToUser(io, to, "typing:stop", { from: socket.userId });
      }
    } catch (err) {
      console.error("[typing]", err.message);
    }
  });

  registerMessageHandlers(io, socket);
  registerCallHandlers(io, socket);

  socket.on("disconnect", () => {
    console.log(`[socket] disconnected: ${socket.userId}`);
    // Socket.IO removes the socket from rooms as disconnect completes. A
    // short deferral lets that removal settle and prevents one device/tab
    // from marking the user offline while another connection remains.
    setTimeout(async () => {
      if (isUserOnline(io, socket.userId)) return;
      const lastSeen = Date.now();
      for (const userId of socket.data.visibleUserIds || []) {
        emitToUser(io, userId, "user:offline", { userId: socket.userId, lastSeen });
      }
      handleUserOffline(io, socket.userId);
      try {
        await pool.query("UPDATE users SET last_seen=NOW() WHERE id=$1", [socket.userId]);
      } catch (err) {
        console.error("[presence]", err.message);
      }
    }, 100);
  });
}

module.exports = { registerHandlers };
