// ============================================================
// routes/xconnect.js — XConnect / Xtream UI bridge
// ============================================================
// Mounted at /api/admin/xconnect in server.js. Manages the link
// between CRM subscribers and XUI customer lines (users table).
// Reads go through MariaDB; writes through the panel session.
// ============================================================

const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const xc = require('../utils/xconnect');

async function requireEnabled(req, res, next) {
  try {
    const s = await xc.getSettings();
    if (!s.enabled) return res.status(503).json({ error: 'XConnect is disabled in system_settings' });
    if (!s.url || !s.username || !s.password) return res.status(503).json({ error: 'XConnect panel not configured' });
    if (!s.db.host || !s.db.user || !s.db.database) return res.status(503).json({ error: 'XUI DB not configured' });
    req.xc = s;
    next();
  } catch (e) {
    res.status(500).json({ error: 'Failed to read XConnect settings', detail: e.message });
  }
}

function audit(req, action, entity_id, details) {
  return req.prisma.audit_log.create({
    data: {
      user_type: 'admin',
      user_id: req.user?.id || 0,
      action,
      entity_type: 'xui_line',
      entity_id: entity_id ? parseInt(entity_id, 10) : null,
      details: details || {},
      ip_address: req.ip || null,
    },
  }).catch(() => {});
}

