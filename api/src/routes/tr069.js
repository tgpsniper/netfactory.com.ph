// ============================================================
// routes/tr069.js — TR-069 / CWMP device management
// ============================================================
// Thin layer over GenieACS NBI. Keeps a local tr069_devices row
// per CPE (for subscriber linkage + notes) and proxies live data
// queries/tasks to GenieACS.
// Mounted at /api/admin/tr069 in server.js
// ============================================================

const express = require('express');
const router = express.Router();
const multer = require('multer');
const adminAuth = require('../middleware/adminAuth');
const acs = require('../utils/genieacs');
const publicIp = require('../utils/tr069-public-ip');

// Firmware upload — memory storage, 80MB cap. Files are PUT through to
// GenieACS NBI, not stored on the j2-api filesystem.
const firmwareUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (!/\.(bin|img|pkg|tar|gz|upg|trx)$/i.test(file.originalname)) {
      return cb(new Error('Unsupported firmware file type'));
    }
    cb(null, true);
  },
});

// Feature-flag gate. Cheap — reads 30s cache.
async function requireEnabled(req, res, next) {
  try {
    const s = await acs.getSettings();
    if (!s.enabled) {
      return res.status(503).json({ error: 'TR-069 is disabled in system_settings' });
    }
    req.acsSettings = s;
    next();
  } catch (e) {
    return res.status(500).json({ error: 'Failed to read TR-069 settings', detail: e.message });
  }
}

// Upsert local row from a live GenieACS device document.
async function syncLocal(prisma, device) {
  const ident = acs.extractIdentity(device);
  if (!ident.device_id) return null;
  const { ssid } = acs.extractWifi(device);
  const data = { ...ident, wifi_ssid: ssid || null, updated_at: new Date() };
  return prisma.tr069_devices.upsert({
    where: { device_id: ident.device_id },
    create: data,
    update: data,
  });
}

// Batch-match unlinked tr069_devices against subscribers.ont_serial /
// router_serial. Runs as a cheap pre-step to GET /devices.
async function autoLinkBySerial(prisma, remoteDevices) {
  const ids = new Map(); // device_id -> serial
  for (const d of remoteDevices) {
    const ident = acs.extractIdentity(d);
    if (ident.device_id && ident.serial_number) ids.set(ident.device_id, ident.serial_number);
  }
  if (!ids.size) return 0;

  // Skip rows already linked
  const existing = await prisma.tr069_devices.findMany({
    where: { device_id: { in: [...ids.keys()] } },
    select: { device_id: true, subscriber_id: true },
  });
  const linked = new Set(existing.filter(r => r.subscriber_id).map(r => r.device_id));
  const serials = [...ids.entries()].filter(([id]) => !linked.has(id)).map(([,s]) => s);
  if (!serials.length) return 0;

  const matches = await prisma.subscribers.findMany({
    where: { OR: [{ ont_serial: { in: serials } }, { router_serial: { in: serials } }] },
    select: { id: true, ont_serial: true, router_serial: true },
  });
  if (!matches.length) return 0;

  const bySerial = new Map();
  for (const m of matches) {
    if (m.ont_serial) bySerial.set(m.ont_serial, m.id);
    if (m.router_serial) bySerial.set(m.router_serial, m.id);
  }

  let linkedCount = 0;
  for (const d of remoteDevices) {
    const ident = acs.extractIdentity(d);
    if (!ident.device_id || !ident.serial_number) continue;
    if (linked.has(ident.device_id)) continue;
    const subId = bySerial.get(ident.serial_number);
    if (!subId) continue;
    const { ssid } = acs.extractWifi(d);
    const data = { ...ident, wifi_ssid: ssid || null, subscriber_id: subId, updated_at: new Date() };
    await prisma.tr069_devices.upsert({
      where: { device_id: ident.device_id },
      create: data,
      update: data,
    });
    linkedCount++;
  }
  return linkedCount;
}

// ── GET /devices — merge GenieACS live view with local linkage ──
router.get('/devices', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const remote = await acs.listDevices({
      projection: '_id,_lastInform,_deviceId,InternetGatewayDevice.DeviceInfo,InternetGatewayDevice.WANDevice,Device.DeviceInfo,Device.IP.Interface,Device.LAN,Device.ManagementServer.ConnectionRequestURL',
    });
    const list = Array.isArray(remote) ? remote : [];
    // Cheap pre-step: auto-link any unlinked devices whose serial matches
    // a subscriber's ont_serial or router_serial.
    await autoLinkBySerial(req.prisma, list).catch(() => {});
    const local = await req.prisma.tr069_devices.findMany({
      include: {
        subscriber: {
          select: { id: true, account_number: true, first_name: true, last_name: true, phone: true, status: true },
        },
      },
    });
    const localByDeviceId = new Map(local.map(r => [r.device_id, r]));

    // Public-IP correlation from nginx /acs/ access log (best-effort)
    const ipMap = await publicIp.getPublicIpMap().catch(() => new Map());

    const onlineCutoff = Date.now() - 10 * 60 * 1000; // 10 min
    const merged = list.map(d => {
      const ident = acs.extractIdentity(d);
      const row = localByDeviceId.get(d._id);
      const lastInformMs = ident.last_inform ? ident.last_inform.getTime() : 0;
      const pubEntry = ipMap.get(d._id);
      const pubIp = pubEntry ? pubEntry.ip : null;
      return {
        device_id: d._id,
        serial_number: ident.serial_number,
        oui: ident.oui,
        product_class: ident.product_class,
        manufacturer: ident.manufacturer,
        software_version: ident.software_version,
        ip_address: ident.ip_address,
        public_ip: pubIp,
        last_inform: ident.last_inform,
        online: lastInformMs >= onlineCutoff,
        subscriber: row ? row.subscriber : null,
        notes: row ? row.notes : null,
        linked: !!(row && row.subscriber_id),
      };
    });

    // Include local rows that don't have a matching GenieACS doc
    // (device was removed from NBI but we still have a binding).
    const seen = new Set(list.map(d => d._id));
    for (const r of local) {
      if (!seen.has(r.device_id)) {
        merged.push({
          device_id: r.device_id,
          serial_number: r.serial_number,
          oui: r.oui,
          product_class: r.product_class,
          manufacturer: r.manufacturer,
          software_version: r.software_version,
          ip_address: r.ip_address,
          last_inform: r.last_inform,
          online: false,
          subscriber: r.subscriber,
          notes: r.notes,
          linked: !!r.subscriber_id,
          stale: true,
        });
      }
    }

    res.json({ devices: merged, count: merged.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list devices', detail: e.message });
  }
});

