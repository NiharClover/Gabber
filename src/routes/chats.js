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
    if (typeof q !== "string" || q.trim().length < 1) return res.json({ messages: [], chats: [], groups: [] });
    const search = q.trim().slice(0, 100).replace(/[\\%_]/g, "\\$&");

    // Search messages
    const messages = await pool.query(
      `SELECT m.*, u.username AS sender_name, c.type AS chat_type,
              c.name AS group_name, peer.id AS other_user_id,
              peer.username AS other_username
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       JOIN chats c ON c.id = m.chat_id
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1
       LEFT JOIN LATERAL (
         SELECT pu.id, pu.username FROM chat_members pcm
         JOIN users pu ON pu.id=pcm.user_id
         WHERE pcm.chat_id=c.id AND pcm.user_id!=$1 AND c.type='direct'
         LIMIT 1
       ) peer ON TRUE
       WHERE m.text ILIKE $2 ESCAPE '\\'
       AND m.deleted_for_everyone = false
       AND NOT EXISTS (
         SELECT 1 FROM message_user_deletions d
         WHERE d.message_id=m.id AND d.user_id=$1
       )
       AND m.text NOT LIKE '[%'
       ORDER BY m.created_at DESC
       LIMIT 30`,
      [req.user.userId, `%${search}%`]
    );

    // Search contacts — all users matching query
    const chats = await pool.query(
      `SELECT DISTINCT u.id, u.username, u.avatar_url
       FROM users u
       WHERE u.id != $1
       AND u.username ILIKE $2 ESCAPE '\\'
       AND NOT EXISTS (
         SELECT 1 FROM blocked_users bu
         WHERE (bu.blocker_id=$1 AND bu.blocked_id=u.id)
            OR (bu.blocker_id=u.id AND bu.blocked_id=$1)
       )
       LIMIT 10`,
      [req.user.userId, `%${search}%`]
    );

    // Search groups user is a member of
    const groups = await pool.query(
      `SELECT c.id, c.name, c.type, COUNT(cm2.user_id) AS member_count
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
       JOIN chat_members cm2 ON cm2.chat_id = c.id
       WHERE c.type = 'group'
       AND c.name ILIKE $2 ESCAPE '\\'
       GROUP BY c.id, c.name, c.type
       LIMIT 10`,
      [req.user.userId, `%${search}%`]
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

    // SECURITY FIX: this previously returned every message in a chat with
    // no check that the caller actually belongs to it — any authenticated
    // user could read any conversation's full history just by knowing (or
    // guessing/enumerating) its chatId. Membership must be verified first.
    const membership = await pool.query(
      "SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2",
      [chatId, req.user.userId]
    );
    if (!membership.rows[0]) {
      return res.status(403).json({ error: "Not a member of this chat." });
    }

    const result = await pool.query(
      `SELECT m.*, u.username AS sender_name
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.chat_id = $1
       AND m.deleted_for_everyone = false
       AND NOT EXISTS (
         SELECT 1 FROM message_user_deletions d
         WHERE d.message_id=m.id AND d.user_id=$2
       )
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
    // SECURITY FIX: same membership gap as GET /:chatId/messages above —
    // previously anyone could mark any chat's messages as read, with no
    // check they're actually part of that chat.
    const membership = await pool.query(
      "SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2",
      [req.params.chatId, req.user.userId]
    );
    if (!membership.rows[0]) {
      return res.status(403).json({ error: "Not a member of this chat." });
    }

    await pool.query(
      `INSERT INTO message_receipts (message_id, user_id, status, delivered_at, read_at)
       SELECT id, $2, 'read', NOW(), NOW() FROM messages
       WHERE chat_id=$1 AND sender_id!=$2
       ON CONFLICT (message_id, user_id) DO UPDATE
       SET status='read', delivered_at=COALESCE(message_receipts.delivered_at, NOW()), read_at=NOW()`,
      [req.params.chatId, req.user.userId]
    );
    await pool.query(
      `UPDATE messages m SET status=summary.status
       FROM (
         SELECT r.message_id,
           CASE
             WHEN COUNT(*) FILTER (WHERE r.status='read')=COUNT(*) THEN 'read'
             WHEN COUNT(*) FILTER (WHERE r.status IN ('delivered','read'))=COUNT(*) THEN 'delivered'
             ELSE 'sent'
           END AS status
         FROM message_receipts r
         JOIN messages target ON target.id=r.message_id AND target.chat_id=$1
         GROUP BY r.message_id
       ) summary
       WHERE m.id=summary.message_id`,
      [req.params.chatId]
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
    if (otherUserId === req.user.userId) return res.status(400).json({ error: "Cannot create a chat with yourself." });

    const target = await pool.query("SELECT id FROM users WHERE id=$1", [otherUserId]);
    if (!target.rows[0]) return res.status(404).json({ error: "User not found." });
    const blocked = await pool.query(
      `SELECT 1 FROM blocked_users
       WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)`,
      [req.user.userId, otherUserId]
    );
    if (blocked.rows[0]) return res.status(403).json({ error: "Cannot start this chat." });

    const chatId = await getOrCreateDirectChat(req.user.userId, otherUserId);
    res.json({ chatId });
  } catch (err) {
    console.error("[chats] Error:", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;
