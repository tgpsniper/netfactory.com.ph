// ============================================================
// arrears.js — money has to land on the oldest debt first
// ============================================================
// Paying one specific invoice is allowed by design: the pay endpoints take an id and
// the webhook credits that invoice by number, with no oldest-first allocation. The
// portal's own "Pay Now" button then hands over unpaidInvoices[0] from a list sorted
// due_date DESC — the NEWEST bill. So the default action for a customer in arrears was
// to pay this month and leave last month outstanding.
//
// That is worse than it sounds, because restriction.restoreIfSettled refuses to lift a
// cutoff while any invoice is past grace. The customer pays, sees "Payment Complete",
// and stays in the walled garden with no explanation. Their money is taken and their
// service does not come back.
//
// So: refuse a newer invoice while an older one is PAST ITS DUE DATE.
//
// Past due, not merely older. On 2026-09-21 there were 170 unpaid invoices not yet due
// — October and November are raised in advance here — and a plain "oldest first" rule
// would have stopped a customer paying October early because September, due in four
// days, was still open. Arrears means overdue. Under this rule 18 subscribers are
// affected, which matches the 18 who would otherwise pay and stay restricted.
//
// NOT blocked, on purpose:
//   * Pay All — it settles the arrears too, so there is always a way to pay. Blocking
//     every route would just stop collections.
//   * Staff recording an over-the-counter payment in admin.js — cash arrives in
//     whatever order the customer hands it over, and refusing to record it would only
//     put the ledger further from reality.
const SETTING_KEY = 'billing_enforce_arrears_first';
const UNPAID = ['pending', 'partial', 'overdue'];

async function isEnabled(prisma) {
  try {
    const row = await prisma.system_settings.findUnique({ where: { key: SETTING_KEY } });
    // Absent means ON. This is a correctness guard, not an opt-in feature — the
    // behaviour it prevents silently takes money without restoring service.
    if (!row) return true;
    return String(row.value).trim().toLowerCase() !== 'false';
  } catch (err) {
    // Unreadable settings must not silently disable the guard.
    console.error('[arrears] could not read ' + SETTING_KEY + ': ' + err.message + ' — enforcing');
    return true;
  }
}

// Returns null when the invoice may be paid, or { oldest, count, total } naming what
// has to be settled first. Never throws: a failure here must not block a payment, so
// it falls through to allowing the charge and logs instead.
async function blockingArrears(prisma, subscriberId, target) {
  try {
    if (!target || !target.due_date) return null;
    if (!(await isEnabled(prisma))) return null;

    const older = await prisma.invoices.findMany({
      where: {
        subscriber_id: subscriberId,
        status: { in: UNPAID },
        due_date: { lt: new Date(target.due_date) },
        id: { not: target.id },
      },
      orderBy: { due_date: 'asc' },
      select: { id: true, invoice_number: true, billing_period: true, amount: true, due_date: true },
    });
    if (!older.length) return null;

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const overdue = older.filter(o => new Date(o.due_date) < today);
    if (!overdue.length) return null;

    return {
      oldest: overdue[0],
      count: overdue.length,
      total: overdue.reduce((s, o) => s + Number(o.amount), 0),
    };
  } catch (err) {
    console.error('[arrears] check failed for subscriber ' + subscriberId + ': ' + err.message +
                  ' — allowing the payment');
    return null;
  }
}

// The 409 body both callers send. Kept here so the portal and the emailed pay link
// cannot drift into describing the same refusal two different ways.
function arrearsResponse(arrears) {
  const o = arrears.oldest;
  return {
    error: 'An earlier invoice is still unpaid and must be settled first.',
    code: 'ARREARS_FIRST',
    // The page needs enough to say WHICH bill and offer the right button, rather than
    // showing a refusal the customer cannot act on.
    oldest: {
      id: o.id, number: o.invoice_number, period: o.billing_period,
      amount: Number(o.amount), dueDate: o.due_date,
    },
    outstandingCount: arrears.count,
    outstandingTotal: arrears.total,
  };
}

module.exports = { blockingArrears, arrearsResponse, isEnabled, SETTING_KEY };
