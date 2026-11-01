const { createHash } = require("crypto");

const SHORTENER_HOSTS = new Set([
  "bit.ly", "buff.ly", "cutt.ly", "goo.gl", "is.gd", "ow.ly",
  "rebrand.ly", "shorturl.at", "t.co", "tiny.cc", "tinyurl.com",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function extractUrls(text) {
  if (typeof text !== "string") return [];
  const matches = text.match(/(?:https?:\/\/|www\.)[^\s<>"']+/gi) || [];
  return matches.map((value) => value.replace(/[),.!?;:]+$/g, ""));
}

function assessMessageSafety(text) {
  const flags = new Set();
  for (const raw of extractUrls(text)) {
    const candidate = raw.toLowerCase().startsWith("www.") ? `https://${raw}` : raw;
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase().replace(/\.$/, "");
      if (url.protocol === "http:") flags.add("insecure_http");
      if (url.username || url.password) flags.add("embedded_credentials");
      if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.startsWith("[") || host.includes(":")) {
        flags.add("ip_address_link");
      }
      if (host.includes("xn--")) flags.add("punycode_domain");
      if (SHORTENER_HOSTS.has(host)) flags.add("shortened_link");
      if (host.split(".").length > 5) flags.add("excessive_subdomains");
    } catch {
      flags.add("malformed_link");
    }
  }
  const safetyFlags = [...flags];
  return {
    status: safetyFlags.length > 0 ? "caution" : "safe",
    flags: safetyFlags,
  };
}

function parseMediaReference(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/^\[(image|video|view-once)\]([^|]+)(?:\|.*)?$/s);
  if (!match) return null;
  return { type: match[1] === "view-once" ? "image" : match[1], url: match[2], viewOnce: match[1] === "view-once" };
}

module.exports = { assessMessageSafety, extractUrls, parseMediaReference, sha256 };
