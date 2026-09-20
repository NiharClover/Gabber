const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const { randomUUID } = require("crypto");
const multer = require("multer");
const path = require("path");
const sharp = require("sharp");
const { uploadBuffer } = require("../services/storage");
const { normalizeGroupCreationInput } = require("../utils/groupValidation");

const router = express.Router();
router.use(requireAuth);

// Same fix as profile.js avatars — fileFilter + sharp re-encode instead of
// accepting and storing any file type verbatim.
const groupAvatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only image files are allowed."));
  },
});

// POST /api/groups — create group
router.post("/", async (req, res) => {
  const input = normalizeGroupCreationInput(req.body);
  if (!input.ok) return res.status(400).json({ error: input.error });

  let client;
  try {
    client = await pool.connect();
    let resolvedMemberIds = input.memberIds;
    if (input.memberPhones.length > 0) {
      const users = await client.query(
        "SELECT id, phone FROM users WHERE phone::text = ANY($1::text[])",
        [input.memberPhones]
      );
      const idsByPhone = new Map(users.rows.map((user) => [user.phone, user.id]));
      const missingPhones = input.memberPhones.filter((phone) => !idsByPhone.has(phone));
      if (missingPhones.length > 0) {
        return res.status(400).json({
          error: `No Gabber account found for ${missingPhones.join(", ")}.`,
        });
      }
      resolvedMemberIds = [...resolvedMemberIds, ...users.rows.map((user) => user.id)];
    }

    const uniqueMemberIds = [...new Set(resolvedMemberIds)]
      .filter((userId) => userId !== req.user.userId);
    if (uniqueMemberIds.length === 0) {
      return res.status(400).json({ error: "Add at least one other Gabber user." });
    }

    const existingUsers = await client.query(
      "SELECT id FROM users WHERE id::text = ANY($1::text[])",
      [uniqueMemberIds]
    );
    const existingIds = new Set(existingUsers.rows.map((user) => user.id));
    const missingIds = uniqueMemberIds.filter((userId) => !existingIds.has(userId));
    if (missingIds.length > 0) {
      return res.status(400).json({ error: "One or more selected members no longer exist." });
    }
    const blocked = await client.query(
      `SELECT 1 FROM blocked_users
       WHERE (blocker_id=$1 AND blocked_id=ANY($2::varchar[]))
          OR (blocked_id=$1 AND blocker_id=ANY($2::varchar[])) LIMIT 1`,
      [req.user.userId, uniqueMemberIds]
    );
    if (blocked.rows[0]) return res.status(403).json({ error: "One or more selected users cannot be added." });

    const chatId = `chat_${randomUUID().split("-")[0]}`;
    await client.query("BEGIN");
    await client.query("INSERT INTO chats (id, type, name) VALUES ($1, 'group', $2)", [chatId, input.name]);
    const allMembers = [req.user.userId, ...uniqueMemberIds];
    for (const userId of allMembers) {
      const role = userId === req.user.userId ? "admin" : "member";
      await client.query("INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)", [chatId, userId, role]);
    }
    await client.query("COMMIT");
    res.status(201).json({ success: true, chatId, name: input.name });
  } catch (err) {
    await client?.query("ROLLBACK").catch(() => {});
    console.error("[groups]", err.message);
    res.status(500).json({ error: "Server error." });
  } finally {
    client?.release();
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

    // SECURITY FIX: this previously returned group info AND the full member
    // list — including phone numbers — to ANY authenticated user, not just
    // members of the group. Any logged-in user could enumerate group ids
    // and harvest every member's phone number.
    const membership = await pool.query(
      "SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2",
      [req.params.chatId, req.user.userId]
    );
    if (!membership.rows[0]) {
      return res.status(403).json({ error: "Not a member of this group." });
    }

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
    let compressed;
    try {
      compressed = await sharp(req.file.buffer)
        .resize({ width: 512, height: 512, fit: "cover" })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch {
      return res.status(400).json({ error: "That doesn't look like a valid image file." });
    }
    const filename = `group_${randomUUID()}.jpg`;
    const url = await uploadBuffer(compressed, "avatars", filename, "image/jpeg", req);
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
  if (typeof userId !== "string" || !userId) return res.status(400).json({ error: "userId is required." });
  try {
    const adminCheck = await pool.query(
      "SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2",
      [req.params.chatId, req.user.userId]
    );
    if (adminCheck.rows[0]?.role !== "admin") return res.status(403).json({ error: "Admin only." });
    if (userId === req.user.userId) return res.status(400).json({ error: "You are already a member." });
    const candidate = await pool.query("SELECT id FROM users WHERE id=$1", [userId]);
    if (!candidate.rows[0]) return res.status(404).json({ error: "User not found." });
    const blocked = await pool.query(
      `SELECT 1 FROM blocked_users WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)`,
      [req.user.userId, userId]
    );
    if (blocked.rows[0]) return res.status(403).json({ error: "This user cannot be added." });
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
