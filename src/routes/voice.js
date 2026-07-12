const express = require("express");
const multer = require("multer");
const { requireAuth } = require("../middleware/auth");
const { randomUUID } = require("crypto");
const { uploadBuffer } = require("../services/storage");

const router = express.Router();
router.use(requireAuth);

// Switched from disk storage to memory storage so the buffer can go through
// uploadBuffer() (S3 or local disk depending on config) instead of always
// writing straight to local disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }, // 16MB max
  fileFilter: (req, file, cb) => {
    const allowed = ["audio/m4a", "audio/mp4", "audio/mpeg", "audio/wav", "audio/aac", "audio/x-m4a"];
    if (allowed.includes(file.mimetype) || file.originalname.endsWith(".m4a")) {
      cb(null, true);
    } else {
      cb(new Error("Only audio files allowed."));
    }
  },
});

// POST /api/voice/upload
router.post("/upload", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file uploaded." });

  try {
    const filename = `voice_${Date.now()}_${randomUUID().split("-")[0]}.m4a`;
    const url = await uploadBuffer(req.file.buffer, "voice", filename, req.file.mimetype || "audio/m4a", req);
    const duration = req.body.duration ? parseInt(req.body.duration) : 0;

    console.log(`[voice] Uploaded: ${filename} (${duration}s) by ${req.user.username}`);
    res.json({ success: true, url, filename, duration });
  } catch (err) {
    console.error("[voice] Error:", err.message);
    res.status(500).json({ error: "Upload failed." });
  }
});

module.exports = router;