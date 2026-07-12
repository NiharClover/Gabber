// GSTIN format + checksum validation.
//
// Catches obviously fake/mistyped GSTINs before anything reaches the admin
// review queue or (eventually) a paid KYC API — this check is free and
// instant. It does NOT confirm the GSTIN is actually registered/active;
// that still requires a manual GST-portal lookup (Task 4) or, later, a
// paid verification API.

const GSTIN_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// 2-digit state code + 10-char PAN (5 letters, 4 digits, 1 letter) +
// 1 entity code + literal 'Z' + 1 checksum character.
const GSTIN_FORMAT_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * @param {string} gstin
 * @returns {boolean} true only if format AND checksum digit are both valid
 */
function isValidGSTIN(gstin) {
  if (typeof gstin !== "string") return false;
  const value = gstin.trim().toUpperCase();

  if (!GSTIN_FORMAT_REGEX.test(value)) return false;

  // Standard GSTIN check-digit algorithm: modulo-36 with alternating 1/2
  // factors over the first 14 characters.
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const charIndex = GSTIN_CHARSET.indexOf(value[i]);
    if (charIndex === -1) return false;
    const factor = i % 2 === 0 ? 1 : 2;
    const product = charIndex * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }

  const checkDigitIndex = (GSTIN_CHARSET.length - (sum % GSTIN_CHARSET.length)) % GSTIN_CHARSET.length;
  const expectedCheckDigit = GSTIN_CHARSET[checkDigitIndex];

  return expectedCheckDigit === value[14];
}

module.exports = { isValidGSTIN };