// ── GET /devices/unlinked — devices not bound to a subscriber ──
router.get('/devices/unlinked', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const remote = await acs.listDevices({
      projection: '_id,_lastInform,_deviceId',
    });
    const list = Array.isArray(remote) ? remote : [];
    const linkedIds = new Set(
      (await req.prisma.tr069_devices.findMany({
        where: { subscriber_id: { not: null } },
        select: { device_id: true },
      })).map(r => r.device_id)
    );
    const unlinked = list
      .filter(d => !linkedIds.has(d._id))
      .map(d => {
        const ident = acs.extractIdentity(d);
        return {
          device_id: d._id,
          serial_number: ident.serial_number,
          oui: ident.oui,
          product_class: ident.product_class,
          last_inform: ident.last_inform,
        };
      });
    res.json({ devices: unlinked, count: unlinked.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list unlinked devices', detail: e.message });
  }
});

// ── GET /devices/:id — live detail + WiFi ──────────────────
router.get('/devices/:id', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const device = await acs.getDevice(deviceId);
    if (!device) return res.status(404).json({ error: 'Device not found in GenieACS' });
    const local = await syncLocal(req.prisma, device);
    const { root, ssid } = acs.extractWifi(device);
    const ident = acs.extractIdentity(device);
    let subscriber = null;
    if (local && local.subscriber_id) {
      subscriber = await req.prisma.subscribers.findUnique({
        where: { id: local.subscriber_id },
        select: { id: true, account_number: true, first_name: true, last_name: true, phone: true, status: true },
      });
    }
    res.json({
      device_id: device._id,
      root,
      ...ident,
      wifi: { ssid, index: 1 },
      subscriber,
      local: local ? { notes: local.notes, last_wifi_change: local.last_wifi_change } : null,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load device', detail: e.message });
  }
});

// ── POST /devices/:id/link — bind device to subscriber ─────
router.post('/devices/:id/link', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const subscriberId = parseInt(req.body.subscriber_id, 10);
    if (!subscriberId) return res.status(400).json({ error: 'subscriber_id required' });

    const sub = await req.prisma.subscribers.findUnique({ where: { id: subscriberId } });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    const device = await acs.getDevice(deviceId);
    if (!device) return res.status(404).json({ error: 'Device not found in GenieACS' });

    const ident = acs.extractIdentity(device);
    const { ssid } = acs.extractWifi(device);
    const data = { ...ident, wifi_ssid: ssid || null, subscriber_id: subscriberId, updated_at: new Date() };
    const row = await req.prisma.tr069_devices.upsert({
      where: { device_id: deviceId },
      create: data,
      update: data,
    });
    res.json({ ok: true, device: row });
  } catch (e) {
    res.status(500).json({ error: 'Failed to link device', detail: e.message });
  }
});

// ── POST /devices/:id/unlink ───────────────────────────────
router.post('/devices/:id/unlink', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const row = await req.prisma.tr069_devices.findUnique({ where: { device_id: deviceId } });
    if (!row) return res.status(404).json({ error: 'Device not tracked locally' });
    await req.prisma.tr069_devices.update({
      where: { device_id: deviceId },
      data: { subscriber_id: null, updated_at: new Date() },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to unlink device', detail: e.message });
  }
});

// ── GET /subscriber/:id/device — the CPE linked to one subscriber ──
// The subscriber modal needs one device, not the fleet. GET /devices pulls every
// document out of GenieACS with a wide projection and auto-links by serial as a side
// effect — far too heavy to run every time staff open a customer. This reads the local
// binding and asks GenieACS about that single device.
router.get('/subscriber/:id/device', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const subscriberId = parseInt(req.params.id, 10);
    if (!Number.isFinite(subscriberId)) return res.status(400).json({ error: 'Invalid subscriber id' });

    // A household occasionally has more than one linked CPE; prefer the one that has
    // reported most recently, same rule the portal uses.
    const rows = await req.prisma.tr069_devices.findMany({
      where: { subscriber_id: subscriberId },
      orderBy: { last_inform: 'desc' },
    });
    const row = rows[0];
    if (!row) return res.json({ linked: false, device: null });

    let online = false;
    let lastInform = row.last_inform;
    // The band picker is built from the radios this ONU actually exposes, so a
    // single-band unit never offers a 5 GHz option that would fail on apply.
    let bands = [];
    try {
      const live = await acs.getDevice(row.device_id);
      if (live) {
        const li = live._lastInform ? new Date(live._lastInform) : null;
        if (li) lastInform = li;
        online = !!li && (Date.now() - li.getTime() < 10 * 60 * 1000);
        bands = acs.wifiTargets(live).map(t => ({ index: t.index, ssid: t.ssid, band: t.band }));
      }
    } catch (_) {
      // GenieACS being unreachable must not blank the card — fall back to the stored
      // last_inform and report offline rather than failing the whole request.
    }

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
        serial_number: row.serial_number,
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
    res.status(500).json({ error: 'Failed to load subscriber device', detail: e.message });
  }
});

// ── POST /devices/:id/wifi — update SSID / password ────────
router.post('/devices/:id/wifi', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const { ssid, password, band } = req.body || {};
    if (!ssid && !password) return res.status(400).json({ error: 'ssid or password required' });
    if (ssid && (typeof ssid !== 'string' || ssid.length > 32)) {
      return res.status(400).json({ error: 'ssid must be <=32 chars' });
    }
    // An unrecognised band would fall through as "no filter" and quietly write both
    // radios, the opposite of what the caller asked for. Reject it instead.
    if (band && !acs.normalizeBand(band)) {
      return res.status(400).json({ error: 'band must be "2.4", "5", or omitted for both' });
    }
    if (password && (typeof password !== 'string' || password.length < 8 || password.length > 63)) {
      return res.status(400).json({ error: 'password must be 8-63 chars' });
    }

    // Cooldown check
    const row = await req.prisma.tr069_devices.findUnique({ where: { device_id: deviceId } });
    const cooldownMs = req.acsSettings.wifiCooldownSec * 1000;
    if (row && row.last_wifi_change) {
      const elapsed = Date.now() - row.last_wifi_change.getTime();
      if (elapsed < cooldownMs) {
        return res.status(429).json({
          error: 'WiFi change cooldown active',
          retry_after_sec: Math.ceil((cooldownMs - elapsed) / 1000),
        });
      }
    }

    // A password goes to every enabled radio; the response reports which, so the caller
    // can say "both bands" only when there really were two.
    const result = await acs.updateWifi(deviceId, { ssid, password, band });
    await req.prisma.tr069_devices.upsert({
      where: { device_id: deviceId },
      create: {
        device_id: deviceId,
        wifi_ssid: ssid || (row && row.wifi_ssid) || null,
        last_wifi_change: new Date(),
      },
      update: {
        wifi_ssid: ssid || (row && row.wifi_ssid) || null,
        last_wifi_change: new Date(),
        updated_at: new Date(),
      },
    });
    res.json({
      ok: true,
      bands: result.bands || [],
      message: 'Task queued; will apply on next INFORM',
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update WiFi', detail: e.message });
  }
});

