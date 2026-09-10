const crypto = require('crypto');
const CSRF_COOKIE_NAME = 'j2_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';
const PROTECTED_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'];
const EXEMPT_PATHS = [
  '/api/webhooks',
  '/api/public',
  '/api/admin/login',
  '/api/portal/login',
  '/api/health',
  '/api/bugs',
];

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function setCsrfCookie(res, token, isProduction = true) {
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function csrfProtection(options = {}) {
  return (req, res, next) => {
    if (!PROTECTED_METHODS.includes(req.method)) return next();
    const isExempt = EXEMPT_PATHS.some(path => req.path.startsWith(path));
    if (isExempt) return next();

    // Skip CSRF if using Bearer token auth (not vulnerable to CSRF)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) return next();

    // Skip if no CSRF cookie (backward compat for old sessions)
    const cookieToken = req.cookies[CSRF_COOKIE_NAME];
    if (!cookieToken) return next();

    const headerToken = req.headers[CSRF_HEADER_NAME];
    if (!headerToken) return res.status(403).json({ error: 'CSRF token missing. Please refresh the page and try again.' });
    if (cookieToken !== headerToken) return res.status(403).json({ error: 'CSRF token mismatch. Please refresh the page and try again.' });

    next();
  };
}

module.exports = { csrfProtection, generateToken, setCsrfCookie, CSRF_COOKIE_NAME };
