// ============================================================
// utils/xconnect.js — XConnect / Xtream UI client
// ============================================================
// Hybrid client:
//   * Reads (lookups, list, display)  → direct MariaDB on the XUI host
//   * Writes (create/edit/enable/etc) → panel session (login.php / user.php / api.php)
//
// `users` table = IPTV customer lines (matched to CRM by username = account_number).
// `reg_users` table = panel logins (admins/resellers) — NOT touched here anymore.
//
// Config from system_settings:
//   xconnect_url        — panel base URL, e.g. http://10.0.108.33:25500
//   xconnect_username   — panel admin username
//   xconnect_password   — panel admin password
//   xconnect_enabled    — 'true' to allow operations
//   xui_db_host/port/name/user/pass — direct MariaDB credentials
// ============================================================

const { PrismaClient } = require('@prisma/client');
const mysql = require('mysql2/promise');
const prisma = new PrismaClient();

const SETTINGS_TTL_MS = 30 * 1000;
const SESSION_TTL_MS = 25 * 60 * 1000;

let settingsCache = { value: null, expires: 0 };
let session = { cookie: null, expires: 0 };
let dbPool = null;
let dbPoolConfig = null;
let bouquetCache = { value: null, expires: 0 };
const BOUQUET_TTL_MS = 60 * 1000;

// ───────── settings ─────────
async function getSettings() {
  if (Date.now() < settingsCache.expires && settingsCache.value) return settingsCache.value;
  const rows = await prisma.system_settings.findMany({
    where: { OR: [{ key: { startsWith: 'xconnect_' } }, { key: { startsWith: 'xui_db_' } }] },
  });
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  const value = {
    enabled: map.xconnect_enabled === 'true',
    url: (map.xconnect_url || '').replace(/\/$/, ''),
    username: map.xconnect_username || '',
    password: map.xconnect_password || '',
    db: {
      host: map.xui_db_host || '',
      port: parseInt(map.xui_db_port || '3306', 10),
      database: map.xui_db_name || '',
      user: map.xui_db_user || '',
      password: map.xui_db_pass || '',
    },
  };
  settingsCache = { value, expires: Date.now() + SETTINGS_TTL_MS };
  return value;
}

function invalidateSettings() {
  settingsCache = { value: null, expires: 0 };
  bouquetCache = { value: null, expires: 0 };
  iptvCache = { value: null, expires: 0 };
  liveCatCache = { value: null, expires: 0 };
  vodCatCache = { value: null, expires: 0 };
  seriesCatCache = { value: null, expires: 0 };
  if (dbPool) { dbPool.end().catch(() => {}); dbPool = null; dbPoolConfig = null; }
}

// ───────── MariaDB pool ─────────
async function getDb() {
  const s = await getSettings();
  const cfgKey = `${s.db.host}:${s.db.port}/${s.db.database}@${s.db.user}`;
  if (dbPool && dbPoolConfig === cfgKey) return dbPool;
  if (dbPool) { try { await dbPool.end(); } catch (e) {} }
  if (!s.db.host || !s.db.database || !s.db.user) throw new Error('XUI DB not configured');
  dbPool = mysql.createPool({
    host: s.db.host, port: s.db.port, database: s.db.database,
    user: s.db.user, password: s.db.password,
    connectionLimit: 4, waitForConnections: true, connectTimeout: 5000,
  });
  dbPoolConfig = cfgKey;
  return dbPool;
}

// ───────── panel session (login.php / api.php / user.php) ─────────
async function login(force = false) {
  if (!force && session.cookie && Date.now() < session.expires) return session.cookie;
  const s = await getSettings();
  if (!s.url || !s.username || !s.password) throw new Error('XConnect not configured');

  const initRes = await fetch(`${s.url}/login.php`, { method: 'GET', redirect: 'manual' });
  const setCookie = initRes.headers.get('set-cookie') || '';
  const m = setCookie.match(/PHPSESSID=([^;]+)/);
  if (!m) throw new Error('XConnect: no PHPSESSID issued');
  const cookie = `PHPSESSID=${m[1]}`;

  const body = new URLSearchParams({ username: s.username, password: s.password, referrer: '' });
  const loginRes = await fetch(`${s.url}/login.php`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
  });
  const loc = loginRes.headers.get('location') || '';
  if (loginRes.status !== 302 || !/dashboard\.php/.test(loc)) {
    throw new Error(`XConnect login failed (HTTP ${loginRes.status}, location: ${loc || 'none'})`);
  }
  session = { cookie, expires: Date.now() + SESSION_TTL_MS };
  return cookie;
}

