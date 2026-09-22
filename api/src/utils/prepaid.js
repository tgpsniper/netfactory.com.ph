// ============================================================
// prepaid — service sold as time, not as a monthly debt
// ============================================================
// Postpaid asks "is an invoice overdue past grace?". Prepaid asks "has the paid-for
// date arrived?". Those are different questions, so this module carries its own
// candidate query, its own enable flag and its own trigger_source. It deliberately
// reuses restriction.js for the actual cutting and restoring — there must be exactly
// one implementation of "put this customer behind the walled garden", or the two
// billing models will drift apart and only one of them will get fixed.
//
// A top-up always writes an invoice and a payment. That is not bookkeeping ceremony:
// payments.invoice_id is NOT NULL with a foreign key, and A/R, SOA, the PDF and
// thermal receipts and the treasury deposit flow all hang off invoices. Issuing an
// invoice per top-up buys the entire existing money path for free.
// ============================================================

const restriction = require('./restriction');

const PREPAID = 'prepaid';
const TRIGGER = 'prepaid-expiry';
const ENABLED_KEY = 'prepaid_auto_expire_enabled';
const GRACE_KEY = 'prepaid_expiry_grace_hours';

// ── time ────────────────────────────────────────────────────
// Manila is UTC+8 and has no DST, so the arithmetic is a fixed offset rather than a
// locale lookup. Expiry lands at 23:59:59.999 of the final day, not at the clock time
// of purchase: a customer who loads at 11pm should not lose that day. Because an
// already-rounded expiry stays rounded when whole days are added, this rounds once on
// the first top-up and never drifts afterwards.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function endOfManilaDay(d) {
  const day = Math.floor((d.getTime() + MANILA_OFFSET_MS) / DAY_MS);
  return new Date((day + 1) * DAY_MS - 1 - MANILA_OFFSET_MS);
}

// Extend from whichever is later: now, or the expiry they already hold. Extending from
// now would silently confiscate unused days from anyone who tops up early, which is
// exactly the customer you least want to punish.
function nextExpiry(current, days, now = new Date()) {
  const base = (current && current.getTime() > now.getTime()) ? current : now;
  return endOfManilaDay(new Date(base.getTime() + days * DAY_MS));
}

// ── plan helpers ────────────────────────────────────────────
function isPrepaidPlan(plan) {
  return !!plan
    && String(plan.billing_type || '').toLowerCase() === PREPAID
    && Number(plan.validity_period) > 0;
}

// How much time a given peso amount buys. Denominations are whole multiples of the
// plan price — ₱999 on a 30-day/₱999 plan buys 30 days, ₱1998 buys 60. Anything that
// does not reach one full period is rejected rather than quietly rounded down to
// nothing, so a short payment surfaces as an error instead of vanishing.
function daysForAmount(plan, amount) {
  const price = Number(plan.price);
  const period = Number(plan.validity_period);
  if (!(price > 0) || !(period > 0)) return null;
  const periods = Math.floor((Number(amount) + 0.005) / price);
  if (periods < 1) return null;
  return periods * period;
}

function amountForDays(plan, days) {
  const price = Number(plan.price);
  const period = Number(plan.validity_period);
  if (!(price > 0) || !(period > 0)) return null;
  return Number((price * (Number(days) / period)).toFixed(2));
}

// ── settings ────────────────────────────────────────────────
async function isAutoExpireEnabled(prisma) {
  try {
    const row = await prisma.system_settings.findUnique({ where: { key: ENABLED_KEY } });
    return String(row ? row.value : '').trim().toLowerCase() === 'true';
  } catch (_) { return false; }
}

async function getGraceHours(prisma) {
  try {
    const row = await prisma.system_settings.findUnique({ where: { key: GRACE_KEY } });
    const n = Number(String(row ? row.value : '').trim());
    if (!Number.isInteger(n) || n < 0 || n > 720) return 0;
    return n;
  } catch (_) { return 0; }
}

