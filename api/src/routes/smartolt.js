// ============================================================
// routes/smartolt.js — SmartOLT cloud integration
// ============================================================
// Mounted at /api/admin/smartolt in server.js. Brings the remote
// ZTE C650 (Colgante POP) into the CRM over SmartOLT's cloud API —
// the only path that works, since nf-crm has no route to the OLT's
// management IP. Complements (does not replace) the direct-SNMP
// VSOL module in routes/olt.js.
//
// All endpoints require admin auth. The API token is stored in
// system_settings (or .env) and is NEVER returned to the client.
// ============================================================

const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const so = require('../utils/smartolt');

function parseNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
function parseInt10(v) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

// Resolve which olt_devices row a sync writes into: the configured one,
// else the single active OLT, else error.
async function resolveOltDeviceId(prisma, cfg) {
  if (cfg.oltDeviceId) return cfg.oltDeviceId;
  const active = await prisma.olt_devices.findMany({ where: { is_active: true }, select: { id: true }, orderBy: { id: 'asc' } });
  if (active.length === 1) return active[0].id;
  return null;
}

// Run async tasks with bounded concurrency (avoid exhausting the PG pool).
async function runBatched(items, worker, concurrency = 8) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    out.push(...await Promise.all(slice.map(worker)));
  }
  return out;
}

