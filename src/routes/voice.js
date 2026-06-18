const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { requireAuth } = require("../middleware/auth");
const { randomUUID } = require("crypto");

const router = express.Router();
router.use(requireAuth);

const uploadDir = path.join(__dirname, "../../uploads/voice");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const name = `voice_${Date.now()}_${randomUUID().split("-")[0]}.m4a`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
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
router.post("/upload", upload.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file uploaded." });

  const url = `${req.protocol}://${req.get("host")}/uploads/voice/${req.file.filename}`;
  const duration = req.body.duration ? parseInt(req.body.duration) : 0;

  console.log(`[voice] Uploaded: ${req.file.filename} (${duration}s) by ${req.user.username}`);
  res.json({ success: true, url, filename: req.file.filename, duration });
});

module.exports = router;