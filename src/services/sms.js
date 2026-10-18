const axios = require("axios");
const { randomInt } = require("crypto");
const redis = require("../db/redis");

const OTP_TTL = 10 * 60; // 10 minutes in seconds
const MAX_ATTEMPTS = 5;

function generateOTP() {
  return randomInt(100000, 1000000).toString();
}

async function sendOTP(phone) {
  const otp = generateOTP();

  // Store in Redis — survives server restarts
  await redis.setex(`otp:${phone}`, OTP_TTL, JSON.stringify({
    otp,
    attempts: 0,
  }));

  if (process.env.DEV_MODE === "true") {
    console.warn("[DEV] OTP generated. DEV_MODE must never be enabled in production.");
    return { success: true, dev: true };
  }

  if (!process.env.MSG91_API_KEY || !process.env.MSG91_TEMPLATE_ID) {
    throw new Error("SMS delivery is not configured");
  }

  // Production: send via MSG91
  try {
    await axios.get("https://api.msg91.com/api/v5/otp", {
      params: {
        authkey: process.env.MSG91_API_KEY,
        template_id: process.env.MSG91_TEMPLATE_ID,
        mobile: phone,
        otp,
      },
    });
    return { success: true };
  } catch (err) {
    console.error("[SMS] Failed:", err.message);
    throw new Error("Failed to send OTP");
  }
}

async function verifyOTP(phone, inputOtp) {
  const key = `otp:${phone}`;
  const raw = await redis.get(key);

  if (!raw) return { valid: false, reason: "OTP not found. Request a new one." };

  const record = JSON.parse(raw);

  if (record.attempts >= MAX_ATTEMPTS) {
    await redis.del(key);
    return { valid: false, reason: "Too many attempts. Request a new OTP." };
  }

  // Increment attempts
  record.attempts += 1;
  await redis.setex(key, OTP_TTL, JSON.stringify(record));

  if (record.otp !== inputOtp) {
    return { valid: false, reason: `Incorrect OTP. ${MAX_ATTEMPTS - record.attempts} attempts left.` };
  }

  // Valid — delete it (one time use)
  await redis.del(key);
  return { valid: true };
}

module.exports = { sendOTP, verifyOTP };
