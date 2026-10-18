const axios = require("axios");

const SANDBOX_BASE_URL = "https://sandbox.cashfree.com";
const PRODUCTION_BASE_URL = "https://api.cashfree.com";
const IGNORED_NAME_WORDS = new Set([
  "and", "the", "private", "pvt", "limited", "ltd", "llp", "company", "co",
  "india", "enterprises", "enterprise", "services", "service",
]);

function normalizeBusinessName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word && !IGNORED_NAME_WORDS.has(word))
    .join(" ");
}

function businessNamesMatch(submittedName, ...registeredNames) {
  const submitted = normalizeBusinessName(submittedName);
  if (!submitted) return false;
  const submittedTokens = new Set(submitted.split(" "));

  return registeredNames.some((name) => {
    const registered = normalizeBusinessName(name);
    if (!registered) return false;
    if (submitted === registered || submitted.includes(registered) || registered.includes(submitted)) return true;
    const registeredTokens = new Set(registered.split(" "));
    const common = [...submittedTokens].filter((token) => registeredTokens.has(token)).length;
    return common / Math.min(submittedTokens.size, registeredTokens.size) >= 0.6;
  });
}

function normalizeRegistryDate(value) {
  const date = String(value || "").trim();
  if (!date) return null;
  const isoFormat = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const indianFormat = date.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  const parts = isoFormat
    ? { year: isoFormat[1], month: isoFormat[2], day: isoFormat[3] }
    : indianFormat
      ? { year: indianFormat[3], month: indianFormat[2], day: indianFormat[1] }
      : null;
  if (!parts) return null;
  const parsed = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  if (
    parsed.getUTCFullYear() !== Number(parts.year)
    || parsed.getUTCMonth() + 1 !== Number(parts.month)
    || parsed.getUTCDate() !== Number(parts.day)
  ) return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function cashfreeConfig() {
  const environment = String(process.env.CASHFREE_ENV || "sandbox").toLowerCase();
  return {
    clientId: process.env.CASHFREE_CLIENT_ID,
    clientSecret: process.env.CASHFREE_CLIENT_SECRET,
    baseUrl: environment === "production" ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL,
    environment: environment === "production" ? "production" : "sandbox",
  };
}

function serviceError(message, status = 503, code = "GSTIN_SERVICE_UNAVAILABLE") {
  return Object.assign(new Error(message), { status, code });
}

async function verifyGstin({ gstin, businessName }) {
  const config = cashfreeConfig();
  if (!config.clientId || !config.clientSecret) {
    throw serviceError("GSTIN verification is not configured yet.");
  }

  let response;
  try {
    response = await axios.post(
      `${config.baseUrl}/verification/gstin`,
      { GSTIN: gstin, business_name: businessName },
      {
        headers: {
          "x-client-id": config.clientId,
          "x-client-secret": config.clientSecret,
          "Content-Type": "application/json",
        },
        timeout: 12000,
        validateStatus: () => true,
      }
    );
  } catch (err) {
    console.error("[cashfree gstin] network failure:", err.code || err.message);
    throw serviceError("GSTIN verification is temporarily unavailable. Please try again.");
  }

  if (response.status === 401 || response.status === 403) {
    console.error(`[cashfree gstin] credentials rejected (${response.status})`);
    throw serviceError("GSTIN verification is temporarily unavailable.");
  }
  if (response.status === 429 || response.status >= 500) {
    console.error(`[cashfree gstin] provider unavailable (${response.status})`);
    throw serviceError("GSTIN verification is busy. Please try again shortly.");
  }
  if (response.status < 200 || response.status >= 300) {
    throw serviceError("Cashfree could not verify this GSTIN. Check it and try again.", 400, "GSTIN_NOT_FOUND");
  }

  const data = response.data || {};
  const valid = data.valid === true || data.valid === "true";
  const registryStatus = String(data.gst_in_status || "").trim();
  return {
    valid,
    active: valid && registryStatus.toLowerCase() === "active",
    gstin: String(data.GSTIN || gstin).toUpperCase(),
    referenceId: data.reference_id == null ? null : String(data.reference_id),
    legalName: String(data.legal_name_of_business || "").trim() || null,
    tradeName: String(data.trade_name_of_business || "").trim() || null,
    registryStatus: registryStatus || null,
    registrationDate: normalizeRegistryDate(data.date_of_registration),
    nameMatch: businessNamesMatch(businessName, data.legal_name_of_business, data.trade_name_of_business),
    environment: config.environment,
  };
}

module.exports = {
  businessNamesMatch,
  cashfreeConfig,
  normalizeBusinessName,
  normalizeRegistryDate,
  verifyGstin,
};
