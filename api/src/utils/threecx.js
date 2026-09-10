// ============================================================
// utils/threecx.js — 3CX V20 Token Manager & XAPI Proxy
// OAuth2 client_credentials flow, cached token, auto-refresh
// Config stored in system_settings (hot-reconfigurable)
// ============================================================

const fetch = require('node-fetch');

let _token = null;   // { access_token, expires_at }
let _configCache = null;
let _configCacheAt = 0;
const CONFIG_TTL = 30_000; // re-read config every 30s

// ── Read 3CX config from system_settings ────────────────────
async function getConfig(prisma) {
  const now = Date.now();
  if (_configCache && (now - _configCacheAt) < CONFIG_TTL) return _configCache;

  const rows = await prisma.system_settings.findMany({
    where: { key: { startsWith: '3cx_' } }
  });
  const cfg = {};
  rows.forEach(r => { cfg[r.key] = r.value; });

  _configCache = {
    enabled:          cfg['3cx_enabled'] === 'true',
    fqdn:             cfg['3cx_fqdn'] || '',
    clientId:         cfg['3cx_client_id'] || '',
    clientSecret:     cfg['3cx_client_secret'] || '',
    webhookSecret:    cfg['3cx_webhook_secret'] || '',
    defaultExtension: cfg['3cx_default_extension'] || '100',
  };
  _configCacheAt = now;
  return _configCache;
}

// ── Get OAuth2 bearer token (cached, auto-refresh) ─────────
async function getToken(prisma) {
  const cfg = await getConfig(prisma);
  if (!cfg.enabled || !cfg.fqdn || !cfg.clientId || !cfg.clientSecret) {
    throw new Error('3CX not configured');
  }

  // Return cached token if still valid (5 min buffer)
  if (_token && _token.expires_at > Date.now() + 5 * 60 * 1000) {
    return _token.access_token;
  }

  const url = `https://${cfg.fqdn}/connect/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`3CX token error: ${res.status} ${errText}`);
  }

  const data = await res.json();
  _token = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
  console.log('[3CX] Token acquired, expires in', data.expires_in, 'sec');
  return _token.access_token;
}

// ── XAPI request proxy ─────────────────────────────────────
async function xapiRequest(prisma, method, path, body = null) {
  const cfg = await getConfig(prisma);
  const token = await getToken(prisma);
  const url = `https://${cfg.fqdn}/xapi/v1${path}`;

  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body && method !== 'GET') {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);

  // If 401, invalidate token and retry once
  if (res.status === 401) {
    invalidateToken();
    const newToken = await getToken(prisma);
    opts.headers.Authorization = `Bearer ${newToken}`;
    const retry = await fetch(url, opts);
    if (!retry.ok) {
      const errText = await retry.text().catch(() => '');
      throw new Error(`3CX XAPI error: ${retry.status} ${errText}`);
    }
    const text = await retry.text();
    return text ? JSON.parse(text) : null;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`3CX XAPI error: ${res.status} ${errText}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Invalidate cached token ─────────────────────────────────
function invalidateToken() {
  _token = null;
}

// ── Invalidate config cache (call after settings update) ────
function invalidateConfig() {
  _configCache = null;
  _configCacheAt = 0;
}

// ── Normalize Philippine phone numbers for 3CX ──────────────
// Handles: 09XX, +639XX, 639XX, 9XX → +639XX
function normalizeFor3cx(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/[\s\-()]/g, '');

  // Already international format
  if (cleaned.startsWith('+63')) return cleaned;
  // Missing + prefix
  if (cleaned.startsWith('63') && cleaned.length >= 12) return '+' + cleaned;
  // Local format 09XX
  if (cleaned.startsWith('0') && cleaned.length === 11) return '+63' + cleaned.slice(1);
  // Short format 9XX
  if (cleaned.startsWith('9') && cleaned.length === 10) return '+63' + cleaned;

  return cleaned; // Return as-is for landlines / other formats
}

// ── Match phone (last 10 digits comparison) ─────────────────
function phoneLast10(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '').slice(-10);
}

module.exports = {
  getConfig,
  getToken,
  xapiRequest,
  invalidateToken,
  invalidateConfig,
  normalizeFor3cx,
  phoneLast10,
};
