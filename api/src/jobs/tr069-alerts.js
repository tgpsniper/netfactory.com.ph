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
  const offline = linked.filter(r => !r.last_inform || r.last_inform.getTime() < cutoff);
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

async function run(prisma) {
  const cfg = await readCfg(prisma);
  if (!cfg.enabled) return;
  if (!cfg.smsNumbers.length && !cfg.emailTo) return; // no channels → nothing to do
  await checkOffline(prisma, cfg);
  await checkFaults(prisma, cfg);
  await checkOptical(prisma, cfg);
}

module.exports = {
  name: 'tr069-alerts',
  schedule: SCHEDULE,
  run,
};