// ── Config field map ───────────────────────────────────────
// Maps friendly form fields → TR-069 parameter paths + types.
// Keyed by data-model root (TR-098 vs TR-181). For Yealink phones
// (TR-181 + VoiceService), the SIP/Time blocks are what admins
// actually want to set.
// Yealink T2x/T3x/T4x layout: VoiceProfile.{N} = Line N (one Line per
// VoiceProfile). SIP server config lives at VoiceProfile.{N}.SIP.* (NOT
// per-line) and account credentials at VoiceProfile.{N}.Line.1.SIP.*
function yealinkLine(n) {
  const profile = `Device.Services.VoiceService.1.VoiceProfile.${n}`;
  const line = `${profile}.Line.1`;
  const k = (suffix) => `sip${n===1?'':n}_${suffix}`;
  return {
    [k('enable')]:            `${line}.Enable`,
    [k('server')]:            `${profile}.SIP.RegistrarServer`,
    [k('server_port')]:       `${profile}.SIP.RegistrarServerPort`,
    [k('proxy')]:             `${profile}.SIP.OutboundProxy`,
    [k('proxy_port')]:        `${profile}.SIP.OutboundProxyPort`,
    [k('register_expires')]:  `${profile}.SIP.RegisterExpires`,
    [k('directory_number')]:  `${line}.SIP.X_001565_UserName`,
    [k('auth_user')]:         `${line}.SIP.AuthUserName`,
    [k('auth_password')]:     `${line}.SIP.AuthPassword`,
    [k('display_name')]:      `${line}.SIP.X_001565_DisplayName`,
    [k('voicemail')]:         `${line}.CallingFeatures.VoiceMailNumber`,
    [k('call_waiting')]:      `${line}.CallingFeatures.CallWaitingEnable`,
    [k('anon')]:              `${line}.CallingFeatures.AnonymousCallEnable`,
    [k('cfwd_all')]:          `${line}.CallingFeatures.CallForwardUnconditionalNumber`,
    [k('cfwd_busy')]:         `${line}.CallingFeatures.CallForwardOnBusyNumber`,
    [k('cfwd_noans')]:        `${line}.CallingFeatures.CallForwardOnNoAnswerNumber`,
  };
}

const CONFIG_PARAMS = {
  'Device': {
    // Network — Yealink IP phones expose this under Device.LAN.*
    // (not under Device.IP.Interface.* like routers)
    network_addressing: 'Device.LAN.AddressingType',
    network_ip:         'Device.LAN.IPAddress',
    network_mask:       'Device.LAN.SubnetMask',
    network_gateway:    'Device.LAN.DefaultGateway',
    network_dns1:       'Device.LAN.DNSServers',
    // SIP — Line 1 (VoiceProfile.1) + Line 2 (VoiceProfile.2)
    ...yealinkLine(1),
    ...yealinkLine(2),
    // Audio (per-profile / per-line)
    dtmf_method:  'Device.Services.VoiceService.1.VoiceProfile.1.DTMFMethod',
    ec_enable:    'Device.Services.VoiceService.1.VoiceProfile.1.Line.1.VoiceProcessing.EchoCancellationEnable',
    vad_enable:   'Device.Services.VoiceService.1.VoiceProfile.1.Line.1.VoiceProcessing.VoiceActivityDetectionEnable',
    rtp_port_min: 'Device.Services.VoiceService.1.VoiceProfile.1.RTP.LocalPortMin',
    // Time
    ntp_server1: 'Device.Time.NTPServer1',
    ntp_server2: 'Device.Time.NTPServer2',
    timezone:    'Device.Time.LocalTimeZone',
    time_format: 'Device.Time.X_001565_TimeFormat',
    // Inform
    inform_interval: 'Device.ManagementServer.PeriodicInformInterval',
  },
  'InternetGatewayDevice': {
    network_ip: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
    ntp_server1: 'InternetGatewayDevice.Time.NTPServer1',
    timezone: 'InternetGatewayDevice.Time.LocalTimeZone',
    inform_interval: 'InternetGatewayDevice.ManagementServer.PeriodicInformInterval',
  },
};

const FIELD_TYPES = {
  inform_interval: 'xsd:unsignedInt',
  rtp_port_min: 'xsd:unsignedInt',
  // Line 1
  sip_server_port: 'xsd:unsignedInt',
  sip_proxy_port: 'xsd:unsignedInt',
  sip_register_expires: 'xsd:unsignedInt',
  sip_call_waiting: 'xsd:boolean',
  sip_anon: 'xsd:boolean',
  // Line 2
  sip2_server_port: 'xsd:unsignedInt',
  sip2_proxy_port: 'xsd:unsignedInt',
  sip2_register_expires: 'xsd:unsignedInt',
  sip2_call_waiting: 'xsd:boolean',
  sip2_anon: 'xsd:boolean',
  // Audio
  ec_enable: 'xsd:boolean',
  vad_enable: 'xsd:boolean',
  // Time
  time_format: 'xsd:unsignedInt',
};

// ── GET /devices/:id/config — current configurable values ──
router.get('/devices/:id/config', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const device = await acs.getDevice(deviceId);
    if (!device) return res.status(404).json({ error: 'Device not found in GenieACS' });
    const root = device.InternetGatewayDevice ? 'InternetGatewayDevice' : (device.Device ? 'Device' : null);
    if (!root) return res.status(400).json({ error: 'Device has no recognised data model root' });
    const map = CONFIG_PARAMS[root] || {};
    const values = {};
    for (const [field, path] of Object.entries(map)) {
      const v = path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), device);
      values[field] = v && typeof v === 'object' && '_value' in v ? v._value : null;
    }
    res.json({ root, values });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read config', detail: e.message });
  }
});

