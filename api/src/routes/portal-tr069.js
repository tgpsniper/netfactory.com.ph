// ============================================================
// routes/portal-tr069.js — subscriber-facing TR-069 endpoints
// ============================================================
// Mounted at /api/portal/tr069. Every endpoint uses portalAuth —
// a subscriber can only touch the device linked to their own
// subscriber_id. Cooldown + validation mirror the admin route.
// ============================================================

const express = require('express');
const rateLimit = require('express-rate-limit');
const portalAuth = require('../middleware/portalAuth');
const acs = require('../utils/genieacs');

const router = express.Router();

// Self-service rate limit — prevent a subscriber from queueing dozens
// of WiFi changes in a row even within their cooldown window.
const selfServiceLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  keyGenerator: (req) => (req.subscriber && req.subscriber.id) || req.ip,
});

async function requireEnabled(req, res, next) {
  const s = await acs.getSettings();
  if (!s.enabled) return res.status(503).json({ error: 'TR-069 service is temporarily unavailable' });
  req.acsSettings = s;
  next();
}

// Find the device tied to THIS subscriber. If they have more than one
// linked CPE (unusual — usually 1 per household), prefer the most
// recently-informed one.
async function getOwnedDevice(req) {
  const rows = await req.prisma.tr069_devices.findMany({
    where: { subscriber_id: req.subscriberId },
    orderBy: { last_inform: 'desc' },
  });
  return rows[0] || null;
}

// ── GET /api/portal/tr069/device — info about my linked CPE ──
router.get('/device', portalAuth, requireEnabled, async (req, res) => {
  try {
    const row = await getOwnedDevice(req);
    if (!row) return res.json({ linked: false, device: null });

    // Pull live status from GenieACS for online/last_inform accuracy
    let online = false, lastInform = row.last_inform;
    // Radios this ONU actually exposes, so the band picker offers only real options.
    let bands = [];
    try {
      const live = await acs.getDevice(row.device_id);
      if (live) {
        const li = live._lastInform ? new Date(live._lastInform) : null;
        lastInform = li || lastInform;
        online = li && (Date.now() - li.getTime() < 10 * 60 * 1000);
        bands = acs.wifiTargets(live).map(t => ({ index: t.index, ssid: t.ssid, band: t.band }));
      }
    } catch (_) {}

    let cooldownRemainingSec = 0;
    if (row.last_wifi_change) {
      const elapsed = (Date.now() - row.last_wifi_change.getTime()) / 1000;
      const remaining = req.acsSettings.wifiCooldownSec - elapsed;
      if (remaining > 0) cooldownRemainingSec = Math.ceil(remaining);
    }

    res.json({
      linked: true,
      bands,
      device: {
        device_id: row.device_id,
        manufacturer: row.manufacturer,
        product_class: row.product_class,
        software_version: row.software_version,
        wifi_ssid: row.wifi_ssid,
        last_inform: lastInform,
        online,
        cooldown_remaining_sec: cooldownRemainingSec,
      },
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load device', detail: e.message });
  }
});

// ── POST /api/portal/tr069/wifi — update MY SSID/password ─
router.post('/wifi', portalAuth, requireEnabled, selfServiceLimit, async (req, res) => {
  try {
    // Password only. Self-service renaming of the network was removed: the two radios
    // normally carry different SSIDs, so a single box could only rename one band or
    // flatten both to the same name, and a subscriber who renames their WiFi by
    // accident loses every device on it with no way back except a support call.
    const { password, band } = req.body || {};
    if (!password) return res.status(400).json({ error: 'password required' });
    if (typeof password !== 'string' || password.length < 8 || password.length > 63) {
      return res.status(400).json({ error: 'Password must be 8-63 characters' });
    }
    // Unrecognised bands are rejected rather than ignored: silently falling back to
    // "both radios" would change a network the subscriber did not intend to touch.
    if (band && !acs.normalizeBand(band)) {
      return res.status(400).json({ error: 'Invalid band' });
    }

    const row = await getOwnedDevice(req);
    if (!row) return res.status(404).json({ error: 'No WiFi device linked to your account. Please contact support.' });

    const cooldownMs = req.acsSettings.wifiCooldownSec * 1000;
    if (row.last_wifi_change) {
      const elapsed = Date.now() - row.last_wifi_change.getTime();
      if (elapsed < cooldownMs) {
        return res.status(429).json({
          error: 'WiFi change cooldown active',
          retry_after_sec: Math.ceil((cooldownMs - elapsed) / 1000),
        });
      }
    }

    // Applies to every enabled radio, so 2.4 GHz and 5 GHz end up on the same password.
    const result = await acs.updateWifi(row.device_id, { password, band });
    await req.prisma.tr069_devices.update({
      where: { device_id: row.device_id },
      data: {
        last_wifi_change: new Date(),
        updated_at: new Date(),
      },
    });
    const written = (result.bands || []).map(b => b.band).filter(Boolean);
    const bandText = written.length > 1 ? ` on both bands (${written.join(' and ')})`
                   : written.length === 1 ? ` on ${written[0]}` : '';
    res.json({
      ok: true,
      bands: result.bands || [],
      message: `Your WiFi password will update${bandText} within about 5 minutes. Every device will need the new password to reconnect.`,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update WiFi', detail: e.message });
  }
});

// ── POST /api/portal/tr069/reboot — reboot MY router ─────
// Rate-limited same as WiFi; no state stored, so cooldown is the
// rate limiter only.
router.post('/reboot', portalAuth, requireEnabled, selfServiceLimit, async (req, res) => {
  try {
    const row = await getOwnedDevice(req);
    if (!row) return res.status(404).json({ error: 'No device linked to your account.' });
    await acs.rebootDevice(row.device_id);
    res.json({ ok: true, message: 'Your router will restart in about 30 seconds. Connection will drop briefly.' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reboot', detail: e.message });
  }
});

module.exports = router;
