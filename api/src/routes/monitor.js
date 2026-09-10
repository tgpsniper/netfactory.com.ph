// ============================================================
// NETFACTORY NETWORK & DATA SOLUTION — Monitor API Routes
// ============================================================
// GET  /api/admin/monitor/state     — Current monitor state
// GET  /api/admin/monitor/history   — Alert notification history
// POST /api/admin/monitor/test      — Trigger a test alert
// ============================================================

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../../monitor-state.json');

// Auth middleware (reuse from admin routes)
function adminAuth() {
  return (req, res, next) => {
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (!token) return res.status(401).json({ error: 'No token' });
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'j2-secret-key');
      req.user = decoded;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

// ── GET /state — Read current monitor state file ────────────
router.get('/state', adminAuth(), (req, res) => {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return res.json({ state: {}, message: 'Monitor has not run yet.' });
    }
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const state = JSON.parse(raw);
    res.json({ state });
  } catch (err) {
    console.error('Monitor state read error:', err.message);
    res.json({ state: {}, error: 'Failed to read monitor state' });
  }
});

// ── GET /history — Alert notifications from DB ──────────────
router.get('/history', adminAuth(), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const alerts = await req.prisma.notifications.findMany({
      where: {
        OR: [
          { target_type: 'system' },
          { title: { contains: 'Alert' } },
          { title: { contains: 'Recovery' } },
        ]
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    res.json({ alerts });
  } catch (err) {
    console.error('Monitor history error:', err.message);
    res.json({ alerts: [] });
  }
});

// ── POST /test — Send a test alert to verify notifications ──
router.post('/test', adminAuth(), async (req, res) => {
  try {
    // Create CRM notification
    await req.prisma.notifications.create({
      data: {
        type: 'warning',
        title: '🧪 Test Alert — Health Monitor',
        message: `This is a test alert triggered manually by ${req.user.username || 'admin'} to verify the notification system.`,
        target_type: 'system',
        target_id: 0,
        is_read: false,
      }
    });

    // Send test email
    if (req.config?.email?.send) {
      await req.config.email.send({
        to: 'alerts@example.com',
        subject: '🧪 Netfactory — Test Alert',
        html: `
          <div style="max-width:500px;margin:0 auto;font-family:'Segoe UI',sans-serif;text-align:center;padding:40px">
            <div style="display:inline-block;background:linear-gradient(135deg,#0ea5e9,#2563eb);color:#fff;font-weight:800;font-size:18px;padding:8px 14px;border-radius:10px">NF</div>
            <h2 style="margin:16px 0 8px;color:#1e293b">Test Alert ✅</h2>
            <p style="color:#64748b;font-size:14px">The health monitor notification system is working correctly.</p>
            <p style="color:#94a3b8;font-size:12px;margin-top:20px">Triggered by ${req.user.username || 'admin'} at ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}</p>
          </div>
        `,
      });
    }

    // Send test SMS
    if (req.config?.sms?.send) {
      await req.config.sms.send('<ALERT_PHONE>', `NFNET TEST: Health monitor notification test. If you received this, SMS alerts are working. — Netfactory`);
    }

    res.json({ success: true, message: 'Test alert sent via CRM notification, email, and SMS.' });
  } catch (err) {
    console.error('Test alert error:', err);
    res.status(500).json({ error: 'Failed to send test alert: ' + err.message });
  }
});

module.exports = router;
