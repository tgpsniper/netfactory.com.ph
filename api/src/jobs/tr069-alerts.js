// ============================================================
// tr069-alerts — TR-069 fleet health monitor
// ============================================================
// Every 5 minutes, check three conditions against thresholds from
// system_settings, and send SMS + email when a new alert fires.
// Writes to tr069_alert_history with dedup so a persistent condition
// only notifies once per cooldown window (default 60 min).
//
// Conditions:
//   - offline_ratio:   % of linked fleet with last_inform > 15 min
//   - fault_count:     GenieACS outstanding faults
//   - optical_degraded: devices with rx_power < -27 dBm in the last
//                        30 minutes of metrics
//
// Settings keys (all optional; defaults in code):
//   tr069_alerts_enabled              true|false
//   tr069_alerts_sms_numbers          "09171112222,09182223333"
//   tr069_alerts_email_to             "ops@netfactory.com.ph"
//   tr069_alerts_offline_pct          "20"   (%)
//   tr069_alerts_offline_min_fleet    "10"   (don't alert until fleet is this large)
//   tr069_alerts_fault_threshold      "25"
//   tr069_alerts_optical_rx_dbm       "-27"
//   tr069_alerts_cooldown_min         "60"
// ============================================================

const acs = require('../utils/genieacs');
const sms = require('../config/sms');
const email = require('../config/email');

const SCHEDULE = '*/5 * * * *';

async function readCfg(prisma) {
  const rows = await prisma.system_settings.findMany({
    where: { key: { startsWith: 'tr069_alerts_' } },
  });
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  return {
    enabled: (m.tr069_alerts_enabled || 'false') === 'true',
    smsNumbers: (m.tr069_alerts_sms_numbers || '').split(',').map(s => s.trim()).filter(Boolean),
    emailTo: (m.tr069_alerts_email_to || '').trim() || null,
    offlinePct: parseFloat(m.tr069_alerts_offline_pct || '20'),
    offlineMinFleet: parseInt(m.tr069_alerts_offline_min_fleet || '10', 10),
    faultThreshold: parseInt(m.tr069_alerts_fault_threshold || '25', 10),
    opticalRxDbm: parseFloat(m.tr069_alerts_optical_rx_dbm || '-27'),
    ssidCoveragePct: parseFloat(m.tr069_alerts_ssid_coverage_pct || '60'),
    cooldownMin: parseInt(m.tr069_alerts_cooldown_min || '60', 10),
  };
}

async function isInCooldown(prisma, alertType, cooldownMin) {
  const cutoff = new Date(Date.now() - cooldownMin * 60 * 1000);
  const last = await prisma.tr069_alert_history.findFirst({
    where: { alert_type: alertType, fired_at: { gt: cutoff }, resolved_at: null },
    orderBy: { fired_at: 'desc' },
  });
  return !!last;
}

async function fire(prisma, cfg, alertType, severity, summary, detail) {
  if (await isInCooldown(prisma, alertType, cfg.cooldownMin)) return false;

  const smsText = `[Netfactory TR-069 ${severity.toUpperCase()}] ${summary}`;
  let sentSms = null, sentEmail = null;

  // SMS broadcast — sendWithPrisma respects the global sms_enabled toggle.
  if (cfg.smsNumbers.length) {
    const successes = [];
    for (const to of cfg.smsNumbers) {
      try {
        const r = await sms.sendWithPrisma(prisma, to, smsText);
        if (r && r.ok) successes.push(to);
      } catch (e) {
        console.error(`[tr069-alerts] sms to ${to} failed: ${e.message}`);
      }
    }
    if (successes.length) sentSms = successes.join(',');
  }

  // Email
  if (cfg.emailTo && email.isConfigured()) {
    try {
      const r = await email.sendWithPrisma(prisma, {
        to: cfg.emailTo,
        subject: `[Netfactory TR-069 ${severity.toUpperCase()}] ${summary}`,
        html: `<p><strong>${summary}</strong></p><pre>${(detail || '').replace(/</g, '&lt;')}</pre>`,
      });
      if (r && r.ok) sentEmail = cfg.emailTo;
    } catch (e) {
      console.error(`[tr069-alerts] email failed: ${e.message}`);
    }
  }

  await prisma.tr069_alert_history.create({
    data: {
      alert_type: alertType,
      severity,
      summary,
      detail: detail || null,
      sent_sms_to: sentSms,
      sent_email_to: sentEmail,
    },
  });
  return true;
}

