const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPushContent, sendPushToDeviceTokens } = require("../src/services/push");

test("direct-message push content contains sender and preview", () => {
  assert.deepEqual(
    buildPushContent({ type: "message", senderName: "Nihar", text: "Hello" }),
    { title: "Nihar", body: "Hello", isCall: false }
  );
});

test("media messages do not expose their storage reference", () => {
  assert.deepEqual(
    buildPushContent({ type: "message", senderName: "Nihar", text: "[image]https://private.example/file.jpg" }),
    { title: "Nihar", body: "Sent a photo", isCall: false }
  );
});

test("group-call notifications use the high-priority call classification", () => {
  assert.deepEqual(
    buildPushContent({ type: "group_video_call", fromName: "Nihar", groupName: "Friends" }),
    { title: "Incoming Group Video Call", body: "Nihar is calling Friends", isCall: true }
  );
});

test("notification delivery fails closed when a user has no tokens", async () => {
  assert.equal(await sendPushToDeviceTokens([], { type: "message", text: "Hello" }), false);
});