// ── POST /devices/:id/config — apply config changes ────────
// Body: { fields: { sip_server: "...", ... }, advanced: [{path,value,type}] }
router.post('/devices/:id/config', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const { fields = {}, advanced = [] } = req.body || {};
    const device = await acs.getDevice(deviceId);
    if (!device) return res.status(404).json({ error: 'Device not found in GenieACS' });
    const root = device.InternetGatewayDevice ? 'InternetGatewayDevice' : (device.Device ? 'Device' : null);
    if (!root) return res.status(400).json({ error: 'Device has no recognised data model root' });
    const map = CONFIG_PARAMS[root] || {};

    const tuples = [];
    for (const [field, value] of Object.entries(fields)) {
      if (value === '' || value === null || value === undefined) continue;
      const path = map[field];
      if (!path) continue; // silently skip unknown fields for this root
      const type = FIELD_TYPES[field] || 'xsd:string';
      const v = type === 'xsd:unsignedInt' ? Number(value) : String(value);
      tuples.push([path, v, type]);
    }
    if (Array.isArray(advanced)) {
      for (const a of advanced) {
        if (!a || !a.path || a.value === undefined) continue;
        const type = a.type || 'xsd:string';
        const v = type === 'xsd:unsignedInt' || type === 'xsd:int' ? Number(a.value) : (type === 'xsd:boolean' ? !!a.value : String(a.value));
        tuples.push([a.path, v, type]);
      }
    }
    if (!tuples.length) return res.status(400).json({ error: 'No parameters to apply' });

    await acs.setParameterValues(deviceId, tuples);
    res.json({ ok: true, applied: tuples.length, message: 'Config queued; CPE applies on next INFORM or connection request' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to apply config', detail: e.message });
  }
});

// ── POST /devices/:id/reboot ───────────────────────────────
router.post('/devices/:id/reboot', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const deviceId = req.params.id;
    await acs.rebootDevice(deviceId);
    res.json({ ok: true, message: 'Reboot task queued' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reboot', detail: e.message });
  }
});

// Soft reset: clear all SIP / voice / call-feature config but leave
// Device.ManagementServer.* untouched so the CPE keeps reporting to
// GenieACS. We do NOT issue the factoryReset RPC — instead we walk the
// device's VoiceService tree and queue setParameterValues to blank out
// known fields, then reboot.
function buildSipResetTuples(device) {
  const tuples = [];
  const root = device.InternetGatewayDevice ? 'InternetGatewayDevice' : (device.Device ? 'Device' : null);
  if (!root) return tuples;
  const services = ((device[root] || {}).Services || {});
  const vs = services.VoiceService || {};
  for (const vsKey of Object.keys(vs)) {
    if (vsKey.startsWith('_') || !/^\d+$/.test(vsKey)) continue;
    const vsObj = vs[vsKey] || {};
    const profiles = vsObj.VoiceProfile || {};
    for (const vpKey of Object.keys(profiles)) {
      if (vpKey.startsWith('_') || !/^\d+$/.test(vpKey)) continue;
      const vp = profiles[vpKey] || {};
      const vpBase = `${root}.Services.VoiceService.${vsKey}.VoiceProfile.${vpKey}`;
      // Profile-level SIP server (fallback)
      tuples.push([`${vpBase}.SIP.UserAgentDomain`, '', 'xsd:string']);
      tuples.push([`${vpBase}.SIP.RegistrarServer`, '', 'xsd:string']);
      tuples.push([`${vpBase}.SIP.OutboundProxy`, '', 'xsd:string']);
      // Per-line config + credentials + features
      const lines = vp.Line || {};
      for (const lnKey of Object.keys(lines)) {
        if (lnKey.startsWith('_') || !/^\d+$/.test(lnKey)) continue;
        const lnBase = `${vpBase}.Line.${lnKey}`;
        tuples.push([`${lnBase}.Enable`, 'Disabled', 'xsd:string']);
        tuples.push([`${lnBase}.DirectoryNumber`, '', 'xsd:string']);
        tuples.push([`${lnBase}.SIP.AuthUserName`, '', 'xsd:string']);
        tuples.push([`${lnBase}.SIP.AuthPassword`, '', 'xsd:string']);
        tuples.push([`${lnBase}.SIP.URI`, '', 'xsd:string']);
        tuples.push([`${lnBase}.SIP.RegistrarServer`, '', 'xsd:string']);
        tuples.push([`${lnBase}.SIP.OutboundProxy`, '', 'xsd:string']);
        tuples.push([`${lnBase}.CallingFeatures.CallerIDName`, '', 'xsd:string']);
        tuples.push([`${lnBase}.CallingFeatures.VoiceMailNumber`, '', 'xsd:string']);
        tuples.push([`${lnBase}.CallingFeatures.CallForwardUnconditionalNumber`, '', 'xsd:string']);
        tuples.push([`${lnBase}.CallingFeatures.CallForwardOnBusyNumber`, '', 'xsd:string']);
        tuples.push([`${lnBase}.CallingFeatures.CallForwardOnNoAnswerNumber`, '', 'xsd:string']);
      }
    }
  }
  return tuples;
}

// ── POST /devices/:id/factory-reset ────────────────────────
// Body: { confirm: true, preserveTr069?: boolean }
//   preserveTr069=true  → soft reset (clear SIP/voice config + reboot,
//                         ManagementServer.* untouched). Default for SIP CPE.
//   preserveTr069=false → hard reset (factoryReset RPC, full wipe).
router.post('/devices/:id/factory-reset', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const deviceId = req.params.id;
    if (req.body.confirm !== true) {
      return res.status(400).json({ error: 'confirm=true required' });
    }
    const preserve = req.body.preserveTr069 === true;

    if (preserve) {
      const device = await acs.getDevice(deviceId);
      if (!device) return res.status(404).json({ error: 'Device not found in GenieACS' });
      const tuples = buildSipResetTuples(device);
      if (!tuples.length) {
        return res.status(400).json({
          error: 'No SIP/voice parameters found on this device — soft reset has nothing to clear. Use preserveTr069=false for a full factoryReset.',
        });
      }
      await acs.setParameterValues(deviceId, tuples);
      await acs.rebootDevice(deviceId);
      return res.json({
        ok: true,
        mode: 'soft',
        cleared: tuples.length,
        message: 'SIP/voice config cleared, device rebooting. TR-069 ManagementServer config preserved.',
      });
    }

    await acs.factoryResetDevice(deviceId);
    res.json({ ok: true, mode: 'hard', message: 'Factory reset task queued (full wipe)' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to factory reset', detail: e.message });
  }
});

