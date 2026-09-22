// ============================================================
// Pay-by-link — public, no portal login required
// ============================================================
// A pending applicant has no portal account (credentials are only minted at
// activation), and an active subscriber often will not log in just to settle a
// bill. This route backs an emailed link that opens straight onto a single
// invoice and a Xendit checkout button.
//
// WHAT THE TOKEN IS, AND IS NOT: a single-purpose JWT naming one invoice and one
// subscriber. It is deliberately NOT a portal session token — the invoice PDF
// route already accepts a full session JWT in a query string, which lands in
// nginx access logs, browser history and any forwarded email. A token sent to
// every customer must not be able to do anything except pay the one invoice it
// names, so `typ` is checked on every use.
//
// The link carries no expiry of its own. A bill is not time-limited, and a dead
// "link expired" page on an unpaid invoice just generates a support call; the
// endpoint refuses the token once the invoice is paid, voided or cancelled,
// which is the condition that actually matters.
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { getCompany } = require('../utils/company');
const arrears = require('../utils/arrears');

const router = express.Router();

const TOKEN_TYPE = 'paylink';
const UNPAYABLE = ['paid', 'cancelled', 'void', 'voided'];

// Issued by the admin route that sends the email; exported so nothing else has to
// know the token's shape.
function signPayToken(invoiceId, subscriberId) {
  return jwt.sign(
    { typ: TOKEN_TYPE, iid: Number(invoiceId), sid: Number(subscriberId) },
    process.env.JWT_SECRET
  );
}

function readPayToken(raw) {
  const decoded = jwt.verify(raw, process.env.JWT_SECRET);
  // A portal session token would otherwise sail through here and be treated as a
  // pay link for whatever invoice id the caller appended.
  if (!decoded || decoded.typ !== TOKEN_TYPE) throw new Error('wrong token type');
  if (!decoded.iid || !decoded.sid) throw new Error('incomplete token');
  return decoded;
}

// Resolve token -> invoice, or an error shape the page can render. Errors are
// deliberately vague about WHY a token is bad: the link is emailed, and anyone
// holding one should not learn whether a given invoice id exists.
async function resolveInvoice(prisma, raw) {
  let claims;
  try { claims = readPayToken(raw); }
  catch (e) { return { error: 'This payment link is not valid.', code: 400 }; }

  const invoice = await prisma.invoices.findUnique({
    where: { id: claims.iid },
    include: { subscriber: { include: { plan: true, municipality: true, barangay: true } } },
  });
  if (!invoice || invoice.subscriber_id !== claims.sid) {
    return { error: 'This payment link is not valid.', code: 400 };
  }
  return { invoice };
}

// ── GET /api/paylink/:token — what the page renders ─────────
const readLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

router.get('/:token', readLimiter, async (req, res) => {
  try {
    const r = await resolveInvoice(req.prisma, req.params.token);
    if (r.error) return res.status(r.code).json({ error: r.error });

    const inv = r.invoice;
    const sub = inv.subscriber;
    const co = await getCompany(req.prisma).catch(() => null);
    const settled = UNPAYABLE.includes(String(inv.status || '').toLowerCase());

    res.json({
      invoice: {
        number: inv.invoice_number,
        amount: Number(inv.amount),
        period: inv.billing_period,
        dueDate: inv.due_date,
        status: inv.status,
        description: inv.description || null,
      },
      subscriber: {
        account: sub.account_number,
        firstName: sub.first_name,
        // Surname-first, matching how the CRM and the invoice itself print a name.
        name: [sub.last_name, [sub.first_name, sub.middle_name].filter(Boolean).join(' ')]
          .filter(Boolean).join(', ') || sub.company_name || sub.account_number,
        status: sub.status,
        plan: sub.plan ? sub.plan.name : null,
      },
      settled,
      company: co ? { name: co.name, email: co.email, phone: co.phone } : null,
    });
  } catch (err) {
    console.error('[paylink] read failed:', err.message);
    res.status(500).json({ error: 'Could not load this invoice.' });
  }
});

// ── POST /api/paylink/:token/checkout — mint or reuse a Xendit checkout ──
// Tighter limit than the read: this one can create objects at Xendit.
const payLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false });

