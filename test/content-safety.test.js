const test = require("node:test");
const assert = require("node:assert/strict");
const { assessMessageSafety, parseMediaReference, sha256 } = require("../src/utils/contentSafety");
process.env.MEDIA_TRACE_SECRET ||= "test-only-media-trace-secret-32-characters";
const { createTraceCode, isTraceableMedia } = require("../src/services/mediaTrace");

test("ordinary HTTPS links do not receive a phishing warning", () => {
  assert.deepEqual(assessMessageSafety("Read https://example.com/news"), { status: "safe", flags: [] });
});

test("high-signal phishing link traits are labelled", () => {
  const result = assessMessageSafety("Login at http://user:pass@192.168.0.8/account");
  assert.equal(result.status, "caution");
  assert.deepEqual(new Set(result.flags), new Set(["insecure_http", "embedded_credentials", "ip_address_link"]));
});

test("shortened and punycode links are labelled", () => {
  assert.ok(assessMessageSafety("https://bit.ly/example").flags.includes("shortened_link"));
  assert.ok(assessMessageSafety("https://xn--pple-43d.example").flags.includes("punycode_domain"));
});

test("media references are parsed without trusting arbitrary text", () => {
  assert.deepEqual(parseMediaReference("[image]https://cdn.example/photo.jpg"), {
    type: "image", url: "https://cdn.example/photo.jpg", viewOnce: false,
  });
  assert.equal(parseMediaReference("hello"), null);
  assert.equal(sha256("same"), sha256("same"));
});

test("recipient trace codes are opaque, stable, and recipient-specific", () => {
  const first = createTraceCode("msg_1", "user_1");
  assert.match(first, /^GBR-[A-F0-9]{5}-[A-F0-9]{5}-[A-F0-9]{6}$/);
  assert.equal(first, createTraceCode("msg_1", "user_1"));
  assert.notEqual(first, createTraceCode("msg_1", "user_2"));
  assert.equal(isTraceableMedia("[video]https://cdn.example/video.mp4"), true);
  assert.equal(isTraceableMedia("[view-once]https://cdn.example/photo.jpg|photo.jpg"), false);
});
