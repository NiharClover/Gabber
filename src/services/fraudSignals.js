const pool = require("../db/pool");

// These are all read-only, non-blocking signals. None of them reject,
// suspend, or auto-flag anything — they just surface patterns worth a
// human glance. Wire in automated blocking later only after seeing real
// false-positive rates.

// Same user creating multiple business listings in a short window — could
// be legitimate (multi-branch owner) or could be duplicate/fake-listing
// farming.
async function multiBusinessOwners(windowDays = 30, minCount = 2) {
  const result = await pool.query(
    `SELECT user_id, COUNT(*) AS business_count, ARRAY_AGG(id) AS business_ids
     FROM businesses
     WHERE created_at > NOW() - ($1 || ' days')::interval
     GROUP BY user_id
     HAVING COUNT(*) >= $2
     ORDER BY business_count DESC`,
    [windowDays, minCount]
  );
  return result.rows;
}

// A business jumping from freshly-verified to a large order spike within
// days — could indicate the verified badge is being used to run a scam
// burst before a real identity check would have caught up, or a genuine
// launch success. Worth a look either way.
async function verifiedOrderSpikes(daysAfterVerification = 7, orderThreshold = 20) {
  const result = await pool.query(
    `SELECT b.id, b.name, b.verified_at, COUNT(o.id) AS order_count
     FROM businesses b
     JOIN orders o ON o.business_id = b.id
     WHERE b.verification_status = 'verified'
       AND b.verified_at IS NOT NULL
       AND o.created_at BETWEEN b.verified_at AND b.verified_at + ($1 || ' days')::interval
     GROUP BY b.id, b.name, b.verified_at
     HAVING COUNT(o.id) >= $2
     ORDER BY order_count DESC`,
    [daysAfterVerification, orderThreshold]
  );
  return result.rows;
}

// The same GSTIN appearing across multiple different business listings.
// Legitimate for multi-branch/franchise businesses, but also a common
// identity-reuse pattern — flag either way for a human to distinguish.
async function reusedGstins() {
  const result = await pool.query(
    `SELECT gst_number,
            COUNT(*) AS listing_count,
            ARRAY_AGG(id) AS business_ids,
            ARRAY_AGG(user_id) AS user_ids
     FROM businesses
     WHERE gst_number IS NOT NULL AND gst_number != ''
     GROUP BY gst_number
     HAVING COUNT(*) > 1`
  );
  return result.rows;
}

module.exports = { multiBusinessOwners, verifiedOrderSpikes, reusedGstins };