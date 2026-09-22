const express = require('express');
const router = express.Router();

// ============================================================
// Netfactory — Prepaid API
// Routes: /api/admin/prepaid/...
// ============================================================
// Counter top-ups, expiry adjustments and the expiry dashboard. The money path is
// prepaid.topUpOverCounter(), which writes a real invoice and a real payment so a
// prepaid renewal lands in A/R, the SOA and the deposit sheet exactly like any other
// payment taken that day.
// ============================================================

const prepaid = require('../utils/prepaid');
let radiusDb;
try { radiusDb = require('../config/radius-db'); } catch (e) { radiusDb = null; }

// The shared middleware, not the lighter copy some sibling route files carry. That copy
// verifies the signature but never checks decoded.type, so a subscriber's portal token
// — signed with the same secret — passes it. It also still accepts ?token=, which
// adminAuth dropped deliberately because query strings land in access logs, browser
// history and Referer headers. These endpoints take money and switch service on and
// off; they get the real one, which also honours the logout blacklist and re-checks
// that the admin account is still active.
const adminAuth = require('../middleware/adminAuth');

// adminAuth sets req.admin; this is just the name written into the audit trail.
function actor(req) {
  return (req.admin && (req.admin.username || req.admin.email)) || String(req.adminId || 'admin');
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// ============================================
// GET /api/admin/prepaid/plans — prepaid plans available for top-up
// ============================================
router.get('/plans', adminAuth(), async (req, res) => {
  try {
    const plans = await req.prisma.plans.findMany({
      where: { billing_type: 'prepaid', is_active: true },
      orderBy: { sort_order: 'asc' },
      select: { id: true, name: true, price: true, validity_period: true,
                speed_label: true, download_mbps: true, upload_mbps: true },
    });
    res.json({ plans: plans.map(p => ({ ...p, price: Number(p.price) })) });
  } catch (err) {
    console.error('[prepaid] plans:', err);
    res.status(500).json({ error: 'Failed to load prepaid plans: ' + err.message });
  }
});

// ============================================
// GET /api/admin/prepaid/status/:id — one subscriber's prepaid standing
// ============================================
router.get('/status/:id', adminAuth(), async (req, res) => {
  try {
    const status = await prepaid.getStatus(req.prisma, req.params.id);
    if (!status) return res.status(404).json({ error: 'Subscriber not found' });
    const topups = await req.prisma.prepaid_topups.findMany({
      where: { subscriber_id: Number(req.params.id) },
      orderBy: { created_at: 'desc' }, take: 20,
      include: { invoice: { select: { invoice_number: true } } },
    });
    res.json({
      ...status,
      topups: topups.map(t => ({
        id: t.id, amount: Number(t.amount), days: t.days,
        expiresBefore: t.expires_before, expiresAfter: t.expires_after,
        source: t.source, createdBy: t.created_by, createdAt: t.created_at,
        invoiceNumber: t.invoice ? t.invoice.invoice_number : null,
      })),
    });
  } catch (err) {
    console.error('[prepaid] status:', err);
    res.status(500).json({ error: 'Failed to load prepaid status: ' + err.message });
  }
});

// ============================================
// POST /api/admin/prepaid/topup/:id — counter top-up (cash, GCash, etc.)
// ============================================
// Send either { days } or { amount }. Sending neither buys one full period of the
// subscriber's plan, which is the overwhelmingly common counter transaction.
router.post('/topup/:id', adminAuth(), async (req, res) => {
  try {
    if (!radiusDb) return res.status(503).json({ error: 'RADIUS unavailable; cannot apply access changes' });
    const out = await prepaid.topUpOverCounter(req.prisma, radiusDb, {
      subscriberId: req.params.id,
      days: num(req.body.days),
      amount: num(req.body.amount),
      method: req.body.method || 'cash',
      reference: req.body.reference || null,
      orNumber: req.body.orNumber || null,
      source: 'manual',
      by: actor(req),
    });
    if (req.auditLog) {
      req.auditLog('PREPAID_TOPUP', {
        subscriberId: Number(req.params.id), days: out.days,
        amount: Number(out.invoice.amount), invoice: out.invoice.invoice_number,
        expiresAfter: out.expiresAfter,
      }).catch(() => {});
    }
    res.status(201).json({
      success: true,
      invoiceNumber: out.invoice.invoice_number,
      paymentId: out.payment.id,
      amount: Number(out.invoice.amount),
      days: out.days,
      expiresBefore: out.expiresBefore,
      expiresAfter: out.expiresAfter,
      accessRestored: !!(out.restored && out.restored.restored),
    });
  } catch (err) {
    console.error('[prepaid] topup:', err);
    // A plan/amount mismatch is the operator's mistake to correct, not a server fault.
    const client = /not on a prepaid plan|does not cover|invalid|not found/i.test(err.message);
    res.status(client ? 400 : 500).json({ error: err.message });
  }
});

// ============================================
// POST /api/admin/prepaid/checkout/:id — online top-up link (Xendit)
// ============================================
// Creates the PENDING invoice only. The existing paylink/portal checkout machinery
// turns an invoice into a Xendit page, and the webhook grants the days on callback —
// so there is exactly one place that talks to Xendit, and it is not this file.
router.post('/checkout/:id', adminAuth(), async (req, res) => {
  try {
    const invoice = await prepaid.createTopUpInvoice(req.prisma, {
      subscriberId: req.params.id,
      days: num(req.body.days),
      amount: num(req.body.amount),
      by: actor(req),
    });
    res.status(201).json({
      success: true, invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      amount: Number(invoice.amount), days: invoice.prepaid_days,
    });
  } catch (err) {
    console.error('[prepaid] checkout:', err);
    const client = /not on a prepaid plan|invalid|not found/i.test(err.message);
    res.status(client ? 400 : 500).json({ error: err.message });
  }
});

// ============================================
// POST /api/admin/prepaid/adjust/:id — grant or correct time without payment
// ============================================
// Goodwill days, a credited outage, or fixing a keying error. It writes a
// prepaid_topups row with no invoice and amount 0 so the adjustment is on the record
// and cannot be mistaken for money taken.
router.post('/adjust/:id', adminAuth(), async (req, res) => {
  try {
    if (!radiusDb) return res.status(503).json({ error: 'RADIUS unavailable; cannot apply access changes' });
    const days = num(req.body.days);
    if (!(days > 0)) return res.status(400).json({ error: 'days must be a positive number' });
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason is required for a free adjustment' });

    const out = await prepaid.grant(req.prisma, radiusDb, {
      subscriberId: req.params.id, days, amount: 0,
      source: 'manual', by: `${actor(req)}: ${reason}`,
    });
    if (req.auditLog) {
      req.auditLog('PREPAID_ADJUST', {
        subscriberId: Number(req.params.id), days, reason, expiresAfter: out.expiresAfter,
      }).catch(() => {});
    }
    res.json({ success: true, ...out });
  } catch (err) {
    console.error('[prepaid] adjust:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /api/admin/prepaid/expiring — the operational dashboard
// ============================================
// ?within=3 lists everyone expiring in the next 3 days as well as everyone already
// expired, which is the list the counter works from each morning.
router.get('/expiring', adminAuth(), async (req, res) => {
  try {
    const within = Math.min(Math.max(parseInt(req.query.within) || 3, 0), 90);
    const rows = await req.prisma.$queryRawUnsafe(`
      SELECT s.id, s.account_number, s.first_name, s.last_name, s.company_name,
             s.phone, s.email, s.status, s.expires_at,
             p.name AS plan_name, p.price, p.validity_period,
             round(EXTRACT(EPOCH FROM (s.expires_at - now())) / 86400.0, 2) AS days_remaining,
             (SELECT count(*) FROM subscriber_restrictions r
               WHERE r.subscriber_id = s.id AND r.lifted_at IS NULL) > 0 AS restricted,
             (SELECT count(*) FROM hotspot_mac_devices hd
               WHERE hd.subscriber_id = s.id) AS devices
        FROM subscribers s
        JOIN plans p ON p.id = s.plan_id AND lower(coalesce(p.billing_type,'')) = 'prepaid'
       WHERE s.status = 'active'
         AND (s.expires_at IS NULL OR s.expires_at < now() + make_interval(days => $1::int))
       ORDER BY s.expires_at ASC NULLS FIRST`, within);
    res.json({
      within,
      count: rows.length,
      subscribers: rows.map(r => ({
        ...r,
        price: Number(r.price),
        days_remaining: r.days_remaining === null ? null : Number(r.days_remaining),
        devices: Number(r.devices),
        // expires_at NULL means the account has never been topped up — an activation
        // question for a human, which is why the expiry job leaves it alone.
        awaitingFirstTopUp: r.expires_at === null,
      })),
    });
  } catch (err) {
    console.error('[prepaid] expiring:', err);
    res.status(500).json({ error: 'Failed to load expiring list: ' + err.message });
  }
});

// ============================================
// POST /api/admin/prepaid/run-expiry — trigger the expiry pass by hand
// ============================================
// Defaults to a dry run whatever the setting says, so this is safe to press. Pass
// { dryRun: false } to actually cut, which still respects prepaid_max_per_run.
router.post('/run-expiry', adminAuth(), async (req, res) => {
  try {
    if (!radiusDb) return res.status(503).json({ error: 'RADIUS unavailable' });
    const dryRun = req.body.dryRun === false ? false : true;
    const out = await prepaid.runPrepaidExpiry(req.prisma, radiusDb, { dryRun });
    if (!dryRun && req.auditLog) {
      req.auditLog('PREPAID_EXPIRY_RUN', { restricted: out.restricted.length }).catch(() => {});
    }
    res.json(out);
  } catch (err) {
    console.error('[prepaid] run-expiry:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
