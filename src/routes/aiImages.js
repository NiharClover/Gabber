const axios = require("axios");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { createHash, randomUUID } = require("crypto");
const { rateLimit } = require("express-rate-limit");
const { requireAuth } = require("../middleware/auth");
const { uploadBuffer } = require("../services/storage");
const pool = require("../db/pool");

const router = express.Router();
router.use(requireAuth);

const generationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user.userId,
  message: { error: "AI image limit reached. Please try again later." },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) callback(null, true);
    else callback(new Error("Only JPEG, PNG, or WebP images allowed."));
  },
});

function serviceErrorMessage(responseData) {
  try {
    const parsed = JSON.parse(Buffer.from(responseData).toString("utf8"));
    return typeof parsed.detail === "string" ? parsed.detail : null;
  } catch {
    return null;
  }
}

router.post("/generate", generationLimiter, upload.single("reference"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "A reference selfie is required." });
  const prompt = typeof req.body.prompt === "string" ? req.body.prompt.trim() : "";
  if (prompt.length < 3 || prompt.length > 500) return res.status(400).json({ error: "Prompt must contain 3 to 500 characters." });
  if (req.body.consentConfirmed !== "true") {
    return res.status(400).json({ error: "Confirm that the reference is you or that you have permission." });
  }

  const serviceUrl = (process.env.AI_IMAGE_SERVICE_URL || "http://127.0.0.1:8010").replace(/\/$/, "");
  try {
    const form = new FormData();
    form.append("reference", new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || "reference.jpg");
    form.append("prompt", prompt);
    form.append("consent_confirmed", "true");
    if (req.body.negativePrompt) form.append("negative_prompt", String(req.body.negativePrompt).slice(0, 500));
    if (req.body.seed) form.append("seed", String(req.body.seed));
    if (req.body.steps) form.append("steps", String(req.body.steps));
    if (req.body.identityStrength) form.append("identity_strength", String(req.body.identityStrength));

    const aiResponse = await axios.post(`${serviceUrl}/v1/generate/portrait`, form, {
      headers: process.env.AI_IMAGE_SERVICE_KEY
        ? { "X-Gabber-AI-Key": process.env.AI_IMAGE_SERVICE_KEY }
        : {},
      responseType: "arraybuffer",
      timeout: 5 * 60 * 1000,
      maxContentLength: 15 * 1024 * 1024,
      maxBodyLength: 12 * 1024 * 1024,
      validateStatus: () => true,
    });
    if (aiResponse.status !== 200) {
      const publicMessage = serviceErrorMessage(aiResponse.data) || "The AI service could not generate this image.";
      return res.status(aiResponse.status >= 400 && aiResponse.status < 500 ? 422 : 503).json({ error: publicMessage });
    }

    // Treat AI output as untrusted bytes. Decode and re-encode before it is
    // served or registered as Gabber media.
    const sanitized = await sharp(Buffer.from(aiResponse.data))
      .rotate()
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90, progressive: true })
      .toBuffer();
    const filename = `ai_${Date.now()}_${randomUUID().split("-")[0]}.jpg`;
    const url = await uploadBuffer(sanitized, "ai", filename, "image/jpeg", req);
    const assetId = `asset_${randomUUID().split("-")[0]}`;
    const contentHash = createHash("sha256").update(sanitized).digest("hex");
    const model = String(aiResponse.headers["x-gabber-ai-model"] || "local-diffusion").slice(0, 120);
    const seed = String(aiResponse.headers["x-gabber-ai-seed"] || "").slice(0, 20);
    await pool.query(
      `INSERT INTO media_assets
       (id,uploader_id,media_type,url,filename,sha256,scan_status,scan_details)
       VALUES ($1,$2,'image',$3,$4,$5,'sanitized',$6::jsonb)`,
      [assetId, req.user.userId, url, filename, contentHash, JSON.stringify({
        decoder: "sharp",
        reencodedAs: "image/jpeg",
        aiGenerated: true,
        model,
        seed,
      })]
    );

    return res.json({ success: true, url, assetId, aiGenerated: true, model, seed });
  } catch (error) {
    const unavailable = ["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET"].includes(error.code);
    console.error("[ai-image]", error.message);
    return res.status(503).json({
      error: unavailable
        ? "The local AI service is offline. Start GabberAI and try again."
        : "AI image generation failed.",
    });
  }
});

module.exports = router;

