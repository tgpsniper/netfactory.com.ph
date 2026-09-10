// ============================================================
// tr069-diagnostics — periodic device metrics collection
// ============================================================
// Every 10 minutes, for every linked device, read the cached
// optical/CPU/memory/uptime values from GenieACS and write one row
// to tr069_metrics.
//
// Notes:
//   - reads the CACHED GenieACS document — it does NOT trigger a
//     fresh CWMP session. Values are as fresh as the last INFORM
//     (5-min interval in our default provision).
//   - devices never linked to a subscriber are skipped — metrics for
//     orphaned devices are noise.
//   - runs with a simple concurrency=8 to avoid NBI flood.
// ============================================================

const acs = require('../utils/genieacs');

const SCHEDULE = '*/10 * * * *'; // every 10 min
const CONCURRENCY = 8;

async function run(prisma) {
  const s = await acs.getSettings();
  if (!s.enabled) return;

  // Focus on linked devices only — unknown CPEs aren't worth metric storage
  const linked = await prisma.tr069_devices.findMany({
    where: { subscriber_id: { not: null } },
    select: { device_id: true },
  });
  if (!linked.length) return;

  const deviceIds = linked.map(r => r.device_id);
  const onlineCutoff = Date.now() - 15 * 60 * 1000;

  let ok = 0, fail = 0, skipped = 0;

  // Simple concurrency pool
  const queue = [...deviceIds];
  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      try {
        const dev = await acs.getDevice(id);
        if (!dev) { skipped++; continue; }
        const lastInformMs = dev._lastInform ? new Date(dev._lastInform).getTime() : 0;
        const online = lastInformMs >= onlineCutoff;
        const m = acs.extractMetrics(dev);
        await prisma.tr069_metrics.create({
          data: {
            device_id: id,
            rx_power: m.rx_power,
            tx_power: m.tx_power,
            voltage: m.voltage,
            temperature: m.temperature,
            cpu_usage: m.cpu_usage,
            mem_usage: m.mem_usage,
            uptime_sec: m.uptime_sec,
            online,
          },
        });
        ok++;
      } catch (e) {
        fail++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  if (ok || fail) {
    console.log(`[tr069-diagnostics] recorded=${ok} failed=${fail} skipped=${skipped} of ${deviceIds.length}`);
  }

  // Retention — keep 30 days
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await prisma.tr069_metrics.deleteMany({ where: { collected_at: { lt: cutoff } } });
}

module.exports = {
  name: 'tr069-diagnostics',
  schedule: SCHEDULE,
  run,
};
