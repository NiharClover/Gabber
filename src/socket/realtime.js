function userRoom(userId) {
  return `user:${userId}`;
}

function getUserSockets(io, userId) {
  const ids = io.sockets.adapter.rooms.get(userRoom(userId));
  if (!ids) return [];
  return [...ids].map((id) => io.sockets.sockets.get(id)).filter(Boolean);
}

function isUserOnline(io, userId) {
  return getUserSockets(io, userId).length > 0;
}

function emitToUser(io, userId, event, payload) {
  const online = isUserOnline(io, userId);
  if (online) io.to(userRoom(userId)).emit(event, payload);
  return online;
}

module.exports = { emitToUser, getUserSockets, isUserOnline, userRoom };
