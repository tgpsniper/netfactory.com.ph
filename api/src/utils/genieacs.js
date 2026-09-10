// ============================================================
// utils/genieacs.js — GenieACS NBI client
// ============================================================
// Reads NBI / CWMP URLs and feature flags from system_settings
// (cached 30s). Talks to GenieACS Northbound Interface over HTTP.
// Handles TR-098 (InternetGatewayDevice.*) and TR-181 (Device.*)
// parameter-path differences automatically.
// ============================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const CACHE_TTL_MS = 30 * 1000;
let settingsCache = { value: null, expires: 0 };

async function getSettings() {
  if (Date.now() < settingsCache.expires && settingsCache.value) {
    return settingsCache.value;
  }
  const rows = await prisma.system_settings.findMany({
    where: { key: { startsWith: 'tr069_' } },
  });
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  const value = {
    enabled: map.tr069_enabled === 'true',
    nbiUrl: (map.tr069_nbi_url || 'http://127.0.0.1:7557').replace(/\/$/, ''),
    cwmpUrl: (map.tr069_cwmp_url || 'http://127.0.0.1:7547').replace(/\/$/, ''),
    wifiCooldownSec: parseInt(map.tr069_wifi_change_cooldown || '300', 10),
  };
  settingsCache = { value, expires: Date.now() + CACHE_TTL_MS };
  return value;
}

function invalidateCache() {
  settingsCache = { value: null, expires: 0 };
}

// ── Low-level NBI HTTP helpers ──────────────────────────────

async function nbiRequest(method, path, body) {
  const { nbiUrl } = await getSettings();
  const url = `${nbiUrl}${path}`;
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`GenieACS ${method} ${path} -> ${res.status} ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

// ── Device queries ──────────────────────────────────────────

// List devices. GenieACS query uses MongoDB-style JSON.
async function listDevices({ query = {}, projection, limit } = {}) {
  const params = new URLSearchParams();
  params.set('query', JSON.stringify(query));
  if (projection) params.set('projection', projection);
  if (limit) params.set('limit', String(limit));
  return nbiRequest('GET', `/devices/?${params.toString()}`);
}

async function getDevice(deviceId) {
  const devices = await listDevices({ query: { _id: deviceId } });
  return Array.isArray(devices) && devices.length ? devices[0] : null;
}

// ── Parameter path detection (TR-098 vs TR-181) ────────────
// GenieACS stores parameters as nested objects. TR-098 devices use
// "InternetGatewayDevice.*", TR-181 devices use "Device.*". A device
// always has exactly one root.
function detectRoot(device) {
  if (!device) return null;
  if (device.InternetGatewayDevice) return 'InternetGatewayDevice';
  if (device.Device) return 'Device';
  return null;
}

// Read a parameter value from a device object using dotted path.
function readParam(device, path) {
  const parts = path.split('.');
  let cur = device;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  if (cur && typeof cur === 'object' && '_value' in cur) return cur._value;
  return cur;
}

// Build the WLAN configuration root path for a given TR standard.
// WLANConfiguration index 1 is the 2.4GHz radio on almost every device.
function wifiPath(root, index = 1) {
  if (root === 'InternetGatewayDevice') {
    return `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}`;
  }
  return `Device.WiFi.SSID.${index}`; // simplified; see note in updateWifi
}

// ── Tasks (changes pushed to CPE on next INFORM) ────────────

async function createTask(deviceId, task, { connectionRequest = true } = {}) {
  const qs = connectionRequest ? '?connection_request' : '';
  return nbiRequest(
    'POST',
    `/devices/${encodeURIComponent(deviceId)}/tasks${qs}`,
    task
  );
}

// List pending tasks (optionally filtered by Mongo-style query).
async function listTasks(query) {
  const qs = query ? `?query=${encodeURIComponent(JSON.stringify(query))}` : '';
  return nbiRequest('GET', `/tasks${qs}`);
}

async function deleteTask(taskId) {
  return nbiRequest('DELETE', `/tasks/${encodeURIComponent(taskId)}`);
}

// List active faults (optionally filtered).
async function listFaults(query) {
  const qs = query ? `?query=${encodeURIComponent(JSON.stringify(query))}` : '';
  return nbiRequest('GET', `/faults${qs}`);
}

// ── Firmware file store ─────────────────────────────────────
// NBI file endpoints use non-JSON bodies, so we bypass nbiRequest().

async function listFiles() {
  return nbiRequest('GET', '/files/');
}

async function uploadFile(filename, buffer, { fileType = '1 Firmware Upgrade Image', oui, productClass, version } = {}) {
  const { nbiUrl } = await getSettings();
  const url = `${nbiUrl}/files/${encodeURIComponent(filename)}`;
  const headers = {
    'Content-Type': 'application/octet-stream',
    'fileType': fileType,
  };
  if (oui) headers['oui'] = oui;
  if (productClass) headers['productClass'] = productClass;
  if (version) headers['version'] = version;
  const res = await fetch(url, { method: 'PUT', headers, body: buffer });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GenieACS PUT /files/${filename} -> ${res.status} ${text}`);
  }
  return { ok: true };
}

