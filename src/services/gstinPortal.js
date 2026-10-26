const axios = require("axios");
const {
  businessNamesMatch,
  normalizeRegistryDate,
} = require("./cashfreeGstin");

function serviceError(message, status = 503, code = "GSTIN_SERVICE_UNAVAILABLE") {
  return Object.assign(new Error(message), { status, code });
}

function portalConfig() {
  return {
    apiKey: process.env.GSTIN_PORTAL_API_KEY,
    baseUrl: String(process.env.GSTIN_PORTAL_BASE_URL || "https://www.gstinani.in").replace(/\/$/, ""),
  };
}

function firstValue(data, names) {
  for (const name of names) {
    const value = data?.[name];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return null;
}

async function verifyGstin({ gstin, businessName }) {
  const config = portalConfig();
  if (!config.apiKey) throw serviceError("GSTIN Portal verification is not configured yet.");

  let response;
  try {
    response = await axios.get(`${config.baseUrl}/v1/gstin/${encodeURIComponent(gstin)}`, {
      headers: { "x-api-key": config.apiKey },
      timeout: 12000,
      validateStatus: () => true,
    });
  } catch (err) {
    console.error("[gstin portal] network failure:", err.code || err.message);
    throw serviceError("GSTIN verification is temporarily unavailable. Please try again.");
  }

  if (response.status === 401 || response.status === 403) {
    console.error(`[gstin portal] credentials rejected (${response.status})`);
    throw serviceError("GSTIN verification is temporarily unavailable.");
  }
  if (response.status === 429 || response.status >= 500) {
    console.error(`[gstin portal] provider unavailable (${response.status})`);
    throw serviceError("GSTIN verification is busy. Please try again shortly.");
  }
  if (response.status < 200 || response.status >= 300) {
    throw serviceError("GSTIN Portal could not verify this GSTIN. Check it and try again.", 400, "GSTIN_NOT_FOUND");
  }

  const envelope = response.data || {};
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data : envelope;
  const legalName = firstValue(data, ["legal_name_of_business", "legalName", "legal_name", "lgnm"]);
  const tradeName = firstValue(data, ["trade_name_of_business", "tradeName", "trade_name", "tradeNam"]);
  const registryStatus = String(firstValue(data, ["gst_in_status", "status", "gstStatus", "sts"]) || "").trim();
  const explicitValid = firstValue(data, ["valid", "is_valid", "isValid"]);
  const valid = envelope.success !== false && envelope.valid !== false && (
    explicitValid === true || String(explicitValid).toLowerCase() === "true" || Boolean(legalName || tradeName || registryStatus)
  );

  return {
    valid,
    active: valid && registryStatus.toLowerCase() === "active",
    gstin: String(firstValue(data, ["GSTIN", "gstin", "gstin_number", "gstinNumber"]) || gstin).toUpperCase(),
    referenceId: firstValue(data, ["reference_id", "referenceId", "request_id", "requestId"]),
    legalName: legalName ? String(legalName).trim() : null,
    tradeName: tradeName ? String(tradeName).trim() : null,
    registryStatus: registryStatus || null,
    registrationDate: normalizeRegistryDate(firstValue(data, ["date_of_registration", "registrationDate", "regDate"])),
    nameMatch: businessNamesMatch(businessName, legalName, tradeName),
  };
}

module.exports = { portalConfig, verifyGstin };