router.post('/:token/checkout', payLimiter, async (req, res) => {
  try {
    const r = await resolveInvoice(req.prisma, req.params.token);
    if (r.error) return res.status(r.code).json({ error: r.error });

    const inv = r.invoice;
    const sub = inv.subscriber;

    if (UNPAYABLE.includes(String(inv.status || '').toLowerCase())) {
      return res.status(409).json({ error: 'This invoice has already been settled.', settled: true });
    }

    // Arrears first. A link emailed for September stays valid for weeks, so by the
    // time it is opened an older invoice may have gone overdue — paying this one
    // would take the money and leave the cutoff in place. See src/utils/arrears.js.
    const owed = await arrears.blockingArrears(req.prisma, inv.subscriber_id, inv);
    if (owed) return res.status(409).json(arrears.arrearsResponse(owed));

    const [xenditKey, co] = await Promise.all([
      req.prisma.system_settings.findUnique({ where: { key: 'xendit_secret_key' } })
        .then(x => x?.value || process.env.XENDIT_SECRET_KEY),
      getCompany(req.prisma),
    ]);
    if (!xenditKey) return res.status(503).json({ error: 'Online payment is not available right now.' });

    const auth = 'Basic ' + Buffer.from(xenditKey + ':').toString('base64');

    // ── reuse an open checkout rather than minting a second one ──
    // Every checkout OVERWRITES invoices.xendit_external_id, and the webhook
    // matches on that single column — so a customer who pays an older checkout
    // sends money that reconciles against nothing. With links sitting in inboxes
    // for weeks that stops being an edge case, so an existing PENDING checkout is
    // reused instead of replaced. Xendit expires these after 24h, which bounds
    // how long the reuse can apply.
    if (inv.xendit_invoice_id) {
      try {
        const look = await fetch('https://api.xendit.co/v2/invoices/' + inv.xendit_invoice_id, {
          headers: { Authorization: auth },
        });
        if (look.ok) {
          const existing = await look.json();
          if (existing && existing.status === 'PENDING' && existing.invoice_url) {
            console.log('[paylink] reusing open checkout ' + existing.id + ' for ' + inv.invoice_number);
            return res.json({ url: existing.invoice_url, reused: true });
          }
        }
      } catch (e) {
        // A lookup failure must not block payment; fall through and create a new one.
        console.warn('[paylink] could not check existing checkout: ' + e.message);
      }
    }

    // Customer-visible: Xendit prints external_id on the payment confirmation as
    // "Reference ID". The webhook matches the stored value exactly and falls back to
    // the INV- number inside it, so the prefix is presentation, not routing.
    const externalId = `NF-PAYLINK-${inv.invoice_number}-${Date.now()}`;
    const base = process.env.APP_URL || 'https://netfactory.com.ph';

    const e164 = (phone) => {
      if (!phone) return undefined;
      const d = String(phone).replace(/\D/g, '');
      if (d.startsWith('63') && d.length >= 12) return '+' + d;
      if (d.startsWith('0') && d.length === 11) return '+63' + d.slice(1);
      if (d.length === 10) return '+63' + d;
      return undefined;
    };

    const total = Number(inv.amount);
    const baseAmount = Math.round((total / (1 + co.taxRate)) * 100) / 100;
    const taxAmount = Math.round((total - baseAmount) * 100) / 100;

    const notif = [];
    if (sub.email) notif.push('email');
    if (sub.phone) notif.push('sms');

    const xr = await fetch('https://api.xendit.co/v2/invoices', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        external_id: externalId,
        amount: total,
        currency: 'PHP',
        description: `${sub.account_number} — ${inv.billing_period || inv.invoice_number}`,
        payer_email: sub.email || undefined,
        should_send_email: !!sub.email,
        invoice_duration: 86400,
        locale: 'en',
        reminder_time: 1,
        reminder_time_unit: 'days',
        success_redirect_url: `${base}/pay/?t=${encodeURIComponent(req.params.token)}&payment=success`,
        failure_redirect_url: `${base}/pay/?t=${encodeURIComponent(req.params.token)}&payment=failed`,
        payment_methods: ['CREDIT_CARD', 'GCASH', 'PAYMAYA', 'GRABPAY', 'SHOPEEPAY', 'QRPH', 'DD_BPI', 'DD_UBP', 'DD_RCBC', 'DD_BDO_EPAY', '7ELEVEN', 'CEBUANA', 'DP_MLHUILLIER', 'DP_PALAWAN', 'LBC'],
        customer: {
          given_names: [sub.first_name, sub.middle_name].filter(Boolean).join(' ') || undefined,
          surname: sub.last_name || undefined,
          email: sub.email || undefined,
          mobile_number: e164(sub.phone),
          addresses: [{
            country: 'PH',
            street_line1: sub.address || undefined,
            city: sub.municipality_name || sub.municipality?.name || undefined,
          }],
        },
        customer_notification_preference: notif.length
          ? { invoice_created: notif, invoice_reminder: notif, invoice_paid: notif }
          : undefined,
        items: [{
          name: inv.billing_period || 'Internet Service',
          price: baseAmount,
          quantity: 1,
          reference_id: inv.invoice_number,
          category: 'Internet Service',
        }],
        fees: [{ type: co.taxLabel, value: taxAmount }],
        metadata: {
          invoice_id: inv.id,
          invoice_number: inv.invoice_number,
          subscriber_id: sub.id,
          account_number: sub.account_number,
          source: 'paylink',
        },
      }),
    });

    const xd = await xr.json();
    if (!xr.ok) {
      console.error('[paylink] Xendit rejected checkout for ' + inv.invoice_number + ':', xd);
      return res.status(502).json({ error: 'Could not start the payment. Please try again.' });
    }

    await req.prisma.invoices.update({
      where: { id: inv.id },
      data: { xendit_invoice_id: xd.id, xendit_external_id: externalId },
    });

    req.auditLog('PAYLINK_CHECKOUT', {
      invoice: inv.invoice_number, account: sub.account_number, amount: total, xenditId: xd.id,
    }, { user_id: sub.id, username: sub.account_number }).catch(() => {});

    console.log('[paylink] checkout ' + xd.id + ' created for ' + inv.invoice_number + ' (PHP ' + total + ')');
    res.json({ url: xd.invoice_url, reused: false });
  } catch (err) {
    console.error('[paylink] checkout failed:', err);
    res.status(500).json({ error: 'Could not start the payment. Please try again.' });
  }
});

module.exports = router;
module.exports.signPayToken = signPayToken;
