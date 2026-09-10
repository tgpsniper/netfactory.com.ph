// ============================================================
// utils/smartolt.js — SmartOLT cloud API client
// ============================================================
// SmartOLT (https://www.smartolt.com) manages remote OLTs (incl. the
// ZTE C650 at the Colgante POP) through an on-site controller and
// exposes everything over a cloud REST API. Unlike the direct
// SNMP/telnet path in utils/vsol-olt.js, this reaches the OLT over the
// public internet — so nf-crm CAN use it even though it has no route to
// the OLT's management IP.
//
// API shape (SmartOLT REST v1):
//   Base:   https://<subdomain>.smartolt.com/api/
//   Auth:   header  X-Token: <api_token>
//   Result: JSON  { "status": true, ...payload }  on success
//                 { "status": false, "error_code": "...",
//                   "error_message": "..." }  on failure
//
// Config lives in system_settings (category 'integrations'), with
// .env fallback so it can be wired before the CRM UI is used:
//   smartolt_enabled          | SMARTOLT_ENABLED
//   smartolt_subdomain / _url  | SMARTOLT_SUBDOMAIN / SMARTOLT_URL
//   smartolt_api_token        | SMARTOLT_API_TOKEN   (never logged/returned)
//   smartolt_olt_device_id    | (which olt_devices row to sync into)
//
// The exact field names SmartOLT returns per ONU can vary a little by
// account/OLT vendor; parsers below are deliberately tolerant and the
// raw object is preserved so callers can adapt without a redeploy.
// ============================================================

'use strict';

const SETTINGS_KEYS = [
  'smartolt_enabled',
  'smartolt_subdomain',
  'smartolt_url',
  'smartolt_api_token',
  'smartolt_olt_device_id',
];

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 30_000;

function invalidateSettings() {
  _cache = null;
  _cacheAt = 0;
}

// Accept a bare subdomain ("netfactory"), a host ("netfactory.smartolt.com")
// or a full URL, and normalise to a scheme+host base with no trailing slash.
function normaliseBaseUrl(subdomain, url) {
  let raw = (url || '').trim();
  if (!raw && subdomain) {
    const s = String(subdomain).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    raw = s.includes('.') ? s : `${s}.smartolt.com`;
  }
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  return raw.replace(/\/+$/, '');
}

async function getSettings(prisma) {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) return _cache;

  let rows = [];
  try {
    rows = await prisma.system_settings.findMany({ where: { key: { in: SETTINGS_KEYS } } });
  } catch (_) { /* fall through to env-only */ }
  const s = {};
  for (const r of rows) s[r.key] = r.value;

  const enabled = (s.smartolt_enabled ?? process.env.SMARTOLT_ENABLED) === 'true';
  const base = normaliseBaseUrl(
    s.smartolt_subdomain || process.env.SMARTOLT_SUBDOMAIN,
    s.smartolt_url || process.env.SMARTOLT_URL,
  );
  const token = s.smartolt_api_token || process.env.SMARTOLT_API_TOKEN || '';
  const oltDeviceId = parseInt(s.smartolt_olt_device_id || process.env.SMARTOLT_OLT_DEVICE_ID || '', 10) || null;

  _cache = { enabled, base, token, oltDeviceId, configured: !!(base && token) };
  _cacheAt = Date.now();
  return _cache;
}

