const { randomUUID } = require("crypto");
const pool = require("../db/pool");
const { emitToUser, isUserOnline, userRoom } = require("./realtime");

const calls = new Map();
const groupCalls = new Map();
const callByUser = new Map();
const startingUsers = new Set();
const RECONNECT_GRACE_MS = 15000;
const SCREENSHOT_GRANT_MS = 60000;
const MAX_GROUP_CALL_PARTICIPANTS = 6;

function acknowledge(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function getSession(callId, userId) {
  const session = calls.get(callId);
  return session && (session.caller === userId || session.callee === userId) ? session : null;
}

function otherUser(session, userId) {
  return session.caller === userId ? session.callee : session.caller;
}

function clearSession(session) {
  clearTimeout(session.lifecycleTimer);
  for (const timer of session.disconnectTimers.values()) clearTimeout(timer);
  calls.delete(session.id);
  if (callByUser.get(session.caller) === session.id) callByUser.delete(session.caller);
  if (callByUser.get(session.callee) === session.id) callByUser.delete(session.callee);
}

function endSession(io, session, endedBy, reason = "ended") {
  const peer = otherUser(session, endedBy);
  emitToUser(io, peer, "call:ended", { callId: session.id, from: endedBy, reason });
  emitToUser(io, endedBy, "call:ended:ack", { callId: session.id, reason });
  clearSession(session);
}

function endGroupCall(io, session, reason = "ended") {
  clearTimeout(session.lifecycleTimer);
  for (const userId of session.participants) {
    emitToUser(io, userId, "group-call:ended", { roomId: session.id, reason });
    if (callByUser.get(userId) === session.id) callByUser.delete(userId);
  }
  session.participants.clear();
  groupCalls.delete(session.id);
}

function relayOrQueue(io, session, recipientId, event, payload) {
  if (session.ready.has(recipientId) && isUserOnline(io, recipientId)) {
    emitToUser(io, recipientId, event, payload);
    return;
  }
  const queue = session.queues.get(recipientId) || [];
  if (queue.length < 256) queue.push({ event, payload });
  session.queues.set(recipientId, queue);
}

function flushQueue(io, session, userId) {
  const queue = session.queues.get(userId) || [];
  for (const item of queue) emitToUser(io, userId, item.event, item.payload);
  session.queues.set(userId, []);
}

function registerCallHandlers(io, socket) {
  socket.on("group-call:start", async ({ chatId, callType } = {}, ack) => {
    if (!chatId || !["voice", "video"].includes(callType) || callByUser.has(socket.userId) || startingUsers.has(socket.userId)) {
      return acknowledge(ack, { ok: false, error: "Invalid call request or you are already in a call." });
    }
    startingUsers.add(socket.userId);
    try {
      const result = await pool.query(
        `SELECT c.name, cm.user_id, u.username
         FROM chats c JOIN chat_members cm ON cm.chat_id=c.id JOIN users u ON u.id=cm.user_id
         WHERE c.id=$1 AND c.type='group' AND EXISTS (
           SELECT 1 FROM chat_members mine WHERE mine.chat_id=c.id AND mine.user_id=$2
         ) ORDER BY u.username`,
        [chatId, socket.userId]
      );
      if (!result.rows.length) return acknowledge(ack, { ok: false, error: "Group not found or access denied." });
      const roomId = `gcall_${randomUUID()}`;
      const members = new Map(result.rows.map((row) => [row.user_id, row.username]));
      const session = { id: roomId, chatId, groupName: result.rows[0].name, callType, creator: socket.userId, members, participants: new Set(), createdAt: Date.now(), lifecycleTimer: null };
      groupCalls.set(roomId, session);
      session.lifecycleTimer = setTimeout(() => {
        if (groupCalls.get(roomId) === session && !session.participants.has(session.creator)) endGroupCall(io, session, "host_unavailable");
      }, 60000);
      for (const [userId] of members) {
        if (userId !== socket.userId && isUserOnline(io, userId) && !callByUser.has(userId)) {
          emitToUser(io, userId, "group-call:incoming", { roomId, chatId, groupName: session.groupName, callType, from: socket.userId, fromName: socket.username });
        }
      }
      acknowledge(ack, { ok: true, roomId, groupName: session.groupName });
    } catch (err) {
      console.error("[group-call:start]", err.message);
      acknowledge(ack, { ok: false, error: "Group call could not be started." });
    } finally {
      startingUsers.delete(socket.userId);
    }
  });

  socket.on("group-call:join", ({ roomId } = {}, ack) => {
    const session = groupCalls.get(roomId);
    if (!session || !session.members.has(socket.userId)) return acknowledge(ack, { ok: false, error: "Group call expired or access denied." });
    const activeCall = callByUser.get(socket.userId);
    if (activeCall && activeCall !== roomId) return acknowledge(ack, { ok: false, error: "You are already in another call." });
    if (session.participants.size >= MAX_GROUP_CALL_PARTICIPANTS && !session.participants.has(socket.userId)) return acknowledge(ack, { ok: false, error: "Group call is full." });
    const participants = [...session.participants].map((userId) => ({ userId, username: session.members.get(userId) || "Participant" }));
    session.participants.add(socket.userId);
    callByUser.set(socket.userId, roomId);
    socket.to(userRoom(socket.userId)).emit("group-call:taken", { roomId });
    if (socket.userId === session.creator) {
      clearTimeout(session.lifecycleTimer);
      session.lifecycleTimer = null;
    }
    for (const userId of session.participants) {
      if (userId !== socket.userId) emitToUser(io, userId, "group-call:participant-joined", { roomId, userId: socket.userId, username: session.members.get(socket.userId) || socket.username });
    }
    acknowledge(ack, { ok: true, participants, groupName: session.groupName, callType: session.callType });
  });

  for (const event of ["offer", "answer", "ice"]) {
    socket.on(`group-call:${event}`, ({ roomId, to, ...payload } = {}, ack) => {
      const session = groupCalls.get(roomId);
      const signal = payload[event];
      if (!session?.participants.has(socket.userId) || !session.participants.has(to) || !signal || typeof signal !== "object") return acknowledge(ack, { ok: false, error: "Invalid group call signal." });
      emitToUser(io, to, `group-call:${event}`, { roomId, from: socket.userId, fromName: session.members.get(socket.userId), [event]: signal });
      acknowledge(ack, { ok: true });
    });
  }

  socket.on("group-call:leave", ({ roomId } = {}, ack) => {
    leaveGroupCall(io, socket.userId, roomId);
    acknowledge(ack, { ok: true });
  });

  socket.on("call:start", async ({ to, callType } = {}, ack) => {
    if (!to || to === socket.userId || !["voice", "video"].includes(callType)) {
      return acknowledge(ack, { ok: false, error: "Invalid call request." });
    }
    if (callByUser.has(socket.userId) || callByUser.has(to) || startingUsers.has(socket.userId) || startingUsers.has(to)) {
      return acknowledge(ack, { ok: false, error: "One of the participants is already in a call.", reason: "busy" });
    }
    startingUsers.add(socket.userId);
    startingUsers.add(to);
    try {
      const access = await pool.query(
        `SELECT
           EXISTS (
             SELECT 1 FROM chat_members mine
             JOIN chat_members peer ON peer.chat_id=mine.chat_id
             WHERE mine.user_id=$1 AND peer.user_id=$2
           ) AS shared_chat,
           EXISTS (
             SELECT 1 FROM blocked_users
             WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)
           ) AS blocked`,
        [socket.userId, to]
      );
      if (!access.rows[0]?.shared_chat || access.rows[0]?.blocked) {
        return acknowledge(ack, { ok: false, error: "Call is not allowed.", reason: "forbidden" });
      }
      if (callByUser.has(socket.userId) || callByUser.has(to) || !isUserOnline(io, to)) {
        return acknowledge(ack, { ok: false, error: "User is busy or unavailable.", reason: "busy" });
      }

      const callId = `call_${randomUUID()}`;
      const session = {
        id: callId,
        caller: socket.userId,
        callee: to,
        callerName: socket.username,
        callType,
        state: "preparing",
        ready: new Set(),
        queues: new Map([[socket.userId, []], [to, []]]),
        disconnectTimers: new Map(),
        screenshotRequests: new Map(),
        screenshotGrants: new Map(),
        lifecycleTimer: null,
        createdAt: Date.now(),
      };
      calls.set(callId, session);
      callByUser.set(socket.userId, callId);
      callByUser.set(to, callId);
      session.lifecycleTimer = setTimeout(() => {
        if (calls.get(callId) === session && session.state !== "connected") {
          endSession(io, session, session.caller, "no_answer");
        }
      }, 60000);
      acknowledge(ack, { ok: true, callId });
    } catch (err) {
      console.error("[call:start]", err.message);
      acknowledge(ack, { ok: false, error: "Call could not be started." });
    } finally {
      startingUsers.delete(socket.userId);
      startingUsers.delete(to);
    }
  });

  socket.on("call:ready", ({ callId } = {}, ack) => {
    const session = getSession(callId, socket.userId);
    if (!session) return acknowledge(ack, { ok: false, error: "Call not found." });
    session.ready.add(socket.userId);
    flushQueue(io, session, socket.userId);
    acknowledge(ack, { ok: true });
  });

  socket.on("call:offer", ({ callId, offer } = {}, ack) => {
    const session = getSession(callId, socket.userId);
    if (!session || session.caller !== socket.userId || !offer || session.state !== "preparing") {
      return acknowledge(ack, { ok: false, error: "Invalid call offer." });
    }
    session.state = "ringing";
    emitToUser(io, session.callee, "call:incoming", {
      callId: session.id,
      from: session.caller,
      fromName: session.callerName,
      offer,
      callType: session.callType,
    });
    acknowledge(ack, { ok: true });
  });

  socket.on("call:answer", ({ callId, answer } = {}, ack) => {
    const session = getSession(callId, socket.userId);
    if (!session || session.callee !== socket.userId || !answer || session.state !== "ringing") {
      return acknowledge(ack, { ok: false, error: "Invalid call answer." });
    }
    session.state = "connected";
    clearTimeout(session.lifecycleTimer);
    session.lifecycleTimer = null;
    socket.to(userRoom(session.callee)).emit("call:taken", { callId: session.id });
    relayOrQueue(io, session, session.caller, "call:answered", { callId: session.id, answer });
    acknowledge(ack, { ok: true });
  });

  socket.on("call:ice", ({ callId, candidate } = {}, ack) => {
    const session = getSession(callId, socket.userId);
    if (!session || !candidate) return acknowledge(ack, { ok: false, error: "Invalid ICE candidate." });
    const peer = otherUser(session, socket.userId);
    relayOrQueue(io, session, peer, "call:ice", { callId: session.id, candidate });
    acknowledge(ack, { ok: true });
  });

  socket.on("call:reject", ({ callId } = {}, ack) => {
    const session = getSession(callId, socket.userId);
    if (!session) return acknowledge(ack, { ok: false, error: "Call not found." });
    const peer = otherUser(session, socket.userId);
    emitToUser(io, peer, "call:rejected", { callId: session.id, from: socket.userId });
    clearSession(session);
    acknowledge(ack, { ok: true });
  });

  socket.on("call:end", ({ callId } = {}, ack) => {
    const session = getSession(callId, socket.userId);
    if (!session) return acknowledge(ack, { ok: true });
    endSession(io, session, socket.userId);
    acknowledge(ack, { ok: true });
  });

  socket.on("call:resume", ({ callId } = {}, ack) => {
    const session = getSession(callId, socket.userId);
    if (!session) return acknowledge(ack, { ok: false, error: "Call expired." });
    const timer = session.disconnectTimers.get(socket.userId);
    if (timer) clearTimeout(timer);
    session.disconnectTimers.delete(socket.userId);
    session.ready.add(socket.userId);
    flushQueue(io, session, socket.userId);
    emitToUser(io, otherUser(session, socket.userId), "call:peer-reconnected", { callId: session.id });
    acknowledge(ack, { ok: true, state: session.state });
  });

  for (const event of ["call:draw:point", "call:draw:end", "call:draw:clear"]) {
    socket.on(event, (payload = {}) => {
      const session = getSession(payload.callId, socket.userId);
      if (!session || session.state !== "connected") return;
      emitToUser(io, otherUser(session, socket.userId), event, { ...payload, from: socket.userId, to: undefined });
    });
  }

  socket.on("call:screenshot:request", ({ callId } = {}, ack) => {
    const session = getSession(callId, socket.userId);
    if (!session || session.state !== "connected") return acknowledge(ack, { ok: false, error: "Call is not connected." });
    const requestId = `shot_${randomUUID()}`;
    const responder = otherUser(session, socket.userId);
    session.screenshotRequests.set(requestId, {
      requester: socket.userId,
      responder,
      expiresAt: Date.now() + 30000,
    });
    emitToUser(io, responder, "call:screenshot:request", { callId: session.id, requestId, from: socket.userId });
    acknowledge(ack, { ok: true, requestId });
  });

  socket.on("call:screenshot:response", ({ callId, requestId, approved } = {}, ack) => {
    const session = getSession(callId, socket.userId);
    const request = session?.screenshotRequests.get(requestId);
    if (session && request?.expiresAt < Date.now()) session.screenshotRequests.delete(requestId);
    if (!session || !request || request.responder !== socket.userId || request.expiresAt < Date.now()) {
      return acknowledge(ack, { ok: false, error: "Screenshot request is invalid or expired." });
    }
    session.screenshotRequests.delete(requestId);
    if (approved === true) session.screenshotGrants.set(request.requester, Date.now() + SCREENSHOT_GRANT_MS);
    emitToUser(io, request.requester, "call:screenshot:response", {
      callId: session.id, requestId, from: socket.userId, approved: approved === true,
    });
    acknowledge(ack, { ok: true });
  });

  socket.on("call:screenshot-taken", ({ callId } = {}, ack) => {
    const session = getSession(callId, socket.userId);
    const grantUntil = session?.screenshotGrants.get(socket.userId) || 0;
    if (!session || session.state !== "connected" || grantUntil < Date.now()) {
      return acknowledge(ack, { ok: false, error: "No active screenshot consent." });
    }
    emitToUser(io, otherUser(session, socket.userId), "call:screenshot-taken", {
      callId: session.id, from: socket.userId,
    });
    acknowledge(ack, { ok: true });
  });

  socket.on("call:screenshot:relock", ({ callId } = {}, ack) => {
    const session = getSession(callId, socket.userId);
    if (!session) return acknowledge(ack, { ok: false, error: "Call not found." });
    session.screenshotGrants.delete(socket.userId);
    emitToUser(io, otherUser(session, socket.userId), "call:screenshot:relock", {
      callId: session.id, from: socket.userId,
    });
    acknowledge(ack, { ok: true });
  });
}

function handleUserOffline(io, userId) {
  const callId = callByUser.get(userId);
  if (callId && groupCalls.has(callId)) {
    leaveGroupCall(io, userId, callId);
    return;
  }
  const session = callId ? calls.get(callId) : null;
  if (!session || session.disconnectTimers.has(userId)) return;
  session.ready.delete(userId);
  emitToUser(io, otherUser(session, userId), "call:peer-disconnected", {
    callId: session.id, reconnectGraceMs: RECONNECT_GRACE_MS,
  });
  const timer = setTimeout(() => {
    if (calls.get(session.id) === session && session.disconnectTimers.get(userId) === timer) {
      endSession(io, session, userId, "peer_disconnected");
    }
  }, RECONNECT_GRACE_MS);
  session.disconnectTimers.set(userId, timer);
}

function leaveGroupCall(io, userId, roomId) {
  const session = groupCalls.get(roomId);
  if (session?.creator === userId && !session.participants.has(userId)) {
    endGroupCall(io, session, "host_unavailable");
    return;
  }
  if (!session?.participants.has(userId)) return;
  session.participants.delete(userId);
  if (callByUser.get(userId) === roomId) callByUser.delete(userId);
  for (const peerId of session.participants) emitToUser(io, peerId, "group-call:participant-left", { roomId, userId });
  if (session.participants.size === 0) {
    clearTimeout(session.lifecycleTimer);
    groupCalls.delete(roomId);
  }
}

module.exports = { registerCallHandlers, handleUserOffline };