async function deleteFile(filename) {
  return nbiRequest('DELETE', `/files/${encodeURIComponent(filename)}`);
}

// Push a firmware download task to a device. file is the NBI-stored filename.
async function downloadFirmware(deviceId, file, { fileType = '1 Firmware Upgrade Image' } = {}) {
  return createTask(deviceId, {
    name: 'download',
    file,
    fileType,
  });
}

async function refreshDevice(deviceId, paths) {
  return createTask(deviceId, {
    name: 'getParameterValues',
    parameterNames: paths,
  });
}

async function rebootDevice(deviceId) {
  return createTask(deviceId, { name: 'reboot' });
}

async function factoryResetDevice(deviceId) {
  return createTask(deviceId, { name: 'factoryReset' });
}

// Apply an array of [path, value, type] tuples to a device.
async function setParameterValues(deviceId, tuples) {
  return createTask(deviceId, {
    name: 'setParameterValues',
    parameterValues: tuples,
  });
}

// Update WiFi SSID/password. TR-098 exposes clean flat fields;
// TR-181 splits SSID (Device.WiFi.SSID.1.SSID) from the security
// config (Device.WiFi.AccessPoint.1.Security.KeyPassphrase).
// Enumerate the WLAN interfaces a password should be written to.
//
// A dual-band ONU exposes one WLANConfiguration per radio, and the numbering is
// vendor-specific — on the RTEG WZAX3000 it is 1-4 = 2.4 GHz and 5-8 = 5 GHz, with
// only 1 and 5 enabled and 2/3/4/6/7/8 sitting there as disabled spare/mesh SSIDs.
// So the instances are discovered from the device document, never hardcoded.
//
// Two rules keep this from breaking things:
//   * only ENABLED interfaces with an SSID are touched, so the disabled guest and
//     mesh SSIDs are left alone rather than silently given the customer's password;
//   * only parameter paths that actually EXIST on the device are written. This one
//     matters more than it looks: SetParameterValues is atomic, so a single unknown
//     path faults the whole request (9005 Invalid Parameter Name) and NOTHING is
//     applied. This firmware has no WLANConfiguration.N.KeyPassphrase leaf at all —
//     the passphrase lives at PreSharedKey.1.KeyPassphrase — so the previous
//     unconditional write of both paths could never have succeeded on it.
function wifiTargets(device) {
  const root = detectRoot(device);
  const out = [];
  if (!root) return out;

  const enabled = (v) => {
    if (v === undefined || v === null) return true;      // unknown -> do not exclude
    const t = String(v).trim().toLowerCase();
    return !(t === 'false' || t === '0');
  };

  if (root === 'InternetGatewayDevice') {
    const wl = ((device.InternetGatewayDevice || {}).LANDevice || {})['1'] || {};
    const cfgs = wl.WLANConfiguration || {};
    for (const idx of Object.keys(cfgs).filter(k => !k.startsWith('_')).sort((a, b) => Number(a) - Number(b))) {
      const node = cfgs[idx];
      if (!node || typeof node !== 'object') continue;
      const ssid = readParam(device, `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.SSID`);
      if (!ssid) continue;
      if (!enabled(readParam(device, `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.Enable`))) continue;

      const base = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}`;
      const paths = [];
      if ('KeyPassphrase' in node) paths.push(`${base}.KeyPassphrase`);
      const psk = node.PreSharedKey || {};
      for (const k of Object.keys(psk).filter(x => !x.startsWith('_'))) {
        if (psk[k] && typeof psk[k] === 'object' && 'KeyPassphrase' in psk[k]) {
          paths.push(`${base}.PreSharedKey.${k}.KeyPassphrase`);
        }
      }
      if (!paths.length) continue;

      // X_CMCC_RFBand is 0 for 2.4 GHz and 1 for 5 GHz on this firmware. It is a
      // vendor extension, so it is used for the human-readable label only and never
      // to decide what gets written.
      const rf = readParam(device, `${base}.X_CMCC_RFBand`);
      const band = rf === null || rf === undefined ? null : (String(rf) === '1' ? '5 GHz' : '2.4 GHz');
      out.push({ index: Number(idx), ssid, band, paths });
    }
    return out;
  }

  const aps = ((device.Device || {}).WiFi || {}).AccessPoint || {};
  for (const idx of Object.keys(aps).filter(k => !k.startsWith('_')).sort((a, b) => Number(a) - Number(b))) {
    const node = aps[idx];
    if (!node || typeof node !== 'object') continue;
    if (!enabled(readParam(device, `Device.WiFi.AccessPoint.${idx}.Enable`))) continue;
    const sec = node.Security || {};
    if (!('KeyPassphrase' in sec)) continue;
    const ssid = readParam(device, `Device.WiFi.SSID.${idx}.SSID`);
    out.push({
      index: Number(idx),
      ssid: ssid || null,
      band: readParam(device, `Device.WiFi.Radio.${idx}.OperatingFrequencyBand`) || null,
      paths: [`Device.WiFi.AccessPoint.${idx}.Security.KeyPassphrase`],
    });
  }
  return out;
}

// A password is a credential for the whole network, so it is written to every enabled
// radio — a customer told "your new WiFi password" must be able to use it on 2.4 GHz
// and 5 GHz alike. An SSID is per-radio (the bands are usually named differently, e.g.
// "Home" and "Home_5G"), so it stays on the single instance named by `index`.
// Accepts "2.4", "2.4 GHz", "5", "5GHz" and so on, so callers are not forced to match
// the exact label wifiTargets() produces. Anything unrecognised returns null, which the
// caller treats as "no band filter" rather than silently matching nothing.
function normalizeBand(v) {
  if (v === null || v === undefined || v === '' || String(v).toLowerCase() === 'all') return null;
  const t = String(v).toLowerCase().replace(/\s|ghz/g, '');
  if (t === '2.4' || t === '24') return '2.4';
  if (t === '5') return '5';
  return null;
}

async function updateWifi(deviceId, { ssid, password, index = 1, band = null }) {
  const device = await getDevice(deviceId);
  if (!device) throw new Error(`Device ${deviceId} not found`);
  const root = detectRoot(device);
  if (!root) throw new Error(`Device ${deviceId} has no recognised data model root`);

  const tuples = [];
  if (ssid) {
    tuples.push(root === 'InternetGatewayDevice'
      ? [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.SSID`, ssid, 'xsd:string']
      : [`Device.WiFi.SSID.${index}.SSID`, ssid, 'xsd:string']);
  }

  let targets = password ? wifiTargets(device) : [];
  if (password) {
    if (!targets.length) {
      // Better a clear error than a task that faults on the CPE 5 minutes later, where
      // the failure is invisible to whoever pressed the button.
      throw new Error('No writable WiFi passphrase parameter found on this device (has it been refreshed?)');
    }
    // Narrowing to one radio is what lets the two bands hold different passwords.
    // Omitting the filter keeps the default behaviour: every enabled radio in step.
    const want = normalizeBand(band);
    if (want) {
      const narrowed = targets.filter(t => normalizeBand(t.band) === want);
      if (!narrowed.length) {
        throw new Error(`This device has no enabled ${want} GHz radio`);
      }
      targets = narrowed;
    }
    for (const t of targets) for (const path of t.paths) tuples.push([path, password, 'xsd:string']);
  }

  if (!tuples.length) throw new Error('Nothing to update');
  const task = await setParameterValues(deviceId, tuples);
  return {
    task,
    bands: targets.map(t => ({ index: t.index, ssid: t.ssid, band: t.band })),
  };
}

