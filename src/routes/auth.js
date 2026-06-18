const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { randomUUID } = require("crypto");
const { sendOTP, verifyOTP } = require("../services/sms");
const pool = require("../db/pool");

const router = express.Router();

const otpRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => req.body.phone,
  message: { error: "Too many OTP requests. Try again in 10 minutes." },
});

// POST /api/auth/send-otp
router.post("/send-otp", otpRateLimit, async (req, res) => {
  console.log("[send-otp] hit with:", req.body);
  const { phone } = req.body;

  if (!phone || !/^\+[1-9]\d{9,14}$/.test(phone)) {
    return res.status(400).json({ error: "Invalid phone number. Use E.164 format e.g. +919876543210" });
  }

  try {
    const result = await sendOTP(phone);
    res.json({ success: true, message: "OTP sent.", dev: result.dev || false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/verify-otp
router.post("/verify-otp", async (req, res) => {
  console.log("[verify-otp] hit with:", req.body);
  const { phone, otp, username } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({ error: "phone and otp are required." });
  }

  const result = await verifyOTP(phone, otp);
  console.log("[verify-otp] OTP result:", result);

  if (!result.valid) {
    return res.status(401).json({ error: result.reason });
  }

  try {
    let userResult = await pool.query(
      "SELECT * FROM users WHERE phone = $1",
      [phone]
    );

    let user = userResult.rows[0];
    const isNewUser = !user;

    if (isNewUser) {
      if (!username) {
        return res.status(400).json({ error: "username required for new users." });
      }
      const userId = `user_${randomUUID().split("-")[0]}`;
      const insertResult = await pool.query(
        `INSERT INTO users (id, phone, username) VALUES ($1, $2, $3) RETURNING *`,
        [userId, phone, username]
      );
      user = insertResult.rows[0];
      console.log(`[auth] New user: ${username} (${phone})`);
    } else {
      await pool.query(
        "UPDATE users SET last_seen = NOW() WHERE id = $1",
        [user.id]
      );
    }

    const token = jwt.sign(
      { userId: user.id, phone: user.phone, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    res.json({
      success: true,
      isNewUser,
      token,
      user: { userId: user.id, username: user.username, phone: user.phone },
    });

  } catch (err) {
    console.error("[auth] DB error:", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;