// ── POST /bulk/reboot ──────────────────────────────────────
// Queues reboot task on a list of device_ids. Does not abort on single failures —
// returns per-device results so the UI can show partial success.
router.post('/bulk/reboot', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.device_ids) ? req.body.device_ids : [];
    if (!ids.length) return res.status(400).json({ error: 'device_ids required (non-empty array)' });
    if (ids.length > 200) return res.status(400).json({ error: 'max 200 devices per bulk op' });

    const results = await Promise.allSettled(ids.map(id => acs.rebootDevice(id)));
    const out = ids.map((id, i) => ({
      device_id: id,
      ok: results[i].status === 'fulfilled',
      error: results[i].status === 'rejected' ? String(results[i].reason.message || results[i].reason) : null,
    }));
    const okCount = out.filter(r => r.ok).length;
    res.json({ ok: okCount === ids.length, queued: okCount, failed: ids.length - okCount, results: out });
  } catch (e) {
    res.status(500).json({ error: 'Bulk reboot failed', detail: e.message });
  }
});

// ── POST /bulk/wifi ────────────────────────────────────────
// Apply the same SSID/password to a list of devices. Useful for bulk
// re-keying (e.g. after a leaked wifi password). Subject to same cooldown
// as single-device wifi. Devices in cooldown are skipped (not failed).
router.post('/bulk/wifi', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.device_ids) ? req.body.device_ids : [];
    const { ssid, password } = req.body || {};
    if (!ids.length) return res.status(400).json({ error: 'device_ids required' });
    if (ids.length > 100) return res.status(400).json({ error: 'max 100 devices per bulk wifi op' });
    if (!ssid && !password) return res.status(400).json({ error: 'ssid or password required' });
    if (ssid && (typeof ssid !== 'string' || ssid.length > 32)) return res.status(400).json({ error: 'ssid must be <=32 chars' });
    if (password && (typeof password !== 'string' || password.length < 8 || password.length > 63)) {
      return res.status(400).json({ error: 'password must be 8-63 chars' });
    }

    const cooldownMs = req.acsSettings.wifiCooldownSec * 1000;
    const rows = await req.prisma.tr069_devices.findMany({
      where: { device_id: { in: ids } },
      select: { device_id: true, last_wifi_change: true },
    });
    const lastByDevice = new Map(rows.map(r => [r.device_id, r.last_wifi_change]));

    const out = [];
    for (const id of ids) {
      const last = lastByDevice.get(id);
      if (last && Date.now() - last.getTime() < cooldownMs) {
        out.push({ device_id: id, ok: false, skipped: 'cooldown' });
        continue;
      }
      try {
        await acs.updateWifi(id, { ssid, password });
        await req.prisma.tr069_devices.upsert({
          where: { device_id: id },
          create: { device_id: id, wifi_ssid: ssid || null, last_wifi_change: new Date() },
          update: { wifi_ssid: ssid || undefined, last_wifi_change: new Date(), updated_at: new Date() },
        });
        out.push({ device_id: id, ok: true });
      } catch (e) {
        out.push({ device_id: id, ok: false, error: String(e.message || e) });
      }
    }
    res.json({ ok: true, results: out, queued: out.filter(r => r.ok).length, skipped: out.filter(r => r.skipped).length, failed: out.filter(r => !r.ok && !r.skipped).length });
  } catch (e) {
    res.status(500).json({ error: 'Bulk wifi failed', detail: e.message });
  }
});

// ── GET /devices/:id/optical — GPON ONU optical readings ───
// Reads RX/TX power, voltage, temperature when available. Returns null for
// paths the CPE doesn't expose (not all ONUs report optical data over TR-069).
router.get('/devices/:id/optical', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const device = await acs.getDevice(deviceId);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    const root = acs.detectRoot(device);

    // Common paths across TR-098 / TR-181 vendor implementations.
    const candidates = root === 'InternetGatewayDevice'
      ? [
          'InternetGatewayDevice.X_CT-COM_GponInterfaceConfig.TXPower',
          'InternetGatewayDevice.X_CT-COM_GponInterfaceConfig.RXPower',
          'InternetGatewayDevice.X_CT-COM_GponInterfaceConfig.Temperature',
          'InternetGatewayDevice.X_CT-COM_GponInterfaceConfig.Voltage',
          'InternetGatewayDevice.X_CU_PON.TXPower',
          'InternetGatewayDevice.X_CU_PON.RXPower',
        ]
      : [
          'Device.XPON.Interface.1.Stats.RxPower',
          'Device.XPON.Interface.1.Stats.TxPower',
          'Device.XPON.Interface.1.Stats.Temperature',
          'Device.XPON.Interface.1.Stats.Voltage',
          'Device.Optical.Interface.1.CurrentRxPower',
          'Device.Optical.Interface.1.CurrentTxPower',
        ];

    const readings = {};
    for (const p of candidates) {
      const v = acs.readParam(device, p);
      if (v != null) {
        const key = p.split('.').pop().toLowerCase();
        readings[key] = v;
      }
    }
    res.json({ device_id: deviceId, root, readings, paths_checked: candidates.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read optical', detail: e.message });
  }
});

// ── POST /devices/:id/refresh — pull latest parameter values ─
router.post('/devices/:id/refresh', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const device = await acs.getDevice(deviceId);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    const root = acs.detectRoot(device) || 'InternetGatewayDevice';
    await acs.refreshDevice(deviceId, [
      `${root}.DeviceInfo.`,
      root === 'InternetGatewayDevice'
        ? 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.'
        : 'Device.WiFi.',
    ]);
    res.json({ ok: true, message: 'Refresh task queued' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to refresh', detail: e.message });
  }
});

