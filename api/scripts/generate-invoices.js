#!/usr/bin/env node
// ============================================================
// J2 NETWORK — Auto Invoice Generation (Cron Job)
// ============================================================
// Runs 1st of every month at 00:00
// Generates invoices for ALL active and suspended subscribers
// Cron: 0 0 1 * * cd /home/ubuntu/Node.js_API/j2-api && /usr/bin/node scripts/generate-invoices.js
// ============================================================

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const invoiceNumber = require('../src/utils/invoiceNumber');
const prisma = new PrismaClient();

// Dry run exists because this script writes financial records for every active
// subscriber in one pass. Anyone about to schedule it, or re-run it for a month
// that was partly billed by hand, needs to see WHO it would invoice before it does.
const DRY = process.argv.includes('--dry-run');

// ── Due date ────────────────────────────────────────────────────────────────
// This used to be hardcoded to the 1st of the following month, which disagreed
// with every invoice in the ledger: 206 invoices raised by hand all fall due on
// the 25th of their own billing month. Automating the run with the old constant
// would have given one billing period two different due dates a week apart, and
// since restriction candidates are picked `billing_grace_period_days` past the
// due date, cut-offs would have drifted with them. The rule now lives in
// system_settings so it is visible and changeable in Settings → Billing.
const DUE_DAY_KEY       = 'billing_due_day';
const DUE_MONTH_KEY     = 'billing_due_month';
const DEFAULT_DUE_DAY   = 25;      // matches existing practice
const DEFAULT_DUE_MONTH = 'same';  // 'same' billing month, or 'next'

// Day 31 in a 30-day month must not roll into the next month — a customer billed
// for September would get an October due date and a week of unearned grace.
function buildDueDate(now, day, monthOffset) {
  const year  = now.getFullYear();
  const month = now.getMonth() + monthOffset;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

async function resolveDueDate(now) {
  let day = DEFAULT_DUE_DAY;
  let offset = DEFAULT_DUE_MONTH === 'next' ? 1 : 0;
  try {
    const rows = await prisma.system_settings.findMany({
      where: { key: { in: [DUE_DAY_KEY, DUE_MONTH_KEY] } }
    });
    const cfg = {};
    rows.forEach(r => { cfg[r.key] = String(r.value == null ? '' : r.value).trim(); });

    const parsed = parseInt(cfg[DUE_DAY_KEY], 10);
    // A blank or nonsense value falls back rather than throwing: a typo in Settings
    // must not stop the month's billing, and silently invoicing with no due date at
    // all would make every invoice permanently non-overdue.
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 31) day = parsed;
    else if (cfg[DUE_DAY_KEY]) console.warn('  \u26a0 ' + DUE_DAY_KEY + '="' + cfg[DUE_DAY_KEY] +
      '" is not a day 1-31 \u2014 using ' + DEFAULT_DUE_DAY);

    if (cfg[DUE_MONTH_KEY] === 'next') offset = 1;
    else if (cfg[DUE_MONTH_KEY] === 'same') offset = 0;
    else if (cfg[DUE_MONTH_KEY]) console.warn('  \u26a0 ' + DUE_MONTH_KEY + '="' + cfg[DUE_MONTH_KEY] +
      '" is not "same" or "next" \u2014 using ' + DEFAULT_DUE_MONTH);
  } catch (err) {
    console.error('  \u26a0 could not read due-date settings: ' + err.message +
                  ' \u2014 using day ' + DEFAULT_DUE_DAY + ' of the ' + DEFAULT_DUE_MONTH + ' month');
  }
  return { dueDate: buildDueDate(now, day, offset), day, offset };
}

