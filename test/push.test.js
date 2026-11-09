const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPushContent, pushData, sendPushToDeviceTokens } = require("../src/services/push");

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

test("notification privacy hides sender but preserves message preview", () => {
  assert.deepEqual(
    buildPushContent({ type: "message", senderName: "Nihar", text: "Hello", hideSenderName: true }),
    { title: "New message", body: "Hello", isCall: false }
  );
  assert.deepEqual(
    buildPushContent({ type: "group_message", senderName: "Nihar", groupName: "Friends", text: "Hello", hideSenderName: true }),
    { title: "Friends", body: "Hello", isCall: false }
  );
});

test("PDF push preview does not expose its storage URL", () => {
  assert.deepEqual(
    buildPushContent({ type: "message", senderName: "Nihar", text: "[document]https://example.test/file.pdf|file.pdf|12" }),
    { title: "Nihar", body: "Sent a PDF document", isCall: false }
  );
});

test("group-call notifications use the high-priority call classification", () => {
  assert.deepEqual(
    buildPushContent({ type: "group_video_call", fromName: "Nihar", groupName: "Friends" }),
    { title: "Incoming Group Video Call", body: "Nihar is calling Friends", isCall: true }
  );
});

test("push data excludes FCM-reserved keys", () => {
  assert.deepEqual(
    pushData({
      type: "group_call",
      roomId: "room-1",
      from: "user-1",
      fromName: "Nihar",
    }),
    { type: "group_call", roomId: "room-1", fromName: "Nihar" }
  );
});

test("message action category is retained in push data", () => {
  assert.deepEqual(
    pushData({ type: "message", chatId: "chat-1", categoryId: "message_actions" }),
    { chatId: "chat-1", type: "message", categoryId: "message_actions" }
  );
});

test("notification delivery fails closed when a user has no tokens", async () => {
  assert.equal(await sendPushToDeviceTokens([], { type: "message", text: "Hello" }), false);
});
