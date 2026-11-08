const { Expo } = require("expo-server-sdk");
const expo = new Expo();

async function sendPushNotification(pushToken, data) {
  if (!Expo.isExpoPushToken(pushToken)) {
    console.error("[push] Invalid Expo token rejected");
    return;
  }

  const { type, senderName, text, chatId, otherUserId, groupName, roomId, callType, from, fromName } = data;

  let title = "";
  let body = "";

  if (type === "message") {
    title = senderName;
    if (text?.startsWith("[image]")) body = "📷 Sent a photo";
    else if (text?.startsWith("[view-once]")) body = "👁 Sent a view once photo";
    else if (text?.startsWith("[voice]")) body = "🎤 Sent a voice message";
    else if (text?.startsWith("[payment-status-v2]")) body = "Payment status updated";
    else if (text?.startsWith("[payment-v2]") || text?.startsWith("[payment]")) body = "Payment initiated";
    else if (text?.startsWith("[payment-request-v2]") || text?.startsWith("[payment-request]")) body = "Payment requested";
    else if (text?.startsWith("[sticker]")) body = "✨ Sent a sticker";
    else if (text?.startsWith("[bill]")) body = "🧾 Sent an order bill";
    else body = text || "New message";
  } else if (type === "group_message") {
    title = groupName || "Group message";
    const preview = text?.startsWith("[image]") ? "📷 Photo"
      : text?.startsWith("[voice]") ? "🎤 Voice message"
      : text?.startsWith("[sticker]") ? "✨ Sticker"
      : text;
    body = `${senderName}: ${preview}`;
  } else if (type === "call") {
    title = "📞 Incoming Call";
    body = `${senderName} is calling you`;
  } else if (type === "video_call") {
    title = "📹 Incoming Video Call";
    body = `${senderName} wants to video call`;
  } else if (type === "group_call" || type === "group_video_call") {
    title = type === "group_video_call" ? "Incoming Group Video Call" : "Incoming Group Call";
    body = `${fromName || senderName || "Someone"} is calling ${groupName || "your group"}`;
  }

  if (!title) return;

  const isCall = ["call", "video_call", "group_call", "group_video_call"].includes(type);

  const message = {
    to: pushToken,
    sound: "default",
    title,
    body,
    data: { chatId, otherUserId, type, senderName, groupName, roomId, callType, from, fromName },
    priority: "high",
    channelId: isCall ? "calls" : "messages",
    badge: 1,
    ttl: isCall ? 120 : 3600,
  };

  try {
    const chunks = expo.chunkPushNotifications([message]);
    for (const chunk of chunks) {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      for (const receipt of receipts) {
        if (receipt.status === "error") {
          console.error("[push] Error:", receipt.message);
        }
      }
    }
  } catch (err) {
    console.error("[push] Send error:", err.message);
  }
}

module.exports = { sendPushNotification };
