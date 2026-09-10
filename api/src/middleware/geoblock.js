// ============================================================
// GEOBLOCK MIDDLEWARE — IP Geolocation Filtering
// ============================================================
// Blocks requests from countries not in the allowed list.
// Uses geoip-lite for fast in-memory IP lookups.
// Toggle controlled via system_settings (geoblock_enabled).
// ============================================================

let geoip;
try {
  geoip = require('geoip-lite');
} catch (e) {
  console.warn('[GeoBlock] geoip-lite not installed — geoblock disabled');
  geoip = null;
}

// Countries allowed to access the site
const ALLOWED_COUNTRIES = ['PH', 'US'];

// J2's own APNIC-allocated IP blocks. Always allowed regardless of geoip
// lookup, because the bundled geoip-lite data is stale and mis-flags these
// ranges as JP. APNIC truth: J2-PILAR-BATAAN, country PH.
const J2_IP_RANGES = [
  '126.209.73.128/28', // J2-PILAR-BATAAN — 126.209.73.128 - .143
];

// Paths that bypass geoblock (health checks, webhooks, etc.)
const EXEMPT_PATHS = [
  '/api/health',
  '/api/webhooks',
  '/api/public',
];

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n * 256) + o;
  }
  return n >>> 0;
}

const J2_RANGES_PARSED = J2_IP_RANGES.map(cidr => {
  const [base, bitsStr] = cidr.split('/');
  const baseInt = ipv4ToInt(base);
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { start: (baseInt & mask) >>> 0, end: ((baseInt & mask) | (~mask >>> 0)) >>> 0 };
});

function isJ2IP(ip) {
  if (!ip) return false;
  const clean = ip.replace(/^::ffff:/, '');
  const n = ipv4ToInt(clean);
  if (n === null) return false;
  return J2_RANGES_PARSED.some(r => n >= r.start && n <= r.end);
}

// Private/local IP ranges that should always be allowed
function isPrivateIP(ip) {
  if (!ip) return true;
  // Strip IPv6 prefix
  const clean = ip.replace(/^::ffff:/, '');
  return (
    clean === '127.0.0.1' ||
    clean === '::1' ||
    clean === 'localhost' ||
    clean.startsWith('10.') ||
    clean.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(clean) ||
    clean.startsWith('100.64.') // CGNAT
  );
}

/**
 * Extract real client IP from request.
 * Respects X-Forwarded-For and X-Real-IP headers (set by nginx).
 */
function getClientIP(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    // First IP in the chain is the original client
    return xff.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.ip || req.connection?.remoteAddress || '';
}

/**
 * Lookup country code for an IP address.
 * Returns 2-letter ISO code (e.g., 'PH', 'US') or null.
 */
function lookupCountry(ip) {
  if (!geoip) return null;
  const clean = ip.replace(/^::ffff:/, '');
  const geo = geoip.lookup(clean);
  return geo?.country || null;
}

/**
 * Express middleware: blocks requests from non-allowed countries.
 * Only active when geoblock_enabled toggle is true.
 */
function geoblockMiddleware() {
  return (req, res, next) => {
    // Check if geoblock is enabled via toggles (attached by systemToggles middleware)
    if (!req.toggles?.geoblock_enabled) {
      return next();
    }

    // Skip exempt paths
    const isExempt = EXEMPT_PATHS.some(p => req.path.startsWith(p));
    if (isExempt) return next();

    // Get client IP
    const ip = getClientIP(req);

    // Always allow private/local IPs
    if (isPrivateIP(ip)) return next();

    // Always allow J2's own IP blocks (overrides stale geoip data)
    if (isJ2IP(ip)) return next();

    // Lookup country
    const country = lookupCountry(ip);

    // If geoip-lite is not installed or lookup fails, allow through
    if (!country) {
      console.warn(`[GeoBlock] Could not determine country for IP: ${ip} — allowing`);
      return next();
    }

    // Check against allowed countries
    if (ALLOWED_COUNTRIES.includes(country)) {
      return next();
    }

    // Blocked
    console.log(`[GeoBlock] ✗ Blocked ${ip} (${country}) — ${req.method} ${req.path}`);

    // For API requests, return JSON
    if (req.path.startsWith('/api')) {
      return res.status(403).json({
        error: 'Access restricted',
        message: 'This service is not available in your region.',
      });
    }

    // For web pages, return a simple HTML page
    return res.status(403).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Access Restricted — Netfactory</title>
  <style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
      background:#0c1222; color:#e8ecf4; font-family:system-ui,-apple-system,sans-serif; }
    .box { text-align:center; max-width:480px; padding:40px; }
    .logo { display:inline-flex; align-items:center; justify-content:center;
      width:56px; height:56px; border-radius:14px; background:linear-gradient(135deg,#60a5fa,#3b82f6);
      color:#fff; font-weight:900; font-size:20px; margin-bottom:20px; }
    h1 { font-size:24px; margin:0 0 12px; }
    p { color:#8896b0; font-size:15px; line-height:1.6; margin:0; }
  </style>
</head>
<body>
  <div class="box">
    <div class="logo">NF</div>
    <h1>Access Restricted</h1>
    <p>Netfactory services are currently only available in the Philippines and United States.
    If you believe this is an error, please contact support.</p>
  </div>
</body>
</html>`);
  };
}

module.exports = { geoblockMiddleware, lookupCountry, getClientIP, isPrivateIP, isJ2IP, ALLOWED_COUNTRIES, J2_IP_RANGES };
