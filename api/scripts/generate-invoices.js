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
const prisma = new PrismaClient();

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

  // Due date = 1st of FOLLOWING month
  const dueDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  console.log('══════════════════════════════════════════════');
  console.log('  J2 Network — Auto Invoice Generation');
  console.log('  Date: ' + now.toISOString());
  console.log('  Period: ' + billingPeriod);
  console.log('  Coverage: ' + coverageText);
  console.log('  Due Date: ' + dueDate.toISOString().split('T')[0]);
  console.log('══════════════════════════════════════════════');

  try {
    const subscribers = await prisma.subscribers.findMany({
      where: {
        status: { in: ['active', 'suspended'] },
        plan_id: { not: null }
      },
      include: { plan: true }
    });

    console.log('Found ' + subscribers.length + ' eligible subscribers (active + suspended)');

    const existing = await prisma.invoices.findMany({
      where: { billing_period: billingPeriod },
      select: { subscriber_id: true }
    });
    const existingIds = new Set(existing.map(e => e.subscriber_id));

    let created = 0;
    let skipped = 0;
    let errors = 0;

    for (const sub of subscribers) {
      if (existingIds.has(sub.id)) {
        skipped++;
        continue;
      }

      try {
        const rand = String(Math.floor(10000 + Math.random() * 90000));
        const invoiceNumber = 'INV-' + yy + mm + rand;
        const planName = sub.plan.name || 'Internet Service';
        const amount = Number(sub.plan.price);

        // Build notes: PLAN: amount | Coverage period
        const notes = planName.toUpperCase() + ': ' + amount.toFixed(2) + '\n' + coverageText;

        await prisma.invoices.create({
          data: {
            subscriber_id: sub.id,
            invoice_number: invoiceNumber,
            amount: sub.plan.price,
            billing_period: billingPeriod,
            due_date: dueDate,
            status: 'pending',
            notes: notes
          }
        });

        await prisma.subscribers.update({
          where: { id: sub.id },
          data: {
            balance: { increment: amount },
            next_bill_date: dueDate
          }
        });

        created++;
        console.log('  ✅ ' + sub.account_number + ' (' + sub.status + ') — ' + invoiceNumber + ' — P' + amount + ' — ' + planName);
      } catch (err) {
        errors++;
        console.error('  ✗ ' + sub.account_number + ': ' + err.message);
      }
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
          total: subscribers.length,
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
    console.log('══════════════════════════════════════════════');

  } catch (err) {
    console.error('FATAL ERROR:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

generateMonthlyInvoices();
