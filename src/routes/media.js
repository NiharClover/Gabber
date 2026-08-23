const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { requireAuth } = require("../middleware/auth");
const { randomUUID } = require("crypto");
const { uploadBuffer, deleteFile } = require("../services/storage");
const pool = require("../db/pool");

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only images allowed."));
  },
});

// POST /api/media/upload
router.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  try {
    const viewOnce = req.body.viewOnce === "true";
    const filename = `${Date.now()}_${randomUUID().split("-")[0]}.jpg`;

    // Compress in memory first, THEN hand the buffer to storage — works
    // identically whether storage ends up being local disk or S3.
    const compressed = await sharp(req.file.buffer)
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 75, progressive: true })
      .toBuffer();

    const sizeKB = Math.round(compressed.length / 1024);
    const url = await uploadBuffer(compressed, "", filename, "image/jpeg", req);

    console.log(`[media] Saved: ${filename} (${sizeKB}KB) by ${req.user.username}${viewOnce ? " [view-once]" : ""}`);

    res.json({ success: true, url, filename, sizeKB, viewOnce });
  } catch (err) {
    console.error("[media] Error:", err.message);
    res.status(500).json({ error: "Upload failed." });
  }
});

// POST /api/media/viewed/:filename — delete view-once after viewing
router.post("/viewed/:filename", async (req, res) => {
  const { filename } = req.params;
  if (filename.includes("/") || filename.includes("..")) {
    return res.status(400).json({ error: "Invalid filename." });
  }
  try {
    // SECURITY FIX: this previously deleted ANY uploaded file by filename
    // with no check that the requester uploaded it, received it, or that
    // it's even view-once media — any authenticated user could delete any
    // other user's photos by guessing/enumerating filenames. Look up the
    // message that actually references this filename and confirm the
    // requester belongs to that chat before deleting anything.
    const msg = await pool.query(
      `SELECT chat_id FROM messages
       WHERE text LIKE '[view-once]%' AND text LIKE '%|' || $1
       LIMIT 1`,
      [filename]
    );
    if (!msg.rows[0]) {
      return res.status(404).json({ error: "File not found." });
    }
    const membership = await pool.query(
      "SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2",
      [msg.rows[0].chat_id, req.user.userId]
    );
    if (!membership.rows[0]) {
      return res.status(403).json({ error: "Not authorized to delete this file." });
    }

    await deleteFile(filename, "");
    console.log(`[media] View-once deleted: ${filename} by ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[media] Delete error:", err.message);
    res.status(500).json({ error: "Failed to delete." });
  }
});

module.exports = router;