function extractWifi(device, index = 1) {
  const root = detectRoot(device);
  if (!root) return { root: null, ssid: null };
  if (root === 'InternetGatewayDevice') {
    const ssid = readParam(device, `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.SSID`);
    return { root, ssid };
  }
  const ssid = readParam(device, `Device.WiFi.SSID.${index}.SSID`);
  return { root, ssid };
}

// Try multiple known IP locations. Order: WAN external IP (router/CPE),
// TR-181 IP interface, TR-098 LAN, TR-181 LAN (Yealink/some phones),
// then parse out of ConnectionRequestURL as a last resort.
function extractIP(device, root) {
  const candidates = root === 'InternetGatewayDevice'
    ? [
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
        'InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.IPInterface.1.IPInterfaceIPAddress',
      ]
    : [
        'Device.IP.Interface.1.IPv4Address.1.IPAddress',
        'Device.IP.Interface.2.IPv4Address.1.IPAddress',
        'Device.LAN.IPAddress',
      ];
  for (const path of candidates) {
    const v = readParam(device, path);
    if (v) return v;
  }
  // Fallback: extract host from ConnectionRequestURL like "http://10.0.4.157:7547/"
  const cru = readParam(device, root === 'InternetGatewayDevice'
    ? 'InternetGatewayDevice.ManagementServer.ConnectionRequestURL'
    : 'Device.ManagementServer.ConnectionRequestURL');
  if (cru) {
    const m = cru.match(/^https?:\/\/([^:/]+)/i);
    if (m) return m[1];
  }
  return null;
}

