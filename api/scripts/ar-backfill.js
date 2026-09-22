// ============================================================
// ar-backfill.js — repair accounts receivable after the receipt-number bug
// ============================================================
// Two things to put right, both caused by src/utils/receipts.js's predecessors:
//
//   1. Payments that never reached receivables at all. The webhook and the
//      apply-credit path numbered receipts 'RCV-' + (count(*) + 1); rows had been
//      deleted, so that number already existed and every insert failed on the
//      unique key, swallowed by the caller's try/catch.
//
//   2. accounts_receivable.amount_paid and status, which no code has ever
//      maintained — the call sites relied on a trigger that does not exist.
//      Recomputed from ar_payments, which is the authoritative record.
//
// Reports only unless run with --apply.
//
//   node scripts/ar-backfill.js            # show what would change
//   node scripts/ar-backfill.js --apply    # change it

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { recordArPayment, refreshArTotals } = require('../src/utils/receipts');

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();
const peso = (n) => 'P' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// A successful payment whose invoice has a receivables record that holds no
// matching ar_payments row. Matched on reference number or on the invoice number
// carried in the note, which is how every writer has ever tagged these.
const ORPHANS = `
  SELECT p.id, p.amount, p.method, p.reference_number, p.paid_at,
         i.invoice_number, ar.id AS ar_id
  FROM payments p
  JOIN invoices i ON i.id = p.invoice_id
  JOIN accounts_receivable ar ON ar.billing_invoice_id = i.id
  WHERE p.status = 'success'
    AND NOT EXISTS (
      SELECT 1 FROM ar_payments ap
      WHERE ap.ar_id = ar.id
        AND (ap.reference_number IS NOT DISTINCT FROM p.reference_number
             OR ap.notes LIKE '%' || i.invoice_number || '%')
    )
  ORDER BY p.paid_at`;

(async () => {
  try {
    // ── 1. payments missing from receivables ────────────────────────────
    const orphans = await prisma.$queryRawUnsafe(ORPHANS);
    console.log(`\n=== Payments taken but never recorded in receivables: ${orphans.length} ===`);
    let recovered = 0;
    for (const o of orphans) {
      recovered += Number(o.amount);
      const when = o.paid_at ? new Date(o.paid_at).toISOString().slice(0, 10) : 'unknown date';
      console.log(`  payment ${o.id}  ${o.invoice_number}  ${peso(o.amount)}  ${o.method}  ${when}`);
      if (APPLY) {
        const r = await recordArPayment(prisma, {
          arId: o.ar_id,
          amount: Number(o.amount),
          method: o.method,
          referenceNumber: o.reference_number,
          notes: `Backfilled: payment ${o.id} for ${o.invoice_number} (receipt-number bug)`,
          receivedBy: 'backfill',
          paymentDate: o.paid_at || null,
        });
        console.log(`      -> ${r.paymentNumber}, receivable now ${r.status} (${peso(r.amountPaid)})`);
      }
    }
    console.log(`  total: ${peso(recovered)}`);

    // ── 2. receivables whose totals were never maintained ───────────────
    const drift = await prisma.$queryRawUnsafe(`
      SELECT ar.id, ar.invoice_number, ar.total_amount, ar.amount_paid, ar.status, s.paid
      FROM accounts_receivable ar
      CROSS JOIN LATERAL (SELECT COALESCE(SUM(amount), 0) AS paid FROM ar_payments ap WHERE ap.ar_id = ar.id) s
      WHERE ar.amount_paid <> s.paid
      ORDER BY ar.id`);
    console.log(`\n=== Receivables whose amount_paid disagrees with their payments: ${drift.length} ===`);
    const total = drift.reduce((a, r) => a + Number(r.paid) - Number(r.amount_paid), 0);
    console.log(`  ${peso(total)} received but shown as outstanding`);
    if (APPLY) {
      let paid = 0, partial = 0;
      for (const d of drift) {
        const r = await refreshArTotals(prisma, d.id);
        if (r.status === 'paid') paid++; else if (r.status === 'partial') partial++;
      }
      console.log(`  updated: ${paid} now 'paid', ${partial} now 'partial'`);
    }

    // ── verification ────────────────────────────────────────────────────
    if (APPLY) {
      const left = await prisma.$queryRawUnsafe(ORPHANS);
      const stillDrifting = await prisma.$queryRawUnsafe(`
        SELECT COUNT(*)::int AS c FROM accounts_receivable ar
        CROSS JOIN LATERAL (SELECT COALESCE(SUM(amount),0) AS paid FROM ar_payments ap WHERE ap.ar_id = ar.id) s
        WHERE ar.amount_paid <> s.paid`);
      const dupes = await prisma.$queryRawUnsafe(`
        SELECT COUNT(*)::int AS c FROM (
          SELECT payment_number FROM ar_payments GROUP BY payment_number HAVING COUNT(*) > 1) d`);
      console.log('\n=== After ===');
      console.log(`  orphaned payments remaining: ${left.length}`);
      console.log(`  receivables still out of step: ${stillDrifting[0].c}`);
      console.log(`  duplicate receipt numbers: ${dupes[0].c}`);
    } else {
      console.log('\nNothing was changed. Re-run with --apply to make these changes.');
    }
  } finally {
    await prisma.$disconnect();
  }
})();
