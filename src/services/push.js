const { Expo } = require("expo-server-sdk");
const pool = require("../db/pool");

const expo = new Expo();

async function sendPushNotification(userId, title, body, data = {}) {
  try {
    const result = await pool.query(
      "SELECT push_token FROM device_tokens WHERE user_id = $1 AND push_token IS NOT NULL",
      [userId]
    );

    const messages = [];
    for (const row of result.rows) {
      if (!Expo.isExpoPushToken(row.push_token)) continue;
      messages.push({
        to: row.push_token,
        sound: "default",
        title,
        body,
        data,
        priority: "high",
        channelId: "messages",
      });
    }

    if (messages.length === 0) return;

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (const ticket of tickets) {
        if (ticket.status === "error") {
          console.error("[push] Error:", ticket.message);
          if (ticket.details?.error === "DeviceNotRegistered") {
            await pool.query("DELETE FROM device_tokens WHERE push_token = $1", [ticket.details.expoPushToken]);
          }
        }
      }
    }
    console.log(`[push] Sent to ${messages.length} device(s) for user ${userId}`);
  } catch (err) {
    console.error("[push]", err.message);
  }
}

module.exports = { sendPushNotification };