// ── GET /settings — expose current effective TR-069 config ──
router.get('/settings', adminAuth(), async (req, res) => {
  try {
    const s = await acs.getSettings();
    res.json(s);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /cache/invalidate — clear settings cache on write ──
router.post('/cache/invalidate', adminAuth(), async (req, res) => {
  acs.invalidateCache();
  res.json({ ok: true });
});

// ── POST /auto-link — manually trigger serial-based linking ──
router.post('/auto-link', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const remote = await acs.listDevices({ projection: '_id,_deviceId' });
    const linked = await autoLinkBySerial(req.prisma, Array.isArray(remote) ? remote : []);
    res.json({ ok: true, linked });
  } catch (e) {
    res.status(500).json({ error: 'Auto-link failed', detail: e.message });
  }
});

// ============================================================
// FIRMWARE MANAGEMENT
// ============================================================

// ── GET /firmwares — list files in GenieACS store ──────────
router.get('/firmwares', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const files = await acs.listFiles();
    res.json({ files: Array.isArray(files) ? files : [] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list firmwares', detail: e.message });
  }
});

// ── POST /firmwares — upload firmware to GenieACS ─────────
// Form fields: file (multipart), oui, productClass, version, fileType
router.post('/firmwares', adminAuth(), requireEnabled, (req, res) => {
  firmwareUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'file field required' });
    try {
      await acs.uploadFile(req.file.originalname, req.file.buffer, {
        fileType: req.body.fileType || '1 Firmware Upgrade Image',
        oui: req.body.oui || undefined,
        productClass: req.body.productClass || undefined,
        version: req.body.version || undefined,
      });
      res.json({ ok: true, filename: req.file.originalname, size: req.file.size });
    } catch (e) {
      res.status(500).json({ error: 'Upload failed', detail: e.message });
    }
  });
});

// ── DELETE /firmwares/:filename ────────────────────────────
router.delete('/firmwares/:filename', adminAuth(), requireEnabled, async (req, res) => {
  try {
    await acs.deleteFile(req.params.filename);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed', detail: e.message });
  }
});

// ── POST /devices/:id/firmware — queue firmware download ──
router.post('/devices/:id/firmware', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const { file, fileType } = req.body || {};
    if (!file) return res.status(400).json({ error: 'file (NBI filename) required' });
    await acs.downloadFirmware(deviceId, file, fileType ? { fileType } : undefined);
    res.json({ ok: true, message: 'Firmware download task queued' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to queue firmware', detail: e.message });
  }
});

// ── POST /bulk/firmware — batch firmware push ─────────────
router.post('/bulk/firmware', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.device_ids) ? req.body.device_ids : [];
    const { file, fileType } = req.body || {};
    if (!ids.length) return res.status(400).json({ error: 'device_ids required' });
    if (ids.length > 50) return res.status(400).json({ error: 'max 50 devices per bulk firmware op' });
    if (!file) return res.status(400).json({ error: 'file required' });

    const results = await Promise.allSettled(
      ids.map(id => acs.downloadFirmware(id, file, fileType ? { fileType } : undefined))
    );
    const out = ids.map((id, i) => ({
      device_id: id,
      ok: results[i].status === 'fulfilled',
      error: results[i].status === 'rejected' ? String(results[i].reason.message || results[i].reason) : null,
    }));
    res.json({
      ok: out.every(r => r.ok),
      queued: out.filter(r => r.ok).length,
      failed: out.filter(r => !r.ok).length,
      results: out,
    });
  } catch (e) {
    res.status(500).json({ error: 'Bulk firmware failed', detail: e.message });
  }
});

// ============================================================
// CWMP TASK QUEUE — visibility into pending Download / Reboot /
// SetParam tasks waiting to fire on the next device inform.
// Each device has a PeriodicInformInterval (default 300 s) so we
// can predict the worst-case ETA from `_lastInform + interval`.
// ============================================================

