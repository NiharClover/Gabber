import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { Platform } from "react-native";
import axios from "axios";
import { BASE_URL, getStoredToken } from "./api";

// How to display notifications when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function registerForPushNotifications() {
  // Push notifications only work on real devices
  if (!Device.isDevice) {
    console.log("[push] Skipping — not a real device");
    return null;
  }

  // Check/request permissions
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    console.log("[push] Permission denied");
    return null;
  }

  // Android needs a notification channel
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("messages", {
      name: "Messages",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#ff6b35",
      sound: "default",
    });
  }

  // Get the Expo push token
  const tokenData = await Notifications.getExpoPushTokenAsync({
    projectId: "822ff64f-bcc1-4b5a-b47a-ef9ce4d8954c", // replace this below
  });

  const pushToken = tokenData.data;
  console.log("[push] Token:", pushToken);

  // Register token with our server
  try {
    const authToken = await getStoredToken();
    await axios.post(
      `${BASE_URL}/api/devices/register`,
      { token: pushToken },
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    console.log("[push] Token registered with server");
  } catch (err) {
    console.error("[push] Failed to register token:", err.message);
  }

  return pushToken;
}

export function setupNotificationListeners(router) {
  // When user taps a notification — navigate to that chat
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    if (data?.chatId) {
      router.push({
        pathname: "/chat",
        params: {
          chatId: data.chatId,
          otherUserId: data.from || "",
          otherUsername: "Chat",
          isGroup: data.type === "group_message" ? "true" : "false",
        },
      });
    }
  });

  return subscription;
}