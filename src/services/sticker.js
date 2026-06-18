const Anthropic = require("@anthropic-ai/sdk");
const pool = require("../db/pool");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FREE_DAILY_LIMIT = 5;

async function checkStickerLimit(userId) {
  // Get or create subscription record
  let result = await pool.query(
    "SELECT * FROM subscriptions WHERE user_id = $1",
    [userId]
  );

  if (!result.rows[0]) {
    await pool.query(
      "INSERT INTO subscriptions (user_id) VALUES ($1)",
      [userId]
    );
    return { allowed: true, remaining: FREE_DAILY_LIMIT - 1, isPro: false };
  }

  const sub = result.rows[0];

  // Pro users have unlimited
  if (sub.plan === "pro" && sub.expires_at > new Date()) {
    return { allowed: true, remaining: -1, isPro: true };
  }

  // Reset daily count if it's a new day
  const lastReset = new Date(sub.stickers_reset);
  const now = new Date();
  if (now.toDateString() !== lastReset.toDateString()) {
    await pool.query(
      "UPDATE subscriptions SET stickers_used = 0, stickers_reset = NOW() WHERE user_id = $1",
      [userId]
    );
    return { allowed: true, remaining: FREE_DAILY_LIMIT - 1, isPro: false };
  }

  // Check limit
  if (sub.stickers_used >= FREE_DAILY_LIMIT) {
    return { allowed: false, remaining: 0, isPro: false };
  }

  return {
    allowed: true,
    remaining: FREE_DAILY_LIMIT - sub.stickers_used - 1,
    isPro: false,
  };
}

async function incrementStickerUsage(userId) {
  await pool.query(
    "UPDATE subscriptions SET stickers_used = stickers_used + 1 WHERE user_id = $1",
    [userId]
  );
}

async function generateSticker(description) {
  const prompt = `You are an expert SVG sticker artist for a chat app called Gabber. Create a fun expressive sticker.

Description: "${description}"

Rules:
- Output ONLY raw SVG code, nothing else, no explanation
- viewBox="0 0 200 200" exactly
- Transparent background (no background rect)
- Bold cartoon style with thick outlines (stroke-width 3-5)
- Vibrant colors, expressive, emoji-like feel
- Centered design filling most of the 200x200 space
- Add subtle drop shadow or glow for premium feel
- Use rounded shapes, smooth curves
- Make it look like a premium WhatsApp/Telegram sticker
- Output starts with <svg and ends with </svg>`;

  const message = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  const content = message.content[0].text.trim();
  const svgMatch = content.match(/<svg[\s\S]*<\/svg>/i);
  if (!svgMatch) throw new Error("Failed to generate valid SVG sticker");
  return svgMatch[0];
}

async function saveSticker(userId, svg, description) {
  const { randomUUID } = require("crypto");
  const id = `sticker_${randomUUID().split("-")[0]}`;
  await pool.query(
    "INSERT INTO sticker_collections (id, user_id, svg, description) VALUES ($1,$2,$3,$4)",
    [id, userId, svg, description]
  );
  return id;
}

async function getUserStickers(userId) {
  const result = await pool.query(
    "SELECT * FROM sticker_collections WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
    [userId]
  );
  return result.rows;
}

module.exports = { generateSticker, checkStickerLimit, incrementStickerUsage, saveSticker, getUserStickers };