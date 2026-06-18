const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  createGroupChat,
  getGroupInfo,
  addGroupMember,
  getUserByPhone,
} = require("../db/queries");

const router = express.Router();
router.use(requireAuth);
const multer = require("multer");
const path = require("path");
const { randomUUID } = require("crypto");

// POST /api/groups — create a group
// Body: { name: "Friends", memberPhones: ["+919876543210"] }
router.post("/", async (req, res) => {
  const { name, memberPhones } = req.body;

  if (!name || !memberPhones || !Array.isArray(memberPhones)) {
    return res.status(400).json({ error: "name and memberPhones array required." });
  }

  try {
    // Resolve phone numbers to user IDs
    const memberIds = [];
    const notFound = [];

    for (const phone of memberPhones) {
      const user = await getUserByPhone(phone);
      if (user) memberIds.push(user.id);
      else notFound.push(phone);
    }

    if (notFound.length > 0) {
      return res.status(400).json({
        error: `These numbers are not on Gabber: ${notFound.join(", ")}`,
      });
    }

    const chatId = await createGroupChat(name, req.user.userId, memberIds);
    const group = await getGroupInfo(chatId);

    res.json({ success: true, group });
  } catch (err) {
    console.error("[groups] Error:", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/groups/:chatId — get group info + members
router.get("/:chatId", async (req, res) => {
  try {
    const group = await getGroupInfo(req.params.chatId);
    if (!group) return res.status(404).json({ error: "Group not found." });
    res.json({ group });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/groups/:chatId/members — add a member by phone
// Body: { phone: "+919876543210" }
router.post("/:chatId/members", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "phone required." });

  try {
    const user = await getUserByPhone(phone);
    if (!user) return res.status(404).json({ error: "User not on Gabber." });

    await addGroupMember(req.params.chatId, user.id);
    res.json({ success: true, userId: user.id, username: user.username });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});
const groupAvatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/avatars/"),
  filename: (req, file, cb) => cb(null, `group_${randomUUID()}${path.extname(file.originalname)}`),
});
const groupAvatarUpload = multer({ storage: groupAvatarStorage, limits: { fileSize: 5 * 1024 * 1024 } });

// PATCH /api/groups/:chatId — update group info (admin only)
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
    const url = `${process.env.BASE_URL || "http://localhost:3000"}/uploads/avatars/${req.file.filename}`;
    await pool.query("UPDATE chats SET avatar_url = $1 WHERE id = $2", [url, req.params.chatId]);
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// PATCH /api/groups/:chatId/members/:userId/role — make admin / remove admin
router.patch("/:chatId/members/:userId/role", async (req, res) => {
  const { role } = req.body; // 'admin' or 'member'
  try {
    const adminCheck = await pool.query(
      "SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2",
      [req.params.chatId, req.user.userId]
    );
    if (adminCheck.rows[0]?.role !== "admin") return res.status(403).json({ error: "Admin only." });
    await pool.query(
      "UPDATE chat_members SET role = $1 WHERE chat_id = $2 AND user_id = $3",
      [role, req.params.chatId, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;