// Core request. Throws Error on transport failure or { status:false }.
async function apiRequest(prisma, path, { method = 'GET', query, body, timeoutMs = 15000 } = {}) {
  const cfg = await getSettings(prisma);
  if (!cfg.base || !cfg.token) {
    const err = new Error('SmartOLT is not configured (missing subdomain/URL or API token)');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  let url = `${cfg.base}/api/${String(path).replace(/^\/+/, '')}`;
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.append(k, v);
    url += `?${qs.toString()}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp, text;
  try {
    const opts = {
      method,
      headers: { 'X-Token': cfg.token, Accept: 'application/json' },
      signal: controller.signal,
    };
    if (body !== undefined) {
      // SmartOLT accepts form-encoded bodies for its POST actions.
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) form.append(k, v);
      opts.body = form;
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    resp = await fetch(url, opts);
    text = await resp.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`SmartOLT request timed out after ${timeoutMs}ms`);
    throw new Error(`SmartOLT request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch (_) { throw new Error(`SmartOLT returned non-JSON (HTTP ${resp.status})`); }

  if (data && data.status === false) {
    const msg = data.error_message || data.error_code || `HTTP ${resp.status}`;
    const err = new Error(`SmartOLT API error: ${msg}`);
    err.apiError = data;
    throw err;
  }
  if (!resp.ok && data.status === undefined) {
    throw new Error(`SmartOLT HTTP ${resp.status}`);
  }
  return data;
}

// ── Normalisers ─────────────────────────────────────────────
// Pull a value from the first key that exists (SmartOLT field names
// vary a little across accounts / OLT vendors).
function pick(obj, ...keys) {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return null;
}

function normStatus(raw) {
  const v = String(raw || '').toLowerCase();
  if (!v) return 'unknown';
  if (v.includes('online') || v === 'ok' || v === 'working') return 'online';
  if (v.includes('los') || v.includes('offline') || v.includes('power') || v.includes('dying') || v.includes('down')) return 'offline';
  return v;
}

function normOnu(o) {
  return {
    external_id: pick(o, 'unique_external_id', 'onu_external_id', 'external_id', 'id'),
    serial: (pick(o, 'sn', 'serial_number', 'serial') || '').toUpperCase(),
    status: normStatus(pick(o, 'status', 'onu_status', 'status_text')),
    status_raw: pick(o, 'status', 'onu_status'),
    name: pick(o, 'name', 'onu_name', 'customer'),
    zone: pick(o, 'zone', 'zone_name'),
    board: pick(o, 'board'),
    port: pick(o, 'port', 'pon_port'),
    onu: pick(o, 'onu', 'onu_id'),
    onu_type: pick(o, 'onu_type', 'onu_type_name'),
    rx_power: pick(o, 'onu_rx_power', 'rx_power', 'signal_1310', 'signal'),
    tx_power: pick(o, 'onu_tx_power', 'tx_power', 'signal_1490'),
    olt_id: pick(o, 'olt_id', 'olt'),
    vlan: pick(o, 'vlan'),
    raw: o,
  };
}

function extractOnuArray(data) {
  if (Array.isArray(data)) return data;
  for (const k of ['onus', 'response', 'data', 'result', 'onus_details']) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  return [];
}

// ── Convenience calls ───────────────────────────────────────
async function getSystemStatus(prisma) {
  return apiRequest(prisma, 'system/get_system_status', { timeoutMs: 10000 });
}

async function getAllOnus(prisma) {
  const data = await apiRequest(prisma, 'onu/get_all_onus_details');
  return extractOnuArray(data).map(normOnu);
}

async function getUnconfiguredOnus(prisma) {
  const data = await apiRequest(prisma, 'onu/unconfigured_onus');
  return extractOnuArray(data).map(normOnu);
}

async function getOnuStatus(prisma, externalId) {
  return apiRequest(prisma, `onu/get_onu_full_status_info/${encodeURIComponent(externalId)}`);
}

async function getOnuSignal(prisma, externalId) {
  return apiRequest(prisma, `onu/get_onu_signal/${encodeURIComponent(externalId)}`);
}

// Control ops — POST actions, only meaningful once a controller is live.
async function rebootOnu(prisma, externalId) {
  return apiRequest(prisma, `onu/reboot_onu/${encodeURIComponent(externalId)}`, { method: 'POST' });
}
async function enableOnu(prisma, externalId) {
  return apiRequest(prisma, `onu/enable_onu/${encodeURIComponent(externalId)}`, { method: 'POST' });
}
async function disableOnu(prisma, externalId) {
  return apiRequest(prisma, `onu/disable_onu/${encodeURIComponent(externalId)}`, { method: 'POST' });
}

module.exports = {
  invalidateSettings,
  getSettings,
  apiRequest,
  getSystemStatus,
  getAllOnus,
  getUnconfiguredOnus,
  getOnuStatus,
  getOnuSignal,
  rebootOnu,
  enableOnu,
  disableOnu,
  normOnu,
  normStatus,
  extractOnuArray,
};