// ── state ───────────────────────────────────────────────────
async function getStatus(prisma, subscriberId) {
  const sub = await prisma.subscribers.findUnique({
    where: { id: Number(subscriberId) },
    include: { plan: true },
  });
  if (!sub) return null;
  const prepaid = isPrepaidPlan(sub.plan);
  const now = new Date();
  const exp = sub.expires_at ? new Date(sub.expires_at) : null;
  return {
    subscriberId: sub.id,
    accountNumber: sub.account_number,
    prepaid,
    planId: sub.plan_id,
    planName: sub.plan ? sub.plan.name : null,
    price: sub.plan ? Number(sub.plan.price) : null,
    validityDays: sub.plan ? Number(sub.plan.validity_period) || null : null,
    expiresAt: exp,
    expired: prepaid && (!exp || exp.getTime() <= now.getTime()),
    // Negative once expired, which reads correctly in a UI as "-3 days".
    daysRemaining: exp ? Math.ceil((exp.getTime() - now.getTime()) / DAY_MS) : null,
  };
}

// ── invoice numbering ───────────────────────────────────────
// INV-YYMM#### resetting monthly, the same scheme admin.js uses. Prepaid invoices must
// be indistinguishable from any other in the books; only prepaid_days marks them.
async function nextInvoiceNumber(prisma) {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `INV-${yy}${mm}`;
  const rows = await prisma.$queryRawUnsafe(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 9 FOR 4) AS INTEGER)), 0) + 1 AS next_num " +
    "FROM invoices WHERE invoice_number LIKE $1 AND LENGTH(invoice_number) = 12",
    prefix + '%');
  return `${prefix}${String(rows[0].next_num).padStart(4, '0')}`;
}

// ── create an unpaid top-up invoice (online checkout) ───────
// The online path needs an invoice to exist before Xendit is called, because the
// webhook identifies the purchase by invoice id. prepaid_days on the row is what tells
// the callback this is time being bought rather than a debt being settled.
async function createTopUpInvoice(prisma, { subscriberId, days, amount, by = 'system', notes = null }) {
  const sub = await prisma.subscribers.findUnique({
    where: { id: Number(subscriberId) }, include: { plan: true },
  });
  if (!sub) throw new Error('subscriber not found');
  if (!isPrepaidPlan(sub.plan)) throw new Error('subscriber is not on a prepaid plan');

  const d = Number(days) || Number(sub.plan.validity_period);
  const amt = amount != null ? Number(amount) : amountForDays(sub.plan, d);
  if (!(d > 0)) throw new Error('invalid number of days');
  if (!(amt > 0)) throw new Error('invalid amount');

  const invoiceNumber = await nextInvoiceNumber(prisma);
  return prisma.invoices.create({
    data: {
      subscriber_id: sub.id,
      invoice_number: invoiceNumber,
      amount: amt,
      billing_period: 'Prepaid Top-Up',
      // Due immediately — a prepaid top-up is not credit, so there is no grace to grant.
      due_date: new Date(),
      status: 'pending',
      prepaid_days: d,
      notes: notes || `${String(sub.plan.name || 'Prepaid').toUpperCase()}: ${amt.toFixed(2)}\n${d} days of prepaid service`,
    },
  });
}

// ── grant service time ──────────────────────────────────────
// The expiry bump is a single UPDATE computed in Postgres rather than read-modify-write
// in Node. Two top-ups landing together — a Xendit retry racing a counter payment — would
// otherwise both read the same starting expiry and one extension would be lost.
// The date arithmetic mirrors nextExpiry() exactly; both round to end of Manila day.
const EXTEND_SQL = `
  WITH before AS (SELECT id, expires_at FROM subscribers WHERE id = $1)
  UPDATE subscribers s
     SET expires_at = (
           date_trunc('day',
             (GREATEST(COALESCE(b.expires_at, now()), now()) AT TIME ZONE 'Asia/Manila')
             + make_interval(days => $2::int)
           ) + interval '1 day' - interval '1 millisecond'
         ) AT TIME ZONE 'Asia/Manila'
    FROM before b
   WHERE s.id = b.id
  RETURNING b.expires_at AS expires_before, s.expires_at AS expires_after`;