// ── Settings ────────────────────────────────────────────────
router.get('/settings', adminAuth(), async (req, res) => {
  try {
    so.invalidateSettings();
    const cfg = await so.getSettings(req.prisma);
    res.json({
      enabled: cfg.enabled,
      url: cfg.base || '',
      hasToken: !!cfg.token,
      oltDeviceId: cfg.oltDeviceId,
      configured: cfg.configured,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/settings', adminAuth(), async (req, res) => {
  try {
    const { subdomain, url, token, enabled, oltDeviceId } = req.body || {};
    const updates = [];
    if (subdomain !== undefined) updates.push({ key: 'smartolt_subdomain', value: String(subdomain).trim() });
    if (url !== undefined) updates.push({ key: 'smartolt_url', value: String(url).trim().replace(/\/+$/, '') });
    if (token) updates.push({ key: 'smartolt_api_token', value: String(token).trim() });
    if (enabled !== undefined) updates.push({ key: 'smartolt_enabled', value: enabled ? 'true' : 'false' });
    if (oltDeviceId !== undefined) updates.push({ key: 'smartolt_olt_device_id', value: String(parseInt10(oltDeviceId) || '') });

    for (const u of updates) {
      await req.prisma.system_settings.upsert({
        where: { key: u.key },
        update: { value: u.value, updated_at: new Date(), updated_by: String(req.user?.id || 'admin') },
        create: { key: u.key, value: u.value, category: 'integrations', updated_by: String(req.user?.id || 'admin') },
      });
    }
    so.invalidateSettings();
    res.json({ ok: true, saved: updates.map(u => u.key) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Connectivity test ───────────────────────────────────────
router.get('/status', adminAuth(), async (req, res) => {
  try {
    const cfg = await so.getSettings(req.prisma);
    if (!cfg.configured) return res.json({ ok: false, configured: false, message: 'SmartOLT not configured — set subdomain and API token.' });
    const data = await so.getSystemStatus(req.prisma);
    res.json({ ok: true, configured: true, enabled: cfg.enabled, url: cfg.base, system: data });
  } catch (e) {
    res.json({ ok: false, configured: true, error: e.message });
  }
});

// ── Dashboard summary (reads the synced snapshot in olt_onu_mappings; works
//    even if SmartOLT is not configured yet, so the dashboard tile is stable) ──
router.get('/summary', adminAuth(), async (req, res) => {
  try {
    const cfg = await so.getSettings(req.prisma);
    const oltDeviceId = await resolveOltDeviceId(req.prisma, cfg);
    const srows = await req.prisma.system_settings.findMany({ where: { key: { in: ['olt_optical_warn_threshold', 'olt_optical_critical_threshold'] } } });
    const sm = {}; for (const r of srows) sm[r.key] = r.value;
    const warn = parseFloat(sm.olt_optical_warn_threshold ?? '-25');
    const crit = parseFloat(sm.olt_optical_critical_threshold ?? '-28');
    const where = oltDeviceId ? { olt_device_id: oltDeviceId } : {};
    const rows = await req.prisma.olt_onu_mappings.findMany({
      where, select: { status: true, last_rx_power: true, subscriber_id: true, last_seen: true },
    });
    let online = 0, offline = 0, unknown = 0, linked = 0, weak = 0, critical = 0, lastSync = null;
    for (const r of rows) {
      const st = (r.status || 'unknown').toLowerCase();
      if (st === 'online') online++; else if (st === 'offline') offline++; else unknown++;
      if (r.subscriber_id) linked++;
      if (r.last_rx_power != null) {
        const rx = parseFloat(String(r.last_rx_power));
        if (Number.isFinite(rx)) { if (rx <= crit) critical++; else if (rx <= warn) weak++; }
      }
      if (r.last_seen && (!lastSync || r.last_seen > lastSync)) lastSync = r.last_seen;
    }
    res.json({ configured: cfg.configured, oltDeviceId, total: rows.length, online, offline, unknown, linked, weak, critical, warnThreshold: warn, critThreshold: crit, lastSync });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ONU listing (live from SmartOLT, merged with local subscriber links) ──
router.get('/onus', adminAuth(), async (req, res) => {
  try {
    const cfg = await so.getSettings(req.prisma);
    if (!cfg.configured) return res.status(503).json({ error: 'SmartOLT not configured' });
    const onus = await so.getAllOnus(req.prisma);

    // Attach the local subscriber link (if any) by serial.
    const oltDeviceId = await resolveOltDeviceId(req.prisma, cfg);
    let linkBySerial = {};
    if (oltDeviceId) {
      const locals = await req.prisma.olt_onu_mappings.findMany({
        where: { olt_device_id: oltDeviceId },
        select: { serial_number: true, subscriber_id: true },
      });
      for (const l of locals) if (l.serial_number) linkBySerial[l.serial_number.toUpperCase()] = l.subscriber_id;
    }
    const merged = onus.map(o => ({ ...o, subscriber_id: linkBySerial[o.serial] ?? null }));
    res.json({ count: merged.length, onus: merged });
  } catch (e) { res.status(e.code === 'NOT_CONFIGURED' ? 503 : 502).json({ error: e.message }); }
});

router.get('/unconfigured', adminAuth(), async (req, res) => {
  try {
    const onus = await so.getUnconfiguredOnus(req.prisma);
    res.json({ count: onus.length, onus });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/onu/:externalId', adminAuth(), async (req, res) => {
  try {
    const data = await so.getOnuStatus(req.prisma, req.params.externalId);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Sync: pull SmartOLT ONUs into olt_onu_mappings (the "accounting" refresh) ──
router.post('/sync', adminAuth(), async (req, res) => {
  try {
    const cfg = await so.getSettings(req.prisma);
    if (!cfg.configured) return res.status(503).json({ error: 'SmartOLT not configured' });
    const oltDeviceId = await resolveOltDeviceId(req.prisma, cfg);
    if (!oltDeviceId) return res.status(400).json({ error: 'No target OLT — set smartolt_olt_device_id (multiple/zero active OLTs).' });

    const onus = await so.getAllOnus(req.prisma);
    const locals = await req.prisma.olt_onu_mappings.findMany({ where: { olt_device_id: oltDeviceId } });
    const localBySerial = {};
    for (const l of locals) if (l.serial_number) localBySerial[l.serial_number.toUpperCase()] = l;

    const now = new Date();
    let updated = 0, inserted = 0, skipped = 0;
    const seen = new Set();

    await runBatched(onus, async (o) => {
      if (!o.serial) { skipped++; return; }
      seen.add(o.serial);
      const patch = {
        status: o.status || 'unknown',
        last_rx_power: parseNum(o.rx_power),
        last_tx_power: parseNum(o.tx_power),
        last_seen: now,
        updated_at: now,
      };
      if (o.name) patch.description = String(o.name).slice(0, 255);

      const existing = localBySerial[o.serial];
      if (existing) {
        await req.prisma.olt_onu_mappings.update({ where: { id: existing.id }, data: patch });
        updated++;
      } else {
        const pon = parseInt10(o.port);
        const onuId = parseInt10(o.onu);
        if (pon === null || onuId === null) { skipped++; return; } // can't satisfy NOT NULL / unique key
        try {
          await req.prisma.olt_onu_mappings.create({
            data: {
              olt_device_id: oltDeviceId,
              pon_port: pon,
              onu_id: onuId,
              serial_number: o.serial.slice(0, 50),
              status: o.status || 'unknown',
              description: o.name ? String(o.name).slice(0, 255) : null,
              last_rx_power: parseNum(o.rx_power),
              last_tx_power: parseNum(o.tx_power),
              registered_at: now,
              last_seen: now,
            },
          });
          inserted++;
        } catch (_) { skipped++; } // unique-key collision etc.
      }
    });

    // Local rows SmartOLT no longer reports — flag stale (don't delete).
    const stale = locals.filter(l => l.serial_number && !seen.has(l.serial_number.toUpperCase())).length;

    res.json({ ok: true, oltDeviceId, total: onus.length, updated, inserted, skipped, stale });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Manual link: bind a serial to a subscriber ──────────────
router.post('/link', adminAuth(), async (req, res) => {
  try {
    const { serial_number, subscriber_id } = req.body || {};
    if (!serial_number) return res.status(400).json({ error: 'serial_number required' });
    const cfg = await so.getSettings(req.prisma);
    const oltDeviceId = await resolveOltDeviceId(req.prisma, cfg);
    const where = { olt_device_id: oltDeviceId || undefined, serial_number: String(serial_number).toUpperCase() };
    const result = await req.prisma.olt_onu_mappings.updateMany({
      where,
      data: { subscriber_id: subscriber_id ? parseInt10(subscriber_id) : null, updated_at: new Date() },
    });
    if (result.count === 0) return res.status(404).json({ error: 'No ONU mapping with that serial (run a sync first).' });
    res.json({ ok: true, linked: result.count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Control ops (only meaningful once a controller is live) ─
function control(action, fn) {
  router.post(`/onu/:externalId/${action}`, adminAuth(), async (req, res) => {
    try {
      const cfg = await so.getSettings(req.prisma);
      if (!cfg.enabled) return res.status(403).json({ error: 'SmartOLT integration is disabled — enable it in settings to run control actions.' });
      const data = await fn(req.prisma, req.params.externalId);
      res.json({ ok: true, result: data });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
}
control('reboot', so.rebootOnu);
control('enable', so.enableOnu);
control('disable', so.disableOnu);

module.exports = router;