async function checkOffline(prisma, cfg) {
  const linked = await prisma.tr069_devices.findMany({
    where: { subscriber_id: { not: null } },
    select: { device_id: true, last_inform: true },
  });
  if (linked.length < cfg.offlineMinFleet) return;
  const cutoff = Date.now() - 15 * 60 * 1000;

  // last_inform on this table is NOT kept current. It is written only by
  // syncLocal(), which runs when someone opens a single device's page in the
  // CRM — there is no background sync. Measured 2026-09-19: 82 of 83 linked
  // rows were more than a day stale while the ACS had 157 devices informing
  // within ten minutes. Trusting the column here would have made this alert
  // report 97.6% of the fleet offline, permanently, from the moment it was
  // switched on — and an alert that cries wolf once gets muted forever.
  //
  // So ask the ACS, which is the only thing that actually knows, and fall back
  // to the stored column only if the NBI cannot be reached. The device list and
  // the subscriber portal already read live for the same reason.
  let liveInform = null;
  try {
    const docs = await acs.nbiRequest('GET',
      '/devices/?query=' + encodeURIComponent('{}') + '&projection=_id,_lastInform');
    if (Array.isArray(docs)) {
      liveInform = new Map(docs.map(d => [d._id, d._lastInform ? new Date(d._lastInform).getTime() : 0]));
    }
  } catch (e) {
    // checkFaults raises nbi_unreachable; do not double-alert here.
  }

  const lastSeen = (r) => {
    if (liveInform && liveInform.has(r.device_id)) return liveInform.get(r.device_id);
    return r.last_inform ? r.last_inform.getTime() : 0;
  };
  const offline = linked.filter(r => lastSeen(r) < cutoff);
  const pct = (offline.length / linked.length) * 100;
  if (pct >= cfg.offlinePct) {
    await fire(
      prisma,
      cfg,
      'offline_ratio',
      pct >= cfg.offlinePct * 2 ? 'critical' : 'warning',
      `${offline.length}/${linked.length} CPEs offline (${pct.toFixed(1)}%)`,
      `Offline threshold: ${cfg.offlinePct}%\nFleet size: ${linked.length}\nOffline count: ${offline.length}`
    );
  }
}

async function checkFaults(prisma, cfg) {
  try {
    const faults = await acs.nbiRequest('GET', '/faults/');
    const count = Array.isArray(faults) ? faults.length : 0;
    if (count >= cfg.faultThreshold) {
      await fire(
        prisma,
        cfg,
        'fault_count',
        count >= cfg.faultThreshold * 2 ? 'critical' : 'warning',
        `${count} outstanding GenieACS faults`,
        `Threshold: ${cfg.faultThreshold}. Check /genieacs/ UI or NBI /faults/.`
      );
    }
  } catch (e) {
    // NBI down — that's a different kind of alert
    await fire(prisma, cfg, 'nbi_unreachable', 'critical', 'GenieACS NBI unreachable', e.message);
  }
}

async function checkOptical(prisma, cfg) {
  const since = new Date(Date.now() - 30 * 60 * 1000);
  // Get latest metric per device in the last 30 min
  const metrics = await prisma.tr069_metrics.findMany({
    where: { collected_at: { gt: since }, rx_power: { not: null } },
    orderBy: { collected_at: 'desc' },
    select: { device_id: true, rx_power: true },
  });
  const latestPerDevice = new Map();
  for (const m of metrics) if (!latestPerDevice.has(m.device_id)) latestPerDevice.set(m.device_id, m.rx_power);
  const degraded = [];
  for (const [id, rx] of latestPerDevice) {
    const n = parseFloat(rx);
    if (Number.isFinite(n) && n < cfg.opticalRxDbm) degraded.push({ id, rx: n });
  }
  if (degraded.length >= 3) { // require at least 3 to avoid single-device noise
    await fire(
      prisma,
      cfg,
      'optical_degraded',
      degraded.length >= 10 ? 'critical' : 'warning',
      `${degraded.length} CPEs with RX power < ${cfg.opticalRxDbm} dBm`,
      degraded.slice(0, 20).map(d => `  ${d.id}: ${d.rx} dBm`).join('\n') +
        (degraded.length > 20 ? `\n  ...and ${degraded.length - 20} more` : '')
    );
  }
}

