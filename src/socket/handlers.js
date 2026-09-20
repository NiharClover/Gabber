const pool = require("../db/pool");
const { registerMessageHandlers, reconcileUserMessages } = require("./messageHandlers");
const { registerCallHandlers, handleUserOffline } = require("./callHandlers");
const { emitToUser, isUserOnline, userRoom } = require("./realtime");

function registerHandlers(io, socket) {
  console.log(`[socket] connected: ${socket.id} user: ${socket.userId}`);

  const alreadyOnline = isUserOnline(io, socket.userId);
  socket.join(userRoom(socket.userId));
  if (!alreadyOnline) socket.broadcast.emit("user:online", { userId: socket.userId });

  const onlineUserIds = new Set();
  for (const [, connectedSocket] of io.sockets.sockets) {
    if (connectedSocket.userId && connectedSocket.userId !== socket.userId) {
      onlineUserIds.add(connectedSocket.userId);
    }
  }
  socket.emit("users:list", [...onlineUserIds].map((userId) => ({ userId })));
  reconcileUserMessages(io, socket.userId);

  socket.on("presence:check", ({ userId } = {}) => {
    const online = isUserOnline(io, userId);
    socket.emit("user:presence", {
      userId,
      online,
      lastSeen: online ? null : Date.now(),
    });
  });

  socket.on("typing:start", ({ to } = {}) => {
    if (to) emitToUser(io, to, "typing:start", { from: socket.userId });
  });
  socket.on("typing:stop", ({ to } = {}) => {
    if (to) emitToUser(io, to, "typing:stop", { from: socket.userId });
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
      io.emit("user:offline", { userId: socket.userId, lastSeen });
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
