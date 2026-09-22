// ============================================================
// prepaid-expiry — cut off accounts whose paid-for time has run out
// ============================================================
// The prepaid counterpart of billing-restriction, and deliberately a separate job
// rather than a branch inside it. The two differ in cadence for a reason:
//
//   POSTPAID cuts once a day at a fixed hour. Cutting someone off over an unpaid
//            invoice is a judgement call with a phone call attached, so it happens
//            predictably, in office hours, in one reviewable batch.
//
//   PREPAID  cuts every 15 minutes. Expiry is not a judgement call — the customer
//            bought until a date and that date has passed. Waiting up to 24 hours to
//            enforce it gives away a free day to everyone who expires just after the
//            daily run, and makes the product incoherent: if the expiry date does not
//            mean anything, neither does paying to extend it.
//
// RESTORE runs every tick. prepaid.grant() already lifts the cutoff the moment money
// lands, so this is the backstop for a top-up taken while a router was unreachable,
// and for an expiry date edited by hand in the CRM.
//
// While prepaid_auto_expire_enabled is false the cut half runs as a DRY RUN and logs
// exactly who it would have switched off. Watch that before switching it on.
// ============================================================

const radiusDb = require('../config/radius-db');
const prepaid = require('../utils/prepaid');

const SCHEDULE = '*/15 * * * *';

function fmt(d) {
  return new Date(d).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
}

async function run(prisma) {
  // ── restore ──
  try {
    const r = await prepaid.runPrepaidRestore(prisma, radiusDb);
    if (r.lifted.length) {
      console.log(`[prepaid-expiry] restored ${r.lifted.length} subscriber(s): ` +
        r.lifted.map(x => `#${x.subscriberId}(${x.devices} dev)`).join(', '));
    }
  } catch (err) {
    console.error('[prepaid-expiry] restore pass failed: ' + err.message);
  }

  // ── cut ──
  try {
    const out = await prepaid.runPrepaidExpiry(prisma, radiusDb);

    if (out.dryRun) {
      // Only speak up when there is something to say. This ticks 96 times a day and a
      // per-tick "nothing to do" would bury the lines that matter.
      if (out.eligible.length) {
        console.log(`[prepaid-expiry] DRY RUN (prepaid_auto_expire_enabled=false) — would restrict ${out.eligible.length} expired subscriber(s):`);
        out.eligible.forEach(e => console.log(`    #${e.subscriberId} ${e.account} ${e.name || ''} — ${e.plan}, expired ${fmt(e.expiresAt)} (${e.hoursExpired}h ago), ${e.devices} device(s)`));
      }
    } else if (out.restricted.length) {
      console.log(`[prepaid-expiry] restricted ${out.restricted.length} expired subscriber(s):`);
      out.restricted.forEach(e => console.log(`    #${e.subscriberId} ${e.account} — expired ${fmt(e.expiresAt)}${e.routerApplied ? '' : ' (ROUTER NOT UPDATED)'}`));
    }

    if (out.capped) {
      console.warn(`[prepaid-expiry] CAP HIT — ${out.eligible.length} subscribers have expired but the per-run limit is ${out.cap}. Raise prepaid_max_per_run or investigate.`);
    }
    if (out.skippedNoDevices.length) {
      console.warn(`[prepaid-expiry] ${out.skippedNoDevices.length} expired subscriber(s) have no registered device, so nothing can be enforced: ${out.skippedNoDevices.join(', ')}`);
    }
  } catch (err) {
    console.error('[prepaid-expiry] expiry pass failed: ' + err.message);
  }
}

module.exports = { name: 'prepaid-expiry', schedule: SCHEDULE, run };