// ──────────── settings ────────────
router.get('/settings', adminAuth(), async (req, res) => {
  try {
    const s = await xc.getSettings();
    res.json({
      enabled: s.enabled, url: s.url, username: s.username,
      hasPassword: !!s.password,
      db: { host: s.db.host, port: s.db.port, database: s.db.database, user: s.db.user, hasPassword: !!s.db.password },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/settings', adminAuth(), async (req, res) => {
  try {
    const { url, username, password, enabled, db } = req.body;
    const updates = [];
    if (url !== undefined) updates.push({ key: 'xconnect_url', value: String(url).replace(/\/$/, '') });
    if (username !== undefined) updates.push({ key: 'xconnect_username', value: String(username) });
    if (password) updates.push({ key: 'xconnect_password', value: String(password) });
    if (enabled !== undefined) updates.push({ key: 'xconnect_enabled', value: enabled ? 'true' : 'false' });
    if (db) {
      if (db.host !== undefined) updates.push({ key: 'xui_db_host', value: String(db.host) });
      if (db.port !== undefined) updates.push({ key: 'xui_db_port', value: String(db.port) });
      if (db.database !== undefined) updates.push({ key: 'xui_db_name', value: String(db.database) });
      if (db.user !== undefined) updates.push({ key: 'xui_db_user', value: String(db.user) });
      if (db.password) updates.push({ key: 'xui_db_pass', value: String(db.password) });
    }
    for (const u of updates) {
      await req.prisma.system_settings.upsert({
        where: { key: u.key },
        update: { value: u.value, updated_at: new Date(), updated_by: String(req.user?.id || 'system') },
        create: { key: u.key, value: u.value, category: 'integrations', updated_by: String(req.user?.id || 'system') },
      });
    }
    xc.invalidateSettings();
    xc.invalidateSession();
    await audit(req, 'xconnect_settings_updated', null, { keys: updates.map(u => u.key) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/test-connection', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const db = await xc.getDb();
    const [[{ now }]] = await db.execute('SELECT NOW() AS now');
    await xc.invalidateSession();
    await xc.login(true);
    res.json({ ok: true, dbNow: now, message: 'Panel session + DB both reachable' });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ──────────── reference data ────────────
router.get('/packages', adminAuth(), requireEnabled, async (req, res) => {
  try { res.json({ packages: await xc.getPackages() }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/resellers', adminAuth(), requireEnabled, async (req, res) => {
  try { res.json({ resellers: await xc.getResellers() }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Catalogue groups (id, name, stream count, series count) — mirrors the panel's Bouquets tab.
router.get('/bouquets', adminAuth(), requireEnabled, async (req, res) => {
  try { res.json({ bouquets: await xc.getBouquets() }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ──────────── live TV preview (admin player at /iptv-live) ────────────
// Live channel catalogue the preview line can stream.
router.get('/streams/live', adminAuth(), requireEnabled, async (req, res) => {
  try { res.json(await xc.getLiveChannels()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// VOD (movies) catalogue the preview line can stream.
router.get('/streams/vod', adminAuth(), requireEnabled, async (req, res) => {
  try { res.json(await xc.getVodStreams()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Series catalogue (titles).
router.get('/streams/series', adminAuth(), requireEnabled, async (req, res) => {
  try { res.json(await xc.getSeries()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Seasons + episodes for one series.
router.get('/streams/series/:id', adminAuth(), requireEnabled, async (req, res) => {
  try { res.json(await xc.getSeriesInfo(req.params.id)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Preview credentials so the page can build same-origin /live/<user>/<pass>/<id>.m3u8 URLs.
router.get('/streams/playback', adminAuth(), requireEnabled, async (req, res) => {
  try { res.json(await xc.getPlaybackConfig()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ──────────── IPTV lines (read-only for now) ────────────
router.get('/lines', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const { search = '', reseller = '', start = '0', length = '25' } = req.query;
    res.json(await xc.listLines({
      search: String(search),
      resellerId: reseller || null,
      start: parseInt(start, 10) || 0,
      length: Math.min(parseInt(length, 10) || 25, 200),
    }));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/lines/:id', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const line = await xc.getLine(req.params.id);
    if (!line) return res.status(404).json({ error: 'Line not found in XUI' });
    res.json(line);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Connection status + viewing activity (online now, channels/films/series watched)
router.get('/lines/:id/activity', adminAuth(), requireEnabled, async (req, res) => {
  try {
    res.json(await xc.getLineActivity(req.params.id));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Line actions via the panel HTTP API
router.post('/lines/:id/enable', adminAuth(), requireEnabled, async (req, res) => {
  try { await xc.lineAction(req.params.id, 'enable'); await audit(req, 'xui_line_enabled', req.params.id, {}); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.post('/lines/:id/disable', adminAuth(), requireEnabled, async (req, res) => {
  try { await xc.lineAction(req.params.id, 'disable'); await audit(req, 'xui_line_disabled', req.params.id, {}); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Update a line's bouquet access. Body: { bouquetIds: number[] }
router.put('/lines/:id/bouquets', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const { bouquetIds } = req.body || {};
    if (!Array.isArray(bouquetIds)) return res.status(400).json({ error: 'bouquetIds array required' });
    const line = await xc.setBouquets(req.params.id, bouquetIds);
    await audit(req, 'xui_line_bouquets_updated', req.params.id, { bouquetIds: line.bouquetIds });
    res.json({ ok: true, line });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Extend / renew a line's expiry. Body: { months } | { days } | { expDate } | { noExpire }
router.post('/lines/:id/extend', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const { months, days, expDate, noExpire } = req.body || {};
    const line = await xc.extendLine(req.params.id, { months, days, expDate, noExpire });
    await audit(req, 'xui_line_extended', req.params.id, { months, days, expDate, noExpire, newExpDate: line.expDate });
    res.json({ ok: true, line });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ──────────── subscriber ↔ XUI line linkage ────────────

// GET — returns linked line. If not yet linked, tries to auto-link by matching
// account_number == users.username (exact). Writes back the link if found.
router.get('/subscribers/:subscriberId/line', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const subscriberId = parseInt(req.params.subscriberId, 10);
    const sub = await req.prisma.subscribers.findUnique({
      where: { id: subscriberId },
      select: { id: true, xui_user_id: true, account_number: true },
    });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    if (sub.xui_user_id) {
      const line = await xc.getLine(sub.xui_user_id);
      if (line) return res.json({ linked: true, line, autoLinked: false });
      return res.json({ linked: false, line: null, warning: 'Linked XUI line no longer exists on the panel' });
    }

    // Auto-link by username == account_number
    if (sub.account_number) {
      const match = await xc.getLineByUsername(sub.account_number);
      if (match) {
        await req.prisma.subscribers.update({
          where: { id: subscriberId },
          data: { xui_user_id: match.id, updated_at: new Date() },
        });
        await audit(req, 'subscriber_xui_auto_linked', subscriberId, {
          xui_user_id: match.id, matched_by: 'username==account_number',
        });
        return res.json({ linked: true, line: match, autoLinked: true });
      }
    }

    res.json({ linked: false, line: null });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// POST — create a new XUI line and link it to this subscriber in one step.
// Pre-fills username = account_number, password = account_number unless overridden.
router.post('/subscribers/:subscriberId/line/create', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const subscriberId = parseInt(req.params.subscriberId, 10);
    const sub = await req.prisma.subscribers.findUnique({ where: { id: subscriberId } });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });
    if (sub.xui_user_id) return res.status(409).json({ error: `Already linked to XUI line ${sub.xui_user_id}` });

    // Convention: XUI username AND password = CRM account_number. Not overridable.
    const username = sub.account_number;
    if (!username) return res.status(400).json({ error: 'Subscriber has no account_number' });

    // Guard: username collision
    const dup = await xc.getLineByUsername(username);
    if (dup) return res.status(409).json({ error: `XUI line "${username}" already exists (id ${dup.id})` });

    const created = await xc.createLine({
      username,
      password: username,
      ownerId: req.body.ownerId,
      maxConnections: req.body.maxConnections,
      noExpire: req.body.noExpire,
      expDate: req.body.expDate,
      bouquetIds: req.body.bouquetIds,
      accessOutputs: req.body.accessOutputs,
      adminNotes: req.body.adminNotes || `Linked to subscriber ${sub.account_number}`,
      resellerNotes: req.body.resellerNotes || `${sub.first_name || ''} ${sub.last_name || ''}`.trim(),
    });

    if (!created?.id) return res.status(502).json({ error: 'XUI returned no line id after create' });

    await req.prisma.subscribers.update({
      where: { id: subscriberId },
      data: { xui_user_id: created.id, updated_at: new Date() },
    });
    await audit(req, 'subscriber_xui_created_linked', subscriberId, {
      xui_user_id: created.id, username: created.username,
    });
    res.status(201).json({ ok: true, line: created });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Manual link by xui_user_id
router.post('/subscribers/:subscriberId/line/link', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const subscriberId = parseInt(req.params.subscriberId, 10);
    const xuiUserId = parseInt(req.body.xuiUserId, 10);
    if (!xuiUserId) return res.status(400).json({ error: 'xuiUserId required' });
    const line = await xc.getLine(xuiUserId);
    if (!line) return res.status(404).json({ error: 'XUI line not found' });
    await req.prisma.subscribers.update({
      where: { id: subscriberId }, data: { xui_user_id: xuiUserId, updated_at: new Date() },
    });
    await audit(req, 'subscriber_xui_linked', subscriberId, { xui_user_id: xuiUserId, username: line.username });
    res.json({ ok: true, line });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Unlink (FK only — does not delete the panel line)
router.delete('/subscribers/:subscriberId/line', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const subscriberId = parseInt(req.params.subscriberId, 10);
    const sub = await req.prisma.subscribers.findUnique({ where: { id: subscriberId }, select: { id: true, xui_user_id: true } });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });
    const previous = sub.xui_user_id;
    await req.prisma.subscribers.update({ where: { id: subscriberId }, data: { xui_user_id: null, updated_at: new Date() } });
    await audit(req, 'subscriber_xui_unlinked', subscriberId, { previous_xui_user_id: previous });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

module.exports = router;
