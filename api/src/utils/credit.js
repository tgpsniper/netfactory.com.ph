// ============================================================
// credit.js — money received that no invoice needed
// ============================================================
// The CRM's counter-payment screen has always turned an overpayment into subscriber
// credit (admin.js, `type: 'overpayment'`). Online payments did not: a pay-link or
// portal checkout paid after the invoice had already been settled produced either a
// second payment row against a settled invoice, or — in the pay-all batch, which
// skips invoices already marked paid — no record of the money at all.
//
// This is the shared version of what the counter does, so both routes land in the
// same ledger and the same credit_balance the CRM and portal already read.
//
// Never throws. The money has already left the customer's account by the time this
// runs; raising here would fail the webhook, Xendit would retry, and the retry would
// settle everything a second time. A failure is logged loudly and left for staff.

const TAG = '[credit]';

// A webhook can be delivered more than once — Xendit retries on any non-2xx, and a
// customer can refresh a redirect. Crediting twice invents money, so a payment that
// has already produced a credit never produces another.
// Only an 'overpayment' row counts. The same payment id also appears on 'applied' rows
// — that is credit being SPENT on an invoice, which says nothing about whether this
// payment's surplus was ever banked, and treating it as proof would silently drop the
// credit for anyone who has had credit applied before.
async function alreadyCredited(prisma, paymentId) {
  if (!paymentId) return false;
  const rows = await prisma.$queryRaw`
    SELECT 1 FROM subscriber_credits
    WHERE source_payment_id = ${paymentId} AND type = 'overpayment' LIMIT 1`;
  return rows.length > 0;
}

/**
 * Add credit to a subscriber and write the ledger row.
 *
 * @param {object} prisma
 * @param {object} opts
 * @param {number} opts.subscriberId
 * @param {number} opts.amount         - pesos; ignored when <= 0
 * @param {number} [opts.paymentId]    - the payment this came from (idempotency key)
 * @param {string} [opts.note]         - free text for the ledger
 * @param {string} [opts.by]           - created_by
 * @returns {Promise<{credited:number, balance:number}|null>}
 */
async function addCredit(prisma, { subscriberId, amount, paymentId = null, note = null, by = 'auto (online payment)' }) {
  try {
    const amt = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(amt) || amt <= 0) return null;
    const sid = Number(subscriberId);
    if (!Number.isInteger(sid)) return null;

    if (await alreadyCredited(prisma, paymentId)) {
      console.log(TAG + ' payment ' + paymentId + ' is already credited — not crediting again');
      return null;
    }

    // credit_balance is the figure the CRM and the portal display; subscriber_credits
    // is the history behind it. Both are written here so they cannot drift.
    const upd = await prisma.$queryRaw`
      UPDATE subscribers
      SET credit_balance = ROUND(COALESCE(credit_balance, 0) + ${amt}::numeric, 2)
      WHERE id = ${sid}
      RETURNING credit_balance`;
    if (!upd.length) {
      console.error(TAG + ' no subscriber ' + sid + ' — P' + amt + ' NOT credited');
      return null;
    }
    const balance = Number(upd[0].credit_balance);

    await prisma.$queryRaw`
      INSERT INTO subscriber_credits
        (subscriber_id, type, amount, running_balance, source_payment_id, notes, created_by)
      VALUES (${sid}, 'overpayment', ${amt}, ${balance}, ${paymentId},
              ${note || 'Advance payment received online'}, ${String(by).slice(0, 50)})`;

    console.log(TAG + ' P' + amt + ' credited to subscriber ' + sid + ' (balance P' + balance + ')' +
      (note ? ' — ' + note : ''));
    return { credited: amt, balance };
  } catch (err) {
    // Loud on purpose: this is received money that did not reach the ledger.
    console.error(TAG + ' !! COULD NOT CREDIT P' + amount + ' to subscriber ' + subscriberId +
                  ' (payment ' + paymentId + '): ' + err.message);
    return null;
  }
}

module.exports = { addCredit };
