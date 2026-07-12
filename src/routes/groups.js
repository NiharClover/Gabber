const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const { randomUUID } = require("crypto");
const multer = require("multer");
const path = require("path");
const { uploadBuffer } = require("../services/storage");

const router = express.Router();
router.use(requireAuth);

const groupAvatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// POST /api/groups — create group
router.post("/", async (req, res) => {
  const { name, memberIds } = req.body;
  if (!name || !memberIds?.length) return res.status(400).json({ error: "name and memberIds required." });
  try {
    const chatId = `chat_${randomUUID().split("-")[0]}`;
    await pool.query("INSERT INTO chats (id, type, name) VALUES ($1, 'group', $2)", [chatId, name]);
    const allMembers = [req.user.userId, ...memberIds.filter(id => id !== req.user.userId)];
    for (const userId of allMembers) {
      const role = userId === req.user.userId ? "admin" : "member";
      await pool.query("INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [chatId, userId, role]);
    }
    res.json({ success: true, chatId, name });
  } catch (err) {
    console.error("[groups]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/groups/:chatId — get group info + members
router.get("/:chatId", async (req, res) => {
  try {
    const group = await pool.query(
      "SELECT id, name, type, description, avatar_url, created_at FROM chats WHERE id = $1 AND type = 'group'",
      [req.params.chatId]
    );
    if (!group.rows[0]) return res.status(404).json({ error: "Group not found." });

    const members = await pool.query(
      `SELECT cm.user_id, cm.role, u.username, u.phone, u.avatar_url
       FROM chat_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.chat_id = $1
       ORDER BY cm.role DESC, u.username ASC`,
      [req.params.chatId]
    );

    res.json({ group: group.rows[0], members: members.rows });
  } catch (err) {
    console.error("[groups get]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// PATCH /api/groups/:chatId — update name/description (admin only)
router.patch("/:chatId", async (req, res) => {
  const { name, description } = req.body;
  try {
    const adminCheck = await pool.query(
      "SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2",
      [req.params.chatId, req.user.userId]
    );
    if (adminCheck.rows[0]?.role !== "admin") return res.status(403).json({ error: "Admin only." });
    await pool.query(
      "UPDATE chats SET name = COALESCE($1, name), description = COALESCE($2, description) WHERE id = $3",
      [name || null, description || null, req.params.chatId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("[groups patch]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/groups/:chatId/avatar — upload group photo (admin only)
router.post("/:chatId/avatar", groupAvatarUpload.single("avatar"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file." });
  try {
    const adminCheck = await pool.query(
      "SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2",
      [req.params.chatId, req.user.userId]
    );
    if (adminCheck.rows[0]?.role !== "admin") return res.status(403).json({ error: "Admin only." });
    // Same localhost-URL bug as profile.js avatars — fixed via uploadBuffer().
    const filename = `group_${randomUUID()}${path.extname(req.file.originalname)}`;
    const url = await uploadBuffer(req.file.buffer, "avatars", filename, req.file.mimetype, req);
    await pool.query("UPDATE chats SET avatar_url = $1 WHERE id = $2", [url, req.params.chatId]);
    res.json({ success: true, url });
  } catch (err) {
    console.error("[groups avatar]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/groups/:chatId/members — add member (admin only)
router.post("/:chatId/members", async (req, res) => {
  const { userId } = req.body;
  try {
    const adminCheck = await pool.query(
      "SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2",
      [req.params.chatId, req.user.userId]
    );
    if (adminCheck.rows[0]?.role !== "admin") return res.status(403).json({ error: "Admin only." });
    await pool.query(
      "INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING",
      [req.params.chatId, userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/groups/:chatId/members/:userId — remove member (admin only)
router.delete("/:chatId/members/:userId", async (req, res) => {
  try {
    const adminCheck = await pool.query(
      "SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2",
      [req.params.chatId, req.user.userId]
    );
    if (adminCheck.rows[0]?.role !== "admin") return res.status(403).json({ error: "Admin only." });

    // Removing yourself through this route bypassed the dedicated /leave
    // flow (no cleanup semantics, and would let a group end up with zero
    // members if it was 1:1). Admins leave via /leave like anyone else.
    if (req.params.userId === req.user.userId) {
      return res.status(400).json({ error: "Use the leave-group action to remove yourself." });
    }

    await pool.query(
      "DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2",
      [req.params.chatId, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// PATCH /api/groups/:chatId/members/:userId/role — make/remove admin
router.patch("/:chatId/members/:userId/role", async (req, res) => {
  const { role } = req.body;
  if (!["admin", "member"].includes(role)) return res.status(400).json({ error: "Invalid role." });
  try {
    const adminCheck = await pool.query(
      "SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2",
      [req.params.chatId, req.user.userId]
    );
    if (adminCheck.rows[0]?.role !== "admin") return res.status(403).json({ error: "Admin only." });

    // Prevent a group being left with zero admins — e.g. the only admin
    // demoting themselves with no one else able to manage the group.
    if (role === "member" && req.params.userId === req.user.userId) {
      const adminCount = await pool.query(
        "SELECT COUNT(*) AS cnt FROM chat_members WHERE chat_id = $1 AND role = 'admin'",
        [req.params.chatId]
      );
      if (parseInt(adminCount.rows[0].cnt, 10) <= 1) {
        return res.status(400).json({ error: "Promote another member to admin first — a group needs at least one admin." });
      }
    }

    await pool.query(
      "UPDATE chat_members SET role = $1 WHERE chat_id = $2 AND user_id = $3",
      [role, req.params.chatId, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/groups/:chatId/leave — leave group
router.delete("/:chatId/leave", async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2",
      [req.params.chatId, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;