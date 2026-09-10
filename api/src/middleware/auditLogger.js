// ============================================================
// NETFACTORY — Audit Logger Middleware
// ============================================================
// Deploy to: src/middleware/auditLogger.js
//
// Attaches req.auditLog(action, details) to every request.
// Call from any route handler to record an audit event.
//
// Usage in routes:
//   await req.auditLog('LOGIN', { method: 'password', success: true });
//   await req.auditLog('SUBSCRIBER_CREATE', { account: 'YYMM000001', plan: 'PLAN A' });
//   await req.auditLog('PAYMENT_ACCEPT', { invoice: 'INV-260200001', amount: 1500 });
// ============================================================

/**
 * Extract the client's public IP from request headers.
 * Priority: X-Forwarded-For → X-Real-IP → req.ip
 */
function getPublicIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // X-Forwarded-For can contain multiple IPs: client, proxy1, proxy2
    // First IP is the original client
    const firstIP = forwarded.split(',')[0].trim();
    return firstIP;
  }

  const realIP = req.headers['x-real-ip'];
  if (realIP) return realIP.trim();

  // Fallback — strip ::ffff: prefix from IPv4-mapped IPv6
  const raw = req.ip || req.socket?.remoteAddress || null;
  if (raw && raw.startsWith('::ffff:')) return raw.slice(7);
  return raw;
}

/**
 * Extract the client's local/private IP from custom header.
 * The frontend sends this via X-Local-IP header.
 */
function getLocalIP(req) {
  return req.headers['x-local-ip'] || null;
}

/**
 * Audit Logger Middleware
 * 
 * Attaches req.auditLog() to every request.
 * Captures IP, user agent, and authenticated user context automatically.
 */
function auditLogger() {
  return (req, res, next) => {

    /**
     * Log an audit event.
     * 
     * @param {string} action     - Action code (LOGIN, PAYMENT_MADE, SUBSCRIBER_CREATE, etc.)
     * @param {object} details    - Action-specific payload (optional)
     * @param {object} overrides  - Override auto-detected fields (optional)
     *   @param {string} overrides.log_source  - 'portal' or 'crm' (auto-detected from route)
     *   @param {number} overrides.user_id     - Override authenticated user ID
     *   @param {string} overrides.username    - Override username/account
     */
    req.auditLog = async (action, details = {}, overrides = {}) => {
      try {
        // Auto-detect source from the route path
        let logSource = overrides.log_source || null;
        if (!logSource) {
          if (req.originalUrl.startsWith('/api/portal')) {
            logSource = 'portal';
          } else if (req.originalUrl.startsWith('/api/admin') || req.originalUrl.startsWith('/api/audit')) {
            logSource = 'crm';
          } else {
            logSource = 'crm'; // Default to CRM for unmatched routes
          }
        }

        // Resolve user identity
        // Portal users: req.subscriber (set by portal auth middleware)
        // CRM users: req.user (set by admin auth middleware)
        let userId = overrides.user_id || null;
        let username = overrides.username || 'SYSTEM';

        if (!overrides.user_id && !overrides.username) {
          if (req.subscriber) {
            userId = req.subscriber.id;
            username = req.subscriber.account_number || req.subscriber.email || 'SUBSCRIBER';
          } else if (req.admin) {
            userId = req.admin.id;
            username = req.admin.username || req.admin.full_name || 'ADMIN';
          }
        }

        // Build the audit record
        const record = {
          log_source: logSource,
          user_id:    userId,
          username:   String(username).toUpperCase(),
          action:     String(action).toUpperCase(),
          details:    details,
          public_ip:  getPublicIP(req),
          local_ip:   getLocalIP(req),
          user_agent: req.headers['user-agent'] || null,
        };

        // Write to database (non-blocking — don't await in critical path if needed)
        await req.prisma.auditLog.create({ data: record });

      } catch (err) {
        // NEVER let audit logging break the actual request
        console.error('[AUDIT] Failed to write audit log:', err.message);
        console.error('[AUDIT] Action:', action, 'Details:', JSON.stringify(details));
      }
    };

    next();
  };
}

module.exports = auditLogger;
