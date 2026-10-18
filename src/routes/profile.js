const express = require("express");
const { requireAuth } = require("../middleware/auth");
const pool = require("../db/pool");
const multer = require("multer");
const path = require("path");
const sharp = require("sharp");
const { randomUUID } = require("crypto");
const { uploadBuffer } = require("../services/storage");

const router = express.Router();
router.use(requireAuth);

// SECURITY FIX: this previously had NO fileFilter and never ran the upload
// through sharp — any file type (a disguised .html/.svg with embedded
// script, an executable, anything) would be accepted, saved with whatever
// extension the client's original filename had, and served back statically.
// A malicious "avatar.svg" containing a <script> tag or "avatar.html" could
// have been stored and then loaded directly by anyone with the URL.
// Restricting to real image mimetypes AND re-encoding through sharp (same
// pattern already used in media.js) closes this off — sharp will refuse to
// process anything that isn't actually a decodable image, regardless of
// what extension or Content-Type the upload claimed.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only image files are allowed."));
  },
});

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
      `SELECT u.id, u.username, u.phone, u.about, u.avatar_url, u.created_at
       FROM users u WHERE u.id=$1
         AND NOT EXISTS (
           SELECT 1 FROM blocked_users bu
           WHERE (bu.blocker_id=$1 AND bu.blocked_id=$2)
              OR (bu.blocker_id=$2 AND bu.blocked_id=$1)
         )
         AND ($1=$2 OR EXISTS (
           SELECT 1 FROM chat_members mine
           JOIN chat_members peer ON peer.chat_id=mine.chat_id
           WHERE mine.user_id=$2 AND peer.user_id=$1
         ))`,
      [req.params.userId, req.user.userId]
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
  const hasUsername = username !== undefined;
  const hasAbout = about !== undefined;
  const hasEmail = email !== undefined;
  const nextUsername = typeof username === "string" ? username.trim() : "";
  const nextAbout = typeof about === "string" ? about.trim() : "";
  const nextEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!hasUsername && !hasAbout && !hasEmail) return res.status(400).json({ error: "Nothing to update." });
  if (hasUsername && (nextUsername.length < 2 || nextUsername.length > 50)) {
    return res.status(400).json({ error: "Name must be between 2 and 50 characters." });
  }
  if (hasAbout && nextAbout.length > 200) return res.status(400).json({ error: "About must be 200 characters or fewer." });
  if (hasEmail && nextEmail && (nextEmail.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail))) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  try {
    await pool.query(
      `UPDATE users SET
        username = CASE WHEN $1 THEN $2 ELSE username END,
        about = CASE WHEN $3 THEN $4 ELSE about END,
        email = CASE WHEN $5 THEN NULLIF($6, '') ELSE email END
       WHERE id = $7`,
      [hasUsername, nextUsername, hasAbout, nextAbout, hasEmail, nextEmail, req.user.userId]
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
    let compressed;
    try {
      compressed = await sharp(req.file.buffer)
        .resize({ width: 512, height: 512, fit: "cover" })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch {
      return res.status(400).json({ error: "That doesn't look like a valid image file." });
    }

    const filename = `avatar_${randomUUID()}.jpg`; // always .jpg now — re-encoded, so the original extension is irrelevant and never trusted
    const url = await uploadBuffer(compressed, "avatars", filename, "image/jpeg", req);
    await pool.query("UPDATE users SET avatar_url = $1 WHERE id = $2", [url, req.user.userId]);
    res.json({ success: true, url });
  } catch (err) {
    console.error("[profile avatar]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;