// Idempotent on invoice_id. Xendit delivers a callback more than once often enough that
// this matters: without it a retry would hand out a second 30 days for nothing.
async function grant(prisma, radiusDb, opts = {}) {
  const sid = Number(opts.subscriberId);
  const days = Number(opts.days);
  const invoiceId = opts.invoiceId != null ? Number(opts.invoiceId) : null;
  const paymentId = opts.paymentId != null ? Number(opts.paymentId) : null;
  if (!(sid > 0)) throw new Error('subscriberId required');
  if (!(days > 0)) throw new Error('days must be a positive number');

  const sub = await prisma.subscribers.findUnique({ where: { id: sid }, include: { plan: true } });
  if (!sub) throw new Error('subscriber not found');

  const out = await prisma.$transaction(async (tx) => {
    if (invoiceId) {
      const prior = await tx.prepaid_topups.findFirst({ where: { invoice_id: invoiceId } });
      // Already granted by an earlier delivery of the same callback. Not an error —
      // report it so the caller can still answer the webhook with 200 and stop retries.
      if (prior) return { already: true, topup: prior };
    }
    const rows = await tx.$queryRawUnsafe(EXTEND_SQL, sid, days);
    if (!rows.length) throw new Error('subscriber vanished mid-transaction');
    const { expires_before, expires_after } = rows[0];
    const topup = await tx.prepaid_topups.create({
      data: {
        subscriber_id: sid,
        invoice_id: invoiceId,
        payment_id: paymentId,
        plan_id: sub.plan_id,
        amount: opts.amount != null ? Number(opts.amount) : (amountForDays(sub.plan, days) || 0),
        days,
        expires_before: expires_before || null,
        expires_after,
        source: opts.source || 'manual',
        created_by: opts.by || 'system',
      },
    });
    return { already: false, topup, expiresBefore: expires_before, expiresAfter: expires_after };
  });

  if (out.already) {
    return { granted: false, reason: 'already granted for this invoice', topup: out.topup };
  }

  // Router work stays outside the transaction — a MikroTik that is slow to answer must
  // never hold a database lock, and the money is already recorded either way.
  const restored = await restoreAfterTopUp(prisma, radiusDb, sid, opts.by);

  return {
    granted: true,
    days,
    expiresBefore: out.expiresBefore,
    expiresAfter: out.expiresAfter,
    topupId: out.topup.id,
    restored,
  };
}

// Paying restores access, same policy as postpaid: whoever applied the cutoff, money
// lifts it — unless it was marked no_auto_restore, which is the flag for restrictions
// billing cannot reason about (abuse, equipment recovery, a disputed account).
// Never throws: the top-up is already recorded and must not be rolled back because a
// router was unreachable. The reconcile job sweeps up anything missed here.
async function restoreAfterTopUp(prisma, radiusDb, subscriberId, by) {
  const sid = Number(subscriberId);
  try {
    const open = await restriction.getRestriction(radiusDb, sid);
    if (!open) return { restored: false, reason: 'not restricted' };
    if (open.no_auto_restore) return { restored: false, reason: 'held for manual review' };
    const out = await restriction.unrestrictSubscriber(prisma, radiusDb, sid,
      { by: by ? `top-up by ${by}` : 'auto (prepaid top-up)' });
    return {
      restored: !!out.wasRestricted,
      devices: out.restored ? out.restored.length : 0,
      routerApplied: out.router ? out.router.ok : null,
    };
  } catch (err) {
    console.error(`[prepaid] restore after top-up, subscriber ${sid}: ${err.message}`);
    return { restored: false, error: err.message };
  }
}

