const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeDeviceTokens } = require("../src/utils/deviceTokens");

test("accepts Expo and native FCM tokens together", () => {
  const result = normalizeDeviceTokens({
    tokens: [
      { token: "ExponentPushToken[abc123]", provider: "expo", platform: "android" },
      { token: "native-fcm-token", provider: "fcm", platform: "android" },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tokens.map((item) => item.provider), ["expo", "fcm"]);
});

test("keeps backward compatibility with the previous pushToken payload", () => {
  const result = normalizeDeviceTokens({ pushToken: "ExponentPushToken[legacy]" });
  assert.equal(result.ok, true);
  assert.equal(result.tokens[0].provider, "expo");
});

test("rejects a native token mislabeled as an Expo token", () => {
  const result = normalizeDeviceTokens({
    tokens: [{ token: "native-token", provider: "expo", platform: "android" }],
  });
  assert.equal(result.ok, false);
});
