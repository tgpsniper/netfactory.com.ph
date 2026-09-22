// ============================================================
// receipts.js — the one place a payment is written to a ledger
// ============================================================
// Seven hand-rolled copies of this code existed across four route files, and two
// bugs lived in them. Both were silent, because every caller wraps the ledger
// sync in a try/catch that logs and carries on — correctly, since the customer's
// money has already moved and failing the request would make Xendit retry and
// settle a second time.
//
//   1. Two of the seven numbered the receipt 'RCV-' + (count(*) + 1). Rows had
//      been deleted, so count(*) was below max(), and the number it produced was
//      one that already existed. Every insert from those two paths — the Xendit
//      webhook and apply-credit — failed on the unique key. Five payments worth
//      P2,064 were taken from customers and never reached receivables.
//
//   2. All seven inserted the payment row and stopped there, on the strength of
//      a comment in admin.js saying "trigger auto-updates AR amount_paid &
//      status". No such trigger exists on this database, and none ever did. So
//      accounts_receivable.amount_paid stayed 0 and status stayed 'pending' for
//      every invoice ever paid: 205 records and P159,498.17 shown as outstanding
//      after the customer had paid in full. `balance` is GENERATED as
//      (total_amount - amount_paid), so it was wrong everywhere too.
//
// The payables mirror (ap_payments / accounts_payable, 'PAY-') had both bugs as
// well. It has never been used, so nothing was lost there — but it is the same
// code and would have failed the same way on its first deleted row.
//
// Numbering reads max(), not count(), so a gap left by a deleted row cannot make
// it hand back a number that is already taken. Two payments taken at the same
// moment can still read the same max, so a unique violation is retried rather
// than treated as an error — with the counter and the webhook both live, that is
// a real collision, not a theoretical one.

const TAG = '[receipts]';

// Postgres unique_violation. A collision means someone else took the number
// between our read and our insert: a reason to try again, not to fail.
const UNIQUE_VIOLATION = '23505';
const MAX_ATTEMPTS = 6;

const isUniqueViolation = (e) =>
  e && (e.code === UNIQUE_VIOLATION ||
        e.meta?.code === UNIQUE_VIOLATION ||
        /duplicate key value|unique constraint/i.test(e.message || ''));

// payment_number is varchar(30), reference_number varchar(50), and a payment must
// not fail because a gateway sent a long reference.
const fit = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));

// Only these two tables are ever addressed, and the name is concatenated into SQL
// to read the running maximum. Whitelisted so that can never become an injection
// point if a caller is ever changed to pass something through.
const LEDGERS = {
  ar: { table: 'ar_payments', prefix: 'RCV-' },
  ap: { table: 'ap_payments', prefix: 'PAY-' },
};

/**
 * Allocate the next receipt number and insert with it, retrying if another
 * request takes the number first.
 *
 * @param {'ar'|'ap'} ledger
 * @param {(payNum: string) => Promise<object[]>} insert - returns the inserted row
 */
