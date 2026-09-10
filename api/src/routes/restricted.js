// ============================================================
// restricted.js — walled-garden notice + settle-up for a cut-off subscriber
// ============================================================
// Mounted PUBLIC at /api/restricted. There is no token here on purpose: a customer
// who has been cut off is exactly the customer who cannot look up their portal
// password, and a login wall on the walled garden is a wall in front of the payment
// we are trying to collect.
//
// What stands in for authentication is the network itself. The router only redirects
// addresses on its nf-restricted list into this page, and every answer below is keyed
// to the caller's source address resolved through RADIUS accounting to the MAC that
// currently holds it. So the page can only ever describe the line the caller is
// physically sitting on. That is the captive-portal trust model, and it has a real
// edge: anyone on that subscriber's WiFi sees the same page. Hence the deliberately
// thin payload — first name, account number, what is owed. No last name, no address,
// no phone, no invoice history, no device list.
//
// The pay endpoint never accepts an invoice id. It bills whatever that subscriber
// owes, resolved server-side, which is what closes the obvious hole: without it an
// unauthenticated endpoint taking an id is an invoice enumerator.
// ============================================================

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { getCompany } = require('../utils/company');
const mikrotik = require('../utils/mikrotik');
const { getRouterDeviceId } = require('../utils/restriction');

// ── timed payment window ────────────────────────────────────
// A checkout cannot be completed inside a domain allow-list. Card payments redirect to
// 3-D Secure at the cardholder's issuing bank — hundreds of banks, different for every
// customer, unknowable in advance — and each wallet bounces through its own domains and
// CDNs. Chasing that list is a maintenance treadmill that still fails for someone.
//
// So when a customer actually starts a payment, their address is parked in nf-paying,
// which one firewall rule allows out on 443. RouterOS expires the entry itself, so there
// is no cleanup job and nothing left behind if this process dies mid-flight.
//
// The trade is deliberate and bounded: a restricted customer can buy themselves this
// much normal internet per attempt, and /pay is rate-limited to 6 attempts per 15
// minutes. Raise it and you are lowering collection pressure; lower it and you start
// cutting people off mid-checkout, which is worse than not offering it at all.
const PAYMENT_WINDOW_MIN = Number(process.env.PAYMENT_WINDOW_MIN || 20);

async function openPaymentWindow(prisma, ip) {
  const deviceId = await getRouterDeviceId(prisma);
  const lists = await mikrotik.getAddressLists(prisma, deviceId);
  // Drop any entry this address already holds. RouterOS keeps duplicates happily, and a
  // stale one's shorter timeout should not be what decides when the window shuts.
  for (const e of lists.filter(e => e.list === 'nf-paying' && e.address === ip)) {
    await mikrotik.execute(prisma, deviceId, '/ip/firewall/address-list', 'remove', { id: e.id });
  }
  await mikrotik.execute(prisma, deviceId, '/ip/firewall/address-list', 'add', {
    data: { list: 'nf-paying', address: ip, timeout: PAYMENT_WINDOW_MIN + 'm',
            comment: 'nf-garden payment window' },
  });
  return PAYMENT_WINDOW_MIN;
}

// 'partial' is deliberately absent: a partially-paid invoice still has a balance, but
// this flow charges inv.amount in full and would overcharge. Those are rare and get
// handled at the counter. Matches the portal's own definition of unpaid.
const UNPAID = ['pending', 'overdue'];

// Same derivation the audit logger uses. nginx sets X-Forwarded-For and the app runs
// with 'trust proxy', so req.ip alone would be the proxy on the loopback hop.
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();
  const raw = req.ip || (req.socket && req.socket.remoteAddress) || null;
  if (raw && raw.startsWith('::ffff:')) return raw.slice(7);
  return raw;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

