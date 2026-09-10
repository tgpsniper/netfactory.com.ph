// ============================================================
// balance-reconcile — nightly self-heal of subscriber balances
// ============================================================
// subscribers.balance is a denormalized running total maintained
// incrementally by ~12 code paths (invoice create, payment, void,
// credit apply, adjustments). Those writes are atomic (increment/
// decrement) so they don't clobber each other, but small mismatches
// can still accumulate from edge cases — overpayments applied as
// credit, voided-then-re-recorded payments, manual invoice edits.
//
// The authoritative value is derivable: a subscriber's balance is
// exactly the sum of remaining amounts on their non-paid,
// non-cancelled invoices (invoice.amount − successful payments).
// This job recomputes that each night and corrects any drift,
// writing one audit_log row per correction so recurring drift is
// visible. Self-healing regardless of which code path caused it.
//
// Notes:
//   - compares at cent precision to ignore float noise.
//   - system subscribers are skipped.
//   - read-only when nothing has drifted (the common case).
// ============================================================

const SCHEDULE = '30 3 * * *'; // daily 03:30 Asia/Manila (off-peak)

async function run(prisma) {
  // Derive the authoritative balance for every real subscriber and
  // surface only the rows that disagree with the stored field.
  const drifted = await prisma.$queryRawUnsafe(`
    SELECT s.id,
           s.account_number,
           s.balance::float8 AS old_balance,
           ROUND(COALESCE((
             SELECT SUM(i.amount - COALESCE((
                      SELECT SUM(p.amount) FROM payments p
                      WHERE p.invoice_id = i.id AND p.status = 'success'), 0))
             FROM invoices i
             WHERE i.subscriber_id = s.id
               AND i.status NOT IN ('paid', 'cancelled')), 0), 2)::float8 AS new_balance
    FROM subscribers s
    WHERE s.is_system = false
  `);

  const toFix = drifted.filter(
    (r) => Math.round(r.old_balance * 100) !== Math.round(r.new_balance * 100)
  );
  if (!toFix.length) return;

  for (const r of toFix) {
    const newBal = Number(r.new_balance.toFixed(2));
    await prisma.$executeRaw`UPDATE subscribers SET balance = ${newBal} WHERE id = ${r.id}`;
    await prisma.audit_log.create({
      data: {
        user_type: 'system',
        user_id: 0,
        action: 'balance_reconciled',
        entity_type: 'subscribers',
        entity_id: r.id,
        details: {
          job: 'balance-reconcile',
          account: r.account_number,
          oldBalance: Number(r.old_balance.toFixed(2)),
          newBalance: newBal,
          diff: Number((newBal - r.old_balance).toFixed(2)),
          reason: 'Resynced balance field to actual unpaid-invoice total',
        },
      },
    });
  }

  console.log(`[balance-reconcile] corrected ${toFix.length} subscriber balance(s): ` +
    toFix.map((r) => `${r.account_number} ${r.old_balance}->${Number(r.new_balance.toFixed(2))}`).join(', '));
}

module.exports = { name: 'balance-reconcile', schedule: SCHEDULE, run };
