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
  const directKey = [userA, userB].sort().join(":");
  const result = await pool.query(
    `SELECT c.* FROM chats c
     JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = $1
     JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = $2
     WHERE c.type = 'direct'
     ORDER BY (c.direct_key = $3) DESC, c.created_at ASC
     LIMIT 1`,
    [userA, userB, directKey]
  );
  return result.rows[0] || null;
}

async function createDirectChat(userA, userB) {
  return getOrCreateDirectChat(userA, userB);
}

async function getOrCreateDirectChat(userA, userB) {
  if (!userA || !userB || userA === userB) {
    throw new Error("A direct chat requires two different users.");
  }

  const directKey = [userA, userB].sort().join(":");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serializes concurrent creation attempts for this exact user pair.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [directKey]);

    let existing = await client.query(
      "SELECT id FROM chats WHERE type='direct' AND direct_key=$1 LIMIT 1",
      [directKey]
    );

    // Adopt a legacy direct chat created before direct_key existed.
    if (!existing.rows[0]) {
      existing = await client.query(
        `SELECT c.id FROM chats c
         JOIN chat_members a ON a.chat_id=c.id AND a.user_id=$1
         JOIN chat_members b ON b.chat_id=c.id AND b.user_id=$2
         WHERE c.type='direct'
         ORDER BY c.created_at ASC
         LIMIT 1`,
        [userA, userB]
      );
      if (existing.rows[0]) {
        await client.query(
          "UPDATE chats SET direct_key=$1 WHERE id=$2 AND direct_key IS NULL",
          [directKey, existing.rows[0].id]
        );
      }
    }

    if (existing.rows[0]) {
      await client.query("COMMIT");
      return existing.rows[0].id;
    }

    const chatId = `chat_${randomUUID().split("-")[0]}`;
    await client.query(
      "INSERT INTO chats (id, type, direct_key) VALUES ($1, 'direct', $2)",
      [chatId, directKey]
    );
    await client.query(
      "INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)",
      [chatId, userA, userB]
    );
    await client.query("COMMIT");
    return chatId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
      c.id,
      c.type,
      c.name,
      c.avatar_url,
      CASE 
        WHEN c.type = 'direct' THEN u.username
        ELSE c.name
      END AS other_username,
      CASE 
        WHEN c.type = 'direct' THEN u.id
        ELSE NULL
      END AS other_user_id,
      CASE
        WHEN c.type = 'direct' THEN u.avatar_url
        ELSE c.avatar_url
      END AS other_avatar_url,
      m.text AS last_message,
      m.created_at AS last_message_at,
      m.sender_id AS last_message_sender,
      (
        SELECT COUNT(*) FROM messages unread_message
        LEFT JOIN message_receipts receipt
          ON receipt.message_id=unread_message.id AND receipt.user_id=$1
        WHERE unread_message.chat_id = c.id
        AND unread_message.sender_id != $1
        AND COALESCE(receipt.status, 'sent') != 'read'
        AND unread_message.deleted_for_everyone = false
        AND NOT EXISTS (
          SELECT 1 FROM message_user_deletions deletion
          WHERE deletion.message_id=unread_message.id AND deletion.user_id=$1
        )
      ) AS unread_count
    FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
    LEFT JOIN chat_members cm2 ON cm2.chat_id = c.id 
      AND cm2.user_id != $1 
      AND c.type = 'direct'
    LEFT JOIN users u ON u.id = cm2.user_id
    LEFT JOIN LATERAL (
      SELECT text, created_at, sender_id 
      FROM messages 
      WHERE chat_id = c.id 
      AND deleted_for_everyone = false
      AND NOT EXISTS (
        SELECT 1 FROM message_user_deletions deletion
        WHERE deletion.message_id=messages.id AND deletion.user_id=$1
      )
      ORDER BY created_at DESC 
      LIMIT 1
    ) m ON true
    GROUP BY c.id, c.type, c.name, c.avatar_url, u.username, u.id, u.avatar_url, m.text, m.created_at, m.sender_id
    ORDER BY m.created_at DESC NULLS LAST`,
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
    "SELECT push_token FROM device_tokens WHERE user_id = $1 AND provider = 'expo'",
    [userId]
  );
  return result.rows.map((r) => r.push_token);
}

async function getGroupMemberTokens(chatId, excludeUserId) {
  const result = await pool.query(
    `SELECT dt.push_token FROM device_tokens dt
     JOIN chat_members cm ON cm.user_id = dt.user_id
     WHERE cm.chat_id = $1 AND dt.user_id != $2 AND dt.provider = 'expo'`,
    [chatId, excludeUserId]
  );
  return result.rows.map((r) => r.push_token);
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