// The failure this was added for, 2026-09-17.
//
// 205 of 206 CPEs showed "SSID: not reported yet" in the CRM for weeks and none
// of the checks above noticed, because by every measure they use the fleet was
// perfectly healthy: every device was informing on schedule, there were zero
// GenieACS faults, and optical power was fine. The ACS was receiving 190,000
// informs and learning nothing from any of them — the provision declared
// parameter VALUES without declaring their PATHS, so GenieACS never ran
// GetParameterNames, never discovered the data model, and closed every session
// with 204 No Content. Correct behaviour, no error anywhere, invisible.
//
// So this checks the one thing the others cannot: whether devices that are
// talking to us are actually telling us anything. A CPE that informs on time but
// whose SSID we still do not know is a CPE we cannot manage, however green it
// looks on the dashboard.
async function checkDiscovery(prisma, cfg) {
  let devices;
  try {
    // Only the two SSID paths and the inform time — the full device documents are
    // megabytes across a fleet this size and this runs every five minutes.
    const projection = [
      '_id', '_lastInform',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
      'Device.WiFi.SSID.1.SSID',
    ].join(',');
    devices = await acs.nbiRequest('GET',
      '/devices/?query=' + encodeURIComponent('{}') + '&projection=' + encodeURIComponent(projection));
  } catch (e) {
    return; // checkFaults already raises nbi_unreachable; do not double-alert
  }
  if (!Array.isArray(devices)) return;

  const read = (obj, path) => {
    let cur = obj;
    for (const key of path.split('.')) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[key];
    }
    return cur && cur._value;
  };

  // Judge only devices we have heard from recently. A CPE that is switched off
  // cannot report an SSID, and counting it here would turn every power cut into a
  // discovery alert.
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  const live = devices.filter(d => d._lastInform && new Date(d._lastInform).getTime() > cutoff);
  if (live.length < cfg.offlineMinFleet) return;

  const known = live.filter(d =>
    read(d, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID') ||
    read(d, 'Device.WiFi.SSID.1.SSID'));
  const pct = (known.length / live.length) * 100;

  if (pct < cfg.ssidCoveragePct) {
    await fire(
      prisma,
      cfg,
      'discovery_stale',
      pct < cfg.ssidCoveragePct / 2 ? 'critical' : 'warning',
      `Only ${known.length}/${live.length} informing CPEs have a known SSID (${pct.toFixed(1)}%)`,
      'Devices are informing but GenieACS is not learning their parameters.\n' +
      `Threshold: ${cfg.ssidCoveragePct}%\n\n` +
      'Most likely the "default" provision has lost its path-discovery declares.\n' +
      'A declare of {value: now} only refreshes parameters GenieACS already knows;\n' +
      '{path: now, value: now} is what makes it run GetParameterNames and find them.\n' +
      'Check: curl http://127.0.0.1:7557/provisions/ and look for "path: now".'
    );
  }
}

async function run(prisma) {
  const cfg = await readCfg(prisma);
  if (!cfg.enabled) return;
  if (!cfg.smsNumbers.length && !cfg.emailTo) return; // no channels → nothing to do
  await checkOffline(prisma, cfg);
  await checkFaults(prisma, cfg);
  await checkOptical(prisma, cfg);
  await checkDiscovery(prisma, cfg);
}

module.exports = {
  name: 'tr069-alerts',
  schedule: SCHEDULE,
  run,
};
