const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { generateSticker, checkStickerLimit, incrementStickerUsage, saveSticker, getUserStickers } = require("../services/sticker");

const router = express.Router();
router.use(requireAuth);

// POST /api/stickers/generate
router.post("/generate", async (req, res) => {
  const { description, save } = req.body;
  if (!description || description.trim().length < 2) {
    return res.status(400).json({ error: "Please describe your sticker." });
  }
  try {
    // Check daily limit
    const limit = await checkStickerLimit(req.user.userId);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "Daily limit reached. Upgrade to Gabber Pro for unlimited stickers.",
        limitReached: true,
        remaining: 0,
      });
    }

    console.log(`[sticker] Generating: "${description}" for ${req.user.username}`);
    const svg = await generateSticker(description.trim());

    // Increment usage
    await incrementStickerUsage(req.user.userId);

    // Auto-save to collection
    let stickerId = null;
    if (save !== false) {
      stickerId = await saveSticker(req.user.userId, svg, description.trim());
    }

    res.json({
      success: true,
      svg,
      stickerId,
      remaining: limit.remaining,
      isPro: limit.isPro,
    });
  } catch (err) {
    console.error("[sticker]", err.message);
    res.status(500).json({ error: "Failed to generate sticker. Try again." });
  }
});

// GET /api/stickers/collection
router.get("/collection", async (req, res) => {
  try {
    const stickers = await getUserStickers(req.user.userId);
    res.json({ stickers });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/stickers/:id
router.delete("/:id", async (req, res) => {
  const pool = require("../db/pool");
  try {
    await pool.query(
      "DELETE FROM sticker_collections WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;