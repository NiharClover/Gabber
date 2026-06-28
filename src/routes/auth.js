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
  const { phone, otp } = req.body;
  try {
    // Verify OTP with MSG91
    const verified = await verifyOTP(phone, otp);
    if (!verified) return res.status(400).json({ error: "Invalid OTP." });

    // Check if user exists
    const existing = await pool.query(
      "SELECT * FROM users WHERE phone = $1", [phone]
    );

    let user;
    let isNewUser = false;

    if (existing.rows[0]) {
      user = existing.rows[0];
    } else {
      // New user — create with placeholder username
      isNewUser = true;
      const userId = `user_${randomUUID().split("-")[0]}`;
      const result = await pool.query(
        `INSERT INTO users (id, phone, username, about) 
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [userId, phone, `User${phone.slice(-4)}`, "Hey there! I am using Gabber."]
      );
      user = result.rows[0];
    }

    const token = jwt.sign(
      { userId: user.id, phone: user.phone },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      success: true,
      token,
      user: {
        userId: user.id,
        username: user.username,
        phone: user.phone,
        avatarUrl: user.avatar_url,
        about: user.about,
        email: user.email,
      },
      isNewUser,
    });
  } catch (err) {
    console.error("[verify-otp]", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;