// ── over-the-counter top-up ─────────────────────────────────
// Cash or GCash taken at the office. Writes the invoice already settled, the payment,
// and the grant, so the books look identical to any other payment taken that day.
async function topUpOverCounter(prisma, radiusDb, opts = {}) {
  const sid = Number(opts.subscriberId);
  const sub = await prisma.subscribers.findUnique({ where: { id: sid }, include: { plan: true } });
  if (!sub) throw new Error('subscriber not found');
  if (!isPrepaidPlan(sub.plan)) throw new Error('subscriber is not on a prepaid plan');

  let days = opts.days != null ? Number(opts.days) : null;
  let amount = opts.amount != null ? Number(opts.amount) : null;
  if (days == null && amount == null) {
    days = Number(sub.plan.validity_period);
    amount = Number(sub.plan.price);
  } else if (days == null) {
    days = daysForAmount(sub.plan, amount);
    if (days == null) {
      throw new Error(`₱${Number(amount).toFixed(2)} does not cover one full period of ${sub.plan.validity_period} days at ₱${Number(sub.plan.price).toFixed(2)}`);
    }
  } else if (amount == null) {
    amount = amountForDays(sub.plan, days);
  }
  if (!(days > 0)) throw new Error('invalid number of days');
  if (!(amount > 0)) throw new Error('invalid amount');

  const invoiceNumber = await nextInvoiceNumber(prisma);
  const now = new Date();
  const created = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoices.create({
      data: {
        subscriber_id: sid,
        invoice_number: invoiceNumber,
        amount,
        billing_period: 'Prepaid Top-Up',
        due_date: now,
        status: 'paid',
        prepaid_days: days,
        notes: `${String(sub.plan.name || 'Prepaid').toUpperCase()}: ${Number(amount).toFixed(2)}\n${days} days of prepaid service`,
      },
    });
    const payment = await tx.payments.create({
      data: {
        invoice_id: invoice.id,
        subscriber_id: sid,
        amount,
        method: opts.method || 'cash',
        reference_number: opts.reference || null,
        status: 'success',
        paid_at: now,
        or_number: opts.orNumber || null,
      },
    });
    return { invoice, payment };
  });

  const granted = await grant(prisma, radiusDb, {
    subscriberId: sid, days, amount,
    invoiceId: created.invoice.id, paymentId: created.payment.id,
    source: opts.source || 'manual', by: opts.by || 'system',
  });

  return { invoice: created.invoice, payment: created.payment, ...granted };
}

// ── expiry ──────────────────────────────────────────────────
// Prepaid's equivalent of restrictionCandidates. Read-only: it answers "who has run
// out", it decides nothing. expires_at IS NULL is deliberately excluded — that is an
// account that has never topped up, which is an activation question for a human, not
// something to cut off automatically.
async function expiryCandidates(prisma, radiusDb, graceHours) {
  const [rows] = await radiusDb.query(
    `SELECT s.id,
            s.account_number,
            trim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')) AS name,
            s.company_name,
            s.status AS subscriber_status,
            s.expires_at,
            round(EXTRACT(EPOCH FROM (now() - s.expires_at)) / 3600.0, 1) AS hours_expired,
            p.name AS plan_name,
            p.validity_period,
            (SELECT count(*) FROM hotspot_mac_devices hd
              WHERE hd.subscriber_id = s.id)   AS devices,
            (r.id IS NOT NULL)                 AS already_restricted
       FROM subscribers s
       JOIN plans p ON p.id = s.plan_id
                   AND lower(coalesce(p.billing_type,'')) = 'prepaid'
       LEFT JOIN subscriber_restrictions r
              ON r.subscriber_id = s.id AND r.lifted_at IS NULL
      WHERE s.restriction_exempt = false
        AND s.status = 'active'
        AND s.expires_at IS NOT NULL
        AND s.expires_at < now() - make_interval(hours => ?::int)
      ORDER BY s.expires_at ASC`, [Number(graceHours) || 0]);
  return rows;
}

