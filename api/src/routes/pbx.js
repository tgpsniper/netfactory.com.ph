// ============================================================
// routes/pbx.js — 3CX PBX Integration Routes
// Click-to-call, call logs, extensions, SMS
// ============================================================

const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const { getConfig, getToken, xapiRequest, normalizeFor3cx, invalidateConfig } = require('../utils/threecx');

// ── Middleware: check 3CX enabled ────────────────────────────
async function require3cx(req, res, next) {
  try {
    const cfg = await getConfig(req.prisma);
    if (!cfg.enabled) {
      return res.status(503).json({ error: '3CX integration is not enabled' });
    }
    req.threecxConfig = cfg;
    next();
  } catch (err) {
    res.status(503).json({ error: '3CX not configured: ' + err.message });
  }
}

// ============================================================
// GET /api/admin/pbx/status — Test 3CX connection
// ============================================================
router.get('/status', adminAuth(), require3cx, async (req, res) => {
  try {
    const data = await xapiRequest(req.prisma, 'GET', '/systemStatus');
    res.json({
      connected: true,
      fqdn: req.threecxConfig.fqdn,
      version: data?.Version || data?.version || 'Unknown',
      status: data,
    });
  } catch (err) {
    res.json({
      connected: false,
      fqdn: req.threecxConfig.fqdn,
      error: err.message,
    });
  }
});

// ============================================================
// POST /api/admin/pbx/click-to-call — Initiate call via XAPI
// Body: { phone, subscriberId, subscriberName, extension? }
// Flow: admin extension rings first → picks up → 3CX dials subscriber
// ============================================================
router.post('/click-to-call', adminAuth(), require3cx, async (req, res) => {
  try {
    const { phone, subscriberId, subscriberName, extension } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    const ext = extension || req.threecxConfig.defaultExtension;
    const normalized = normalizeFor3cx(phone);

    // Initiate call via XAPI
    const result = await xapiRequest(req.prisma, 'POST', `/callControl/${ext}/call`, {
      destination: normalized,
    });

    // Log the call initiation
    await req.prisma.call_logs.create({
      data: {
        call_id: result?.callId || `CTC-${Date.now()}`,
        direction: 'outbound',
        caller_number: ext,
        callee_number: normalized,
        subscriber_id: subscriberId ? parseInt(subscriberId) : null,
        subscriber_name: subscriberName || null,
        extension: ext,
        admin_user_id: req.admin?.id || null,
        status: 'initiated',
        started_at: new Date(),
        raw_event: result || {},
      }
    });

    res.json({
      ok: true,
      message: `Call initiated to ${normalized} via ext. ${ext}`,
      extension: ext,
      destination: normalized,
    });
  } catch (err) {
    console.error('[PBX] Click-to-call error:', err.message);
    res.status(500).json({
      error: 'Failed to initiate call',
      detail: err.message,
      fallback: `tel:${req.body.phone}`,
    });
  }
});

// ============================================================
// GET /api/admin/pbx/call-logs — List call logs with filters
// Query: page, limit, direction, status, dateFrom, dateTo, search
// ============================================================
router.get('/call-logs', adminAuth(), async (req, res) => {
  try {
    const { page = 1, limit = 50, direction, status, dateFrom, dateTo, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (direction) where.direction = direction;
    if (status) where.status = status;
    if (dateFrom || dateTo) {
      where.started_at = {};
      if (dateFrom) where.started_at.gte = new Date(dateFrom);
      if (dateTo) where.started_at.lte = new Date(dateTo + 'T23:59:59Z');
    }
    if (search) {
      where.OR = [
        { caller_number: { contains: search } },
        { callee_number: { contains: search } },
        { subscriber_name: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [logs, total] = await Promise.all([
      req.prisma.call_logs.findMany({
        where,
        orderBy: { started_at: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      req.prisma.call_logs.count({ where }),
    ]);

    res.json({ logs, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('[PBX] Call logs error:', err.message);
    res.status(500).json({ error: 'Failed to fetch call logs' });
  }
});

// ============================================================
// GET /api/admin/pbx/call-logs/subscriber/:id — Call history
// ============================================================
router.get('/call-logs/subscriber/:id', adminAuth(), async (req, res) => {
  try {
    const subscriberId = parseInt(req.params.id);
    const logs = await req.prisma.call_logs.findMany({
      where: { subscriber_id: subscriberId },
      orderBy: { started_at: 'desc' },
      take: 100,
    });
    res.json({ logs });
  } catch (err) {
    console.error('[PBX] Subscriber call logs error:', err.message);
    res.status(500).json({ error: 'Failed to fetch call history' });
  }
});

// ============================================================
// GET /api/admin/pbx/extensions — List active 3CX extensions
// ============================================================
router.get('/extensions', adminAuth(), require3cx, async (req, res) => {
  try {
    const data = await xapiRequest(req.prisma, 'GET', '/extensions');
    const extensions = (data?.value || data || []).map(ext => ({
      number: ext.Number || ext.number,
      name: ext.Name || ext.name || '',
      status: ext.CurrentProfile || ext.currentProfile || 'Unknown',
    }));
    res.json({ extensions });
  } catch (err) {
    console.error('[PBX] Extensions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch extensions' });
  }
});

// ============================================================
// POST /api/admin/pbx/sms/send — Send SMS via 3CX XAPI
// Body: { phone, message, subscriberId, subscriberName }
// ============================================================
router.post('/sms/send', adminAuth(), require3cx, async (req, res) => {
  try {
    const { phone, message, subscriberId, subscriberName } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
    if (message.length > 320) return res.status(400).json({ error: 'Message exceeds 320 character limit' });

    const normalized = normalizeFor3cx(phone);
    const ext = req.threecxConfig.defaultExtension;

    // Send SMS via 3CX XAPI
    const result = await xapiRequest(req.prisma, 'POST', `/callControl/${ext}/sendSms`, {
      destination: normalized,
      message,
    });

    // Log the SMS
    await req.prisma.sms_logs.create({
      data: {
        direction: 'outbound',
        phone_number: normalized,
        subscriber_id: subscriberId ? parseInt(subscriberId) : null,
        subscriber_name: subscriberName || null,
        message,
        status: 'sent',
        admin_user_id: req.admin?.id || null,
        sent_via: '3cx',
        raw_response: result || {},
      }
    });

    res.json({ ok: true, message: `SMS sent to ${normalized}` });
  } catch (err) {
    console.error('[PBX] SMS send error:', err.message);

    // Log failed SMS
    if (req.body.phone) {
      await req.prisma.sms_logs.create({
        data: {
          direction: 'outbound',
          phone_number: req.body.phone,
          subscriber_id: req.body.subscriberId ? parseInt(req.body.subscriberId) : null,
          subscriber_name: req.body.subscriberName || null,
          message: req.body.message || '',
          status: 'failed',
          admin_user_id: req.admin?.id || null,
          sent_via: '3cx',
          error_message: err.message,
        }
      }).catch(() => {});
    }

    res.status(500).json({ error: 'Failed to send SMS', detail: err.message });
  }
});

// ============================================================
// GET /api/admin/pbx/sms/logs/subscriber/:id — SMS history
// ============================================================
router.get('/sms/logs/subscriber/:id', adminAuth(), async (req, res) => {
  try {
    const subscriberId = parseInt(req.params.id);
    const logs = await req.prisma.sms_logs.findMany({
      where: { subscriber_id: subscriberId },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    res.json({ logs });
  } catch (err) {
    console.error('[PBX] SMS logs error:', err.message);
    res.status(500).json({ error: 'Failed to fetch SMS history' });
  }
});

module.exports = router;
