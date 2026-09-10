// ============================================================
// SYSTEM TOGGLES MIDDLEWARE
// ============================================================
// Caches toggle states from system_settings table.
// Wraps req.config.sms and req.config.email so they check
// the toggle before actually sending.
// ============================================================

const TOGGLE_KEYS = ['sms_enabled', 'email_enabled', 'geoblock_enabled', 'promotions_enabled', 'careers_enabled', 'promotions_notify_subscribers'];
const CACHE_TTL = 30_000; // refresh from DB every 30 seconds

let cache = {
  sms_enabled: true,
  email_enabled: true,
  geoblock_enabled: false,
  promotions_enabled: false,
  careers_enabled: false,
  promotions_notify_subscribers: false,
};
let lastFetch = 0;

/**
 * Load toggle values from the database.
 * Called on first request and every CACHE_TTL ms thereafter.
 */
async function refreshCache(prisma) {
  try {
    const rows = await prisma.system_settings.findMany({
      where: { key: { in: TOGGLE_KEYS } },
      select: { key: true, value: true },
    });
    rows.forEach(r => {
      cache[r.key] = r.value === 'true' || r.value === '1';
    });
    lastFetch = Date.now();
  } catch (err) {
    console.error('[Toggles] Failed to refresh cache:', err.message);
  }
}

/**
 * Get current toggle state (from cache).
 */
function getToggle(key) {
  return !!cache[key];
}

/**
 * Set a toggle value (writes to DB and updates cache).
 */
async function setToggle(prisma, key, value, updatedBy) {
  if (!TOGGLE_KEYS.includes(key)) {
    throw new Error(`Unknown toggle: ${key}`);
  }
  const strVal = value ? 'true' : 'false';
  await prisma.system_settings.upsert({
    where: { key },
    create: { key, value: strVal, category: 'toggles', label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), updated_by: updatedBy },
    update: { value: strVal, updated_by: updatedBy },
  });
  cache[key] = !!value;
  return cache[key];
}

/**
 * Express middleware: refreshes cache, wraps sms/email with toggle checks.
 */
function systemToggles() {
  return async (req, res, next) => {
    // Refresh cache if stale
    if (Date.now() - lastFetch > CACHE_TTL && req.prisma) {
      await refreshCache(req.prisma);
    }

    // Attach toggle accessor to request
    req.toggles = { ...cache };

    // Wrap SMS send to check toggle
    if (req.config && req.config.sms) {
      const origSmsSend = req.config.sms.send.bind(req.config.sms);
      const origSmsPriority = req.config.sms.sendPriority ? req.config.sms.sendPriority.bind(req.config.sms) : null;
      const origSmsTemplate = req.config.sms.sendTemplate ? req.config.sms.sendTemplate.bind(req.config.sms) : null;
      const origSmsOTP = req.config.sms.sendOTP ? req.config.sms.sendOTP.bind(req.config.sms) : null;

      req.config.sms = Object.create(req.config.sms);

      req.config.sms.send = async (...args) => {
        if (!cache.sms_enabled) {
          console.log('[SMS] ⏸ Disabled by system toggle — skipping send to:', args[0]);
          return { ok: false, skipped: true, reason: 'SMS disabled by system toggle' };
        }
        return origSmsSend(...args);
      };
      if (origSmsPriority) {
        req.config.sms.sendPriority = async (...args) => {
          if (!cache.sms_enabled) {
            console.log('[SMS] ⏸ Disabled by system toggle — skipping priority send to:', args[0]);
            return { ok: false, skipped: true, reason: 'SMS disabled by system toggle' };
          }
          return origSmsPriority(...args);
        };
      }
      if (origSmsTemplate) {
        req.config.sms.sendTemplate = async (...args) => {
          if (!cache.sms_enabled) {
            console.log('[SMS] ⏸ Disabled by system toggle — skipping template send to:', args[0]);
            return { ok: false, skipped: true, reason: 'SMS disabled by system toggle' };
          }
          return origSmsTemplate(...args);
        };
      }
      if (origSmsOTP) {
        req.config.sms.sendOTP = async (...args) => {
          if (!cache.sms_enabled) {
            console.log('[SMS] ⏸ Disabled by system toggle — skipping OTP send to:', args[0]);
            return { ok: false, skipped: true, reason: 'SMS disabled by system toggle' };
          }
          return origSmsOTP(...args);
        };
      }
    }

    // Wrap Email send to check toggle
    if (req.config && req.config.email) {
      const origEmailSend = req.config.email.send.bind(req.config.email);
      const origEmailTemplate = req.config.email.sendTemplate ? req.config.email.sendTemplate.bind(req.config.email) : null;

      req.config.email = Object.create(req.config.email);

      req.config.email.send = async (...args) => {
        if (!cache.email_enabled) {
          const to = args[0]?.to || args[0];
          console.log('[EMAIL] ⏸ Disabled by system toggle — skipping send to:', to);
          return { ok: false, skipped: true, reason: 'Email disabled by system toggle' };
        }
        return origEmailSend(...args);
      };
      if (origEmailTemplate) {
        req.config.email.sendTemplate = async (...args) => {
          if (!cache.email_enabled) {
            console.log('[EMAIL] ⏸ Disabled by system toggle — skipping template send to:', args[0]);
            return { ok: false, skipped: true, reason: 'Email disabled by system toggle' };
          }
          return origEmailTemplate(...args);
        };
      }
    }

    next();
  };
}

module.exports = { systemToggles, getToggle, setToggle, refreshCache, TOGGLE_KEYS, cache };