function invalidateSession() { session = { cookie: null, expires: 0 }; }

async function authedFetch(path, init = {}) {
  const s = await getSettings();
  const cookie = await login();
  const exec = (c) => fetch(`${s.url}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Cookie: c },
    redirect: 'manual',
  });
  let res = await exec(cookie);
  const loc = res.headers.get('location') || '';
  if (res.status === 302 && /login\.php/.test(loc)) {
    invalidateSession();
    res = await exec(await login(true));
  }
  return res;
}

// ───────── IPTV line (users table) reads via DB ─────────

// Row → API-friendly shape. exp_date is Unix epoch (NULL/0 = no expire).
// Note: users.member_id and users.created_by both point to reg_users.id (the owner/reseller).
// There is NO per-user package field on the `users` table — packages are only a creation-time
// helper used to populate bouquets/max_connections/exp_date on the new line.
function shapeLine(row) {
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  const enabled = row.enabled === 1 && row.admin_enabled === 1;
  const expired = !!row.exp_date && row.exp_date > 0 && row.exp_date <= now;
  let bouquetIds = [];
  if (row.bouquet) {
    try { bouquetIds = JSON.parse(row.bouquet); } catch (e) { bouquetIds = []; }
  }
  return {
    id: row.id,
    username: row.username,
    password: row.password,
    expDate: row.exp_date ? new Date(row.exp_date * 1000).toISOString() : null,
    noExpire: !row.exp_date || row.exp_date === 0,
    maxConnections: row.max_connections,
    isTrial: row.is_trial === 1,
    isMag: row.is_mag === 1,
    isE2: row.is_e2 === 1,
    adminEnabled: row.admin_enabled === 1,
    enabled,
    expired,
    status: enabled ? (expired ? 'expired' : 'active') : 'disabled',
    createdAt: row.created_at ? new Date(row.created_at * 1000).toISOString() : null,
    ownerId: row.member_id,
    ownerName: row.owner_name || null,
    createdBy: row.created_by,
    createdByName: row.created_by_name || null,
    bouquetIds,
    adminNotes: row.admin_notes || '',
    resellerNotes: row.reseller_notes || '',
  };
}

const LINE_SELECT = `
  SELECT u.id, u.username, u.password, u.member_id, u.exp_date,
         u.admin_enabled, u.enabled, u.max_connections, u.is_trial, u.is_mag, u.is_e2,
         u.admin_notes, u.reseller_notes, u.created_at, u.created_by, u.bouquet,
         owner.username AS owner_name,
         creator.username AS created_by_name
  FROM users u
  LEFT JOIN reg_users owner   ON owner.id   = u.member_id
  LEFT JOIN reg_users creator ON creator.id = u.created_by
`;

async function getLine(id) {
  const db = await getDb();
  const [rows] = await db.execute(`${LINE_SELECT} WHERE u.id = ? LIMIT 1`, [id]);
  const line = shapeLine(rows[0]);
  if (line) attachBouquets(line, await getBouquetMap());
  return line;
}

async function getLineByUsername(username) {
  if (!username) return null;
  const db = await getDb();
  const [rows] = await db.execute(`${LINE_SELECT} WHERE u.username = ? LIMIT 1`, [username]);
  const line = shapeLine(rows[0]);
  if (line) attachBouquets(line, await getBouquetMap());
  return line;
}

async function listLines({ search = '', resellerId = null, start = 0, length = 25 } = {}) {
  const db = await getDb();
  const where = [];
  const params = [];
  if (search) { where.push('u.username LIKE ?'); params.push(`%${search}%`); }
  if (resellerId) { where.push('u.created_by = ?'); params.push(parseInt(resellerId, 10)); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await db.execute(
    `${LINE_SELECT} ${whereSql} ORDER BY u.id DESC LIMIT ${parseInt(length, 10)} OFFSET ${parseInt(start, 10)}`,
    params
  );
  const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM users u ${whereSql}`, params);
  const map = await getBouquetMap();
  return { total: Number(total), rows: rows.map(r => attachBouquets(shapeLine(r), map)) };
}

