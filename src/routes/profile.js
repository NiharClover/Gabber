const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const multer = require("multer");
const path = require("path");
const { randomUUID } = require("crypto");

const router = express.Router();
router.use(requireAuth);

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/avatars/"),
  filename: (req, file, cb) => cb(null, `avatar_${randomUUID()}${path.extname(file.originalname)}`),
});
const avatarUpload = multer({ storage: avatarStorage, limits: { fileSize: 5 * 1024 * 1024 } });

// GET /api/profile — own profile
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, username, phone, about, avatar_url, email, created_at FROM users WHERE id = $1",
      [req.user.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "User not found." });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/profile/:userId — public profile
router.get("/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, username, phone, about, avatar_url, created_at FROM users WHERE id = $1",
      [req.params.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "User not found." });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// PATCH /api/profile — update name, about, email
router.patch("/", async (req, res) => {
  const { username, about, email } = req.body;
  try {
    await pool.query(
      `UPDATE users SET 
        username = COALESCE($1, username),
        about = COALESCE($2, about),
        email = COALESCE($3, email)
       WHERE id = $4`,
      [username || null, about || null, email || null, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/profile/avatar
router.post("/avatar", avatarUpload.single("avatar"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  try {
    const url = `${process.env.BASE_URL || "http://localhost:3000"}/uploads/avatars/${req.file.filename}`;
    await pool.query("UPDATE users SET avatar_url = $1 WHERE id = $2", [url, req.user.userId]);
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;