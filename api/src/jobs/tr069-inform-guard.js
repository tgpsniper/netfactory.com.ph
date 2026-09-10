// ============================================================
// tr069-inform-guard — keep every CPE talking
// ============================================================
// A CPE that arrives with Periodic Inform disabled sends one BOOT inform and is never
// heard from again. Most of this fleet is exactly that: the ZTE F670L units delivered a
// single "1 BOOT,4 VALUE CHANGE" (some after 169 retries against the 404 that used to
// sit at /acs/) and went silent, and their connection-request URLs are on CGNAT and
// unreachable from the ACS, so there is no way to wake them either. That one boot
// session is the only chance to fix them.
//
// Normally the 'default' preset would handle this. Preset/provision execution does not
// work on this install — 'default' has never written a value, and a hand-built preset
// tried with three preconditions ('true', '', '1 = 1') never fired, with zero faults
// logged. An explicit setParameterValues task applies in about 20 seconds. So this job
// queues that task directly rather than depending on presets.
//
// A queued task is not wasted on a silent device: it waits and applies the moment the
// CPE next boots, which is precisely the moment we need to catch.
//
// If presets are ever repaired, this job becomes a harmless no-op — it only touches
// devices whose interval is unset and which have no task already pending.
// ============================================================

const acs = require('../utils/genieacs');

const SCHEDULE = '*/10 * * * *'; // every 10 min
const INTERVAL_SEC = 300;
const MAX_PER_RUN = 200; // safety cap so a bad NBI day cannot flood the queue

// TR-098 and TR-181 paths both declared: the fleet is mixed (ZTE is
// InternetGatewayDevice.*, the Huawei ONTs expose Device.*). Writing a path a device
// does not implement is rejected by that device alone and costs nothing elsewhere.
function taskFor(root) {
  return {
    name: 'setParameterValues',
    parameterValues: [
      [`${root}.ManagementServer.PeriodicInformEnable`, true, 'xsd:boolean'],
      [`${root}.ManagementServer.PeriodicInformInterval`, INTERVAL_SEC, 'xsd:unsignedInt'],
    ],
  };
}

async function run(prisma) {
  const s = await acs.getSettings();
  if (!s.enabled) return;

  // Ask GenieACS for devices whose inform interval is not set under either root.
  const query = {
    $and: [
      { 'InternetGatewayDevice.ManagementServer.PeriodicInformInterval._value': { $exists: false } },
      { 'Device.ManagementServer.PeriodicInformInterval._value': { $exists: false } },
    ],
  };

  let devices;
  try {
    // Projection carries one node under each root so detectRoot() can tell which data
    // model the CPE speaks — writing a TR-181 path to a TR-098 device faults the whole
    // SetParameterValues, not just the offending parameter.
    devices = await acs.listDevices({
      query,
      projection: '_id,InternetGatewayDevice.DeviceInfo,Device.DeviceInfo',
    });
  } catch (err) {
    console.error('[tr069-inform-guard] device query failed: ' + err.message);
    return;
  }
  if (!devices || !devices.length) return;

  // Skip anything already carrying a task — re-queueing on every tick would pile up
  // hundreds of duplicates against devices that are simply asleep.
  let pending = [];
  try {
    pending = await acs.listTasks({ name: 'setParameterValues' }) || [];
  } catch (err) {
    console.error('[tr069-inform-guard] task query failed: ' + err.message);
    return;
  }
  const alreadyQueued = new Set(pending.map(t => t.device));

  let queued = 0, failed = 0;
  for (const d of devices) {
    if (queued >= MAX_PER_RUN) break;
    if (alreadyQueued.has(d._id)) continue;

    // Which data model this CPE speaks decides the parameter path.
    const root = acs.detectRoot(d);
    if (!root) continue; // nothing read back yet — catch it on a later tick
    try {
      // No connection request: these CPEs are mostly unreachable from the ACS, and
      // asking for one only slows the queue and logs failures. The task applies on the
      // device's next inform, which for a silent unit means its next boot.
      await acs.createTask(d._id, taskFor(root), { connectionRequest: false });
      queued++;
    } catch (err) {
      failed++;
      if (failed <= 3) console.error(`[tr069-inform-guard] ${d._id}: ${err.message}`);
    }
  }

  if (queued || failed) {
    console.log(`[tr069-inform-guard] queued periodic-inform for ${queued} device(s)` +
      (failed ? `, ${failed} failed` : '') +
      ` (${devices.length} without an interval, ${alreadyQueued.size} already queued)`);
  }
}

module.exports = {
  name: 'tr069-inform-guard',
  schedule: SCHEDULE,
  run,
};
