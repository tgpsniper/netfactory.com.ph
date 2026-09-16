// ============================================================
// jobs/monthly-invoices.js — generate the month's invoices
// ============================================================
// Why this exists: scripts/generate-invoices.js has been here since the J2
// deployment and its header says "Runs 1st of every month at 00:00", but the cron
// line was never installed on this host — and the one in that header points at
// /home/ubuntu, which is not where this instance lives, so pasting it would have
// failed silently too. Nothing has ever run it automatically. Invoices were being
// typed in by hand, which is why September 2026 had 74 invoices against 142
// billable subscribers when this job was written.
//
// That gap is not only a billing problem. billing-restriction decides who to cut
// off from overdue invoices; a subscriber who was never invoiced carries no debt
// and can never be restricted, however long they go unpaid. Automating this is
// what makes collections mean anything.
//
// Registered here rather than in crontab on purpose: this scheduler already runs
// in Asia/Manila, so "the 1st at 00:00" is the 1st in Manila. System cron on this
// box runs in UTC, where 0 0 1 * * fires at 08:00 Manila — right date, wrong
// morning, and a difference nobody would notice until a month boundary landed
// awkwardly.
//
// Safe to run repeatedly: the script skips any subscriber who already holds an
// invoice for the billing period, so a re-run after a partial month adds only
// what is missing. Prepaid plans are excluded by the script itself.
const { generateMonthlyInvoices } = require('../../scripts/generate-invoices');

const SCHEDULE = '0 0 1 * *';          // 1st of the month, 00:00 Asia/Manila
const ENABLED_KEY = 'billing_auto_invoice_enabled';

async function isEnabled(prisma) {
  try {
    const row = await prisma.system_settings.findUnique({ where: { key: ENABLED_KEY } });
    // Absent means enabled. The setting is a brake for an operator who needs to stop
    // a run, not a switch someone has to find and flip before billing works at all —
    // this job exists precisely because billing that depends on a human remembering
    // does not happen.
    if (!row) return true;
    return String(row.value).trim().toLowerCase() === 'true';
  } catch (err) {
    // Unreadable settings must not silently cancel billing.
    console.error('[monthly-invoices] could not read ' + ENABLED_KEY + ': ' + err.message +
                  ' — proceeding');
    return true;
  }
}

async function run(prisma) {
  if (!(await isEnabled(prisma))) {
    console.log('[monthly-invoices] skipped — ' + ENABLED_KEY + ' is false');
    return;
  }
  console.log('[monthly-invoices] starting monthly invoice generation');
  try {
    await generateMonthlyInvoices();
    console.log('[monthly-invoices] done');
  } catch (err) {
    // Never rethrow into the scheduler: one bad month must not take down the
    // process that also runs restriction sync and the prepaid expiry cut.
    console.error('[monthly-invoices] FAILED: ' + (err && err.message));
  }
}

module.exports = { name: 'monthly-invoices', schedule: SCHEDULE, run };
