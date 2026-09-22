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
  // Pay-by-link is authorised by a single-purpose token in the URL, not by ambient
  // cookies, so CSRF is not the control that protects it. Anyone able to forge the
  // request would need the token — and with the token they could simply open the link
  // themselves. Without this, the page breaks for anyone who also holds a j2_csrf
  // cookie from the CRM on the same domain, which is exactly who tests it first.
  '/api/paylink',
  // The walled garden. Every route here is public and unauthenticated by design —
  // server.js says so where it mounts them — and /pay resolves the subscriber from
  // the connection the request arrives on, never from a cookie. It can only ever act
  // on the line the caller is physically sitting on, and both routes are rate limited.
  // CSRF defends against a third-party site spending someone's ambient credentials;
  // there are none here. Same argument as /api/paylink above.
  //
  // Without this, Pay Now returns 403 for anyone whose browser also holds a j2_csrf
  // cookie from the CRM on this domain — which is exactly the staff who test it.
  '/api/restricted',
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
