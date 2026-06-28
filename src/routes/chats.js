const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { getUserChats, getChatMessages, getOrCreateDirectChat } = require("../db/queries");
const pool = require("../db/pool");
const router = express.Router();

// All routes require a valid JWT
router.use(requireAuth);

// ─── GET /api/chats ───────────────────────────────────────────────────────────
// Get all chats for the logged-in user
router.get("/", async (req, res) => {
  try {
    const chats = await getUserChats(req.user.userId);
    res.json({ chats });
  } catch (err) {
    console.error("[chats] Error:", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// ─── GET /api/chats/search?q=hello ───────────────────────────────────────────
// IMPORTANT: must be defined BEFORE /:chatId routes so Express doesn't treat
// the literal string "search" as a chatId parameter
router.get("/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 1) return res.json({ messages: [], chats: [], groups: [] });

    // Search messages
    const messages = await pool.query(
      `SELECT m.*, u.username AS sender_name, c.type AS chat_type
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       JOIN chats c ON c.id = m.chat_id
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1
       WHERE m.text ILIKE $2
       AND m.deleted_for_everyone = false
       AND NOT (m.deleted_for_sender = true AND m.sender_id = $1)
       AND m.text NOT LIKE '[%'
       ORDER BY m.created_at DESC
       LIMIT 30`,
      [req.user.userId, `%${q.trim()}%`]
    );

    // Search contacts — all users matching query
    const chats = await pool.query(
      `SELECT DISTINCT u.id, u.username, u.phone
       FROM users u
       WHERE u.id != $1
       AND u.username ILIKE $2
       LIMIT 10`,
      [req.user.userId, `%${q.trim()}%`]
    );

    // Search groups user is a member of
    const groups = await pool.query(
      `SELECT c.id, c.name, c.type, COUNT(cm2.user_id) AS member_count
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
       JOIN chat_members cm2 ON cm2.chat_id = c.id
       WHERE c.type = 'group'
       AND c.name ILIKE $2
       GROUP BY c.id, c.name, c.type
       LIMIT 10`,
      [req.user.userId, `%${q.trim()}%`]
    );

    res.json({ messages: messages.rows, chats: chats.rows, groups: groups.rows });
  } catch (err) {
    console.error("[search]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// ─── GET /api/chats/:chatId/messages ─────────────────────────────────────────
// Load full chat history for a given chat
router.get("/:chatId/messages", async (req, res) => {
  try {
    const { chatId } = req.params;
    const result = await pool.query(
      `SELECT m.*, u.username AS sender_name
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.chat_id = $1
       AND m.deleted_for_everyone = false
       AND NOT (m.deleted_for_sender = true AND m.sender_id = $2)
       ORDER BY m.created_at ASC`,
      [chatId, req.user.userId]
    );
    res.json({ messages: result.rows });
  } catch (err) {
    console.error("[messages] Error:", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// ─── POST /api/chats/:chatId/read ─────────────────────────────────────────────
// Mark all unread messages in a chat as read (called when user opens a chat)
router.post("/:chatId/read", async (req, res) => {
  try {
    await pool.query(
      `UPDATE messages SET status = 'read'
       WHERE chat_id = $1 
       AND sender_id != $2 
       AND status != 'read'`,
      [req.params.chatId, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// ─── POST /api/chats ──────────────────────────────────────────────────────────
// Start or get an existing direct chat
// Body: { otherUserId: "user_abc" }
router.post("/", async (req, res) => {
  try {
    const { otherUserId } = req.body;
    if (!otherUserId) return res.status(400).json({ error: "otherUserId required." });

    const chatId = await getOrCreateDirectChat(req.user.userId, otherUserId);
    res.json({ chatId });
  } catch (err) {
    console.error("[chats] Error:", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;