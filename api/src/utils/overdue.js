// ============================================================
// overdue.js — an invoice is overdue by its due date, not by a stored status
// ============================================================
// Nothing in this system has ever written status = 'overdue'. The only writer is
// the "Mark as Overdue" button on the CRM billing page, which staff have used
// zero times. Every report that counted status = 'overdue' therefore reported 0
// forever: the CRM billing tile sat on 0 while 17 invoices were weeks past due,
// and so did the dashboard KPI, the collections report and the receivables aging.
//
// The rule below is the one the invoice rows and the restriction job were already
// using, lifted somewhere both the API and the CRM can share, so a tile and the
// report behind it can never disagree again.
//
// Past due means the due date has passed — an invoice due today is not late yet.
// That matches restriction.js, which measures days_past_due as
// (CURRENT_DATE - due_date) and only cuts a customer off once that exceeds the
// grace period, so nobody is restricted on the day their bill falls due.
//
// 'overdue' stays in the unsettled list because the manual button can still write
// it, and such a row is owed whatever its due date says.

const UNSETTLED = ['pending', 'partial', 'overdue'];

/** Local midnight. Prisma compares against a Date, the raw SQL against CURRENT_DATE. */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Prisma `where` for invoices that are owed and past their due date.
 * @param {object} [extra] - merged in, e.g. { generated_at: { gte: yearStart } }
 */
function overdueWhere(extra = {}) {
  return { status: { in: UNSETTLED }, due_date: { lt: startOfToday() }, ...extra };
}

/**
 * Prisma `where` for invoices that are owed but not yet late.
 *
 * Deliberately excludes anything already overdue: the dashboard used to count
 * every pending invoice here AND report overdue separately, so the two buckets
 * would have double-counted the same bill the moment overdue stopped being zero.
 */
function notYetDueWhere(extra = {}) {
  return { status: 'pending', due_date: { gte: startOfToday() }, ...extra };
}

// For raw SQL against any table with `status` and `due_date` — invoices,
// accounts_receivable and accounts_payable all qualify.
const OVERDUE_SQL = "status IN ('pending','partial','overdue') AND due_date < CURRENT_DATE";
const OPEN_SQL    = "status IN ('pending','partial','overdue')";

module.exports = { UNSETTLED, startOfToday, overdueWhere, notYetDueWhere, OVERDUE_SQL, OPEN_SQL };