router.get('/queue', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const [tasks, devices, faults] = await Promise.all([
      acs.listTasks().catch(() => []),
      acs.listDevices({
        projection: '_id,_lastInform,_deviceId,Device.ManagementServer.PeriodicInformInterval,InternetGatewayDevice.ManagementServer.PeriodicInformInterval',
      }).catch(() => []),
      acs.listFaults().catch(() => []),
    ]);
    // Build device map keyed by id
    const devMap = new Map();
    for (const d of (devices || [])) {
      const ident = acs.extractIdentity(d);
      const pii =
        (d.Device && d.Device.ManagementServer && d.Device.ManagementServer.PeriodicInformInterval && d.Device.ManagementServer.PeriodicInformInterval._value) ||
        (d.InternetGatewayDevice && d.InternetGatewayDevice.ManagementServer && d.InternetGatewayDevice.ManagementServer.PeriodicInformInterval && d.InternetGatewayDevice.ManagementServer.PeriodicInformInterval._value) ||
        300;
      devMap.set(d._id, {
        device_id: d._id,
        serial_number: ident.serial_number,
        manufacturer: ident.manufacturer,
        product_class: ident.product_class,
        last_inform: ident.last_inform,
        inform_interval_sec: Number(pii) || 300,
      });
    }
    // Build a fault-by-task index so we can flag rows that already faulted
    const faultByTask = new Map();
    for (const f of (faults || [])) {
      if (f.channel && f.channel.startsWith('task_')) {
        faultByTask.set(f.channel.slice(5), f);
      }
    }
    // Heuristic — translate raw CWMP task fields into a one-line
    // human-readable purpose so operators can tell at a glance what
    // the task was queued for.
    function inferPurpose(t) {
      if (t.name === 'download') {
        const f = (t.file || '').toLowerCase();
        const ft = t.fileType || '';
        if (f.includes('security') || f.includes('lock')) return 'Yealink security lockdown — disable LCD reset + rotate admin password';
        if (ft.includes('Firmware') || /\.(rom|bin|fw|img)$/.test(f)) return 'Firmware upgrade — CPE will reboot during install';
        if (ft.includes('Vendor Configuration') || /\.cfg$/.test(f)) return 'Vendor config push — CPE applies on next inform';
        return 'File download to CPE';
      }
      if (t.name === 'getParameterValues') {
        const paths = t.parameterNames || [];
        const text = paths.join(' ');
        // Auto-refresh preset (covers wide swath of voice + network)
        if (paths.length > 8 && /VoiceProfile/.test(text)) return 'Auto-refresh on inform — pull current SIP / network / time / audio';
        if (/VoiceProfile|SIP|Line\./.test(text)) return 'Refresh SIP / voice config (Configure modal opened or auto-refresh)';
        if (/WiFi/.test(text)) return 'Refresh WiFi state';
        if (/LAN|IP\.Interface|DNS|Routing/.test(text)) return 'Refresh network config';
        if (/Time\./.test(text)) return 'Refresh NTP / timezone';
        if (/DeviceInfo/.test(text) && paths.length === 1) return 'Diagnostic probe (uptime / version check)';
        if (/DeviceInfo/.test(text)) return 'Refresh device identity';
        if (/ManagementServer/.test(text)) return 'Refresh ACS settings';
        return 'Read CPE parameters';
      }
      if (t.name === 'setParameterValues') {
        const paths = (t.parameterValues || []).map(p => p[0]);
        const text = paths.join(' ');
        if (/Line\.\*\.SIP|VoiceProfile/.test(text) && paths.length > 3) return 'Soft factory reset — clear SIP / voice config';
        if (/SIP|Line\./.test(text)) return 'Apply SIP / voice changes from Configure modal';
        if (/WiFi.*SSID|WiFi.*KeyPassphrase/.test(text)) return 'Apply WiFi update';
        if (/LAN|IP\.Interface|DNS/.test(text)) return 'Apply network changes';
        if (/Time\./.test(text)) return 'Apply time / timezone';
        if (/ManagementServer/.test(text)) return 'Apply ACS / inform-interval changes';
        return 'Apply parameter changes';
      }
      if (t.name === 'reboot') return 'Reboot CPE — 30-60s downtime';
      if (t.name === 'factoryReset') return 'Hard factory reset — full wipe';
      if (t.name === 'refreshObject') {
        const o = t.objectName || '';
        if (!o) return 'Refresh entire CPE object tree';
        if (/VoiceService/.test(o)) return 'Refresh voice service tree';
        return 'Refresh object: ' + o;
      }
      return 'CWMP task';
    }

    const now = Date.now();
    const items = (tasks || []).map(t => {
      const dev = devMap.get(t.device) || { device_id: t.device, inform_interval_sec: 300, last_inform: null };
      const queuedAt = t.timestamp ? new Date(t.timestamp).getTime() : now;
      const lastInformMs = dev.last_inform ? new Date(dev.last_inform).getTime() : 0;
      // ETA = max(now, lastInform + interval) — task fires on the
      // next inform after it was queued. If the device is offline,
      // ETA shifts as informs slip; we report best-case using cached
      // lastInform.
      const intervalMs = dev.inform_interval_sec * 1000;
      const projected = lastInformMs + intervalMs;
      const etaMs = Math.max(queuedAt + 1000, projected);
      const etaSec = Math.max(0, Math.round((etaMs - now) / 1000));
      const fault = faultByTask.get(t._id) || null;
      // Pretty-printed task action summary
      let action = t.name;
      let target = '';
      if (t.name === 'download') {
        target = t.file || '';
        action = (t.fileType || '').includes('Firmware') ? 'Firmware push' :
                 (t.fileType || '').includes('Configuration') ? 'Config push' : 'Download';
      } else if (t.name === 'setParameterValues') {
        target = (t.parameterValues || []).slice(0, 2).map(p => p[0]).join(', ');
        if ((t.parameterValues || []).length > 2) target += ` (+${(t.parameterValues||[]).length - 2} more)`;
        action = 'Set parameters';
      } else if (t.name === 'getParameterValues') {
        target = (t.parameterNames || []).slice(0, 2).join(', ');
        if ((t.parameterNames || []).length > 2) target += ` (+${(t.parameterNames||[]).length - 2} more)`;
        action = 'Get parameters';
      } else if (t.name === 'reboot') {
        action = 'Reboot';
      } else if (t.name === 'factoryReset') {
        action = 'Factory reset';
      } else if (t.name === 'refreshObject') {
        target = t.objectName || '(all)';
        action = 'Refresh object';
      }
      return {
        task_id: t._id,
        action,
        purpose: inferPurpose(t),
        name: t.name,
        target,
        file: t.file || null,
        file_type: t.fileType || null,
        device: dev,
        queued_at: t.timestamp || null,
        eta_at: new Date(etaMs).toISOString(),
        eta_seconds: etaSec,
        last_inform: dev.last_inform,
        inform_interval_sec: dev.inform_interval_sec,
        fault: fault ? {
          code: fault.code,
          message: fault.message,
          retries: fault.retries,
          since: fault.timestamp,
        } : null,
      };
    });
    // Sort: faulted first, then earliest ETA
    items.sort((a, b) => {
      if (!!a.fault !== !!b.fault) return a.fault ? -1 : 1;
      return a.eta_seconds - b.eta_seconds;
    });
    res.json({ count: items.length, items });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load queue', detail: e.message });
  }
});

// Cancel a queued task (and optionally clear its fault)
router.delete('/queue/:taskId', adminAuth(), requireEnabled, async (req, res) => {
  try {
    await acs.deleteTask(req.params.taskId).catch(() => null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to cancel task', detail: e.message });
  }
});

// ============================================================
// YEALINK SECURITY LOCK — disables LCD factory reset and rotates
// the admin password from default admin/admin via autoprovision
// config file pushed as TR-069 Download (file type 3).
// ============================================================

const YEALINK_SECURITY_FILE = 'yealink-security-lock.cfg';
const YEALINK_SECURITY_FILETYPE = '3 Vendor Configuration File';

// POST /yealink/lock-all — push security cfg to every Yealink device
router.post('/yealink/lock-all', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const remote = await acs.listDevices({ projection: '_id,_deviceId' });
    const list = Array.isArray(remote) ? remote : [];
    const yealinks = list.filter(d => {
      const m = d._deviceId && d._deviceId._Manufacturer;
      return m && String(m).toLowerCase() === 'yealink';
    });
    if (!yealinks.length) {
      return res.status(404).json({ error: 'No Yealink devices found in GenieACS' });
    }
    const results = await Promise.allSettled(
      yealinks.map(d => acs.downloadFirmware(d._id, YEALINK_SECURITY_FILE, { fileType: YEALINK_SECURITY_FILETYPE }))
    );
    const out = yealinks.map((d, i) => ({
      device_id: d._id,
      serial: d._deviceId && d._deviceId._SerialNumber,
      ok: results[i].status === 'fulfilled',
      error: results[i].status === 'rejected' ? String(results[i].reason.message || results[i].reason) : null,
    }));
    res.json({
      ok: out.every(r => r.ok),
      total: yealinks.length,
      queued: out.filter(r => r.ok).length,
      failed: out.filter(r => !r.ok).length,
      file: YEALINK_SECURITY_FILE,
      results: out,
      note: 'CPE applies on next INFORM (≤5 min). LCD factory reset will be disabled and admin password rotated.',
    });
  } catch (e) {
    res.status(500).json({ error: 'Yealink lock-all failed', detail: e.message });
  }
});

// POST /devices/:id/yealink-lock — push security cfg to a single Yealink
router.post('/devices/:id/yealink-lock', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const deviceId = req.params.id;
    await acs.downloadFirmware(deviceId, YEALINK_SECURITY_FILE, { fileType: YEALINK_SECURITY_FILETYPE });
    res.json({ ok: true, file: YEALINK_SECURITY_FILE, message: 'Security cfg queued; CPE applies on next INFORM' });
  } catch (e) {
    res.status(500).json({ error: 'Yealink lock failed', detail: e.message });
  }
});