async function generateMonthlyInvoices() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const billingPeriod = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  // Coverage period = current month (1st to last day)
  const coverageStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const coverageEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0); // last day of current month
  const fmtDate = (d) => d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const coverageText = `Internet Service Coverage Period ${fmtDate(coverageStart)} - ${fmtDate(coverageEnd)}`;

  const due = await resolveDueDate(now);
  const dueDate = due.dueDate;

  console.log('══════════════════════════════════════════════');
  console.log('  Netfactory — Monthly Invoice Generation' + (DRY ? '  [DRY RUN]' : ''));
  console.log('  Date: ' + now.toISOString());
  console.log('  Period: ' + billingPeriod);
  console.log('  Coverage: ' + coverageText);
  console.log('  Due Date: ' + dueDate.toISOString().split('T')[0] +
              '  (day ' + due.day + ' of the ' + (due.offset ? 'following' : 'billing') + ' month)');
  console.log('══════════════════════════════════════════════');

  try {
    const allSubscribers = await prisma.subscribers.findMany({
      where: {
        status: { in: ['active', 'suspended'] },
        plan_id: { not: null }
      },
      include: { plan: true }
    });

    // Prepaid accounts must never be billed monthly. They have already paid for the
    // time they hold; an invoice here would post a debt they do not owe, push their
    // balance up, and make them candidates for the postpaid overdue cutoff — a prepaid
    // customer with weeks of paid service left would be switched off for "non-payment".
    const subscribers = allSubscribers.filter(
      s => String(s.plan && s.plan.billing_type || '').toLowerCase() !== 'prepaid');
    const prepaidSkipped = allSubscribers.length - subscribers.length;

    console.log('Found ' + subscribers.length + ' eligible subscribers (active + suspended)' +
      (prepaidSkipped ? ', skipped ' + prepaidSkipped + ' prepaid' : ''));

    const existing = await prisma.invoices.findMany({
      where: { billing_period: billingPeriod },
      select: { subscriber_id: true }
    });
    const existingIds = new Set(existing.map(e => e.subscriber_id));

    let created = 0;
    let skipped = 0;
    let errors = 0;
    const orphaned = [];

    for (const sub of subscribers) {
      if (existingIds.has(sub.id)) {
        skipped++;
        continue;
      }

      // plan_id has an index but no foreign key, so it can point at a plan that no
      // longer exists. The include then yields null and every read below throws,
      // which the catch would file as a generic error — one active subscriber
      // quietly unbilled, every month, with nothing naming the cause. Call it out.
      if (!sub.plan) {
        orphaned.push(sub.account_number + ' (plan_id=' + sub.plan_id + ')');
        console.error('  ⚠ ' + sub.account_number + ' references plan_id ' + sub.plan_id +
                      ' which does not exist — cannot invoice, assign a valid plan');
        errors++;
        continue;
      }

      try {
        const planName = sub.plan.name || 'Internet Service';
        const amount = Number(sub.plan.price);

        // Build notes: PLAN: amount | Coverage period
        const notes = planName.toUpperCase() + ': ' + amount.toFixed(2) + '\n' + coverageText;

        if (DRY) {
          const preview = await invoiceNumber.next(prisma, now);
          console.log('  [dry-run] would invoice ' + sub.account_number + ' (' + sub.status +
                      ') — ' + preview + ' — P' + amount + ' — ' + planName);
          created++;
          continue;
        }

        // Sequential and retried on collision — see utils/invoiceNumber.js for why
        // the previous random tail could silently drop a subscriber each month.
        const inv = await invoiceNumber.create(prisma, {
          subscriber_id: sub.id,
          amount: sub.plan.price,
          billing_period: billingPeriod,
          due_date: dueDate,
          status: 'pending',
          notes: notes
        }, { when: now });

        await prisma.subscribers.update({
          where: { id: sub.id },
          data: {
            balance: { increment: amount },
            next_bill_date: dueDate
          }
        });

        created++;
        console.log('  ✅ ' + sub.account_number + ' (' + sub.status + ') — ' + inv.invoice_number + ' — P' + amount + ' — ' + planName);
      } catch (err) {
        errors++;
        console.error('  ✗ ' + sub.account_number + ': ' + err.message);
      }
    }

    if (DRY) {
      console.log('──────────────────────────────────────────────');
      console.log('  DRY RUN — nothing was written');
      console.log('  Would create: ' + created + '   Already invoiced: ' + skipped);
      if (orphaned.length) console.log('  Unbillable (missing plan): ' + orphaned.join(', '));
      console.log('══════════════════════════════════════════════');
      return;
    }

    await prisma.audit_log.create({
      data: {
        user_type: 'system',
        user_id: 0,
        action: 'auto_invoice_generation',
        entity_type: 'invoices',
        details: {
          billingPeriod,
          coveragePeriod: coverageText,
          dueDate: dueDate.toISOString().split('T')[0],
          dueRule: 'day ' + due.day + ' of ' + (due.offset ? 'following' : 'billing') + ' month',
          total: subscribers.length,
          prepaidSkipped,
          created,
          skipped,
          errors
        },
        ip_address: '127.0.0.1'
      }
    });

    console.log('──────────────────────────────────────────────');
    console.log('  Total eligible: ' + subscribers.length);
    console.log('  Created: ' + created);
    console.log('  Skipped (already exists): ' + skipped);
    console.log('  Errors: ' + errors);
    if (orphaned.length) {
      console.log('  Unbillable (missing plan): ' + orphaned.join(', '));
    }
    console.log('══════════════════════════════════════════════');

  } catch (err) {
    // Only a directly-invoked run may kill the process. When the scheduler calls
    // this inside isp-api, process.exit(1) would take the whole API down with it
    // and pm2 would restart it — a failed billing run must not be an outage.
    console.error('FATAL ERROR:', err);
    if (require.main === module) process.exit(1);
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

// Run when invoked directly (cron, by hand); export when required by the scheduler,
// so jobs/monthly-invoices.js drives the exact code path that has been tested here
// rather than a second copy of the same logic.
if (require.main === module) {
  generateMonthlyInvoices();
}

module.exports = { generateMonthlyInvoices };