async function getPackages() {
  const db = await getDb();
  const [rows] = await db.execute(
    'SELECT id, package_name, is_trial, is_official, official_duration, official_duration_in, max_connections FROM packages ORDER BY id'
  );
  return rows.map(r => ({
    id: r.id, name: r.package_name,
    isTrial: r.is_trial === 1,
    isOfficial: r.is_official === 1,
    durationLabel: r.official_duration ? `${r.official_duration} ${r.official_duration_in}` : null,
    maxConnections: r.max_connections,
  }));
}

async function getResellers() {
  const db = await getDb();
  const [rows] = await db.execute(
    'SELECT id, username FROM reg_users WHERE member_group_id IN (1,4,5) ORDER BY id'
  );
  return rows.map(r => ({ id: r.id, name: r.username }));
}

// ───────── bouquets (catalog groups) ─────────
// The `bouquets` table holds the catalogue groups a line can be granted.
// `bouquet_channels` = JSON array of stream ids (the panel's "STREAMS" count),
// `bouquet_series`   = JSON array of series ids  (the panel's "SERIES" count).
function jsonLen(j) {
  if (!j) return 0;
  try { const a = JSON.parse(j); return Array.isArray(a) ? a.length : 0; } catch (e) { return 0; }
}

async function getBouquets() {
  const db = await getDb();
  const [rows] = await db.execute(
    'SELECT id, bouquet_name, bouquet_channels, bouquet_series FROM bouquets ORDER BY bouquet_order ASC, id ASC'
  );
  return rows.map(r => ({
    id: r.id,
    name: r.bouquet_name,
    streams: jsonLen(r.bouquet_channels),
    series: jsonLen(r.bouquet_series),
  }));
}

// Cached id→bouquet map so enriching a list of lines costs one query, not N.
async function getBouquetMap() {
  if (Date.now() < bouquetCache.expires && bouquetCache.value) return bouquetCache.value;
  const list = await getBouquets();
  const map = new Map(list.map(b => [String(b.id), b]));
  bouquetCache = { value: map, expires: Date.now() + BOUQUET_TTL_MS };
  return map;
}

// Resolve a shaped line's bouquetIds into full {id,name,streams,series} entries.
// Stale ids (bouquet deleted on the panel) are kept but flagged missing:true so
// the caller still sees the assignment without a crash.
function attachBouquets(line, map) {
  if (!line) return line;
  line.bouquets = (line.bouquetIds || []).map(id => {
    const b = map.get(String(id));
    return b
      ? { id: b.id, name: b.name, streams: b.streams, series: b.series }
      : { id, name: `#${id} (deleted)`, streams: 0, series: 0, missing: true };
  });
  return line;
}

