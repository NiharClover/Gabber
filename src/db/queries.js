const pool = require("./pool");
const { randomUUID } = require("crypto");

// ─── Users ────────────────────────────────────────────────

async function getUserById(userId) {
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
  return result.rows[0] || null;
}

async function getUserByPhone(phone) {
  const result = await pool.query("SELECT * FROM users WHERE phone = $1", [phone]);
  return result.rows[0] || null;
}

async function updateLastSeen(userId) {
  await pool.query("UPDATE users SET last_seen = NOW() WHERE id = $1", [userId]);
}

// ─── Direct Chats ─────────────────────────────────────────

async function findDirectChat(userA, userB) {
  const result = await pool.query(
    `SELECT c.* FROM chats c
     JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = $1
     JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = $2
     WHERE c.type = 'direct' LIMIT 1`,
    [userA, userB]
  );
  return result.rows[0] || null;
}

async function createDirectChat(userA, userB) {
  const chatId = `chat_${randomUUID().split("-")[0]}`;
  await pool.query("INSERT INTO chats (id, type) VALUES ($1, 'direct')", [chatId]);
  await pool.query(
    "INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)",
    [chatId, userA, userB]
  );
  return chatId;
}

async function getOrCreateDirectChat(userA, userB) {
  const existing = await findDirectChat(userA, userB);
  if (existing) return existing.id;
  return createDirectChat(userA, userB);
}

// ─── Group Chats ──────────────────────────────────────────

async function createGroupChat(name, creatorId, memberIds) {
  const chatId = `group_${randomUUID().split("-")[0]}`;

  await pool.query(
    "INSERT INTO chats (id, type, name) VALUES ($1, 'group', $2)",
    [chatId, name]
  );

  // Add creator as admin
  await pool.query(
    "INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'admin')",
    [chatId, creatorId]
  );

  // Add all other members
  for (const memberId of memberIds) {
    if (memberId !== creatorId) {
      await pool.query(
        "INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member')",
        [chatId, memberId]
      );
    }
  }

  console.log(`[group] Created "${name}" (${chatId}) with ${memberIds.length + 1} members`);
  return chatId;
}

async function getGroupInfo(chatId) {
  const chatResult = await pool.query(
    "SELECT * FROM chats WHERE id = $1 AND type = 'group'",
    [chatId]
  );
  if (!chatResult.rows[0]) return null;

  const membersResult = await pool.query(
    `SELECT u.id, u.username, u.avatar_url, cm.role
     FROM chat_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.chat_id = $1`,
    [chatId]
  );

  return { ...chatResult.rows[0], members: membersResult.rows };
}

async function addGroupMember(chatId, userId) {
  await pool.query(
    `INSERT INTO chat_members (chat_id, user_id, role)
     VALUES ($1, $2, 'member')
     ON CONFLICT DO NOTHING`,
    [chatId, userId]
  );
}

async function getGroupMembers(chatId) {
  const result = await pool.query(
    "SELECT user_id FROM chat_members WHERE chat_id = $1",
    [chatId]
  );
  return result.rows.map((r) => r.user_id);
}

// ─── All Chats (direct + group) ───────────────────────────

async function getUserChats(userId) {
  const result = await pool.query(
    `SELECT
       c.id, c.type, c.name, c.last_message_at,
       -- For direct chats: other user's info
       u.id AS other_user_id,
       u.username AS other_username,
       u.avatar_url,
       (SELECT text FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message
     FROM chats c
     JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
     LEFT JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id != $1 AND c.type = 'direct'
     LEFT JOIN users u ON u.id = cm2.user_id
     ORDER BY c.last_message_at DESC`,
    [userId]
  );
  return result.rows;
}

// ─── Messages ─────────────────────────────────────────────

async function saveMessage({ chatId, senderId, text }) {
  const messageId = `msg_${randomUUID().split("-")[0]}`;
  const result = await pool.query(
    `INSERT INTO messages (id, chat_id, sender_id, text, status)
     VALUES ($1, $2, $3, $4, 'sent') RETURNING *`,
    [messageId, chatId, senderId, text]
  );
  await pool.query(
    "UPDATE chats SET last_message_at = NOW() WHERE id = $1",
    [chatId]
  );
  return result.rows[0];
}

async function getChatMessages(chatId, limit = 50, before = null) {
  let query, params;
  if (before) {
    query = `SELECT m.*, u.username AS sender_name FROM messages m
             JOIN users u ON u.id = m.sender_id
             WHERE m.chat_id = $1 AND m.created_at < $2
             ORDER BY m.created_at DESC LIMIT $3`;
    params = [chatId, before, limit];
  } else {
    query = `SELECT m.*, u.username AS sender_name FROM messages m
             JOIN users u ON u.id = m.sender_id
             WHERE m.chat_id = $1
             ORDER BY m.created_at DESC LIMIT $2`;
    params = [chatId, limit];
  }
  const result = await pool.query(query, params);
  return result.rows.reverse();
}

async function updateMessageStatus(messageId, status) {
  await pool.query("UPDATE messages SET status = $1 WHERE id = $2", [status, messageId]);
}

async function getUserDeviceTokens(userId) {
  const result = await pool.query(
    "SELECT token FROM device_tokens WHERE user_id = $1",
    [userId]
  );
  return result.rows.map((r) => r.token);
}

async function getGroupMemberTokens(chatId, excludeUserId) {
  const result = await pool.query(
    `SELECT dt.token FROM device_tokens dt
     JOIN chat_members cm ON cm.user_id = dt.user_id
     WHERE cm.chat_id = $1 AND dt.user_id != $2`,
    [chatId, excludeUserId]
  );
  return result.rows.map((r) => r.token);
}

module.exports = {
  getUserById,
  getUserByPhone,
  getUserDeviceTokens,
  getGroupMemberTokens,
  updateLastSeen,
  findDirectChat,
  createDirectChat,
  getOrCreateDirectChat,
  createGroupChat,
  getGroupInfo,
  addGroupMember,
  getGroupMembers,
  getUserChats,
  saveMessage,
  getChatMessages,
  updateMessageStatus,
};