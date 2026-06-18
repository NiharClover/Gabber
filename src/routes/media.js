const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { requireAuth } = require("../middleware/auth");
const { randomUUID } = require("crypto");

const router = express.Router();
router.use(requireAuth);

const uploadDir = path.join(__dirname, "../../uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

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
    const filepath = path.join(uploadDir, filename);

    const info = await sharp(req.file.buffer)
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 75, progressive: true })
      .toFile(filepath);

    const sizeKB = Math.round(info.size / 1024);
    const url = `${req.protocol}://${req.get("host")}/uploads/${filename}`;

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
    const filepath = path.join(uploadDir, filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      console.log(`[media] View-once deleted: ${filename}`);
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[media] Delete error:", err.message);
    res.status(500).json({ error: "Failed to delete." });
  }
});

module.exports = router;