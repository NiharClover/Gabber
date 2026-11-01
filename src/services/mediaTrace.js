const { createHmac } = require("crypto");
const { parseMediaReference } = require("../utils/contentSafety");

function traceSecret() {
  const secret = process.env.MEDIA_TRACE_SECRET || process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("MEDIA_TRACE_SECRET or JWT_SECRET must be at least 32 characters.");
  return secret;
}

function createTraceCode(messageId, recipientId) {
  const digest = createHmac("sha256", traceSecret())
    .update(`${messageId}:${recipientId}`)
    .digest("hex")
    .toUpperCase();
  return `GBR-${digest.slice(0, 5)}-${digest.slice(5, 10)}-${digest.slice(10, 16)}`;
}

function isTraceableMedia(text) {
  const media = parseMediaReference(text);
  return Boolean(media && !media.viewOnce);
}

module.exports = { createTraceCode, isTraceableMedia };
