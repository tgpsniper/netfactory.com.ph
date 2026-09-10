const jwt = require('jsonwebtoken');
const tokenBlacklist = require('./tokenBlacklist');

// ============================================================
// PORTAL AUTH MIDDLEWARE — Secure Version
// ============================================================
// Token priority: httpOnly cookie > Authorization header
// Validates token against DB session_token (single-session enforcement)
// Blacklisted tokens are rejected
// ============================================================

const PORTAL_COOKIE_NAME = 'j2_portal_token';

const portalAuth = async (req, res, next) => {
  try {
    let token = null;

    // Priority 1: httpOnly cookie (most secure)
    if (req.cookies && req.cookies[PORTAL_COOKIE_NAME]) {
      token = req.cookies[PORTAL_COOKIE_NAME];
    }
    // Priority 2: Authorization header (for API clients)
    else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    // Check if token has been blacklisted (logged out)
    if (tokenBlacklist.isBlacklisted(token)) {
      return res.status(401).json({ error: 'Session has been terminated. Please login again.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.type !== 'subscriber') {
      return res.status(403).json({ error: 'Invalid token type' });
    }

    // Verify subscriber exists and is not disconnected
    const subscriber = await req.prisma.subscribers.findUnique({
      where: { id: decoded.id },
      include: {
        auth: true,
        plan: { include: { features: { where: { is_active: true }, orderBy: { sort_order: 'asc' } } } },
        barangay: true,
        municipality: true
      }
    });

    if (!subscriber) {
      return res.status(401).json({ error: 'Account not found' });
    }

    if (subscriber.status === 'disconnected') {
      return res.status(403).json({ error: 'Account has been disconnected' });
    }

    // Validate token matches the stored session_token (single-session enforcement)
    // If someone logs in from another device, previous session is invalidated
    if (subscriber.auth && subscriber.auth.session_token !== token) {
      return res.status(401).json({ error: 'Session invalidated. You may have logged in from another device.' });
    }

    // Check if stored session has expired
    if (subscriber.auth && subscriber.auth.token_expires_at && subscriber.auth.token_expires_at < new Date()) {
      return res.status(401).json({ error: 'Session expired. Please login again.' });
    }

    req.subscriber = subscriber;
    req.subscriberId = subscriber.id;
    req.token = token;
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

module.exports = portalAuth;
module.exports.PORTAL_COOKIE_NAME = PORTAL_COOKIE_NAME;
