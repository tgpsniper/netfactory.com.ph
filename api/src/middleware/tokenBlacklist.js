// ============================================================
// TOKEN BLACKLIST — In-memory store with auto-cleanup
// ============================================================
// Blacklisted tokens are rejected by auth middleware.
// Tokens auto-expire from the blacklist when their JWT expiry passes.
// For multi-server deployments, replace with Redis.
// ============================================================

const jwt = require('jsonwebtoken');

const blacklist = new Map(); // token -> expiresAt (timestamp)

/**
 * Add a token to the blacklist
 * @param {string} token - JWT token to blacklist
 */
function add(token) {
  try {
    // Decode without verifying (token may be expired but we still want to blacklist it)
    const decoded = jwt.decode(token);
    if (decoded && decoded.exp) {
      blacklist.set(token, decoded.exp * 1000); // Convert to ms
    } else {
      // If no exp, blacklist for 24 hours
      blacklist.set(token, Date.now() + 24 * 60 * 60 * 1000);
    }
  } catch {
    // Blacklist for 24 hours if decode fails
    blacklist.set(token, Date.now() + 24 * 60 * 60 * 1000);
  }
}

/**
 * Check if a token is blacklisted
 * @param {string} token - JWT token to check
 * @returns {boolean}
 */
function isBlacklisted(token) {
  return blacklist.has(token);
}

/**
 * Remove expired tokens from the blacklist (auto-runs every 15 min)
 */
function cleanup() {
  const now = Date.now();
  for (const [token, expiresAt] of blacklist) {
    if (expiresAt <= now) {
      blacklist.delete(token);
    }
  }
}

// Auto-cleanup every 15 minutes
setInterval(cleanup, 15 * 60 * 1000);

module.exports = { add, isBlacklisted, cleanup };
