const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { requireAuth } = require("../middleware/auth");
const { createHash, randomUUID } = require("crypto");
const { uploadBuffer, deleteFile } = require("../services/storage");
const pool = require("../db/pool");

const router = express.Router();
router.use(requireAuth);

async function differenceHash(imageBuffer) {
  const metadata = await sharp(imageBuffer).metadata();
  const { data: pixels, info } = await sharp(imageBuffer)
    .resize(9, 8, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = 0n;
  const totals = [0, 0, 0];
  for (let i = 0; i < pixels.length; i += info.channels) {
    totals[0] += pixels[i];
    totals[1] += pixels[i + 1];
    totals[2] += pixels[i + 2];
  }
  const luminance = (offset) => (0.299 * pixels[offset]) + (0.587 * pixels[offset + 1]) + (0.114 * pixels[offset + 2]);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = ((y * 9) + x) * info.channels;
      const right = left + info.channels;
      bits = (bits << 1n) | (luminance(left) > luminance(right) ? 1n : 0n);
    }
  }
  const pixelCount = 9 * 8;
  const averageColor = totals.map((total) => {
    const quantized = Math.min(255, Math.round((total / pixelCount) / 16) * 16);
    return quantized.toString(16).padStart(2, "0");
  }).join("");
  const aspectBucket = Math.round(((metadata.width || 1) / (metadata.height || 1)) * 100)
    .toString(16)
    .padStart(3, "0");
  return `${bits.toString(16).padStart(16, "0")}${averageColor}${aspectBucket}`;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only images allowed."));
  },
});

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF documents are allowed."));
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

    // Every accepted image is decoded and re-encoded by sharp. The stored
    // file therefore cannot retain an uploaded HTML/SVG/script payload. The
    // hashes provide exact and visually-stable identifiers without embedding
    // a hidden user watermark in the user's photo.
    const contentHash = createHash("sha256").update(compressed).digest("hex");
    const visualHash = await differenceHash(compressed);

    const sizeKB = Math.round(compressed.length / 1024);
    const url = await uploadBuffer(compressed, "", filename, "image/jpeg", req);

    const existing = await pool.query(
      `SELECT id, COALESCE(origin_asset_id, id) AS root_asset_id
       FROM media_assets
       WHERE sha256=$1 OR perceptual_hash=$2
       ORDER BY (sha256=$1) DESC, created_at ASC
       LIMIT 1`,
      [contentHash, visualHash]
    );
    const assetId = `asset_${randomUUID().split("-")[0]}`;
    const originAssetId = existing.rows[0]?.root_asset_id || null;
    await pool.query(
      `INSERT INTO media_assets
       (id,uploader_id,origin_asset_id,media_type,url,filename,sha256,perceptual_hash,scan_status,scan_details)
       VALUES ($1,$2,$3,'image',$4,$5,$6,$7,'sanitized',$8::jsonb)`,
      [assetId, req.user.userId, originAssetId, url, filename, contentHash, visualHash,
        JSON.stringify({ decoder: "sharp", reencodedAs: "image/jpeg" })]
    );

    console.log(`[media] Saved: ${filename} (${sizeKB}KB) by ${req.user.username}${viewOnce ? " [view-once]" : ""}`);

    res.json({
      success: true, url, filename, sizeKB, viewOnce, assetId,
      provenance: { knownCopy: Boolean(originAssetId) },
      safety: { status: "sanitized" },
    });
  } catch (err) {
    console.error("[media] Error:", err.message);
    res.status(500).json({ error: "Upload failed." });
  }
});

// POST /api/media/document — PDF chat attachment (20 MB maximum)
router.post("/document", documentUpload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF uploaded." });
  try {
    const filename = `${Date.now()}_${randomUUID().split("-")[0]}.pdf`;
    const originalName = String(req.file.originalname || "Document.pdf")
      .replace(/[\r\n|]/g, "_")
      .slice(0, 180);
    const url = await uploadBuffer(
      req.file.buffer,
      "documents",
      filename,
      "application/pdf",
      req
    );
    res.json({
      success: true,
      url,
      filename,
      originalName,
      bytes: req.file.size,
      mimeType: "application/pdf",
    });
  } catch (err) {
    console.error("[media:document]", err.message);
    res.status(500).json({ error: "PDF upload failed." });
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
      `SELECT id, chat_id, sender_id FROM messages
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
    if (msg.rows[0].sender_id === req.user.userId) {
      return res.status(403).json({ error: "The sender cannot consume their own view-once message." });
    }

    await pool.query(
      `INSERT INTO view_once_receipts (message_id,user_id,viewed_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (message_id,user_id) DO NOTHING`,
      [msg.rows[0].id, req.user.userId]
    );

    const remaining = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM chat_members cm
       WHERE cm.chat_id=$1 AND cm.user_id!=$2
         AND NOT EXISTS (
           SELECT 1 FROM view_once_receipts vor
           WHERE vor.message_id=$3 AND vor.user_id=cm.user_id
         )`,
      [msg.rows[0].chat_id, msg.rows[0].sender_id, msg.rows[0].id]
    );
    if (remaining.rows[0].count === 0) {
      await pool.query("UPDATE messages SET viewed_at=COALESCE(viewed_at,NOW()) WHERE id=$1", [msg.rows[0].id]);
      await deleteFile(filename, "");
      console.log(`[media] View-once deleted after all recipients viewed: ${filename}`);
    }
    res.json({ success: true, consumed: true });
  } catch (err) {
    console.error("[media] Delete error:", err.message);
    res.status(500).json({ error: "Failed to delete." });
  }
});

module.exports = router;
