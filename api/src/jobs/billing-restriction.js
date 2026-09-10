// ============================================================
// billing-restriction — act on lapsed payments
// ============================================================
// Runs every minute, but the two halves have deliberately different cadences:
//
//   RESTORE  runs every time, and is also called directly from the payment endpoints so
//            service resumes the moment money is taken. This pass is the backstop for
//            the payment paths that are not hooked — credits, A/R settlement, bulk
//            webhook batches — and for any endpoint added later. It short-circuits on a
//            single indexed query when nothing is restricted, which is the normal case,
//            so a one-minute cadence costs almost nothing.
//
//   RESTRICT runs once a day, in the hour set by billing_restrict_hour. Cutting
//            someone off is not something to do at 3am when nobody is on the phones,
//            and doing it on a fixed schedule makes it predictable for both staff
//            and customers.
//
// While billing_auto_restrict_enabled is false the restrict half still runs as a DRY
// RUN and logs exactly who it would have cut off. Watch that in the logs for a few
// days before switching it on.
// ============================================================

const radiusDb = require('../config/radius-db');
const restriction = require('../utils/restriction');

const SCHEDULE = '* * * * *';

async function hourSetting(prisma) {
  try {
    const row = await prisma.system_settings.findUnique({ where: { key: 'billing_restrict_hour' } });
    const n = Number(String(row ? row.value : '').trim());
    return (Number.isInteger(n) && n >= 0 && n <= 23) ? n : 9;
  } catch (_) { return 9; }
}

// The cron runs in Asia/Manila, but Date here is whatever the server is set to, so
// read the hour explicitly in Manila time rather than assuming they match.
function manilaNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = t => Number(parts.find(p => p.type === t).value);
  return { hour: get('hour'), minute: get('minute') };
}

async function run(prisma) {
  // ── restore: every run ──
  try {
    const r = await restriction.runAutoRestore(prisma, radiusDb);
    if (r.lifted.length) {
      console.log(`[billing-restriction] restored ${r.lifted.length} subscriber(s): ` +
        r.lifted.map(x => `#${x.subscriberId}(${x.devices} dev)`).join(', '));
    }
  } catch (err) {
    console.error('[billing-restriction] restore pass failed: ' + err.message);
  }

  // ── restrict: once a day, in the configured hour ──
  // The job now ticks every minute, so this must fire on minute 0 only — anything wider
  // would attempt the cutoff repeatedly through the hour.
  const { hour, minute } = manilaNow();
  const targetHour = await hourSetting(prisma);
  if (hour !== targetHour || minute !== 0) return;

  try {
    const out = await restriction.runAutoRestrict(prisma, radiusDb);

    if (out.dryRun) {
      if (out.eligible.length) {
        console.log(`[billing-restriction] DRY RUN (billing_auto_restrict_enabled=false) — would ${out.mode === 'full' ? 'cut off' : 'restrict'} ${out.eligible.length} subscriber(s) at ${out.graceDays} days grace:`);
        out.eligible.forEach(e => console.log(`    #${e.subscriberId} ${e.account} ${e.name || ''} — ${e.daysPastDue}d past due, balance ${e.balance}, ${e.devices} device(s)`));
      } else {
        console.log(`[billing-restriction] DRY RUN — nobody is past ${out.graceDays} days grace`);
      }
    } else if (out.restricted.length) {
      console.log(`[billing-restriction] ${out.mode === 'full' ? 'cut off' : 'restricted'} ${out.restricted.length} subscriber(s):`);
      out.restricted.forEach(e => console.log(`    #${e.subscriberId} ${e.account} — ${e.daysPastDue}d past due, balance ${e.balance}${e.routerApplied ? '' : ' (ROUTER NOT UPDATED)'}`));
    }

    // Never let a cap silently hide work — a run that stops at 25 while 200 qualify
    // would otherwise look like a normal quiet night.
    if (out.capped) {
      console.warn(`[billing-restriction] CAP HIT — ${out.eligible.length} subscribers qualify but the per-run limit is ${out.cap}. Raise billing_auto_restrict_max_per_run or investigate why so many are overdue.`);
    }
    if (out.skippedNoDevices.length) {
      console.warn(`[billing-restriction] ${out.skippedNoDevices.length} subscriber(s) are past grace but have no registered device, so nothing can be enforced: ${out.skippedNoDevices.join(', ')}`);
    }
  } catch (err) {
    console.error('[billing-restriction] restrict pass failed: ' + err.message);
  }
}

module.exports = { name: 'billing-restriction', schedule: SCHEDULE, run };
