const { Expo } = require("expo-server-sdk");
const { applicationDefault, getApps, initializeApp } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

const expo = new Expo();
let firebaseApp = null;

function buildPushContent(data = {}) {
  const { type, senderName, text, groupName, fromName } = data;
  let title = "";
  let body = "";

  if (type === "message") {
    title = senderName || "New message";
    if (text?.startsWith("[image]")) body = "Sent a photo";
    else if (text?.startsWith("[view-once]")) body = "Sent a view-once photo";
    else if (text?.startsWith("[voice]")) body = "Sent a voice message";
    else if (text?.startsWith("[payment-status-v2]")) body = "Payment status updated";
    else if (text?.startsWith("[payment-v2]") || text?.startsWith("[payment]")) body = "Payment initiated";
    else if (text?.startsWith("[payment-request-v2]") || text?.startsWith("[payment-request]")) body = "Payment requested";
    else if (text?.startsWith("[sticker]")) body = "Sent a sticker";
    else if (text?.startsWith("[bill]")) body = "Sent an order bill";
    else body = text || "New message";
  } else if (type === "group_message") {
    title = groupName || "Group message";
    const preview = text?.startsWith("[image]") ? "Photo"
      : text?.startsWith("[voice]") ? "Voice message"
      : text?.startsWith("[sticker]") ? "Sticker"
      : text || "New message";
    body = `${senderName || "Someone"}: ${preview}`;
  } else if (type === "call") {
    title = "Incoming Call";
    body = `${senderName || "Someone"} is calling you`;
  } else if (type === "video_call") {
    title = "Incoming Video Call";
    body = `${senderName || "Someone"} wants to video call`;
  } else if (type === "group_call" || type === "group_video_call") {
    title = type === "group_video_call" ? "Incoming Group Video Call" : "Incoming Group Call";
    body = `${fromName || senderName || "Someone"} is calling ${groupName || "your group"}`;
  }

  if (!title) return null;
  const isCall = ["call", "video_call", "group_call", "group_video_call"].includes(type);
  return { title, body, isCall };
}

function pushData(data = {}) {
  const allowed = ["chatId", "otherUserId", "type", "senderName", "groupName", "roomId", "callType", "from", "fromName"];
  return Object.fromEntries(allowed
    .filter((key) => data[key] !== undefined && data[key] !== null)
    .map((key) => [key, String(data[key])]));
}

function firebaseMessaging() {
  if (!firebaseApp) {
    firebaseApp = getApps()[0] || initializeApp({
      credential: applicationDefault(),
      ...(process.env.FIREBASE_PROJECT_ID ? { projectId: process.env.FIREBASE_PROJECT_ID } : {}),
    });
  }
  return getMessaging(firebaseApp);
}

async function sendExpoPushNotification(pushToken, data) {
  if (!Expo.isExpoPushToken(pushToken)) {
    console.error("[push:expo] Invalid Expo token rejected");
    return false;
  }
  const content = buildPushContent(data);
  if (!content) return false;
  const message = {
    to: pushToken,
    sound: "default",
    title: content.title,
    body: content.body,
    data: pushData(data),
    priority: "high",
    channelId: content.isCall ? "calls" : "messages",
    badge: 1,
    ttl: content.isCall ? 120 : 3600,
  };

  try {
    const chunks = expo.chunkPushNotifications([message]);
    for (const chunk of chunks) {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (const ticket of tickets) {
        if (ticket.status === "error") {
          console.error("[push:expo]", ticket.details?.error || ticket.message);
          return false;
        }
      }
    }
    return true;
  } catch (err) {
    console.error("[push:expo] Send error:", err.message);
    return false;
  }
}

async function sendFcmPushNotification(pushToken, data) {
  if (typeof pushToken !== "string" || !pushToken) return false;
  const content = buildPushContent(data);
  if (!content) return false;
  try {
    await firebaseMessaging().send({
      token: pushToken,
      notification: { title: content.title, body: content.body },
      data: pushData(data),
      android: {
        priority: "high",
        ttl: (content.isCall ? 120 : 3600) * 1000,
        notification: {
          channelId: content.isCall ? "calls" : "messages",
          sound: "default",
          defaultVibrateTimings: true,
        },
      },
    });
    return true;
  } catch (err) {
    console.error("[push:fcm]", err.code || err.message, err.message);
    return false;
  }
}

async function sendPushNotification(pushToken, data, provider = "expo") {
  return provider === "fcm"
    ? sendFcmPushNotification(pushToken, data)
    : sendExpoPushNotification(pushToken, data);
}

async function sendPushToDeviceTokens(tokenRows, data) {
  const fcmTokens = [...new Set(tokenRows.filter((row) => row.provider === "fcm").map((row) => row.push_token))];
  const expoTokens = [...new Set(tokenRows.filter((row) => row.provider === "expo").map((row) => row.push_token))];

  if (fcmTokens.length) {
    const nativeResults = await Promise.all(fcmTokens.map((token) => sendFcmPushNotification(token, data)));
    if (nativeResults.some(Boolean)) return true;
    console.warn("[push] All native FCM sends failed; falling back to Expo.");
  }
  if (!expoTokens.length) return false;
  const expoResults = await Promise.all(expoTokens.map((token) => sendExpoPushNotification(token, data)));
  return expoResults.some(Boolean);
}

module.exports = {
  buildPushContent,
  sendExpoPushNotification,
  sendFcmPushNotification,
  sendPushNotification,
  sendPushToDeviceTokens,
};
