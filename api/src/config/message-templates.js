// ============================================================
// NETFACTORY — Editable Message Templates
// ============================================================
// The email HTML and SMS text that goes to subscribers lives in code:
//   • src/routes/notifications.js — the status-flow messages
//   • src/config/email.js / sms.js — billing, payment and password messages
//
// This module lets staff override that text from the CRM without a deploy.
// A row in message_templates REPLACES the default for one (channel, key);
// remove the row and the code default is back. Nothing here changes WHEN a
// message is sent or WHO it goes to — only the wording.
//
// Lookups are synchronous on purpose. There are ~18 call sites that render a
// template inside an already-synchronous block, and making them async would
// mean touching every one. So the overrides sit in a TTL cache refreshed by
// middleware — the same shape as src/middleware/systemToggles.js — and a save
// from the panel refreshes it immediately rather than waiting for the TTL.
// ============================================================

const CACHE_TTL = 30_000;

/** Map of "channel:key" → { subject, body, enabled }. Empty until first load. */
let cache = new Map();
let lastFetch = 0;
let loaded = false;

// ── Placeholder rendering ───────────────────────────────────

/**
 * Substitute {{field}} against the data object, and {{company.field}} against
 * the company object.
 *
 * A field the caller did not supply renders as an EMPTY STRING, never the word
 * "undefined". That is not a stylistic choice: a welcome SMS once went out to
 * subscribers reading "Account: undefined, Plan: undefined" because a caller
 * omitted two fields, and an editable template makes that mistake much easier
 * to make. Empty is quiet and harmless; "undefined" is not.
 */
function render(str, data, company) {
  if (!str) return '';
  return String(str).replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (_, path) => {
    const src = path.startsWith('company.') ? company : data;
    const key = path.startsWith('company.') ? path.slice(8) : path;
    const val = src ? src[key] : undefined;
    return (val === undefined || val === null) ? '' : String(val);
  });
}

/** Every {{placeholder}} used in a string, deduplicated. */
function placeholdersUsed(str) {
  const out = new Set();
  String(str || '').replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (_, p) => { out.add(p); return ''; });
  return [...out];
}

// ── Email body extraction / splicing ────────────────────────
// Both email wrappers (notifications.js emailWrap, config/email.js emailShell)
// fence the body content between these two comments. Staff edit only what is
// between them, so the branded header, the footer and the live company details
// are never something they can accidentally delete.

const BODY_START = '<!--BODY_START-->';
const BODY_END = '<!--BODY_END-->';

/** Pull the editable body out of a fully rendered default email. */
function extractBody(html) {
  const a = String(html || '').indexOf(BODY_START);
  const b = String(html || '').indexOf(BODY_END);
  if (a === -1 || b === -1 || b < a) return null;
  return html.slice(a + BODY_START.length, b);
}

/** Put an edited body back into the default email's wrapper. */
function spliceBody(html, newBody) {
  const a = String(html || '').indexOf(BODY_START);
  const b = String(html || '').indexOf(BODY_END);
  if (a === -1 || b === -1 || b < a) return html;
  return html.slice(0, a + BODY_START.length) + newBody + html.slice(b);
}

// ── Cache ───────────────────────────────────────────────────

async function refreshCache(prisma) {
  try {
    const rows = await prisma.$queryRaw`
      SELECT channel, template_key, subject, body, enabled FROM message_templates`;
    const next = new Map();
    for (const r of rows) {
      // A row is kept even when the message is switched off, so the wording is
      // still there to come back to when it is switched on again.
      next.set(`${r.channel}:${r.template_key}`, { subject: r.subject, body: r.body, enabled: r.enabled });
    }
    cache = next;
    lastFetch = Date.now();
    loaded = true;
  } catch (err) {
    // A missing table or an unreachable DB must never stop a message going out —
    // every caller falls back to the hardcoded default when the cache is empty.
    console.error('[Templates] Failed to refresh cache:', err.message);
  }
}

function isStale() { return Date.now() - lastFetch > CACHE_TTL; }

/** The override for one template, or null to use the code default. */
function getOverride(channel, key) {
  return cache.get(`${channel}:${key}`) || null;
}

/**
 * True when staff have switched this message off. Callers must then send
 * NOTHING — an off switch that still delivered an empty message would be worse
 * than no switch at all.
 */
function isDisabled(channel, key) {
  const o = cache.get(`${channel}:${key}`);
  return !!o && o.enabled === false;
}

/** Express middleware — keeps the cache warm, mirroring systemToggles(). */
function messageTemplates() {
  return async (req, res, next) => {
    if (isStale() && req.prisma) refreshCache(req.prisma).catch(() => {});
    next();
  };
}

// ── Applying an override ────────────────────────────────────

/**
 * Render an SMS, preferring the staff override.
 * @param {string} key       template key
 * @param {object} data      per-message fields
 * @param {object} company   company info from system_settings
 * @param {Function} fallback  () => string — the hardcoded default
 */
function renderSms(key, data, company, fallback) {
  // null, not '' — every caller already guards with `if (text)`, so returning
  // null suppresses the send rather than delivering a blank text.
  if (isDisabled('sms', key)) return null;
  const o = getOverride('sms', key);
  if (o && o.body) return render(o.body, data, company);
  return fallback();
}

/**
 * Render an email, preferring the staff override.
 * The override supplies the subject and the body content; the wrapper, accent
 * colour and badge all still come from the default, so branding stays intact
 * and a template nobody has edited is byte-for-byte what it always was.
 * @param {Function} fallback  () => ({ subject, html })
 */
function renderEmail(key, data, company, fallback) {
  if (isDisabled('email', key)) return null;
  const def = fallback();
  if (!def) return def;
  const o = getOverride('email', key);
  if (!o) return def;
  return {
    subject: o.subject ? render(o.subject, data, company) : def.subject,
    html: o.body ? spliceBody(def.html, render(o.body, data, company)) : def.html,
  };
}

module.exports = {
  render, placeholdersUsed,
  extractBody, spliceBody, BODY_START, BODY_END,
  refreshCache, getOverride, isDisabled, messageTemplates,
  renderSms, renderEmail,
  isLoaded: () => loaded,
};