// ── who is calling ──────────────────────────────────────────
// Address -> open RADIUS session -> MAC -> subscriber.
//
// Only sessions still open (acctstoptime IS NULL) count. A closed session's address
// has been handed back to the pool and may belong to somebody else by now; matching
// one would show a stranger's balance to whoever inherited the lease. Newest first
// for the case where accounting missed a stop record and left a stale row behind.
async function identify(req) {
  const ip = clientIp(req);
  if (!ip || !IPV4.test(ip)) return { ip, subscriber: null, reason: 'no usable client address' };

  const sessions = await req.prisma.$queryRaw`
    SELECT username
      FROM radacct
     WHERE framedipaddress = ${ip}::inet
       AND acctstoptime IS NULL
     ORDER BY acctstarttime DESC
     LIMIT 1`;
  if (!sessions.length) return { ip, subscriber: null, reason: 'no open session on this address' };

  const mac = sessions[0].username;
  // Raw SQL because hotspot_mac_devices and subscriber_restrictions are not in
  // schema.prisma — the RADIUS-side tables are managed outside it, which is also why
  // restriction.js reaches them through radiusDb rather than the client.
  const devices = await req.prisma.$queryRaw`
    SELECT subscriber_id FROM hotspot_mac_devices WHERE mac = ${mac} LIMIT 1`;
  const device = devices[0];
  if (!device || !device.subscriber_id) return { ip, mac, subscriber: null, reason: 'device not linked to a subscriber' };

  const subscriber = await req.prisma.subscribers.findUnique({
    where: { id: device.subscriber_id },
    include: { plan: true, municipality: true, barangay: true, notification_prefs: true },
  });
  if (!subscriber) return { ip, mac, subscriber: null, reason: 'subscriber not found' };

  return { ip, mac, subscriber };
}

async function openRestriction(prisma, subscriberId) {
  const rows = await prisma.$queryRaw`
    SELECT id, restricted_at, reason, mode, trigger_source
      FROM subscriber_restrictions
     WHERE subscriber_id = ${subscriberId} AND lifted_at IS NULL
     ORDER BY restricted_at DESC
     LIMIT 1`;
  return rows[0] || null;
}

async function unpaidInvoices(prisma, subscriberId) {
  return prisma.invoices.findMany({
    where: { subscriber_id: subscriberId, status: { in: UNPAID } },
    orderBy: { due_date: 'asc' },
  });
}

function publicCompany(co) {
  if (!co) return {};
  return {
    name: co.name || 'Netfactory',
    phone: co.phone || null,
    email: co.email || null,
    website: co.website || null,
  };
}

// ── GET /api/restricted/status ──────────────────────────────
// Answers three different situations, and the page renders a different face for each:
//   identified + restricted  -> the notice, the amount, the pay button
//   identified + not         -> "your line is fine", send them to the portal
//   not identified           -> generic notice only. Never guess: showing an account
//                              we are not sure about is worse than showing none.
const statusLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

router.get('/status', statusLimiter, async (req, res) => {
  try {
    const co = await getCompany(req.prisma).catch(() => null);
    const company = publicCompany(co);

    const { ip, subscriber, reason } = await identify(req);
    if (!subscriber) {
      return res.json({ identified: false, restricted: null, company, seenIp: ip, why: reason });
    }

    const restriction = await openRestriction(req.prisma, subscriber.id);
    if (!restriction) {
      return res.json({ identified: true, restricted: false, account: subscriber.account_number, firstName: subscriber.first_name, company });
    }

    const invoices = await unpaidInvoices(req.prisma, subscriber.id);
    const totalDue = invoices.reduce((s, i) => s + Number(i.amount), 0);
    const today = new Date();

    const xenditKey = await req.prisma.system_settings
      .findUnique({ where: { key: 'xendit_secret_key' } })
      .then(r => (r && r.value) || process.env.XENDIT_SECRET_KEY)
      .catch(() => null);

    res.json({
      identified: true,
      restricted: true,
      account: subscriber.account_number,
      firstName: subscriber.first_name,
      plan: subscriber.plan ? subscriber.plan.name : null,
      restrictedAt: restriction.restricted_at,
      reason: restriction.reason || null,
      mode: restriction.mode,
      invoices: invoices.map(i => ({
        number: i.invoice_number,
        period: i.billing_period,
        dueDate: i.due_date,
        amount: Number(i.amount),
        daysOverdue: Math.max(0, Math.floor((today - new Date(i.due_date)) / 86400000)),
      })),
      totalDue,
      // A pay button that 503s on click is worse than no pay button, so the page is
      // told up front whether online payment is actually wired up.
      canPayOnline: !!xenditKey && totalDue > 0,
      company,
    });
  } catch (err) {
    console.error('[restricted] status failed:', err);
    res.status(500).json({ error: 'Could not load your account status' });
  }
});