// Pull commonly-used identifying fields for our tr069_devices row.
function extractIdentity(device) {
  const root = detectRoot(device);
  const deviceIdObj = device._deviceId || {};
  const base = root || 'InternetGatewayDevice';
  return {
    device_id: device._id,
    serial_number: deviceIdObj._SerialNumber || readParam(device, `${base}.DeviceInfo.SerialNumber`) || null,
    oui: deviceIdObj._OUI || null,
    product_class: deviceIdObj._ProductClass || null,
    manufacturer: readParam(device, `${base}.DeviceInfo.Manufacturer`) || null,
    software_version: readParam(device, `${base}.DeviceInfo.SoftwareVersion`) || null,
    hardware_version: readParam(device, `${base}.DeviceInfo.HardwareVersion`) || null,
    ip_address: extractIP(device, root),
    last_inform: device._lastInform ? new Date(device._lastInform) : null,
  };
}

// ── Metrics extraction ──────────────────────────────────────
// Read optical + CPU + mem + uptime from a device object. Returns
// numeric values or null per field. Used by the diagnostics cron.
function extractMetrics(device) {
  const root = detectRoot(device);
  if (!root) return {};

  const opticalIGD = [
    'InternetGatewayDevice.X_CT-COM_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.X_CT-COM_GponInterfaceConfig.TXPower',
    'InternetGatewayDevice.X_CT-COM_GponInterfaceConfig.Voltage',
    'InternetGatewayDevice.X_CT-COM_GponInterfaceConfig.Temperature',
    'InternetGatewayDevice.X_CU_PON.RXPower',
    'InternetGatewayDevice.X_CU_PON.TXPower',
  ];
  const opticalDev = [
    'Device.XPON.Interface.1.Stats.RxPower',
    'Device.XPON.Interface.1.Stats.TxPower',
    'Device.XPON.Interface.1.Stats.Voltage',
    'Device.XPON.Interface.1.Stats.Temperature',
    'Device.Optical.Interface.1.CurrentRxPower',
    'Device.Optical.Interface.1.CurrentTxPower',
  ];
  const paths = root === 'InternetGatewayDevice' ? opticalIGD : opticalDev;
  const out = { rx_power: null, tx_power: null, voltage: null, temperature: null, cpu_usage: null, mem_usage: null, uptime_sec: null };
  for (const p of paths) {
    const v = readParam(device, p);
    if (v == null || v === '') continue;
    const n = parseFloat(v);
    if (Number.isNaN(n)) continue;
    const k = p.split('.').pop().toLowerCase();
    if (k === 'rxpower') out.rx_power = n;
    else if (k === 'txpower') out.tx_power = n;
    else if (k === 'voltage') out.voltage = n;
    else if (k === 'temperature') out.temperature = n;
    else if (k === 'currentrxpower') out.rx_power = n;
    else if (k === 'currenttxpower') out.tx_power = n;
  }
  const uptime = readParam(device, `${root}.DeviceInfo.UpTime`);
  if (uptime != null) out.uptime_sec = parseInt(uptime, 10) || null;
  const cpu = readParam(device, `${root}.DeviceInfo.ProcessStatus.CPUUsage`);
  if (cpu != null) out.cpu_usage = parseFloat(cpu);
  const mem = readParam(device, `${root}.DeviceInfo.MemoryStatus.Free`);
  const memTotal = readParam(device, `${root}.DeviceInfo.MemoryStatus.Total`);
  if (mem != null && memTotal != null && parseFloat(memTotal) > 0) {
    out.mem_usage = 100 - (parseFloat(mem) / parseFloat(memTotal)) * 100;
  }
  return out;
}

module.exports = {
  getSettings,
  invalidateCache,
  nbiRequest,
  listDevices,
  getDevice,
  detectRoot,
  readParam,
  wifiPath,
  refreshDevice,
  rebootDevice,
  factoryResetDevice,
  setParameterValues,
  updateWifi,
  wifiTargets,
  normalizeBand,
  extractWifi,
  extractIdentity,
  extractMetrics,
  listFiles,
  uploadFile,
  deleteFile,
  downloadFirmware,
  createTask,
  listTasks,
  deleteTask,
  listFaults,
};
