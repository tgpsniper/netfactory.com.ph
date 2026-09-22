const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const portalAuth = require('../middleware/portalAuth');
const { PORTAL_COOKIE_NAME } = require('../middleware/portalAuth');
const tokenBlacklist = require('../middleware/tokenBlacklist');
const { generateToken: generateCsrfToken, setCsrfCookie } = require('../middleware/csrfProtection');
const { getCompany } = require('../utils/company');
const radiusDb = require('../config/radius-db');

const router = express.Router();
const prepaid = require('../utils/prepaid');
const arrears = require('../utils/arrears');

// Login rate limiter - set high, rely on DB lockout after 6 attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  keyGenerator: (req) => req.body.account || req.ip
});

// ============================================
// POST /api/portal/login
// ============================================
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { account, password } = req.body;

    if (!account || !password) {
      return res.status(400).json({ error: 'Account number and password are required' });
    }

    const subscriber = await req.prisma.subscribers.findUnique({
      where: { account_number: account.toUpperCase().trim() },
      include: { auth: true }
    });

    if (!subscriber || !subscriber.auth) {
      return res.status(401).json({ error: 'Invalid account number or password' });
    }

    const auth = subscriber.auth;

    if (auth.locked_until && auth.locked_until > new Date()) {
      const minutes = Math.ceil((auth.locked_until - new Date()) / 60000);
      const secsLeft = Math.ceil((auth.locked_until - new Date()) / 1000);
      return res.status(423).json({
        error: `Account locked. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}.`,
        lockedSeconds: secsLeft
      });
    }

    const valid = await bcrypt.compare(password, auth.password_hash);

    if (!valid) {
      const attempts = auth.failed_attempts + 1;
      const updateData = { failed_attempts: attempts };

      if (attempts >= 6) {
        updateData.locked_until = new Date(Date.now() + 15 * 60 * 1000);
      }

      await req.prisma.subscriber_auth.update({
        where: { subscriber_id: subscriber.id },
        data: updateData
      });

      req.auditLog('LOGIN_FAILED', { account: account.toUpperCase().trim(), attempts }, { username: account.toUpperCase().trim() }).catch(() => {});

      return res.status(401).json({ error: 'Invalid account number or password' });
    }

    // Blacklist old session token if exists
    if (auth.session_token) {
      tokenBlacklist.add(auth.session_token);
    }

    const token = jwt.sign(
      { id: subscriber.id, account: subscriber.account_number, type: 'subscriber' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    const tokenExpiry = 24 * 60 * 60 * 1000;

    await req.prisma.subscriber_auth.update({
      where: { subscriber_id: subscriber.id },
      data: {
        session_token: token,
        token_expires_at: new Date(Date.now() + tokenExpiry),
        last_login_at: new Date(),
        last_login_ip: req.ip,
        failed_attempts: 0,
        locked_until: null
      }
    });

    await req.prisma.audit_log.create({
      data: {
        user_type: 'subscriber',
        user_id: subscriber.id,
        action: 'portal_login',
        ip_address: req.ip
      }
    });

    // ── New audit trail ──
    req.subscriber = subscriber;
    req.auditLog('LOGIN', { account: subscriber.account_number }, { user_id: subscriber.id, username: subscriber.account_number }).catch(() => {});

    const isProd = process.env.NODE_ENV === 'production';

    res.cookie(PORTAL_COOKIE_NAME, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      maxAge: tokenExpiry,
      path: '/',
    });

    const csrfToken = generateCsrfToken();
    setCsrfCookie(res, csrfToken, isProd);

    res.json({
      token,
      csrfToken,
      subscriber: {
        id: subscriber.id,
        accountNumber: subscriber.account_number,
        firstName: subscriber.first_name,
        lastName: subscriber.last_name,
        email: subscriber.email,
        status: subscriber.status
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================
// POST /api/portal/logout
// ============================================
router.post('/logout', portalAuth, async (req, res) => {
  try {
    const token = req.token;

    if (token) {
      tokenBlacklist.add(token);
    }

    await req.prisma.subscriber_auth.update({
      where: { subscriber_id: req.subscriberId },
      data: { session_token: null, token_expires_at: null }
    });

    await req.prisma.audit_log.create({
      data: {
        user_type: 'subscriber',
        user_id: req.subscriberId,
        action: 'portal_logout',
        ip_address: req.ip
      }
    });

    // ── New audit trail ──
    req.auditLog('LOGOUT', {}).catch(() => {});

    const isProd = process.env.NODE_ENV === 'production';
    res.clearCookie(PORTAL_COOKIE_NAME, { httpOnly: true, secure: isProd, sameSite: 'strict', path: '/' });
    res.clearCookie('j2_csrf', { httpOnly: false, secure: isProd, sameSite: 'strict', path: '/' });

    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('Portal logout error:', err);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ============================================
// POST /api/portal/forgot-password
// ✅ UPDATED: Now sends password reset email + SMS
// ============================================
router.post('/forgot-password', async (req, res) => {
  try {
    const { account, email } = req.body;
    if (!account || !email) {
      return res.status(400).json({ error: 'Account number and email are required' });
    }

    const subscriber = await req.prisma.subscribers.findUnique({
      where: { account_number: account.toUpperCase().trim() },
      include: { auth: true }
    });

    // Always return success (don't reveal if account exists)
    if (!subscriber || subscriber.email !== email.toLowerCase().trim() || !subscriber.auth) {
      return res.json({ message: 'If the account exists, a reset link will be sent to the registered email.' });
    }

    // Generate reset token
    const resetToken = require('crypto').randomBytes(32).toString('hex');
    await req.prisma.subscriber_auth.update({
      where: { subscriber_id: subscriber.id },
      data: {
        reset_token: resetToken,
        reset_expires_at: new Date(Date.now() + 60 * 60 * 1000) // 1 hour
      }
    });

    // ── Send password reset EMAIL ──
    const resetLink = `${process.env.APP_URL || process.env.API_BASE_URL || 'https://netfactory.com.ph'}/portal/reset-password.html?token=${resetToken}`;
    req.config.email.sendTemplateWithPrisma(req.prisma, subscriber.email, 'password_reset', {
      name: subscriber.first_name,
      accountNumber: subscriber.account_number,
      resetUrl: resetLink,
    }).catch(err => console.error('[EMAIL] Password reset send failed:', err.message));

    // ── Send password reset SMS (6-digit code) ──
    if (subscriber.phone) {
      const resetCode = String(Math.floor(100000 + Math.random() * 900000));
      // Store the code alongside the token for SMS-based reset
      await req.prisma.subscriber_auth.update({
        where: { subscriber_id: subscriber.id },
        data: { reset_token: `${resetToken}|${resetCode}` }
      });
      req.config.sms.sendTemplateWithPrisma(req.prisma, subscriber.phone, 'password_reset', {
        code: resetCode,
      }).catch(err => console.error('[SMS] Password reset send failed:', err.message));
    }

    // ── New audit trail ──
    req.auditLog('PASSWORD_CHANGE', { action: 'reset_requested', account: subscriber.account_number }).catch(() => {});

    res.json({ message: 'If the account exists, a reset link will be sent to the registered email.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Request failed' });
  }
});

// ============================================

// ============================================
// POST /api/portal/reset-password
// ============================================
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // Find auth record with matching token (token may have |code appended)
    const auth = await req.prisma.subscriber_auth.findFirst({
      where: { reset_token: { startsWith: token } }
    });

    if (!auth) return res.status(400).json({ error: 'Invalid or expired reset token' });
    if (!auth.reset_expires_at || new Date() > new Date(auth.reset_expires_at)) {
      return res.status(400).json({ error: 'Reset token has expired. Please request a new one.' });
    }

    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 12);

    await req.prisma.subscriber_auth.update({
      where: { id: auth.id },
      data: { password_hash: hash, reset_token: null, reset_expires_at: null }
    });

      // ── New audit trail ──
      req.auditLog('PASSWORD_CHANGE', { method: 'reset_token', authId: auth.id }).catch(() => {});

    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Reset failed' });
  }
});

// All routes below require authentication
// ============================================

// ============================================
// GET /api/portal/dashboard
// ============================================
router.get('/dashboard', portalAuth, async (req, res) => {
  try {
    const sub = req.subscriber;

    // Get unpaid invoices count and total
    const unpaidInvoices = await req.prisma.invoices.findMany({
      where: {
        subscriber_id: sub.id,
        status: { in: ['pending', 'overdue'] }
      },
      orderBy: { due_date: 'asc' }
    });

    const unpaidTotal = unpaidInvoices.reduce((sum, inv) => sum + Number(inv.amount), 0);

    // Get recent invoices (last 5)
    const recentInvoices = await req.prisma.invoices.findMany({
      where: { subscriber_id: sub.id },
      orderBy: { created_at: 'desc' },
      take: 5
    });

    // Get open tickets count
    const openTickets = await req.prisma.tickets.count({
      where: {
        subscriber_id: sub.id,
        status: { in: ['open', 'in_progress'] }
      }
    });

    // Check real connection status from RADIUS (active PPPoE session)
    let connection = { isOnline: false };
    try {
      const [sessions] = await radiusDb.query(
        `SELECT framedipaddress, nasipaddress, acctstarttime, acctsessiontime,
                acctinputoctets, acctoutputoctets
         FROM radacct
         WHERE username = ? AND acctstoptime IS NULL
         ORDER BY acctstarttime DESC LIMIT 1`,
        [sub.account_number]
      );
      if (sessions.length > 0) {
        const s = sessions[0];
        connection = {
          isOnline: true,
          ipAddress: s.framedipaddress,
          nasIp: s.nasipaddress,
          connectedSince: s.acctstarttime,
          sessionTime: Number(s.acctsessiontime) || 0,
          uploadBytes: Number(s.acctinputoctets) || 0,
          downloadBytes: Number(s.acctoutputoctets) || 0,
        };
      }
    } catch (e) {
      console.error('RADIUS connection check error:', e.message);
    }

    res.json({
      subscriber: {
        id: sub.id,
        accountNumber: sub.account_number,
        firstName: sub.first_name,
        middleName: sub.middle_name || null,
        lastName: sub.last_name,
        email: sub.email,
        phone: sub.phone,
        address: sub.address,
        barangay: sub.barangay_name || sub.barangay?.name || null,
        municipality: sub.municipality_name || sub.municipality?.name || null,
        postalCode: sub.postal_code || null,
        status: sub.status,
        balance: Number(sub.balance),
        creditBalance: Number(sub.credit_balance || 0),
        installedAt: sub.installed_at,
        nextBillDate: sub.next_bill_date,
        plan: sub.plan ? {
          name: sub.plan.name,
          speed: sub.plan.speed_label,
          price: Number(sub.plan.price)
        } : null
      },
      connection,
      billing: {
        unpaidCount: unpaidInvoices.length,
        unpaidTotal,
        nextDueDate: unpaidInvoices[0]?.due_date || null,
        recentInvoices: recentInvoices.map(inv => ({
          id: inv.id,
          number: inv.invoice_number,
          amount: Number(inv.amount),
          period: inv.billing_period,
          dueDate: inv.due_date,
          status: inv.status
        }))
      },
      openTickets
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ============================================
// GET /api/portal/invoices
// ============================================
router.get('/invoices', portalAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const status = req.query.status; // optional filter

    const where = { subscriber_id: req.subscriberId };
    if (status && status !== 'all') where.status = status;

    const [invoices, total] = await Promise.all([
      req.prisma.invoices.findMany({
        where,
        include: {
          payments: {
            where: { status: 'success' },
            select: { id: true, amount: true, method: true, paid_at: true, reference_number: true }
          }
        },
        orderBy: { due_date: 'desc' },
        skip: (page - 1) * limit,
        take: limit
      }),
      req.prisma.invoices.count({ where })
    ]);

    res.json({
      invoices: invoices.map(inv => ({
        id: inv.id,
        number: inv.invoice_number,
        amount: Number(inv.amount),
        period: inv.billing_period,
        dueDate: inv.due_date,
        status: inv.status,
        overdueFee: Number(inv.overdue_fee || 0),
        payments: inv.payments.map(p => ({
          amount: Number(p.amount),
          method: p.method,
          paidAt: p.paid_at,
          reference: p.reference_number
        }))
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Invoices error:', err);
    res.status(500).json({ error: 'Failed to load invoices' });
  }
});

// ============================================
// GET /api/portal/usage - 30-day usage data (from RADIUS radacct)
// ============================================
router.get('/usage', portalAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const username = req.subscriber.account_number;

    // Daily usage aggregated from radacct
    const [daily] = await radiusDb.query(
      `SELECT DATE(acctstarttime) AS usage_date,
              COALESCE(SUM(acctoutputoctets), 0) AS download_bytes,
              COALESCE(SUM(acctinputoctets), 0) AS upload_bytes,
              COUNT(*) AS session_count
       FROM radacct
       WHERE username = ?
         AND acctstarttime >= NOW() - INTERVAL '1 day' * ?
       GROUP BY DATE(acctstarttime)
       ORDER BY usage_date ASC`,
      [username, days]
    );

    const GB = 1024 * 1024 * 1024;
    const totalDown = daily.reduce((s, d) => s + Number(d.download_bytes), 0);
    const totalUp = daily.reduce((s, d) => s + Number(d.upload_bytes), 0);
    const daysWithData = daily.length || 1;
    const peakDown = daily.length ? Math.max(...daily.map(d => Number(d.download_bytes))) : 0;

    res.json({
      summary: {
        totalDownload: Math.round((totalDown / GB) * 100) / 100,
        totalUpload: Math.round((totalUp / GB) * 100) / 100,
        avgDailyDownload: Math.round((totalDown / daysWithData / GB) * 100) / 100,
        avgDailyUpload: Math.round((totalUp / daysWithData / GB) * 100) / 100,
        peakDownload: Math.round((peakDown / GB) * 100) / 100,
        days: daily.length
      },
      daily: daily.map(d => ({
        date: d.usage_date,
        download: Math.round((Number(d.download_bytes) / GB) * 1000) / 1000,
        upload: Math.round((Number(d.upload_bytes) / GB) * 1000) / 1000,
        sessions: Number(d.session_count)
      })),
      plan: req.subscriber.plan ? {
        speed: req.subscriber.plan.speed_label,
        dataCap: req.subscriber.plan.data_cap_gb
      } : null
    });
  } catch (err) {
    console.error('Usage error:', err);
    res.status(500).json({ error: 'Failed to load usage data' });
  }
});

// ============================================
// GET /api/portal/plan - Current plan + all plans
// ============================================
router.get('/plan', portalAuth, async (req, res) => {
  try {
    const allPlans = await req.prisma.plans.findMany({
      where: { is_active: true },
      include: {
        features: {
          where: { is_active: true },
          orderBy: { sort_order: 'asc' }
        }
      },
      orderBy: { sort_order: 'asc' }
    });

    res.json({
      currentPlan: req.subscriber.plan ? {
        id: req.subscriber.plan.id,
        name: req.subscriber.plan.name,
        speed: req.subscriber.plan.speed_label,
        price: Number(req.subscriber.plan.price),
        features: req.subscriber.plan.features.map(f => f.feature_text)
      } : null,
      availablePlans: allPlans.map(p => ({
        id: p.id,
        name: p.name,
        speed: p.speed_label,
        price: Number(p.price),
        isPopular: p.is_popular,
        color: p.color_hex,
        features: p.features.map(f => f.feature_text)
      }))
    });
  } catch (err) {
    console.error('Plan error:', err);
    res.status(500).json({ error: 'Failed to load plan info' });
  }
});

// ============================================
// POST /api/portal/plan/change - Request plan change
// ✅ UPDATED: Sends email confirmation
// ============================================
router.post('/plan/change', portalAuth, async (req, res) => {
  try {
    const { planId } = req.body;

    if (!planId) {
      return res.status(400).json({ error: 'Plan ID is required' });
    }

    const newPlan = await req.prisma.plans.findUnique({ where: { id: parseInt(planId) } });
    if (!newPlan || !newPlan.is_active) {
      return res.status(400).json({ error: 'Invalid or inactive plan' });
    }

    if (req.subscriber.plan_id === newPlan.id) {
      return res.status(400).json({ error: 'Already on this plan' });
    }

    // Check for outstanding balance
    if (Number(req.subscriber.balance) > 0) {
      return res.status(400).json({ error: 'Please settle your outstanding balance before changing plans' });
    }

    const oldPlan = req.subscriber.plan;

    // Create a ticket for the plan change request
    const ticketCount = await req.prisma.tickets.count();
    const ticketNumber = `TK-${new Date().getFullYear()}-${String(ticketCount + 1).padStart(4, '0')}`;

    const ticket = await req.prisma.tickets.create({
      data: {
        subscriber_id: req.subscriberId,
        ticket_number: ticketNumber,
        category: 'account',
        priority: 'medium',
        status: 'open',
        subject: `Plan change request: ${oldPlan?.name || 'N/A'} → ${newPlan.name}`,
        description: `Subscriber requested plan change from ${oldPlan?.name} (₱${oldPlan?.price}) to ${newPlan.name} (₱${newPlan.price}).`
      }
    });

    // Add ticket update
    await req.prisma.ticket_updates.create({
      data: {
        ticket_id: ticket.id,
        message: 'Plan change request submitted via Customer Portal',
        created_by: 'System'
      }
    });

    // Audit log
    await req.prisma.audit_log.create({
      data: {
        user_type: 'subscriber',
        user_id: req.subscriberId,
        action: 'plan_change_request',
        entity_type: 'subscribers',
        entity_id: req.subscriberId,
        details: { from: oldPlan?.name, to: newPlan.name, ticket: ticketNumber },
        ip_address: req.ip
      }
    });

      // ── New audit trail ──
      req.auditLog('PLAN_CHANGE', { from: oldPlan?.name, to: newPlan.name, ticket: ticketNumber }).catch(() => {});

    // ── Send plan change confirmation EMAIL ──
    const planCo = await getCompany(req.prisma).catch(() => null);
    const planCoName = planCo?.name || 'Netfactory';

    if (req.subscriber.email) {
      req.config.email.sendWithPrisma(req.prisma, {
        to: req.subscriber.email,
        subject: `Plan Change Request Received — ${ticketNumber}`,
        html: `
          <h2>Plan Change Request Received</h2>
          <p>Hi ${req.subscriber.first_name},</p>
          <p>We've received your request to change your internet plan:</p>
          <table style="border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px 16px;background:#f3f4f6;font-weight:bold;">Current Plan</td><td style="padding:8px 16px;">${oldPlan?.name || 'N/A'} — ₱${Number(oldPlan?.price || 0).toLocaleString()}/mo</td></tr>
            <tr><td style="padding:8px 16px;background:#f3f4f6;font-weight:bold;">Requested Plan</td><td style="padding:8px 16px;">${newPlan.name} — ₱${Number(newPlan.price).toLocaleString()}/mo</td></tr>
            <tr><td style="padding:8px 16px;background:#f3f4f6;font-weight:bold;">Ticket #</td><td style="padding:8px 16px;">${ticketNumber}</td></tr>
          </table>
          <p>Our team will review your request and contact you within 24-48 hours.</p>
          <p>— ${planCoName}</p>
        `,
      }).catch(err => console.error('[EMAIL] Plan change confirmation failed:', err.message));
    }

    // ── Send plan change confirmation SMS ──
    if (req.subscriber.phone) {
      req.config.sms.sendWithPrisma(req.prisma,
        req.subscriber.phone,
        `${planCoName}: Your plan change request (${oldPlan?.name || 'N/A'} to ${newPlan.name}) has been received. Ticket: ${ticketNumber}. We'll contact you within 24-48hrs.`
      ).catch(err => console.error('[SMS] Plan change confirmation failed:', err.message));
    }

    res.json({
      message: 'Plan change request submitted successfully',
      ticketNumber,
      newPlan: { name: newPlan.name, speed: newPlan.speed_label, price: Number(newPlan.price) }
    });
  } catch (err) {
    console.error('Plan change error:', err);
    res.status(500).json({ error: 'Failed to submit plan change request' });
  }
});

// ============================================
// GET /api/portal/tickets - My tickets
// ============================================
router.get('/tickets', portalAuth, async (req, res) => {
  try {
    const status = req.query.status;
    const where = { subscriber_id: req.subscriberId };
    if (status && status !== 'all') where.status = status;

    const tickets = await req.prisma.tickets.findMany({
      where,
      include: {
        updates: {
          where: { is_internal: false }, // Hide internal notes from customer
          orderBy: { created_at: 'asc' }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    res.json({
      tickets: tickets.map(tk => ({
        id: tk.id,
        number: tk.ticket_number,
        category: tk.category,
        priority: tk.priority,
        status: tk.status,
        subject: tk.subject,
        description: tk.description,
        createdAt: tk.created_at,
        resolvedAt: tk.resolved_at,
        updates: tk.updates.map(u => ({
          message: u.message,
          by: u.created_by,
          date: u.created_at
        }))
      }))
    });
  } catch (err) {
    console.error('Tickets error:', err);
    res.status(500).json({ error: 'Failed to load tickets' });
  }
});

// ============================================
// POST /api/portal/tickets - Create new ticket
// ✅ UPDATED: Sends SMS confirmation
// ============================================
router.post('/tickets', portalAuth, async (req, res) => {
  try {
    const { category, priority, subject, description } = req.body;

    if (!category || !subject) {
      return res.status(400).json({ error: 'Category and subject are required' });
    }

    const validCategories = ['connectivity', 'billing', 'speed', 'equipment', 'installation', 'account', 'general', 'disconnect'];
    const validPriorities = ['low', 'medium', 'high', 'critical'];

    if (!validCategories.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const ticketCount = await req.prisma.tickets.count();
    const ticketNumber = `TK-${new Date().getFullYear()}-${String(ticketCount + 1).padStart(4, '0')}`;

    const ticket = await req.prisma.tickets.create({
      data: {
        subscriber_id: req.subscriberId,
        ticket_number: ticketNumber,
        category,
        priority: validPriorities.includes(priority) ? priority : 'medium',
        status: 'open',
        subject: subject.trim(),
        description: description ? description.trim() : null
      }
    });

    // Auto-create first update
    await req.prisma.ticket_updates.create({
      data: {
        ticket_id: ticket.id,
        message: 'Ticket created via Customer Portal',
        created_by: 'System'
      }
    });

    // Create notification for CRM
    await req.prisma.notifications.create({
      data: {
        type: priority === 'critical' ? 'danger' : priority === 'high' ? 'warning' : 'info',
        title: `New ticket: ${subject}`,
        message: `${req.subscriber.first_name}${req.subscriber.middle_name ? ' ' + req.subscriber.middle_name : ''} ${req.subscriber.last_name} (${req.subscriber.account_number}) - ${category}`,
        target_type: 'admin'
      }
    });

      // ── New audit trail ──
      req.auditLog('TICKET_CREATE', { ticket: ticketNumber, category, subject: subject.trim() }).catch(() => {});

    // ── Send ticket confirmation SMS ──
    if (req.subscriber.phone) {
      req.config.sms.sendTemplateWithPrisma(req.prisma, req.subscriber.phone, 'ticket_update', {
        ticketId: ticketNumber,
        status: 'Open — we\'ll get back to you shortly',
      }).catch(err => console.error('[SMS] Ticket confirmation failed:', err.message));
    }

    res.status(201).json({
      message: 'Ticket created successfully',
      ticket: {
        number: ticketNumber,
        category,
        priority: validPriorities.includes(priority) ? priority : 'medium',
        status: 'open'
      }
    });
  } catch (err) {
    console.error('Create ticket error:', err);
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

// ============================================
// GET /api/portal/account - Account details
// (UPDATED v3: fresh query with includes, text column fallbacks)
// ============================================
router.get('/account', portalAuth, async (req, res) => {
  try {
    // Fresh query with all relations included
    const sub = await req.prisma.subscribers.findUnique({
      where: { id: req.subscriberId },
      include: {
        barangay: true,
        municipality: true,
        plan: true
      }
    });

    if (!sub) {
      return res.status(404).json({ error: 'Subscriber not found' });
    }

    const auth = await req.prisma.subscriber_auth.findUnique({
      where: { subscriber_id: sub.id },
      select: { is_2fa_enabled: true, last_login_at: true }
    });

    // Get notification preferences (create defaults if none exist)
    let notifPrefs = await req.prisma.subscriber_notification_prefs.findUnique({
      where: { subscriber_id: sub.id }
    });
    if (!notifPrefs) {
      notifPrefs = await req.prisma.subscriber_notification_prefs.create({
        data: { subscriber_id: sub.id }
      });
    }

    res.json({
      accountNumber: sub.account_number,
      firstName: sub.first_name,
      middleName: sub.middle_name || null,
      lastName: sub.last_name,
      email: sub.email,
      phone: sub.phone,
      address: sub.address,
      // Text columns first, FK relation as fallback
      barangay: sub.barangay_name || sub.barangay?.name || null,
      municipality: sub.municipality_name || sub.municipality?.name || null,
      province: sub.municipality?.province || 'Bataan',
      postalCode: sub.postal_code || null,
      status: sub.status,
      installedAt: sub.installed_at,
      is2faEnabled: auth?.is_2fa_enabled || false,
      lastLogin: auth?.last_login_at || null,
      notificationPrefs: {
        emailBilling: notifPrefs.email_billing,
        smsPayment: notifPrefs.sms_payment,
        outageAlerts: notifPrefs.outage_alerts,
        promos: notifPrefs.promos
      }
    });
  } catch (err) {
    console.error('Account error:', err);
    res.status(500).json({ error: 'Failed to load account' });
  }
});

// ============================================
// PUT /api/portal/account - Update profile
// (UPDATED v3: saves text columns directly, FK lookup as bonus)
// ============================================
router.put('/account', portalAuth, async (req, res) => {
  try {
    const { email, phone, address, barangay, municipality, province, postalCode } = req.body;
    const updateData = {};

    // Identity fields are not editable from the portal.
    //
    // first_name, middle_name, last_name and account_number identify the person on
    // the service contract, on every invoice already issued against it, and — via
    // the account number — the RADIUS username the session authenticates with. A
    // subscriber able to rewrite them could quietly re-point a billing history at a
    // different name, and there is no second record to reconcile against afterwards.
    // Changing them is a staff action in the CRM, where it is attributable to an
    // operator.
    //
    // Ignored rather than refused with a 400: a cached copy of the portal still
    // posts these on every save, and failing the whole request would stop
    // subscribers updating the address and phone number they ARE allowed to change.
    // The attempt is recorded instead, so a crafted request is visible rather than
    // merely dropped.
    // Map each rejected input name to the column it would have written, so an
    // unchanged value echoed back by the form can be told apart from a real attempt
    // to change one. Without that comparison every ordinary save would flag itself,
    // the audit entry would mean nothing, and a genuine tamper would be buried in
    // the noise it created.
    const LOCKED = {
      firstName: 'first_name',   first_name: 'first_name',
      middleName: 'middle_name', middle_name: 'middle_name',
      lastName: 'last_name',     last_name: 'last_name',
      accountNumber: 'account_number', account_number: 'account_number',
    };
    const supplied = Object.keys(LOCKED).filter(k => req.body[k] !== undefined);
    let attemptedLocked = [];
    if (supplied.length) {
      const current = await req.prisma.subscribers.findUnique({
        where: { id: req.subscriberId },
        select: { first_name: true, middle_name: true, last_name: true, account_number: true }
      });
      const norm = v => (v === null || v === undefined) ? '' : String(v).trim();
      attemptedLocked = supplied.filter(
        k => norm(req.body[k]) !== norm(current && current[LOCKED[k]]));
    }

    if (email) {
      const existing = await req.prisma.subscribers.findFirst({
        where: { email: email.toLowerCase().trim(), id: { not: req.subscriberId } }
      });
      if (existing) {
        return res.status(409).json({ error: 'Email already in use' });
      }
      updateData.email = email.toLowerCase().trim();
    }

    if (phone) updateData.phone = phone.trim();
    if (address !== undefined) updateData.address = address.trim();
    if (postalCode !== undefined) updateData.postal_code = postalCode.trim();

    // Always save municipality/barangay as text (guaranteed persistence)
    if (municipality) {
      updateData.municipality_name = municipality.trim();
      // Also try FK lookup (best-effort)
      try {
        const muni = await req.prisma.municipalities.findFirst({
          where: { name: { equals: municipality.trim(), mode: 'insensitive' } }
        });
        if (muni) updateData.municipality_id = muni.id;
      } catch (e) { /* FK lookup failed, text column still saved */ }
    }

    if (barangay) {
      updateData.barangay_name = barangay.trim();
      // Also try FK lookup (best-effort)
      try {
        const brgy = await req.prisma.barangays.findFirst({
          where: { name: { equals: barangay.trim(), mode: 'insensitive' } }
        });
        if (brgy) updateData.barangay_id = brgy.id;
      } catch (e) { /* FK lookup failed, text column still saved */ }
    }

    if (Object.keys(updateData).length === 0) {
      // Someone who edited only their name would otherwise be told "No fields to
      // update", which reads like a bug rather than a rule and invites a support
      // call. Name the actual reason instead.
      if (attemptedLocked.length) {
        return res.status(403).json({
          error: 'Your name and account number cannot be changed here. ' +
                 'Please contact support to correct them.'
        });
      }
      return res.status(400).json({ error: 'No fields to update' });
    }

    // Add updated_at timestamp
    updateData.updated_at = new Date();

    await req.prisma.subscribers.update({
      where: { id: req.subscriberId },
      data: updateData
    });

    // Audit log
    await req.prisma.audit_log.create({
      data: {
        user_type: 'subscriber',
        user_id: req.subscriberId,
        action: 'profile_updated',
        entity_type: 'subscribers',
        entity_id: req.subscriberId,
        details: {
          fields: Object.keys(updateData),
          ...(attemptedLocked.length ? { rejectedLockedFields: attemptedLocked } : {})
        },
        ip_address: req.ip
      }
    });

      // ── New audit trail ──
      req.auditLog('ACCOUNT_UPDATE', {
          fields: Object.keys(updateData),
          ...(attemptedLocked.length ? { rejectedLockedFields: attemptedLocked } : {})
        }).catch(() => {});

    res.json({ message: 'Profile updated successfully' });
  } catch (err) {
    console.error('Update account error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ============================================
// POST /api/portal/change-password
// ============================================
router.post('/change-password', portalAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new passwords are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const auth = await req.prisma.subscriber_auth.findUnique({
      where: { subscriber_id: req.subscriberId }
    });

    const valid = await bcrypt.compare(currentPassword, auth.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await req.prisma.subscriber_auth.update({
      where: { subscriber_id: req.subscriberId },
      data: { password_hash: hash }
    });

    await req.prisma.audit_log.create({
      data: {
        user_type: 'subscriber',
        user_id: req.subscriberId,
        action: 'password_changed',
        ip_address: req.ip
      }
    });

    // ── New audit trail ──
    req.auditLog('PASSWORD_CHANGE', { method: 'self_service' }).catch(() => {});

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ============================================
// POST /api/portal/2fa/setup
// Generate a proper Base32 TOTP secret and store it (pending verification)
// ============================================
router.post('/2fa/setup', portalAuth, async (req, res) => {
  try {
    const { generateSecret } = require('../utils/totp');
    const secret = generateSecret(); // e.g. "JBSWY3DPEBLW64TMMQ2CFQIASF3A6YJT"

    await req.prisma.subscriber_auth.update({
      where: { subscriber_id: req.subscriberId },
      data: { two_fa_secret: secret, is_2fa_enabled: false }
    });

    res.json({ secret });
  } catch (err) {
    console.error('2FA setup error:', err);
    res.status(500).json({ error: 'Failed to set up 2FA' });
  }
});

// ============================================
// POST /api/portal/2fa/verify
// Verify the TOTP code from the authenticator app and enable 2FA
// ============================================
router.post('/2fa/verify', portalAuth, async (req, res) => {
  try {
    const { code } = req.body;
    const { verifyToken } = require('../utils/totp');

    if (!code || !/^\d{6}$/.test(String(code))) {
      return res.status(400).json({ error: 'Please enter a 6-digit code' });
    }

    const auth = await req.prisma.subscriber_auth.findUnique({
      where: { subscriber_id: req.subscriberId }
    });

    if (!auth?.two_fa_secret) {
      return res.status(400).json({ error: 'Please complete 2FA setup first' });
    }

    if (!verifyToken(auth.two_fa_secret, code)) {
      return res.status(400).json({ error: 'Invalid code — please check your authenticator app and try again' });
    }

    await req.prisma.subscriber_auth.update({
      where: { subscriber_id: req.subscriberId },
      data: { is_2fa_enabled: true }
    });

    req.auditLog('ACCOUNT_UPDATE', { action: '2fa_enabled' }).catch(() => {});

    res.json({ message: 'Two-factor authentication enabled successfully' });
  } catch (err) {
    console.error('2FA verify error:', err);
    res.status(500).json({ error: 'Failed to verify 2FA code' });
  }
});

// ============================================
// POST /api/portal/2fa/disable
// Confirm with current TOTP code then disable 2FA
// ============================================
router.post('/2fa/disable', portalAuth, async (req, res) => {
  try {
    const { code } = req.body;
    const { verifyToken } = require('../utils/totp');

    if (!code || !/^\d{6}$/.test(String(code))) {
      return res.status(400).json({ error: 'Please enter the 6-digit code from your authenticator app' });
    }

    const auth = await req.prisma.subscriber_auth.findUnique({
      where: { subscriber_id: req.subscriberId }
    });

    if (!auth?.is_2fa_enabled) {
      return res.status(400).json({ error: '2FA is not currently enabled' });
    }

    if (!verifyToken(auth.two_fa_secret, code)) {
      return res.status(400).json({ error: 'Invalid code — enter your current authenticator code to confirm' });
    }

    await req.prisma.subscriber_auth.update({
      where: { subscriber_id: req.subscriberId },
      data: { is_2fa_enabled: false, two_fa_secret: null }
    });

    req.auditLog('ACCOUNT_UPDATE', { action: '2fa_disabled' }).catch(() => {});

    res.json({ message: 'Two-factor authentication disabled' });
  } catch (err) {
    console.error('2FA disable error:', err);
    res.status(500).json({ error: 'Failed to disable 2FA' });
  }
});

// ============================================
// PUT /api/portal/notifications/preferences
// Update notification preferences
// ============================================
router.put('/notifications/preferences', portalAuth, async (req, res) => {
  try {
    const { emailBilling, smsPayment, outageAlerts, promos } = req.body;

    const data = {};
    if (emailBilling !== undefined) data.email_billing = !!emailBilling;
    if (smsPayment !== undefined) data.sms_payment = !!smsPayment;
    if (outageAlerts !== undefined) data.outage_alerts = !!outageAlerts;
    if (promos !== undefined) data.promos = !!promos;

    await req.prisma.subscriber_notification_prefs.upsert({
      where: { subscriber_id: req.subscriberId },
      update: data,
      create: { subscriber_id: req.subscriberId, ...data }
    });

      // ── New audit trail ──
      req.auditLog('ACCOUNT_UPDATE', { action: 'notification_prefs', prefs: Object.keys(data) }).catch(() => {});

    res.json({ message: 'Notification preferences updated' });
  } catch (err) {
    console.error('Notification prefs error:', err);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// ============================================
// POST /api/portal/disconnect
// Request service disconnection (creates a ticket)
// ✅ UPDATED: Sends email/SMS confirmation
// ============================================
router.post('/disconnect', portalAuth, async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Please provide a reason for disconnection' });
    }

    const reasonLabels = {
      relocating: 'Relocating / Moving out',
      switching: 'Switching to another provider',
      cost: 'Cost / Financial reasons',
      service: 'Unsatisfied with service quality',
      temporary: 'Temporary — plan to reconnect later',
      other: 'Other'
    };

    // Generate ticket number (default)
    //   const seq = await req.prisma.$queryRaw`SELECT nextval('ticket_number_seq') as num`;
    //  const ticketNumber = `TK-${new Date().getFullYear()}-${String(seq[0].num).padStart(4, '0')}`;


// Generate ticket number 02/12/2026
    const ticketCount = await req.prisma.tickets.count();
    const ticketNumber = `TK-${new Date().getFullYear()}-${String(ticketCount + 1).padStart(4, '0')}`;

    const ticket = await req.prisma.tickets.create({
      data: {
        subscriber_id: req.subscriberId,
        ticket_number: ticketNumber,
        category: 'disconnect',
        priority: 'medium',
        status: 'open',
        subject: `Disconnection Request — ${reasonLabels[reason] || reason}`,
        description: `Subscriber has requested service disconnection.\nReason: ${reasonLabels[reason] || reason}\n\nThis request requires admin review and approval before processing.`
      }
    });

    // Add first update
    await req.prisma.ticket_updates.create({
      data: {
        ticket_id: ticket.id,
        message: 'Disconnection request submitted by subscriber via customer portal.',
        created_by: `${req.subscriber.first_name}${req.subscriber.middle_name ? ' ' + req.subscriber.middle_name : ''} ${req.subscriber.last_name}`
      }
    });

    // Create notification for admin
    await req.prisma.notifications.create({
      data: {
        type: 'warning',
        title: `Disconnection request: ${req.subscriber.first_name}${req.subscriber.middle_name ? ' ' + req.subscriber.middle_name : ''} ${req.subscriber.last_name}`,
        message: `${req.subscriber.account_number} — Reason: ${reasonLabels[reason] || reason}`,
        target_type: 'admin'
      }
    });

    // Audit log
    await req.prisma.audit_log.create({
      data: {
        user_type: 'subscriber',
        user_id: req.subscriberId,
        action: 'disconnect_requested',
        entity_type: 'tickets',
        entity_id: ticket.id,
        details: { reason, ticketNumber },
        ip_address: req.ip
      }
    });

      // ── New audit trail ──
      req.auditLog('ACCOUNT_UPDATE', { action: 'disconnect_requested', reason, ticket: ticketNumber }).catch(() => {});

    // ── Send disconnection confirmation EMAIL ──
    const discCo = await getCompany(req.prisma).catch(() => null);
    const discCoName = discCo?.name || 'Netfactory';

    if (req.subscriber.email) {
      req.config.email.sendWithPrisma(req.prisma, {
        to: req.subscriber.email,
        subject: `Disconnection Request Received — ${ticketNumber}`,
        html: `
          <h2>Disconnection Request Received</h2>
          <p>Hi ${req.subscriber.first_name},</p>
          <p>We've received your request to disconnect your ${discCoName} service.</p>
          <table style="border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px 16px;background:#f3f4f6;font-weight:bold;">Account</td><td style="padding:8px 16px;">${req.subscriber.account_number}</td></tr>
            <tr><td style="padding:8px 16px;background:#f3f4f6;font-weight:bold;">Reason</td><td style="padding:8px 16px;">${reasonLabels[reason] || reason}</td></tr>
            <tr><td style="padding:8px 16px;background:#f3f4f6;font-weight:bold;">Ticket #</td><td style="padding:8px 16px;">${ticketNumber}</td></tr>
          </table>
          <p>Our team will review your request. If you have any outstanding balance, it must be settled before disconnection can be processed.</p>
          <p>If you change your mind, you can cancel this request by contacting our support team.</p>
          <p>— ${discCoName}</p>
        `,
      }).catch(err => console.error('[EMAIL] Disconnect confirmation failed:', err.message));
    }

    // ── Send disconnection confirmation SMS ──
    if (req.subscriber.phone) {
      req.config.sms.sendWithPrisma(req.prisma,
        req.subscriber.phone,
        `${discCoName}: Your disconnection request has been received. Ticket: ${ticketNumber}. Our team will review and contact you within 24-48hrs.`
      ).catch(err => console.error('[SMS] Disconnect confirmation failed:', err.message));
    }

    res.json({
      message: 'Disconnection request submitted',
      ticketNumber
    });
  } catch (err) {
    console.error('Disconnect request error:', err);
    res.status(500).json({ error: 'Failed to submit disconnection request' });
  }
});



// ============================================================
// XENDIT PAYMENT — Create checkout invoice for subscriber
// POST /api/portal/invoices/:id/pay
// ============================================================
router.post('/invoices/:id/pay', portalAuth, async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);
    const { method } = req.body; // "xendit", "gcash", "maya", etc.

    // Find the invoice with full subscriber + plan + address details
    const invoice = await req.prisma.invoices.findUnique({
      where: { id: invoiceId },
      include: {
        subscriber: {
          include: {
            plan: true,
            municipality: true,
            barangay: true,
            notification_prefs: true
          }
        }
      }
    });

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    if (invoice.subscriber_id !== req.subscriber.id) {
      return res.status(403).json({ error: 'Not authorized to pay this invoice' });
    }

    if (invoice.status === 'paid') {
      return res.status(400).json({ error: 'Invoice is already paid' });
    }

    // Arrears first: paying this month while last month is overdue takes the money
    // and leaves the cutoff in place, because restoreIfSettled looks at the whole
    // balance. See src/utils/arrears.js.
    const owed = await arrears.blockingArrears(req.prisma, req.subscriber.id, invoice);
    if (owed) return res.status(409).json(arrears.arrearsResponse(owed));

    // Only Xendit is supported for online payment right now
    if (method !== 'xendit') {
      return res.status(400).json({ error: 'Only Xendit payments are supported online. For other methods, please visit our office or contact support.' });
    }

    const [xenditKey, co] = await Promise.all([
      req.prisma.system_settings.findUnique({ where: { key: 'xendit_secret_key' } }).then(r => r?.value || process.env.XENDIT_SECRET_KEY),
      getCompany(req.prisma)
    ]);
    if (!xenditKey) {
      return res.status(503).json({ error: 'Payment service not configured' });
    }

    const sub = invoice.subscriber;
    const plan = sub.plan;
    const externalId = `NF-PAY-${invoice.invoice_number}-${Date.now()}`;
    const portalUrl = (process.env.APP_URL || 'https://netfactory.com.ph') + '/portal';

    // Format phone to E.164 (+63...)
    const formatPhone = (phone) => {
      if (!phone) return undefined;
      const digits = phone.replace(/\D/g, '');
      if (digits.startsWith('63') && digits.length >= 12) return '+' + digits;
      if (digits.startsWith('0') && digits.length === 11) return '+63' + digits.slice(1);
      if (digits.length === 10) return '+63' + digits;
      return undefined;
    };

    // Build customer object from subscriber data
    const customer = {
      given_names: [sub.first_name, sub.middle_name].filter(Boolean).join(' ') || undefined,
      surname: sub.last_name || undefined,
      email: sub.email || undefined,
      mobile_number: formatPhone(sub.phone),
      addresses: [{
        country: 'PH',
        street_line1: sub.address_street1 || sub.address || undefined,
        street_line2: sub.address_street2 || undefined,
        city: sub.address_city || sub.municipality_name || sub.municipality?.name || undefined,
        province: sub.address_state || sub.municipality?.province || undefined,
        postal_code: sub.address_postal_code || sub.postal_code || sub.municipality?.postal_code || undefined
      }]
    };

    // Build line items — show pre-tax base price on the item
    const planLabel = plan ? `${plan.name} (${plan.speed_label})` : 'Internet Service';
    const total = Number(invoice.amount);
    const baseAmount = Math.round((total / (1 + co.taxRate)) * 100) / 100;
    const taxAmount  = Math.round((total - baseAmount) * 100) / 100;
    const items = [{
      name: invoice.billing_period || 'Monthly Subscription',
      price: baseAmount,
      quantity: 1,
      reference_id: invoice.invoice_number,
      category: 'Internet Service'
    }];

    // Tax + optional overdue fee
    const fees = [{ type: co.taxLabel, value: taxAmount }];
    if (Number(invoice.overdue_fee) > 0) {
      fees.push({ type: 'Late Payment Fee', value: Number(invoice.overdue_fee) });
    }

    // Notification channels based on available subscriber contact info
    const notifChannels = [];
    if (sub.email) notifChannels.push('email');
    if (sub.phone) notifChannels.push('sms');
    const customer_notification_preference = notifChannels.length > 0 ? {
      invoice_created: notifChannels,
      invoice_reminder: notifChannels,
      invoice_paid: notifChannels
    } : undefined;

    const description = `${sub.first_name}${sub.middle_name ? ' ' + sub.middle_name : ''} ${sub.last_name} — ${planLabel}`;

    // Create Xendit invoice
    const xenditResponse = await fetch('https://api.xendit.co/v2/invoices', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(xenditKey + ':').toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        external_id: externalId,
        amount: Number(invoice.amount),
        currency: 'PHP',
        description,
        payer_email: sub.email || undefined,
        should_send_email: !!sub.email,
        invoice_duration: 86400, // 24 hours
        locale: 'en',
        reminder_time: 1,
        reminder_time_unit: 'days',
        success_redirect_url: `${portalUrl}/?payment=success&invoice=${invoice.invoice_number}&token=${req.token}`,
        failure_redirect_url: `${portalUrl}/?payment=failed&invoice=${invoice.invoice_number}`,
        payment_methods: ['CREDIT_CARD', 'GCASH', 'PAYMAYA', 'GRABPAY', 'SHOPEEPAY', 'QRPH', 'DD_BPI', 'DD_UBP', 'DD_RCBC', 'DD_BDO_EPAY', '7ELEVEN', 'CEBUANA', 'DP_MLHUILLIER', 'DP_PALAWAN', 'LBC'],
        customer,
        customer_notification_preference,
        items,
        ...(fees.length > 0 && { fees }),
        metadata: {
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number,
          subscriber_id: sub.id,
          account_number: sub.account_number
        }
      })
    });

    const xenditData = await xenditResponse.json();

    if (!xenditResponse.ok) {
      console.error('Xendit invoice creation failed:', xenditData);
      return res.status(502).json({ error: 'Failed to create payment invoice', details: xenditData.message || 'Unknown error' });
    }

    // Store the Xendit invoice ID on our invoice for tracking
    await req.prisma.invoices.update({
      where: { id: invoiceId },
      data: {
        xendit_invoice_id: xenditData.id,
        xendit_external_id: externalId
      }
    });

    // Audit log
    await req.prisma.audit_log.create({
      data: {
        user_type: 'subscriber',
        action: 'payment_initiated',
        entity_type: 'invoice',
        entity_id: invoiceId,
        details: `Xendit checkout created: ${xenditData.id} for ${invoice.invoice_number} (₱${invoice.amount})`,
        user_id: sub.id,
      }
    }).catch(() => {});

      // ── New audit trail ──
      req.auditLog('PAYMENT_MADE', { invoice: invoice.invoice_number, amount: Number(invoice.amount), method: 'xendit', xenditId: xenditData.id }).catch(() => {});

    console.log(`💳 Xendit checkout created for ${invoice.invoice_number}: ${xenditData.invoice_url}`);

    res.json({
      checkoutUrl: xenditData.invoice_url,
      xenditInvoiceId: xenditData.id,
      externalId: externalId,
      amount: Number(invoice.amount),
      expiresAt: xenditData.expiry_date
    });

  } catch (err) {
    console.error('Payment initiation error:', err);
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

// GET /api/portal/invoices/:id/payment-status
// Check if a Xendit payment has been completed
router.get('/invoices/:id/payment-status', portalAuth, async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);
    const invoice = await req.prisma.invoices.findUnique({
      where: { id: invoiceId },
      include: { payments: { orderBy: { paid_at: 'desc' }, take: 1 } }
    });

    if (!invoice || invoice.subscriber_id !== req.subscriber.id) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    res.json({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      status: invoice.status,
      amount: Number(invoice.amount),
      paidAt: invoice.payments[0]?.paid_at || null,
      method: invoice.payments[0]?.method || null,
      reference: invoice.payments[0]?.reference || null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});


// ============================================
// GET /api/portal/credits — Subscriber credit history
// ============================================
// ============================================================
// PREPAID — self-service renewal
// ============================================================
// Deliberately two calls rather than one: this mints the invoice, and the client then
// sends it through the existing POST /invoices/:id/pay checkout. There is exactly one
// place in this file that talks to Xendit and it stays that way — a second copy would
// drift, and the copy that drifts is always the one handling money.

// GET /api/portal/prepaid — standing + what renewal costs
router.get('/prepaid', portalAuth, async (req, res) => {
  try {
    const status = await prepaid.getStatus(req.prisma, req.subscriber.id);
    if (!status) return res.status(404).json({ error: 'Account not found' });
    if (!status.prepaid) return res.json({ prepaid: false });

    const pending = await req.prisma.invoices.findFirst({
      where: { subscriber_id: req.subscriber.id, status: { in: ['pending', 'partial'] },
               prepaid_days: { not: null } },
      orderBy: { id: 'desc' },
    });
    const recent = await req.prisma.prepaid_topups.findMany({
      where: { subscriber_id: req.subscriber.id },
      orderBy: { created_at: 'desc' }, take: 6,
    });

    res.json({
      prepaid: true,
      planName: status.planName,
      expiresAt: status.expiresAt,
      expired: status.expired,
      daysRemaining: status.daysRemaining,
      renewAmount: status.price,
      renewDays: status.validityDays,
      // Offered as whole multiples of the plan period — the same rule the counter and
      // the walled garden use, so a customer cannot construct an amount that buys
      // nothing and then wonder where their money went.
      options: [1, 2, 3, 6].map(n => ({
        periods: n,
        days: n * status.validityDays,
        amount: Number((status.price * n).toFixed(2)),
      })),
      pendingInvoice: pending ? {
        id: pending.id, number: pending.invoice_number,
        amount: Number(pending.amount), days: pending.prepaid_days,
      } : null,
      history: recent.map(t => ({
        amount: Number(t.amount), days: t.days,
        expiresAfter: t.expires_after, source: t.source, createdAt: t.created_at,
      })),
    });
  } catch (err) {
    console.error('[portal] prepaid status:', err);
    res.status(500).json({ error: 'Could not load your prepaid status' });
  }
});

// POST /api/portal/prepaid/topup — mint the renewal invoice
router.post('/prepaid/topup', portalAuth, async (req, res) => {
  try {
    const status = await prepaid.getStatus(req.prisma, req.subscriber.id);
    if (!status) return res.status(404).json({ error: 'Account not found' });
    if (!status.prepaid) return res.status(400).json({ error: 'This account is not on a prepaid plan' });

    // Reuse an unpaid renewal rather than stacking up abandoned invoices.
    const existing = await req.prisma.invoices.findFirst({
      where: { subscriber_id: req.subscriber.id, status: { in: ['pending', 'partial'] },
               prepaid_days: { not: null } },
      orderBy: { id: 'desc' },
    });
    if (existing) {
      return res.json({ success: true, reused: true, invoiceId: existing.id,
        invoiceNumber: existing.invoice_number, amount: Number(existing.amount),
        days: existing.prepaid_days });
    }

    const periods = Math.min(Math.max(parseInt(req.body.periods) || 1, 1), 12);
    const invoice = await prepaid.createTopUpInvoice(req.prisma, {
      subscriberId: req.subscriber.id,
      days: periods * status.validityDays,
      by: 'portal',
    });
    res.status(201).json({ success: true, reused: false, invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number, amount: Number(invoice.amount),
      days: invoice.prepaid_days });
  } catch (err) {
    console.error('[portal] prepaid topup:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/credits', portalAuth, async (req, res) => {
  try {
    const sub = req.subscriber;
    const credits = await req.prisma.subscriber_credits.findMany({
      where: { subscriber_id: sub.id },
      orderBy: { created_at: 'desc' },
      take: 50
    });
    res.json({
      creditBalance: Number(sub.credit_balance || 0),
      history: credits.map(c => ({
        id: c.id,
        type: c.type,
        amount: Number(c.amount),
        runningBalance: Number(c.running_balance),
        notes: c.notes,
        createdAt: c.created_at
      }))
    });
  } catch (err) {
    console.error('Portal credits error:', err);
    res.status(500).json({ error: 'Failed to load credits' });
  }
});

// ============================================
// GET /api/portal/referrals — List my referrals
// ============================================
router.get('/referrals', portalAuth, async (req, res) => {
  try {
    const referrals = await req.prisma.referrals.findMany({
      where: { referrer_id: req.subscriberId },
      include: {
        referee: {
          select: { id: true, first_name: true, middle_name: true, last_name: true, phone: true, email: true, status: true, account_number: true }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    res.json({
      referrals: referrals.map(r => ({
        id: r.id,
        referee: r.referee ? {
          name: `${r.referee.first_name}${r.referee.middle_name ? ' ' + r.referee.middle_name : ''} ${r.referee.last_name}`,
          phone: r.referee.phone,
          email: r.referee.email,
          status: r.referee.status,
          accountNumber: r.referee.account_number
        } : null,
        status: new Date() > new Date(r.expires_at) && r.status === 'pending' ? 'expired' : r.status,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        convertedAt: r.converted_at
      }))
    });
  } catch (err) {
    console.error('Portal referrals list error:', err);
    res.status(500).json({ error: 'Failed to load referrals' });
  }
});

// ============================================
// POST /api/portal/referrals — Submit a referral
// ============================================
router.post('/referrals', portalAuth, async (req, res) => {
  try {
    const { firstName, middleName, lastName, email, contactNumber } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !contactNumber) {
      return res.status(400).json({ error: 'First name, last name, and contact number are required' });
    }

    // Check if email already exists in subscribers
    if (email) {
      const emailExists = await req.prisma.subscribers.findFirst({ where: { email: email.toLowerCase().trim() } });
      if (emailExists) {
        return res.status(409).json({ error: 'A subscriber with this email address already exists' });
      }
    }

    // Check if contact number already exists in subscribers
    const cleanPhone = contactNumber.replace(/\D/g, '');
    const phoneExists = await req.prisma.subscribers.findFirst({ where: { phone: cleanPhone } });
    if (phoneExists) {
      return res.status(409).json({ error: 'A subscriber with this contact number already exists' });
    }

    const referrer = req.subscriber;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000); // 60 days

    // Create prospective subscriber and referral in a transaction
    const result = await req.prisma.$transaction(async (tx) => {
      // Create prospective subscriber
      const newSub = await tx.subscribers.create({
        data: {
          account_number: '', // Auto-generated by DB trigger (unique YYMM###### like web applications)
          first_name: firstName.trim(),
          middle_name: middleName ? middleName.trim() : null,
          last_name: lastName.trim(),
          email: email ? email.toLowerCase().trim() : null,
          phone: cleanPhone,
          address: referrer.address || '',
          status: 'prospective',
          notes: `Referred by ${referrer.first_name} ${referrer.last_name} (${referrer.account_number}) on ${now.toLocaleDateString('en-PH')}`
        }
      });

      // Create referral record
      const referral = await tx.referrals.create({
        data: {
          referrer_id: referrer.id,
          referrer_account: referrer.account_number,
          referee_id: newSub.id,
          status: 'pending',
          created_at: now,
          expires_at: expiresAt
        }
      });

      return { referral, newSub };
    });

    res.status(201).json({
      message: 'Referral submitted successfully',
      referral: {
        id: result.referral.id,
        refereeName: `${firstName} ${lastName}`,
        status: 'pending',
        createdAt: result.referral.created_at,
        expiresAt: result.referral.expires_at
      }
    });
  } catch (err) {
    console.error('Portal referral create error:', err);
    if (err.code === 'P2002') {
      const field = err.meta?.target?.includes('email') ? 'email' : 'account number';
      return res.status(409).json({ error: `A subscriber with this ${field} already exists` });
    }
    res.status(500).json({ error: 'Failed to submit referral' });
  }
});

module.exports = router;

// ============================================================
// GET /api/portal/invoices/:id/pdf — Download invoice as PDF
// Accepts token via Authorization header OR ?token= query param
// ============================================================
router.get('/invoices/:id/pdf', async (req, res) => {
  try {
    const jwt = require('jsonwebtoken');
    const token = req.headers.authorization?.split(' ')[1] || req.query.token;
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded) return res.status(401).json({ error: 'Invalid token' });
    const subId = decoded.subscriberId || decoded.id || decoded.sub;
    if (!subId) return res.status(401).json({ error: 'Invalid token structure' });

    // Verify invoice belongs to this subscriber
    const invoice = await req.prisma.invoices.findUnique({
      where: { id: parseInt(req.params.id) },
      select: { id: true, invoice_number: true, subscriber_id: true }
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.subscriber_id !== subId) {
      return res.status(403).json({ error: 'Not authorized to view this invoice' });
    }

    const { generateInvoicePDF } = require('../utils/invoicePdf');
    const pdfBuffer = await generateInvoicePDF(req.prisma, req.params.id);

    const filename = `${invoice.invoice_number || 'invoice'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    console.error('Portal invoice PDF error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate PDF' });
  }
});

// ============================================================
// POST /api/portal/invoices/pay-all — Pay all unpaid invoices at once
// Creates a single Xendit checkout for the total amount
// ============================================================
router.post('/invoices/pay-all', portalAuth, async (req, res) => {
  try {
    const { method, invoiceIds } = req.body;

    if (method !== 'xendit') {
      return res.status(400).json({ error: 'Only Xendit payments are supported online.' });
    }

    const [xenditKey, co] = await Promise.all([
      req.prisma.system_settings.findUnique({ where: { key: 'xendit_secret_key' } }).then(r => r?.value || process.env.XENDIT_SECRET_KEY),
      getCompany(req.prisma)
    ]);
    if (!xenditKey) {
      return res.status(503).json({ error: 'Payment service not configured' });
    }

    // Fetch all unpaid invoices with full subscriber + plan + address details
    const invoices = await req.prisma.invoices.findMany({
      where: {
        subscriber_id: req.subscriberId,
        id: { in: invoiceIds.map(Number) },
        status: { in: ['pending', 'overdue'] }
      },
      include: {
        subscriber: {
          include: {
            plan: true,
            municipality: true,
            barangay: true,
            notification_prefs: true
          }
        }
      }
    });

    if (invoices.length === 0) {
      return res.status(400).json({ error: 'No unpaid invoices found' });
    }

    // Verify all invoices belong to this subscriber
    const unauthorized = invoices.find(inv => inv.subscriber_id !== req.subscriberId);
    if (unauthorized) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const totalAmount = invoices.reduce((sum, inv) => sum + Number(inv.amount), 0);
    const sub = invoices[0].subscriber;
    const plan = sub.plan;
    const invoiceNumbers = invoices.map(inv => inv.invoice_number).join(', ');
    const externalId = `NF-PAYALL-${Date.now()}`;
    const portalUrl = (process.env.APP_URL || 'https://netfactory.com.ph') + '/portal';

    // Format phone to E.164 (+63...)
    const formatPhone = (phone) => {
      if (!phone) return undefined;
      const digits = phone.replace(/\D/g, '');
      if (digits.startsWith('63') && digits.length >= 12) return '+' + digits;
      if (digits.startsWith('0') && digits.length === 11) return '+63' + digits.slice(1);
      if (digits.length === 10) return '+63' + digits;
      return undefined;
    };

    // Build customer object from subscriber data
    const customer = {
      given_names: [sub.first_name, sub.middle_name].filter(Boolean).join(' ') || undefined,
      surname: sub.last_name || undefined,
      email: sub.email || undefined,
      mobile_number: formatPhone(sub.phone),
      addresses: [{
        country: 'PH',
        street_line1: sub.address_street1 || sub.address || undefined,
        street_line2: sub.address_street2 || undefined,
        city: sub.address_city || sub.municipality_name || sub.municipality?.name || undefined,
        province: sub.address_state || sub.municipality?.province || undefined,
        postal_code: sub.address_postal_code || sub.postal_code || sub.municipality?.postal_code || undefined
      }]
    };

    // One line item per invoice — show pre-tax base price on each item
    const planLabel = plan ? `${plan.name} (${plan.speed_label})` : 'Internet Service';
    const items = invoices.map(inv => {
      const invTotal = Number(inv.amount);
      const invBase  = Math.round((invTotal / (1 + co.taxRate)) * 100) / 100;
      return {
        name: inv.billing_period || 'Monthly Subscription',
        price: invBase,
        quantity: 1,
        reference_id: inv.invoice_number,
        category: 'Internet Service'
      };
    });

    // Tax (summed across all invoices) + optional overdue fees
    const totalTax = Math.round(invoices.reduce((sum, inv) => {
      const invTotal = Number(inv.amount);
      const invBase  = Math.round((invTotal / (1 + co.taxRate)) * 100) / 100;
      return sum + (invTotal - invBase);
    }, 0) * 100) / 100;
    const fees = [{ type: co.taxLabel, value: totalTax }];
    const totalOverdue = invoices.reduce((sum, inv) => sum + Number(inv.overdue_fee || 0), 0);
    if (totalOverdue > 0) {
      fees.push({ type: 'Late Payment Fees', value: totalOverdue });
    }

    // Notification channels based on available subscriber contact info
    const notifChannels = [];
    if (sub.email) notifChannels.push('email');
    if (sub.phone) notifChannels.push('sms');
    const customer_notification_preference = notifChannels.length > 0 ? {
      invoice_created: notifChannels,
      invoice_reminder: notifChannels,
      invoice_paid: notifChannels
    } : undefined;

    const description = `${sub.first_name}${sub.middle_name ? ' ' + sub.middle_name : ''} ${sub.last_name} — ${planLabel}`;

    // Create single Xendit invoice for total amount
    const xenditResponse = await fetch('https://api.xendit.co/v2/invoices', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(xenditKey + ':').toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        external_id: externalId,
        amount: totalAmount,
        currency: 'PHP',
        description,
        payer_email: sub.email || undefined,
        should_send_email: !!sub.email,
        invoice_duration: 86400,
        locale: 'en',
        reminder_time: 1,
        reminder_time_unit: 'days',
        success_redirect_url: `${portalUrl}/?payment=success&invoice=BATCH&token=${req.token}`,
        failure_redirect_url: `${portalUrl}/?payment=failed&invoice=BATCH`,
        payment_methods: ['CREDIT_CARD', 'GCASH', 'PAYMAYA', 'GRABPAY', 'SHOPEEPAY', 'QRPH', 'DD_BPI', 'DD_UBP', 'DD_RCBC', 'DD_BDO_EPAY', '7ELEVEN', 'CEBUANA', 'DP_MLHUILLIER', 'DP_PALAWAN', 'LBC'],
        customer,
        customer_notification_preference,
        items,
        ...(fees.length > 0 && { fees }),
        metadata: {
          type: 'pay_all',
          invoice_ids: invoices.map(inv => inv.id),
          invoice_numbers: invoices.map(inv => inv.invoice_number),
          subscriber_id: sub.id,
          account_number: sub.account_number
        }
      })
    });

    const xenditData = await xenditResponse.json();

    if (!xenditResponse.ok) {
      console.error('Xendit pay-all creation failed:', xenditData);
      return res.status(502).json({ error: 'Failed to create payment', details: xenditData.message });
    }

    // Store Xendit ID on all invoices
    for (const inv of invoices) {
      await req.prisma.invoices.update({
        where: { id: inv.id },
        data: {
          xendit_invoice_id: xenditData.id,
          xendit_external_id: externalId
        }
      });
    }

    // Audit log
    await req.prisma.audit_log.create({
      data: {
        user_type: 'subscriber',
        user_id: sub.id,
        action: 'payment_all_initiated',
        entity_type: 'invoice',
        entity_id: invoices[0].id,
        details: JSON.stringify({ xenditId: xenditData.id, invoiceCount: invoices.length, total: totalAmount, invoiceNumbers })
      }
    }).catch(() => {});

      // ── New audit trail ──
      req.auditLog('PAYMENT_MADE', { invoices: invoiceNumbers, amount: totalAmount, count: invoices.length, method: 'xendit', xenditId: xenditData.id }).catch(() => {});

    console.log(`💳 Xendit pay-all created for ${invoices.length} invoices (₱${totalAmount}): ${xenditData.invoice_url}`);

    res.json({
      checkoutUrl: xenditData.invoice_url,
      xenditInvoiceId: xenditData.id,
      externalId,
      amount: totalAmount,
      invoiceCount: invoices.length
    });

  } catch (err) {
    console.error('Pay-all error:', err);
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

// GET /api/portal/settings — public branding endpoint
router.get('/settings', async (req, res) => {
  try {
    const rows = await req.prisma.system_settings.findMany({
      where: { category: 'company' }
    });
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
