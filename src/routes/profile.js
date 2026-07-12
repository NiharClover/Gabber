const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const multer = require("multer");
const path = require("path");
const { randomUUID } = require("crypto");
const { uploadBuffer } = require("../services/storage");

const router = express.Router();
router.use(requireAuth);

// Memory storage — needed so we have the raw buffer to hand to
// uploadBuffer() (which goes to S3 or local disk depending on config).
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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
    // Previously built the URL from `process.env.BASE_URL || "http://localhost:3000"`.
    // BASE_URL was never actually set in .env, so this ALWAYS returned
    // "http://localhost:3000/..." — which on a phone means the phone itself,
    // not the dev machine, so the avatar silently failed to load. uploadBuffer()
    // builds the URL from the real request host (or a real S3/CDN URL).
    const filename = `avatar_${randomUUID()}${path.extname(req.file.originalname)}`;
    const url = await uploadBuffer(req.file.buffer, "avatars", filename, req.file.mimetype, req);
    await pool.query("UPDATE users SET avatar_url = $1 WHERE id = $2", [url, req.user.userId]);
    res.json({ success: true, url });
  } catch (err) {
    console.error("[profile avatar]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;