// ============================================================
// METRICS / DIAGNOSTICS
// ============================================================

// ── GET /devices/:id/metrics?hours=24 — timeseries ────────
router.get('/devices/:id/metrics', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const hours = Math.min(parseInt(req.query.hours, 10) || 24, 24 * 30);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const rows = await req.prisma.tr069_metrics.findMany({
      where: { device_id: deviceId, collected_at: { gt: since } },
      orderBy: { collected_at: 'asc' },
    });
    // Convert Decimal -> number for easy client consumption
    res.json({
      device_id: deviceId,
      hours,
      points: rows.map(r => ({
        t: r.collected_at,
        rx_power: r.rx_power != null ? Number(r.rx_power) : null,
        tx_power: r.tx_power != null ? Number(r.tx_power) : null,
        voltage: r.voltage != null ? Number(r.voltage) : null,
        temperature: r.temperature != null ? Number(r.temperature) : null,
        cpu_usage: r.cpu_usage != null ? Number(r.cpu_usage) : null,
        mem_usage: r.mem_usage != null ? Number(r.mem_usage) : null,
        uptime_sec: r.uptime_sec,
        online: r.online,
      })),
      count: rows.length,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read metrics', detail: e.message });
  }
});

// ── POST /metrics/collect-now — manual trigger for the cron job ──
// Useful for first-run testing without waiting for the 10-minute tick.
router.post('/metrics/collect-now', adminAuth(), requireEnabled, async (req, res) => {
  try {
    const job = require('../jobs/tr069-diagnostics');
    await job.run(req.prisma);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Manual collection failed', detail: e.message });
  }
});

// ============================================================
// ALERTS
// ============================================================

// Convert BigInt id field to string for JSON serialization
function alertRowToJson(r) {
  return {
    id: r.id.toString(),
    alert_type: r.alert_type,
    fired_at: r.fired_at,
    severity: r.severity,
    summary: r.summary,
    detail: r.detail,
    sent_sms_to: r.sent_sms_to,
    sent_email_to: r.sent_email_to,
    resolved_at: r.resolved_at,
  };
}

// ── GET /alerts — recent alert history (admin UI) ─────────
router.get('/alerts', adminAuth(), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const rows = await req.prisma.tr069_alert_history.findMany({
      orderBy: { fired_at: 'desc' },
      take: limit,
    });
    res.json({ alerts: rows.map(alertRowToJson), count: rows.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list alerts', detail: e.message });
  }
});

// ── GET /alerts/config — read current alert rule settings ─
router.get('/alerts/config', adminAuth(), async (req, res) => {
  try {
    const rows = await req.prisma.system_settings.findMany({
      where: { key: { startsWith: 'tr069_alerts_' } },
    });
    const cfg = {};
    for (const r of rows) cfg[r.key] = r.value;
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /alerts/config — update alert rule settings ───────
router.put('/alerts/config', adminAuth(), async (req, res) => {
  try {
    const allowed = new Set([
      'tr069_alerts_enabled',
      'tr069_alerts_sms_numbers',
      'tr069_alerts_email_to',
      'tr069_alerts_offline_pct',
      'tr069_alerts_offline_min_fleet',
      'tr069_alerts_fault_threshold',
      'tr069_alerts_optical_rx_dbm',
      'tr069_alerts_cooldown_min',
    ]);
    const incoming = req.body || {};
    const writes = [];
    for (const [key, value] of Object.entries(incoming)) {
      if (!allowed.has(key)) continue;
      writes.push(
        req.prisma.system_settings.upsert({
          where: { key },
          create: { key, value: String(value) },
          update: { value: String(value) },
        })
      );
    }
    await Promise.all(writes);
    res.json({ ok: true, updated: writes.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update', detail: e.message });
  }
});

// ── POST /alerts/run-now — trigger the alerts cron job inline ──
// For testing rule logic without waiting 5 minutes for the schedule.
router.post('/alerts/run-now', adminAuth(), async (req, res) => {
  try {
    const job = require('../jobs/tr069-alerts');
    await job.run(req.prisma);
    const fresh = await req.prisma.tr069_alert_history.findMany({
      orderBy: { fired_at: 'desc' },
      take: 10,
    });
    res.json({ ok: true, recent_alerts: fresh.map(alertRowToJson) });
  } catch (e) {
    res.status(500).json({ error: 'Alerts job failed', detail: e.message });
  }
});

// ── POST /alerts/test — fire a test alert through both channels ──
router.post('/alerts/test', adminAuth(), async (req, res) => {
  try {
    const job = require('../jobs/tr069-alerts');
    // Temporarily bypass cooldown by writing a synthetic alert_type.
    const cfgRows = await req.prisma.system_settings.findMany({
      where: { key: { startsWith: 'tr069_alerts_' } },
    });
    const m = {};
    for (const r of cfgRows) m[r.key] = r.value;
    const sms = require('../config/sms');
    const email = require('../config/email');
    const smsNumbers = (m.tr069_alerts_sms_numbers || '').split(',').map(s => s.trim()).filter(Boolean);
    const emailTo = (m.tr069_alerts_email_to || '').trim();

    const results = { sms: [], email: null };
    for (const to of smsNumbers) {
      try {
        const r = await sms.sendWithPrisma(req.prisma, to, '[Netfactory TR-069 TEST] Alert test from admin UI — ignore.');
        results.sms.push({ to, ok: !!(r && r.ok) });
      } catch (e) {
        results.sms.push({ to, ok: false, error: e.message });
      }
    }
    if (emailTo) {
      try {
        await email.sendWithPrisma(req.prisma, {
          to: emailTo,
          subject: '[Netfactory TR-069 TEST] Alert test',
          html: '<p>This is a test alert from the TR-069 Manager. No action needed.</p>',
        });
        results.email = { to: emailTo, ok: true };
      } catch (e) {
        results.email = { to: emailTo, ok: false, error: e.message };
      }
    }
    await req.prisma.tr069_alert_history.create({
      data: {
        alert_type: 'test',
        severity: 'info',
        summary: 'Manual test alert',
        detail: 'Triggered from POST /api/admin/tr069/alerts/test',
        sent_sms_to: results.sms.filter(r => r.ok).map(r => r.to).join(',') || null,
        sent_email_to: results.email && results.email.ok ? results.email.to : null,
      },
    });
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: 'Test alert failed', detail: e.message });
  }
});

module.exports = router;
module.exports.autoLinkBySerial = autoLinkBySerial;
