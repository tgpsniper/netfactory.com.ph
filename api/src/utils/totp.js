// ============================================================
// NETFACTORY — TOTP (Time-based One-Time Password) Utility
// Implements RFC 6238 TOTP using Node.js built-in crypto only.
// Compatible with Google Authenticator, Authy, Microsoft Authenticator.
// No external dependencies required.
// ============================================================

'use strict';

const crypto = require('crypto');

// Base32 alphabet — RFC 4648
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode a Buffer as a Base32 string (RFC 4648, no padding).
 * @param {Buffer} buf
 * @returns {string}
 */
function base32Encode(buf) {
  let bits = '';
  for (const byte of buf) {
    bits += byte.toString(2).padStart(8, '0');
  }
  let result = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    result += BASE32_CHARS[parseInt(bits.substr(i, 5), 2)];
  }
  return result;
}

/**
 * Decode a Base32 string to a Buffer (RFC 4648, case-insensitive).
 * Strips spaces, dashes, and padding before decoding.
 * @param {string} str
 * @returns {Buffer}
 */
function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[\s\-=]/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = BASE32_CHARS.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid Base32 character: ${ch}`);
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substr(i, 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * Generate a random Base32 TOTP secret.
 * 20 bytes = 160 bits = 32 Base32 characters.
 * This is the standard length used by Google Authenticator and all RFC-compliant apps.
 *
 * @returns {string} e.g. "JBSWY3DPEBLW64TMMQ2CFQIASF3A6YJT"
 */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * Generate a TOTP token for a given secret and time counter (RFC 6238).
 * @param {string} secret - Base32 encoded secret
 * @param {number} counter - Time step counter (floor(unixSeconds / 30))
 * @returns {string} 6-digit zero-padded token
 */
function generateToken(secret, counter) {
  const keyBuf = base32Decode(secret);

  // Encode counter as big-endian 64-bit integer
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', keyBuf).update(counterBuf).digest();

  // Dynamic truncation per RFC 4226 §5.4
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) <<  8) |
     (hmac[offset + 3] & 0xff);

  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * Verify a TOTP token against a secret.
 * Accepts tokens from ±1 time step (±30 seconds) to handle clock skew.
 *
 * @param {string} secret  - Base32 encoded secret (from DB)
 * @param {string|number} token - 6-digit token from user's authenticator app
 * @param {number} [window=1] - Number of time steps to check on each side
 * @returns {boolean}
 */
function verifyToken(secret, token, window = 1) {
  const tokenStr = String(token).padStart(6, '0');
  const timeStep = Math.floor(Date.now() / 1000 / 30);
  for (let delta = -window; delta <= window; delta++) {
    if (generateToken(secret, timeStep + delta) === tokenStr) {
      return true;
    }
  }
  return false;
}

module.exports = { generateSecret, generateToken, verifyToken };