// ── POST /api/restricted/pay ────────────────────────────────
// One checkout for everything the caller owes. No request body is read: the amount and
// the invoices come from the database, keyed to the address that called.
//
// external_id keeps the J2-PAYALL- prefix so the existing batch branch of the Xendit
// webhook settles it. Reusing that path rather than adding a second one means walled-
// garden payments post, sync to AR and lift the restriction through exactly the code
// that is already proven in the portal.
const payLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6,
  message: { error: 'Too many payment attempts. Please wait a few minutes and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/pay', payLimiter, async (req, res) => {
  try {
    const { subscriber, ip } = await identify(req);
    if (!subscriber) {
      return res.status(403).json({ error: 'We could not identify this connection. Please sign in to the customer portal to pay.' });
    }

    const restriction = await openRestriction(req.prisma, subscriber.id);
    if (!restriction) {
      return res.status(400).json({ error: 'This connection is not restricted.' });
    }

    const invoices = await unpaidInvoices(req.prisma, subscriber.id);
    if (!invoices.length) {
      return res.status(400).json({ error: 'There is nothing outstanding on this account.' });
    }

    const [xenditKey, co] = await Promise.all([
      req.prisma.system_settings.findUnique({ where: { key: 'xendit_secret_key' } })
        .then(r => (r && r.value) || process.env.XENDIT_SECRET_KEY),
      getCompany(req.prisma),
    ]);
    if (!xenditKey) return res.status(503).json({ error: 'Online payment is not available right now.' });

    const sub = subscriber;
    const plan = sub.plan;
    const totalAmount = invoices.reduce((s, i) => s + Number(i.amount), 0);
    const externalId = `J2-PAYALL-WG-${sub.id}-${Date.now()}`;
    const baseUrl = process.env.APP_URL || 'https://netfactory.com.ph';

    const formatPhone = (phone) => {
      if (!phone) return undefined;
      const digits = phone.replace(/\D/g, '');
      if (digits.startsWith('63') && digits.length >= 12) return '+' + digits;
      if (digits.startsWith('0') && digits.length === 11) return '+63' + digits.slice(1);
      if (digits.length === 10) return '+63' + digits;
      return undefined;
    };

    const customer = {
      given_names: [sub.first_name, sub.middle_name].filter(Boolean).join(' ') || undefined,
      surname: sub.last_name || undefined,
      email: sub.email || undefined,
      mobile_number: formatPhone(sub.phone),
      addresses: [{
        country: 'PH',
        street_line1: sub.address_street1 || sub.address || undefined,
        city: sub.address_city || (sub.municipality && sub.municipality.name) || undefined,
        province: sub.address_state || (sub.municipality && sub.municipality.province) || undefined,
      }],
    };

    const planLabel = plan ? `${plan.name} (${plan.speed_label})` : 'Internet Service';
    const items = invoices.map(inv => {
      const invTotal = Number(inv.amount);
      const invBase = Math.round((invTotal / (1 + co.taxRate)) * 100) / 100;
      return {
        name: inv.billing_period || 'Monthly Subscription',
        price: invBase,
        quantity: 1,
        reference_id: inv.invoice_number,
        category: 'Internet Service',
      };
    });
    const totalTax = Math.round(invoices.reduce((sum, inv) => {
      const invTotal = Number(inv.amount);
      const invBase = Math.round((invTotal / (1 + co.taxRate)) * 100) / 100;
      return sum + (invTotal - invBase);
    }, 0) * 100) / 100;
    const fees = [{ type: co.taxLabel, value: totalTax }];
    const totalOverdue = invoices.reduce((sum, inv) => sum + Number(inv.overdue_fee || 0), 0);
    if (totalOverdue > 0) fees.push({ type: 'Late Payment Fees', value: totalOverdue });

    const notifChannels = [];
    if (sub.email) notifChannels.push('email');
    if (sub.phone) notifChannels.push('sms');

    const xenditResponse = await fetch('https://api.xendit.co/v2/invoices', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(xenditKey + ':').toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        external_id: externalId,
        amount: totalAmount,
        currency: 'PHP',
        description: `${sub.first_name}${sub.middle_name ? ' ' + sub.middle_name : ''} ${sub.last_name} — ${planLabel}`,
        payer_email: sub.email || undefined,
        should_send_email: !!sub.email,
        invoice_duration: 86400,
        locale: 'en',
        reminder_time: 1,
        reminder_time_unit: 'days',
        success_redirect_url: `${baseUrl}/restricted/?payment=success`,
        failure_redirect_url: `${baseUrl}/restricted/?payment=failed`,
        payment_methods: ['CREDIT_CARD', 'GCASH', 'PAYMAYA', 'GRABPAY', 'SHOPEEPAY', 'QRPH', 'DD_BPI', 'DD_UBP', 'DD_RCBC', 'DD_BDO_EPAY', '7ELEVEN', 'CEBUANA', 'DP_MLHUILLIER', 'DP_PALAWAN', 'LBC'],
        customer,
        customer_notification_preference: notifChannels.length ? {
          invoice_created: notifChannels,
          invoice_reminder: notifChannels,
          invoice_paid: notifChannels,
        } : undefined,
        items,
        ...(fees.length > 0 && { fees }),
        metadata: {
          type: 'walled_garden',
          invoice_ids: invoices.map(i => i.id),
          invoice_numbers: invoices.map(i => i.invoice_number),
          subscriber_id: sub.id,
          account_number: sub.account_number,
          restriction_id: restriction.id,
        },
      }),
    });

    const xenditData = await xenditResponse.json();
    if (!xenditResponse.ok) {
      console.error('[restricted] Xendit checkout failed:', xenditData);
      return res.status(502).json({ error: 'Could not start the payment. Please try again.' });
    }

    // Stamp every invoice in the batch with the same external_id — this is what the
    // webhook's batch branch looks them up by, so skipping it would mean a paid
    // checkout that matches nothing and a customer still cut off.
    await req.prisma.invoices.updateMany({
      where: { id: { in: invoices.map(i => i.id) } },
      data: { xendit_invoice_id: xenditData.id, xendit_external_id: externalId },
    });

    if (req.auditLog) {
      req.auditLog('PAYMENT_MADE', {
        account: sub.account_number,
        amount: totalAmount,
        method: 'xendit',
        source: 'walled-garden',
        invoice: invoices.map(i => i.invoice_number).join(', '),
        xenditId: xenditData.id,
      }, { log_source: 'portal', user_id: sub.id, username: sub.account_number }).catch(() => {});
    }

    // Open the window BEFORE handing back the URL, so the checkout is reachable by the
    // time the browser follows it. Best-effort on purpose: if the router is unreachable
    // we still return the link rather than refusing a payment the customer is trying to
    // make. The log line below is the signal that the window did not open.
    let windowMin = null;
    try {
      windowMin = await openPaymentWindow(req.prisma, ip);
    } catch (e) {
      console.error(`[restricted] payment window NOT opened for ${ip}: ${e.message}`);
    }

    console.log(`[restricted] checkout ${xenditData.id} for ${sub.account_number} (P${totalAmount}) from ${ip}` +
      (windowMin ? ` — ${windowMin}m payment window open` : ' — NO payment window'));
    res.json({ checkoutUrl: xenditData.invoice_url, amount: totalAmount, invoiceCount: invoices.length });
  } catch (err) {
    console.error('[restricted] pay failed:', err);
    res.status(500).json({ error: 'Could not start the payment. Please try again.' });
  }
});

module.exports = router;