async function runPrepaidExpiry(prisma, radiusDb, opts = {}) {
  const dryRun = opts.dryRun !== undefined ? opts.dryRun : !(await isAutoExpireEnabled(prisma));
  const graceHours = await getGraceHours(prisma);
  const { mode } = await restriction.getRestrictionMode(prisma);
  const cap = await readCap(prisma);

  const candidates = await expiryCandidates(prisma, radiusDb, graceHours);
  const eligible = candidates.filter(c => !c.already_restricted && Number(c.devices) > 0);
  const skippedNoDevices = candidates
    .filter(c => !c.already_restricted && Number(c.devices) === 0)
    .map(c => `#${c.id} ${c.account_number}`);

  const capped = eligible.length > cap;
  const batch = eligible.slice(0, cap);

  const restricted = [];
  if (!dryRun) {
    for (const c of batch) {
      try {
        const out = await restriction.restrictSubscriber(prisma, radiusDb, Number(c.id), {
          reason: `Prepaid expired ${new Date(c.expires_at).toISOString().slice(0, 10)} (${c.hours_expired}h ago)`,
          by: 'auto (prepaid expiry)', trigger: TRIGGER,
        });
        if (!out.alreadyRestricted) {
          restricted.push({
            subscriberId: Number(c.id), account: c.account_number,
            expiresAt: c.expires_at, hoursExpired: Number(c.hours_expired),
            mode: out.mode, routerApplied: out.router.ok,
          });
        }
      } catch (err) {
        console.error(`[prepaid-expiry] subscriber ${c.id} failed: ${err.message}`);
      }
    }
  }

  return {
    dryRun, graceHours, mode, cap, capped,
    eligible: eligible.map(c => ({
      subscriberId: Number(c.id), account: c.account_number,
      name: c.name || c.company_name, plan: c.plan_name,
      expiresAt: c.expires_at, hoursExpired: Number(c.hours_expired),
      devices: Number(c.devices),
    })),
    restricted,
    skippedNoDevices,
  };
}

async function readCap(prisma) {
  try {
    const row = await prisma.system_settings.findUnique({ where: { key: 'prepaid_max_per_run' } });
    const n = Number(String(row ? row.value : '').trim());
    if (!Number.isInteger(n) || n < 1 || n > 10000) return 25;
    return n;
  } catch (_) { return 25; }
}

// Lift expiry cutoffs for anyone whose expiry is now in the future. grant() already
// restores on the spot; this is the backstop for a top-up taken while a router was
// unreachable, and for expiry dates edited by hand in the CRM. Only restrictions this
// module created are touched — trigger_source is the whole guard.
async function runPrepaidRestore(prisma, radiusDb) {
  const [open] = await radiusDb.query(
    `SELECT r.subscriber_id
       FROM subscriber_restrictions r
       JOIN subscribers s ON s.id = r.subscriber_id
      WHERE r.lifted_at IS NULL
        AND r.no_auto_restore = false
        AND r.trigger_source = ?
        AND s.expires_at IS NOT NULL
        AND s.expires_at > now()`, [TRIGGER]);
  const lifted = [];
  for (const r of open) {
    const sid = Number(r.subscriber_id);
    try {
      const out = await restriction.unrestrictSubscriber(prisma, radiusDb, sid,
        { by: 'auto (prepaid active again)' });
      if (out.wasRestricted) lifted.push({ subscriberId: sid, devices: out.restored.length });
    } catch (err) {
      console.error(`[prepaid-restore] subscriber ${sid} failed: ${err.message}`);
    }
  }
  return { lifted };
}

module.exports = {
  PREPAID, TRIGGER, ENABLED_KEY, GRACE_KEY,
  DAY_MS,
  endOfManilaDay, nextExpiry,
  isPrepaidPlan, daysForAmount, amountForDays,
  isAutoExpireEnabled, getGraceHours,
  getStatus, nextInvoiceNumber, createTopUpInvoice,
  grant, restoreAfterTopUp, topUpOverCounter,
  expiryCandidates, runPrepaidExpiry, runPrepaidRestore,
};
