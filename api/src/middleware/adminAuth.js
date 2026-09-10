const jwt = require('jsonwebtoken');
const tokenBlacklist = require('./tokenBlacklist');

// ============================================================
// ADMIN AUTH MIDDLEWARE — Secure Version
// ============================================================
// Token priority: httpOnly cookie > Authorization header
// Query string tokens (?token=) REMOVED for security
// Blacklisted tokens are rejected
// ============================================================

const ADMIN_COOKIE_NAME = 'j2_admin_token';

const adminAuth = () => {
  return async (req, res, next) => {
    try {
      let token = null;

      // Priority 1: httpOnly cookie (most secure)
      if (req.cookies && req.cookies[ADMIN_COOKIE_NAME]) {
        token = req.cookies[ADMIN_COOKIE_NAME];
      }
      // Priority 2: Authorization header (for API clients)
      else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
      }

      // NOTE: Query string token (?token=) intentionally removed
      // It exposes tokens in server logs, browser history, and referrer headers

      if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
      }

      // Check if token has been blacklisted (logged out)
      if (tokenBlacklist.isBlacklisted(token)) {
        return res.status(401).json({ error: 'Session has been terminated. Please login again.' });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (decoded.type !== 'admin') {
        return res.status(403).json({ error: 'Invalid token type' });
      }

      const admin = await req.prisma.admin_users.findUnique({
        where: { id: Number(decoded.id) }
      });

      if (!admin || !admin.is_active) {
        return res.status(401).json({ error: 'Account disabled or not found' });
      }

      req.admin = admin;
      req.adminId = admin.id;
      req.token = token; // Attach token for logout use
      next();
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Session expired. Please login again.' });
      }
      if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({ error: 'Invalid token' });
      }
      return res.status(500).json({ error: 'Authentication error' });
    }
  };
};

module.exports = adminAuth;
module.exports.ADMIN_COOKIE_NAME = ADMIN_COOKIE_NAME;