async function allocateAndInsert(prisma, ledger, insert) {
  const { table, prefix } = LEDGERS[ledger];
  const offset = prefix.length + 1; // SUBSTRING is 1-based: 'RCV-' -> start at 5
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // max() of the numeric suffix, never count(*): the table has gaps where rows
    // were deleted, and count(*) + 1 lands inside one of them.
    const next = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(payment_number FROM ${offset}) AS INTEGER)), 0) + 1 AS next_num
         FROM ${table}
        WHERE payment_number ~ '^${prefix}[0-9]+$'`
    );
    const payNum = prefix + String(next[0].next_num).padStart(6, '0');

    try {
      const rows = await insert(payNum);
      return rows[0];
    } catch (e) {
      lastErr = e;
      if (!isUniqueViolation(e)) throw e;
      console.warn(`${TAG} ${payNum} was taken (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying`);
    }
  }
  throw new Error(`could not allocate a receipt number after ${MAX_ATTEMPTS} attempts: ${lastErr?.message}`);
}

/**
 * Record a payment against an accounts-receivable invoice, and bring that
 * invoice's amount_paid, status and balance back in line with what it has
 * actually received.
 *
 * Throws on failure. Every caller already catches and logs, so the payment
 * itself is kept even when its accounting copy cannot be written.
 *
 * @param {object} prisma
 * @param {object} opts
 * @param {number} opts.arId              - accounts_receivable.id
 * @param {number} opts.amount            - pesos
 * @param {string} [opts.method]          - 'cash' | 'gcash' | 'credit' | ...
 * @param {string} [opts.referenceNumber]
 * @param {string} [opts.notes]
 * @param {string} [opts.receivedBy]
 * @param {Date|string} [opts.paymentDate] - defaults to today
 * @returns {Promise<{id:number, paymentNumber:string, amountPaid:number, status:string}>}
 */
async function recordArPayment(prisma, {
  arId, amount, method = 'cash', referenceNumber = null,
  notes = null, receivedBy = 'system', paymentDate = null,
}) {
  if (!arId) throw new Error('recordArPayment: arId required');
  const payAmount = Number(amount);
  if (!Number.isFinite(payAmount)) throw new Error('recordArPayment: amount must be a number');

  const payDate = paymentDate ? new Date(paymentDate) : new Date();
  const ref = fit(referenceNumber, 50);
  const by = fit(receivedBy, 50) || 'system';
  const meth = fit(method, 30) || 'cash';

  const inserted = await allocateAndInsert(prisma, 'ar', (payNum) => prisma.$queryRaw`
    INSERT INTO ar_payments
      (payment_number, ar_id, payment_date, amount, payment_method, reference_number, notes, received_by)
    VALUES
      (${payNum}, ${arId}, ${payDate}::date, ${payAmount}, ${meth}, ${ref}, ${notes}, ${by})
    RETURNING id, payment_number
  `);

  const totals = await refreshArTotals(prisma, arId);
  return {
    id: inserted.id,
    paymentNumber: inserted.payment_number,
    amountPaid: totals.amountPaid,
    status: totals.status,
  };
}

/**
 * The payables mirror of recordArPayment. Same two fixes, same shape.
 *
 * @param {number} opts.apId - accounts_payable.id
 */
async function recordApPayment(prisma, {
  apId, amount, method = 'bank_transfer', referenceNumber = null, checkNumber = null,
  notes = null, paidBy = 'system', paymentDate = null,
}) {
  if (!apId) throw new Error('recordApPayment: apId required');
  const payAmount = Number(amount);
  if (!Number.isFinite(payAmount)) throw new Error('recordApPayment: amount must be a number');

  const payDate = paymentDate ? new Date(paymentDate) : new Date();
  const ref = fit(referenceNumber, 50);
  const chk = fit(checkNumber, 30);   // check_number is varchar(30), narrower than reference_number
  const by = fit(paidBy, 50) || 'system';
  const meth = fit(method, 30) || 'bank_transfer';

  const inserted = await allocateAndInsert(prisma, 'ap', (payNum) => prisma.$queryRaw`
    INSERT INTO ap_payments
      (payment_number, ap_id, payment_date, amount, payment_method, reference_number, check_number, notes, paid_by)
    VALUES
      (${payNum}, ${apId}, ${payDate}::date, ${payAmount}, ${meth}, ${ref}, ${chk}, ${notes}, ${by})
    RETURNING id, payment_number
  `);

  const totals = await refreshApTotals(prisma, apId);
  return {
    id: inserted.id,
    paymentNumber: inserted.payment_number,
    amountPaid: totals.amountPaid,
    status: totals.status,
  };
}

/**
 * Recompute one receivable's amount_paid and status from the payments it holds.
 *
 * Recomputed from the sum rather than incremented, so running it twice cannot
 * double-count and running it on a record that drifted repairs it.
 *
 * `balance` is a GENERATED column (total_amount - amount_paid) and must not be
 * written; it follows amount_paid on its own.
 *
 * A record with nothing paid keeps the status it has, so an invoice already
 * marked 'overdue' is not quietly reset to 'pending'.
 */
async function refreshArTotals(prisma, arId) {
  const rows = await prisma.$queryRaw`
    UPDATE accounts_receivable ar
    SET amount_paid = s.paid,
        status = CASE
                   WHEN s.paid > 0 AND s.paid >= ar.total_amount THEN 'paid'
                   WHEN s.paid > 0                               THEN 'partial'
                   ELSE ar.status
                 END,
        updated_at = NOW()
    FROM (SELECT COALESCE(SUM(amount), 0) AS paid FROM ar_payments WHERE ar_id = ${arId}) s
    WHERE ar.id = ${arId}
    RETURNING ar.amount_paid, ar.status
  `;
  if (rows.length === 0) throw new Error(`accounts_receivable ${arId} not found`);
  return { amountPaid: Number(rows[0].amount_paid), status: rows[0].status };
}

/** The payables mirror of refreshArTotals. */
async function refreshApTotals(prisma, apId) {
  const rows = await prisma.$queryRaw`
    UPDATE accounts_payable ap
    SET amount_paid = s.paid,
        status = CASE
                   WHEN s.paid > 0 AND s.paid >= ap.total_amount THEN 'paid'
                   WHEN s.paid > 0                               THEN 'partial'
                   ELSE ap.status
                 END,
        updated_at = NOW()
    FROM (SELECT COALESCE(SUM(amount), 0) AS paid FROM ap_payments WHERE ap_id = ${apId}) s
    WHERE ap.id = ${apId}
    RETURNING ap.amount_paid, ap.status
  `;
  if (rows.length === 0) throw new Error(`accounts_payable ${apId} not found`);
  return { amountPaid: Number(rows[0].amount_paid), status: rows[0].status };
}

module.exports = { recordArPayment, recordApPayment, refreshArTotals, refreshApTotals };
