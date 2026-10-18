const ALLOWED_PROVIDERS = new Set(["expo", "fcm", "apns"]);
const ALLOWED_PLATFORMS = new Set(["android", "ios"]);

function normalizeDeviceTokens(body = {}) {
  const submitted = Array.isArray(body.tokens)
    ? body.tokens
    : body.pushToken
      ? [{ token: body.pushToken, provider: "expo", platform: body.platform }]
      : [];

  if (submitted.length === 0 || submitted.length > 3) {
    return { ok: false, error: "One to three push tokens are required." };
  }

  const unique = new Map();
  for (const item of submitted) {
    const token = typeof item?.token === "string" ? item.token.trim() : "";
    const provider = typeof item?.provider === "string" ? item.provider.toLowerCase() : "";
    const platform = typeof item?.platform === "string" ? item.platform.toLowerCase() : null;

    if (!token || token.length > 4096) return { ok: false, error: "Invalid push token." };
    if (!ALLOWED_PROVIDERS.has(provider)) return { ok: false, error: "Invalid push-token provider." };
    if (platform && !ALLOWED_PLATFORMS.has(platform)) return { ok: false, error: "Invalid push-token platform." };
    if (provider === "expo" && !/^ExponentPushToken\[[^\]]+\]$|^ExpoPushToken\[[^\]]+\]$/.test(token)) {
      return { ok: false, error: "Invalid Expo push token." };
    }

    unique.set(token, { token, provider, platform });
  }

  return { ok: true, tokens: [...unique.values()] };
}

module.exports = { normalizeDeviceTokens };
