// ============================================================
// NETFACTORY — Service Test Routes
// ============================================================
// These routes allow the HTML tester page to send test
// emails and SMS through the backend, avoiding CORS issues
// with third-party APIs (Semaphore, Mailgun).
//
// Mount in server.js:
//   const testRoutes = require('./routes/test');
//   app.use('/api/test', testRoutes);
// ============================================================

const express = require('express');
const router = express.Router();

// ── Simple auth check (same admin creds) ────────────────────
// Protects test routes so random visitors can't send SMS/email
function testAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const base64 = authHeader.split(' ')[1];
  const [user, pass] = Buffer.from(base64, 'base64').toString().split(':');

  // Uses the same admin credentials
  if (user === 'admin' && pass === (process.env.ADMIN_PASSWORD || 'changeme123')) {
    next();
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
}

// ── SMS: Send Test Message ──────────────────────────────────
router.post('/sms/send', testAuth, async (req, res) => {
  try {
    const { number, message } = req.body;

    if (!number || !message) {
      return res.status(400).json({ error: 'number and message are required' });
    }

    const result = await req.config.sms.send(number, message);
    res.json(result);
  } catch (err) {
    console.error('Test SMS error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── SMS: Send Priority Message ──────────────────────────────
router.post('/sms/priority', testAuth, async (req, res) => {
  try {
    const { number, message } = req.body;

    if (!number || !message) {
      return res.status(400).json({ error: 'number and message are required' });
    }

    const result = await req.config.sms.sendPriority(number, message);
    res.json(result);
  } catch (err) {
    console.error('Test priority SMS error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── SMS: Send OTP ───────────────────────────────────────────
router.post('/sms/otp', testAuth, async (req, res) => {
  try {
    const { number, code } = req.body;

    if (!number) {
      return res.status(400).json({ error: 'number is required' });
    }

    const result = await req.config.sms.sendOTP(number, code || undefined);
    res.json(result);
  } catch (err) {
    console.error('Test OTP error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── SMS: Send Template ──────────────────────────────────────
router.post('/sms/template', testAuth, async (req, res) => {
  try {
    const { number, template, data } = req.body;

    if (!number || !template) {
      return res.status(400).json({ error: 'number and template are required' });
    }

    const result = await req.config.sms.sendTemplate(number, template, data || {});
    res.json(result);
  } catch (err) {
    console.error('Test SMS template error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── SMS: Check Credits ──────────────────────────────────────
router.get('/sms/credits', testAuth, async (req, res) => {
  try {
    const result = await req.config.sms.checkCredits();
    res.json(result);
  } catch (err) {
    console.error('Check credits error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── SMS: Get Sender Names ───────────────────────────────────
router.get('/sms/sendernames', testAuth, async (req, res) => {
  try {
    const result = await req.config.sms.getSenderNames();
    res.json(result);
  } catch (err) {
    console.error('Get sender names error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── EMAIL: Send Test ────────────────────────────────────────
router.post('/email/send', testAuth, async (req, res) => {
  try {
    const { to, subject, html, text } = req.body;

    if (!to || !subject) {
      return res.status(400).json({ error: 'to and subject are required' });
    }

    const result = await req.config.email.send({
      to,
      subject,
      html: html || `<p>${text || 'Test email from Netfactory'}</p>`,
      text,
    });
    res.json(result);
  } catch (err) {
    console.error('Test email error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── EMAIL: Send Template ────────────────────────────────────
router.post('/email/template', testAuth, async (req, res) => {
  try {
    const { to, template, data } = req.body;

    if (!to || !template) {
      return res.status(400).json({ error: 'to and template are required' });
    }

    const result = await req.config.email.sendTemplate(to, template, data || {});
    res.json(result);
  } catch (err) {
    console.error('Test email template error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── EMAIL: Verify Connection ────────────────────────────────
router.get('/email/verify', testAuth, async (req, res) => {
  try {
    const result = await req.config.email.verify();
    res.json(result);
  } catch (err) {
    console.error('Email verify error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── STATUS: All services ────────────────────────────────────
router.get('/status', testAuth, async (req, res) => {
  try {
    const dbHealth = await req.config.db.healthCheck();

    res.json({
      database: {
        ok: dbHealth.ok,
        latencyMs: dbHealth.latencyMs,
      },
      email: {
        configured: req.config.email.isConfigured(),
      },
      sms: {
        configured: req.config.sms.isConfigured(),
        senderName: req.config.sms.settings.senderName,
      },
      xendit: {
        configured: !!req.config.payments?.xendit?.secretKey,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── XENDIT: Create ₱1.00 Test Invoice (linked to WEBINQUIRY) ─
router.post('/xendit/test-invoice', testAuth, async (req, res) => {
  try {
    const xenditKey = (await req.prisma.system_settings.findUnique({ where: { key: 'xendit_secret_key' } }))?.value || process.env.XENDIT_SECRET_KEY;
    if (!xenditKey) return res.status(503).json({ ok: false, error: 'Xendit not configured' });

    const subscriber = await req.prisma.subscribers.findFirst({ where: { account_number: 'WEBINQUIRY' } });
    if (!subscriber) return res.status(404).json({ ok: false, error: 'WEBINQUIRY test account not found' });

    const externalId = `NF-TEST-${Date.now()}`;
    const invoice = await req.prisma.invoices.create({
      data: {
        subscriber_id: subscriber.id,
        amount: 1.00,
        status: 'pending',
        invoice_number: `INV-TEST-${Date.now()}`,
        due_date: new Date(Date.now() + 5 * 60 * 1000),
        billing_period: 'Test',
        xendit_external_id: externalId,

      }
    });

    const xenditResponse = await fetch('https://api.xendit.co/v2/invoices', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(xenditKey + ':').toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        external_id: externalId,
        amount: 1.00,
        description: 'Netfactory — Xendit Live Test Payment (₱1.00)',
        currency: 'PHP',
        invoice_duration: 300,
        customer: {
          given_names: `${subscriber.first_name}${subscriber.middle_name ? ' ' + subscriber.middle_name : ''} ${subscriber.last_name}`,
          email: subscriber.email,
          mobile_number: subscriber.phone
        },
        success_redirect_url: 'https://netfactory.com.ph/crm/',
        failure_redirect_url: 'https://netfactory.com.ph/crm/'
      })
    });

    const data = await xenditResponse.json();
    if (!xenditResponse.ok) return res.status(502).json({ ok: false, error: data.message || 'Xendit error', details: data });

    await req.prisma.invoices.update({
      where: { id: invoice.id },
      data: { xendit_invoice_id: data.id }
    });

    res.json({
      ok: true,
      invoiceId: invoice.id,
      externalId,
      xenditInvoiceId: data.id,
      checkoutUrl: data.invoice_url,
      amount: data.amount,
      currency: data.currency,
      expiresAt: data.expiry_date,
      subscriber: `${subscriber.first_name}${subscriber.middle_name ? ' ' + subscriber.middle_name : ''} ${subscriber.last_name} (${subscriber.account_number})`
    });
  } catch (err) {
    console.error('Xendit test invoice error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