// ───────── create a new IPTV line via panel user.php POST ─────────
// `data` accepts: username, password, ownerId (= member_id, defaults to 1=admin),
// maxConnections (default 1), noExpire (bool), expDate (ISO string OR YYYY-MM-DD;
// ignored if noExpire), bouquetIds (array, default [1]=All), accessOutputs
// (array, default [1,2,3]), adminNotes, resellerNotes, isTrial, isMag, isE2, isRestreamer.
async function createLine(data) {
  if (!data.username) throw new Error('username required');
  if (!data.password) throw new Error('password required');

  const form = new URLSearchParams();
  form.append('username', data.username);
  form.append('password', data.password);
  form.append('member_id', String(data.ownerId ?? 1));
  form.append('max_connections', String(data.maxConnections ?? 1));
  form.append('bouquets_selected', JSON.stringify(data.bouquetIds ?? [1]));
  for (const out of (data.accessOutputs ?? [1, 2, 3])) form.append('access_output[]', String(out));
  if (data.noExpire) form.append('no_expire', 'on');
  else if (data.expDate) {
    // Panel date input expects YYYY-MM-DD. Accept ISO or YYYY-MM-DD.
    const d = String(data.expDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('Invalid expDate (expected YYYY-MM-DD)');
    form.append('exp_date', d);
  }
  form.append('admin_notes', data.adminNotes || '');
  form.append('reseller_notes', data.resellerNotes || '');
  form.append('force_server_id', '0');
  form.append('forced_country', '');
  form.append('mac_address_mag', data.macMag || '');
  form.append('mac_address_e2', data.macE2 || '');
  if (data.isTrial) form.append('is_trial', 'on');
  if (data.isMag) form.append('is_mag', 'on');
  if (data.isE2) form.append('is_e2', 'on');
  if (data.isRestreamer) form.append('is_restreamer', 'on');
  if (data.isStalker) form.append('is_stalker', 'on');
  form.append('submit_user', 'Add');

  const res = await authedFetch('/user.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  // Success: 302 → user.php?id=<newId>
  if (res.status === 302) {
    const loc = res.headers.get('location') || '';
    const m = loc.match(/[?&]id=(\d+)/);
    if (m) return await getLine(parseInt(m[1], 10));
    // Fall back to looking up by username
    return await getLineByUsername(data.username);
  }
  // Failure path: form re-rendered with an alert
  const html = await res.text();
  const errMatch = html.match(/<div[^>]*class="[^"]*alert-danger[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const err = errMatch ? errMatch[1].replace(/<[^>]+>/g, '').trim() : `HTTP ${res.status}`;
  throw new Error(err || 'Create failed');
}

// ───────── extend / renew a line's expiry (direct exp_date write) ─────────
// exp_date is the source of truth the streaming daemon checks for expiry, so a
// renew is just a forward-dated UPDATE — no risky full-form user.php edit needed.
// opts: { months } | { days } | { expDate: 'YYYY-MM-DD' } | { noExpire: true }
// For months/days, the new expiry stacks on the later of (now, current exp_date)
// so renewing early adds time instead of losing it.
async function extendLine(id, opts = {}) {
  const lineId = parseInt(id, 10);
  if (!lineId) throw new Error('valid line id required');
  const db = await getDb();

  let newExp; // Unix epoch seconds, or null for no-expire
  if (opts.noExpire) {
    newExp = null;
  } else if (opts.expDate) {
    const d = String(opts.expDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('Invalid expDate (expected YYYY-MM-DD)');
    // End of that local day so the customer gets the full final day.
    newExp = Math.floor(new Date(d + 'T23:59:59').getTime() / 1000);
  } else {
    const months = parseInt(opts.months, 10) || 0;
    const days = parseInt(opts.days, 10) || 0;
    if (months <= 0 && days <= 0) throw new Error('Provide months, days, expDate, or noExpire');
    const [rows] = await db.execute('SELECT exp_date FROM users WHERE id = ?', [lineId]);
    if (!rows.length) throw new Error(`Line ${lineId} not found`);
    const cur = rows[0].exp_date || 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const base = new Date(Math.max(nowSec, cur) * 1000);
    if (months) base.setMonth(base.getMonth() + months);
    if (days) base.setDate(base.getDate() + days);
    newExp = Math.floor(base.getTime() / 1000);
  }

  // Forward-dating exp_date reactivates an expired line (enabled stays 1).
  await db.execute('UPDATE users SET exp_date = ? WHERE id = ?', [newExp, lineId]);
  return await getLine(lineId);
}

// ───────── live TV preview (admin in-browser player) ─────────
// A dedicated preview line streams the channels; its creds + the XUI streaming
// base live in system_settings (iptv_preview_username/password, iptv_stream_base).
let iptvCache = { value: null, expires: 0 };
async function getIptvConfig() {
  if (Date.now() < iptvCache.expires && iptvCache.value) return iptvCache.value;
  const rows = await prisma.system_settings.findMany({
    where: { key: { in: ['iptv_preview_username', 'iptv_preview_password', 'iptv_stream_base'] } },
  });
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  const value = {
    username: m.iptv_preview_username || '',
    password: m.iptv_preview_password || '',
    base: (m.iptv_stream_base || '').replace(/\/$/, ''),
  };
  iptvCache = { value, expires: Date.now() + SETTINGS_TTL_MS };
  return value;
}

async function playerApi(action, params = {}) {
  const c = await getIptvConfig();
  if (!c.username || !c.base) throw new Error('IPTV preview not configured');
  let url = `${c.base}/player_api.php?username=${encodeURIComponent(c.username)}&password=${encodeURIComponent(c.password)}&action=${encodeURIComponent(action)}`;
  for (const [k, v] of Object.entries(params)) url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`player_api ${action} HTTP ${res.status}`);
  return res.json();
}

// Catalogue caches — the live/VOD lists change rarely, so a short cache makes
// page refreshes instant and spares the (fragile) XUI panel repeated hits.
let liveCatCache = { value: null, expires: 0 };
let vodCatCache = { value: null, expires: 0 };
const CATALOG_TTL_MS = 5 * 60 * 1000;

// Live channel catalogue the preview line can play, grouped with category names.
async function getLiveChannels() {
  if (Date.now() < liveCatCache.expires && liveCatCache.value) return liveCatCache.value;
  const [cats, streams] = await Promise.all([
    playerApi('get_live_categories'),
    playerApi('get_live_streams'),
  ]);
  const catMap = new Map((cats || []).map(c => [String(c.category_id), c.category_name]));
  const value = {
    categories: (cats || []).map(c => ({ id: String(c.category_id), name: c.category_name })),
    channels: (streams || []).map(s => ({
      id: s.stream_id,
      name: s.name,
      icon: s.stream_icon || '',
      categoryId: String(s.category_id),
      categoryName: catMap.get(String(s.category_id)) || 'Other',
    })),
  };
  liveCatCache = { value, expires: Date.now() + CATALOG_TTL_MS };
  return value;
}

// VOD (movies) catalogue the preview line can play. Each movie plays as a direct
// file: /movie/<user>/<pass>/<id>.<ext> (nginx proxies /movie/).
async function getVodStreams() {
  if (Date.now() < vodCatCache.expires && vodCatCache.value) return vodCatCache.value;
  const [cats, streams] = await Promise.all([
    playerApi('get_vod_categories'),
    playerApi('get_vod_streams'),
  ]);
  const catMap = new Map((cats || []).map(c => [String(c.category_id), c.category_name]));
  const value = {
    categories: (cats || []).map(c => ({ id: String(c.category_id), name: c.category_name })),
    movies: (streams || []).map(s => ({
      id: s.stream_id,
      name: s.name,
      icon: s.stream_icon || '',
      ext: s.container_extension || 'mp4',
      rating: s.rating || '',
      categoryId: String(s.category_id),
      categoryName: catMap.get(String(s.category_id)) || 'Other',
    })),
  };
  vodCatCache = { value, expires: Date.now() + CATALOG_TTL_MS };
  return value;
}

// Series catalogue (titles). Episodes are fetched per-series via getSeriesInfo.
let seriesCatCache = { value: null, expires: 0 };
async function getSeries() {
  if (Date.now() < seriesCatCache.expires && seriesCatCache.value) return seriesCatCache.value;
  const [cats, list] = await Promise.all([
    playerApi('get_series_categories'),
    playerApi('get_series'),
  ]);
  const catMap = new Map((cats || []).map(c => [String(c.category_id), c.category_name]));
  const value = {
    categories: (cats || []).map(c => ({ id: String(c.category_id), name: c.category_name })),
    series: (list || []).map(s => ({
      id: s.series_id,
      name: s.name,
      icon: s.cover || s.stream_icon || '',
      categoryId: String(s.category_id),
      categoryName: catMap.get(String(s.category_id)) || 'Other',
    })),
  };
  seriesCatCache = { value, expires: Date.now() + CATALOG_TTL_MS };
  return value;
}

// Seasons + episodes for one series. Episode plays as /series/<user>/<pass>/<id>.<ext>.
async function getSeriesInfo(seriesId) {
  const id = parseInt(seriesId, 10);
  if (!id) throw new Error('valid series id required');
  const d = await playerApi('get_series_info', { series_id: id });
  const epsObj = d.episodes || {};
  const seasons = Object.keys(epsObj)
    .sort((a, b) => Number(a) - Number(b))
    .map(sn => ({
      season: sn,
      episodes: (epsObj[sn] || []).map(e => ({
        id: e.id,
        title: e.title,
        ext: e.container_extension || 'mp4',
        episodeNum: e.episode_num,
      })),
    }));
  const info = d.info || {};
  return { name: info.name || '', cover: info.cover || info.movie_image || '', plot: info.plot || '', seasons };
}

// What the browser needs to build same-origin HLS URLs: /live/<user>/<pass>/<id>.m3u8
// (nginx proxies /live/ and /hls/ to the XUI streaming server).
async function getPlaybackConfig() {
  const c = await getIptvConfig();
  if (!c.username) throw new Error('IPTV preview not configured');
  return { username: c.username, password: c.password };
}

// ───────── update a line's bouquet access (direct users.bouquet write) ─────────
// users.bouquet is a JSON array of bouquet ids and is what the streaming daemon
// reads to authorise channel access — so, like exp_date, a direct UPDATE is the
// safe write (no risky full-form user.php edit that can corrupt the edit=<id>).
// Unknown/deleted ids are dropped; order preserved; duplicates removed.
async function setBouquets(id, bouquetIds) {
  const lineId = parseInt(id, 10);
  if (!lineId) throw new Error('valid line id required');
  if (!Array.isArray(bouquetIds)) throw new Error('bouquetIds must be an array');
  const db = await getDb();

  const map = await getBouquetMap();
  const seen = new Set();
  const clean = [];
  for (const raw of bouquetIds) {
    const bid = parseInt(raw, 10);
    if (!bid || seen.has(bid)) continue;
    if (!map.has(String(bid))) continue; // skip ids that no longer exist on the panel
    seen.add(bid);
    clean.push(bid);
  }

  const [rows] = await db.execute('SELECT id FROM users WHERE id = ?', [lineId]);
  if (!rows.length) throw new Error(`Line ${lineId} not found`);
  await db.execute('UPDATE users SET bouquet = ? WHERE id = ?', [JSON.stringify(clean), lineId]);
  return await getLine(lineId);
}

// ───────── IPTV line actions via panel api.php ─────────
async function lineAction(id, sub) {
  if (!['enable', 'disable', 'delete'].includes(sub)) throw new Error(`Invalid sub: ${sub}`);
  const res = await authedFetch(`/api.php?action=user&sub=${sub}&user_id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`api.php HTTP ${res.status}`);
  const json = await res.json();
  if (json.result !== true) throw new Error(`XUI refused ${sub} for line ${id}`);
  return true;
}

// ───────── connection status + viewing activity ─────────
// user_activity_now = live connections; user_activity = watch history.
// stream type: 1 Live TV · 2 Movie · 4 Radio · 5 Series episode.
const STREAM_TYPE = { 1: 'Live TV', 2: 'Movie', 4: 'Radio', 5: 'Series' };
const typeName = (t) => STREAM_TYPE[t] || 'Other';
const epochIso = (s) => (s ? new Date(s * 1000).toISOString() : null);

async function getLineActivity(id, { historyLimit = 12 } = {}) {
  const db = await getDb();
  const uid = parseInt(id, 10);
  if (!uid) throw new Error('Invalid line id');

  const [now] = await db.query(
    `SELECT n.stream_id, n.user_ip, n.container, n.date_start, n.geoip_country_code, n.user_agent,
            s.type, s.stream_display_name
       FROM user_activity_now n
       LEFT JOIN streams s ON s.id = n.stream_id
      WHERE n.user_id = ?
      ORDER BY n.date_start DESC`, [uid]);

  const [hist] = await db.query(
    `SELECT ua.stream_id, s.type, s.stream_display_name,
            MAX(ua.date_start) AS last_seen, COUNT(*) AS plays
       FROM user_activity ua
       LEFT JOIN streams s ON s.id = ua.stream_id
      WHERE ua.user_id = ?
      GROUP BY ua.stream_id, s.type, s.stream_display_name
      ORDER BY last_seen DESC
      LIMIT ?`, [uid, historyLimit]);

  const connections = now.map((r) => ({
    streamId: r.stream_id,
    name: r.stream_display_name || `Stream #${r.stream_id}`,
    type: typeName(r.type),
    ip: r.user_ip || null,
    country: r.geoip_country_code || null,
    container: r.container || null,
    since: epochIso(r.date_start),
    device: r.user_agent || null,
  }));

  const history = hist.filter((r) => r.stream_id).map((r) => ({
    streamId: r.stream_id,
    name: r.stream_display_name || `Stream #${r.stream_id}`,
    type: typeName(r.type),
    plays: Number(r.plays) || 0,
    lastSeen: epochIso(r.last_seen),
  }));

  return {
    connected: connections.length > 0,
    activeConnections: connections.length,
    connections,
    history,
  };
}

module.exports = {
  getSettings, invalidateSettings,
  login, invalidateSession,
  getDb,
  // IPTV lines (the users table)
  getLine, getLineByUsername, listLines, createLine, lineAction, extendLine, setBouquets,
  getLineActivity,
  getPackages, getResellers, getBouquets,
  getLiveChannels, getVodStreams, getSeries, getSeriesInfo, getPlaybackConfig,
};
