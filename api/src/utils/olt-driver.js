// ============================================================
// utils/olt-driver.js — per-device OLT driver dispatch
// ============================================================
// routes/olt.js used to require utils/vsol-olt directly, which was correct while there
// was one OLT. There are now two vendors on the network and their CLIs have nothing in
// common: every ZTE read command ("show gpon onu state", "show gpon onu detail-info")
// is rejected by the VSOL V1600G, and every VSOL command is rejected by the ZTE C600.
// Pointing one driver at both produced "%Error 140303: Invalid input detected" for each
// command and an empty ONU list that looked like an OLT with no subscribers on it.
//
// Dispatch is on olt_devices.olt_model. Anything not recognised as ZTE keeps the VSOL
// driver, so an unknown or mislabelled model behaves exactly as it did before this file
// existed rather than failing closed.

const vsol = require('./vsol-olt');
const zte = require('./zte-olt');

// ZTE TITAN chassis: C600, C610, C620, C650, C300/C320 share this CLI.
// Matched loosely because the model column is free text typed by an operator.
function isZte(model) {
  const m = String(model || '').toUpperCase();
  return /(^|[^A-Z0-9])C[36]\d{2}([^A-Z0-9]|$)/.test(m) || /ZTE|TITAN|ZXA?N/.test(m);
}

function driverForModel(model) {
  return isZte(model) ? zte : vsol;
}

const _modelCache = new Map();
const MODEL_TTL = 60_000;

async function driverFor(prisma, deviceId) {
  const hit = _modelCache.get(deviceId);
  if (hit && (Date.now() - hit.at) < MODEL_TTL) return hit.driver;
  const dev = await prisma.olt_devices.findUnique({
    where: { id: Number(deviceId) },
    select: { olt_model: true, label: true },
  });
  if (!dev) throw new Error(`OLT device ${deviceId} not found`);
  // The label is consulted as well as the model because device 5 was labelled
  // "OLTZTE-C600" while carrying olt_model 'V1600G' — copied from the other OLT when it
  // was added. That single wrong field routed every ZTE command through the VSOL driver.
  const driver = driverForModel(`${dev.olt_model || ''} ${dev.label || ''}`);
  _modelCache.set(deviceId, { at: Date.now(), driver });
  return driver;
}

// Called after olt_devices is edited so a model change takes effect immediately rather
// than at the next cache expiry.
function invalidate(deviceId) {
  if (deviceId == null) _modelCache.clear();
  else _modelCache.delete(Number(deviceId));
}

// ── Device-scoped: dispatch on the stored model ─────────────
const byDevice = (fn) => async (prisma, deviceId, ...rest) => {
  const d = await driverFor(prisma, deviceId);
  return d[fn](prisma, deviceId, ...rest);
};

// ── Config reads: identical on both drivers ─────────────────
const getConfig = vsol.getConfig;
const getDeviceConfig = vsol.getDeviceConfig;
const stripAnsi = vsol.stripAnsi;

// routes/olt.js calls sshShellExec with an already-loaded device row rather than an id,
// so dispatch here reads the model off that row.
function sshShellExec(device, commands, timeout) {
  return driverForModel(`${device.olt_model || ''} ${device.label || ''}`)
    .sshShellExec(device, commands, timeout);
}

function disconnectAll() {
  try { vsol.disconnectAll(); } catch (_) {}
  try { zte.disconnectAll(); } catch (_) {}
}

module.exports = {
  getConfig,
  getDeviceConfig,
  stripAnsi,
  sshShellExec,

  getSystemInfo:         byDevice('getSystemInfo'),
  getPonPorts:           byDevice('getPonPorts'),
  getONUs:               byDevice('getONUs'),
  getONUDetail:          byDevice('getONUDetail'),
  getONUOpticalLevels:   byDevice('getONUOpticalLevels'),
  registerONU:           byDevice('registerONU'),
  deregisterONU:         byDevice('deregisterONU'),
  rebootONU:             byDevice('rebootONU'),

  disconnectAll,
  driverFor,
  driverForModel,
  isZte,
  invalidate,
  vsol,
  zte,
};
