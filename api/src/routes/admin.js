// RADIUS auto-sync
let radiusDb;
try { radiusDb = require('../config/radius-db'); } catch(e) { radiusDb = null; }

// Billing restriction — loaded the same tolerant way as radiusDb above, so a deployment
// without the RADIUS side still serves billing rather than failing to boot. The no-op
// stub keeps the payment path free of null checks.
let restriction;
try { restriction = require('../utils/restriction'); }
catch(e) { restriction = { restoreIfSettled: async () => ({ restored: false, reason: 'restriction module unavailable' }) }; }

const express = require('express');
const { defaultPortalPassword } = require('../utils/generators');
const { getCompany } = require('../utils/company');
const { parseLcp, lcpSiblingRegex } = require('../utils/lcp');
const { overdueWhere, notYetDueWhere } = require('../utils/overdue');
const { recordArPayment } = require('../utils/receipts');

// Mikrotik-Rate-Limit carries more than the sustained rate:
//   rx/tx  burst-rate  burst-threshold  burst-time  [priority]  [min-rate]
// The CRM only knows about the first field, so a plain rewrite on every plan
// save silently discarded any burst configuration — which lives nowhere else
// and has no UI. Parsed in bits per second so 400M and 400000k compare properly.
function parseRateToBps(v) {
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*([kKmMgG]?)$/);
  if (!m) return NaN;
  const mult = { '': 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6, g: 1e9, G: 1e9 }[m[2]];
  return parseFloat(m[1]) * mult;
}

// Moved to utils/radius-groups so unrestrictSubscriber can build the same string when
// it has to recreate a plan's group. One definition — a restore that invented its own
// rate-limit format would put the customer on a speed no screen in the CRM agrees with.
const { buildRateLimit } = require('../utils/radius-groups');

// Auto-sync single plan to RADIUS
async function syncPlanToRadius(slug, downloadMbps, uploadMbps, isActive, burst) {
  if (!radiusDb) return;
  try {
    const rateLimit = buildRateLimit(downloadMbps, uploadMbps, burst);
    const [existing] = await radiusDb.query("SELECT id, value FROM radgroupreply WHERE groupname = ? AND attribute = 'Mikrotik-Rate-Limit'", [slug]);

    // Deactivating a plan means "stop offering this", not "cut off everyone already on
    // it". Deleting the group unconditionally meant the second: the plan vanished from
    // RADIUS while its subscribers still pointed at it, so they authenticated into a
    // group that replies with nothing — no rate limit, no session timeout, no interim
    // accounting. Found 2026-09-24 with five subscribers across four deactivated plans.
    // The delete is now conditional on the plan being genuinely empty; otherwise we fall
    // through and keep the group correct for whoever is still there.
    let deactivatedButOccupied = false;
    if (isActive === false && slug !== 'plan-suspended') {
      // No status filter on purpose. Keeping a group nobody uses costs nothing;
      // deleting one somebody still points at is the bug being fixed here.
      const [occ] = await radiusDb.query(
        `SELECT count(*)::int AS n FROM subscribers s
           JOIN plans p ON p.id = s.plan_id
          WHERE p.radius_group = ?`, [slug]);
      const n = occ[0] ? Number(occ[0].n) : 0;
      if (n > 0) {
        deactivatedButOccupied = true;
        console.warn('RADIUS sync: ' + slug + ' deactivated but ' + n +
                     ' subscriber(s) still on it — keeping the group');
      }
    }

    if (isActive === false && !deactivatedButOccupied) {
      // Plan deactivated and empty — remove from RADIUS (but don't touch plan-suspended)
      if (slug !== 'plan-suspended') {
        await radiusDb.query("DELETE FROM radgroupreply WHERE groupname = ?", [slug]);
        console.log('RADIUS sync: removed group ' + slug + ' (plan deactivated)');
      }
    } else if (existing.length > 0) {
      let value = rateLimit;
      // When the caller hands us the plan record, the plan is authoritative —
      // including when it says "no burst", which is how the UI clears it.
      // Only a caller that knows nothing about burst (legacy call site) falls
      // back to preserving whatever was appended by hand in SQL, so that a
      // price edit from such a path cannot silently delete it.
      const planIsAuthoritative = !!burst;
      const prior = String(existing[0].value || '').trim().split(/\s+/).slice(1);
      if (!planIsAuthoritative && prior.length) {
        const newRx   = parseRateToBps(String(rateLimit).split('/')[0]);
        const burstRx = parseRateToBps(String(prior[0]).split('/')[0]);
        if (Number.isFinite(newRx) && Number.isFinite(burstRx) && burstRx > newRx) {
          value = rateLimit + ' ' + prior.join(' ');
        } else {
          console.warn('RADIUS sync: dropped burst on ' + slug + ' — burst ' + prior[0] +
                       ' is not above the new rate ' + rateLimit);
        }
      }
      await radiusDb.query("UPDATE radgroupreply SET value = ? WHERE groupname = ? AND attribute = 'Mikrotik-Rate-Limit'", [value, slug]);
      console.log('RADIUS sync: updated ' + slug + ' → ' + value);
    } else {
      // Create new RADIUS group with all attributes
      await radiusDb.query("INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Mikrotik-Rate-Limit', ':=', ?)", [slug, rateLimit]);
      await radiusDb.query("INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Session-Timeout', ':=', '86400')", [slug]);
      await radiusDb.query("INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Acct-Interim-Interval', ':=', '300')", [slug]);
      console.log('RADIUS sync: created ' + slug + ' → ' + rateLimit);
    }
  } catch(e) { console.error('RADIUS sync error:', e.message); }
}

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ADMIN_COOKIE_NAME } = require('../middleware/adminAuth');
const tokenBlacklist = require('../middleware/tokenBlacklist');
const { generateToken: generateCsrfToken, setCsrfCookie } = require('../middleware/csrfProtection');
const rateLimit = require('express-rate-limit');
const adminAuth = require('../middleware/adminAuth');
const { getToggle, setToggle, TOGGLE_KEYS, refreshCache } = require('../middleware/systemToggles');
const { getPrefs } = require('../utils/notifPrefs');
// Same verification the account-number reassign modal runs, reused on create.
const acctNum = require('./account-number');
const subNotes = require('../utils/subscriber-notes');
const { getCompanyInfo, getEmailTemplate, getSmsTemplate } = require('./notifications');

const router = express.Router();

// Admin login rate limiter
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  keyGenerator: (req) => req.body.username || req.ip
});

// ============================================
// POST /api/admin/login
// ============================================
router.post('/login', adminLoginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const admin = await req.prisma.admin_users.findUnique({
      where: { username: username.trim().toLowerCase() }
    });

    if (!admin || !admin.is_active) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
        req.auditLog('LOGIN_FAILED', { username: username?.trim() }).catch(() => {});
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: admin.id, username: admin.username, role: admin.role, type: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_ADMIN_EXPIRES_IN || '8h' }
    );

    await req.prisma.admin_users.update({
      where: { id: admin.id },
      data: { last_login_at: new Date() }
    });

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin',
        user_id: admin.id,
        action: 'admin_login',
        ip_address: req.ip
      }
    });

      // ── New audit trail ──
      req.auditLog('LOGIN', { username: admin.username, role: admin.role }, { user_id: admin.id, username: admin.username }).catch(() => {});

    const isProd = process.env.NODE_ENV === 'production';
    const maxAge = 8 * 60 * 60 * 1000;

    res.cookie(ADMIN_COOKIE_NAME, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      maxAge: maxAge,
      path: '/',
    });

    const csrfToken = generateCsrfToken();
    setCsrfCookie(res, csrfToken, isProd);

    res.json({
      token,
      csrfToken,
      admin: {
        id: admin.id,
        username: admin.username,
        fullName: admin.full_name,
        email: admin.email,
        role: admin.role,
        allowedPages: admin.allowed_pages || []
      }
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Forgot password rate limiter
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { error: 'Too many reset attempts. Try again in 15 minutes.' },
  keyGenerator: (req) => req.body.username || req.ip
});

// ============================================
// POST /api/admin/forgot-password - Public reset via email/SMS
// ============================================
router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username or email is required' });

    // Look up by username or email
    const admin = await req.prisma.admin_users.findFirst({
      where: {
        OR: [
          { username: username.trim().toLowerCase() },
          { email: username.trim().toLowerCase() }
        ],
        is_active: true
      }
    });

    // Always return success to prevent user enumeration
    if (!admin) {
      return res.json({ message: 'If an account exists with that username or email, a password reset has been sent.' });
    }

    if (!admin.email && !admin.phone) {
      return res.json({ message: 'If an account exists with that username or email, a password reset has been sent.' });
    }

    // Generate random password: CAPS (no L,I,O) + digits 2-9, 8 chars
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let newPassword = '';
    for (let i = 0; i < 8; i++) newPassword += chars[Math.floor(Math.random() * chars.length)];

    const hash = await bcrypt.hash(newPassword, 12);
    await req.prisma.admin_users.update({ where: { id: admin.id }, data: { password_hash: hash } });

    // Branding comes from system_settings so a rebrand is a settings change,
    // not a code change. These messages used to hardcode "J2 Network" and
    // links to j2.network, a domain this deployment does not serve.
    const co = await getCompany(req.prisma).catch(() => null);
    const coName = co?.name || 'Netfactory';
    const crmUrl = co?.crmUrl || 'https://netfactory.com.ph/crm';

    let emailSent = false, smsSent = false;

    // Send email
    if (admin.email) {
      try {
        await req.config.email.sendWithPrisma(req.prisma, {
          to: admin.email,
          subject: coName + ' CRM - Password Reset',
          html: '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">' +
            '<div style="text-align:center;padding:20px 0;border-bottom:2px solid #3b82f6;">' +
            '<h1 style="color:#0f172a;margin:0;">' + coName + '</h1>' +
            '<p style="color:#3b82f6;margin:4px 0 0;">CRM Password Reset</p></div>' +
            '<div style="padding:24px 0;">' +
            '<p>Hi <strong>' + (admin.full_name || admin.username) + '</strong>,</p>' +
            '<p>Your CRM account password has been reset.</p>' +
            '<div style="background:#f0f9ff;border:1px solid #93c5fd;border-radius:10px;padding:16px;margin:20px 0;">' +
            '<p style="margin:0;"><strong>Username:</strong> ' + admin.username + '</p>' +
            '<p style="margin:8px 0 0;"><strong>New Password:</strong> <span style="font-family:monospace;font-size:18px;letter-spacing:2px;color:#1d4ed8;">' + newPassword + '</span></p></div>' +
            '<p>Please log in and change your password immediately.</p>' +
            '<p style="text-align:center;margin:24px 0;">' +
            '<a href="' + crmUrl + '/" style="background:#3b82f6;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Log In to CRM</a></p></div>' +
            '<div style="border-top:1px solid #e2e8f0;padding-top:16px;color:#94a3b8;font-size:12px;text-align:center;">' + coName + '<br>If you did not request this reset, contact your administrator immediately.</div></div>',
        });
        emailSent = true;
      } catch (emailErr) { console.error('Forgot password email failed:', emailErr.message); }
    }

    // Send SMS
    if (admin.phone) {
      try {
        await req.config.sms.sendWithPrisma(req.prisma, admin.phone,
          coName + ' CRM: Your password has been reset. Username: ' + admin.username + ' New Password: ' + newPassword + ' Log in at ' + crmUrl.replace(/^https?:\/\//, '') + '/ and change it immediately.'
        );
        smsSent = true;
      } catch (smsErr) { console.error('Forgot password SMS failed:', smsErr.message); }
    }

    await req.prisma.audit_log.create({
      data: {
        user_type: 'system',
        user_id: admin.id,
        action: 'admin_forgot_password',
        entity_type: 'admin_users',
        entity_id: admin.id,
        details: { username: admin.username, emailSent, smsSent },
        ip_address: req.ip
      }
    });

    // Build delivery message
    const methods = [];
    if (emailSent) {
      const masked = admin.email.replace(/^(.{2})(.*)(@.*)$/, (m, a, b, c) => a + '*'.repeat(b.length) + c);
      methods.push('email (' + masked + ')');
    }
    if (smsSent) {
      const masked = admin.phone.replace(/^(.{4})(.*)(.{4})$/, (m, a, b, c) => a + '*'.repeat(b.length) + c);
      methods.push('SMS (' + masked + ')');
    }

    if (methods.length > 0) {
      res.json({ message: 'Password reset sent via ' + methods.join(' and ') + '.', sent: true });
    } else {
      res.json({ message: 'If an account exists with that username or email, a password reset has been sent.' });
    }
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process reset request' });
  }
});

// ============================================
// ============================================
// POST /api/admin/logout
// ============================================
router.post('/logout', async (req, res) => {
  try {
    let token = null;

    if (req.cookies && req.cookies[ADMIN_COOKIE_NAME]) {
      token = req.cookies[ADMIN_COOKIE_NAME];
    } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (token) {
      tokenBlacklist.add(token);

      try {
        const decoded = jwt.decode(token);
        if (decoded && decoded.id) {
          await req.prisma.audit_log.create({
            data: {
              user_type: 'admin',
              user_id: decoded.id,
              action: 'admin_logout',
              ip_address: req.ip
            }
          });
      req.auditLog('LOGOUT', {}).catch(() => {});
        }
      } catch (e) { /* audit log failure is non-critical */ }
    }

    const isProd = process.env.NODE_ENV === 'production';
    res.clearCookie(ADMIN_COOKIE_NAME, { httpOnly: true, secure: isProd, sameSite: 'strict', path: '/' });
    res.clearCookie('j2_csrf', { httpOnly: false, secure: isProd, sameSite: 'strict', path: '/' });

    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('Admin logout error:', err);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// All routes below require admin auth
// ============================================

// ============================================
// GET /api/admin/dashboard - KPI stats
// ============================================
router.get('/dashboard', adminAuth(), async (req, res) => {
  try {
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const firstOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const yearEnd = new Date(now.getFullYear() + 1, 0, 1);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowStart = new Date(todayStart.getTime() + 24*60*60*1000);

    const [
      totalSubs,
      activeSubs,
      pendingSubs,
      suspendedSubs,
      disconnectedSubs,
      openTickets,
      criticalTickets,
      pendingInvoices,
      overdueInvoices,
      paidThisMonth,
      paidThisYear,
      pendingInvoicesThisYear,
      overdueInvoicesThisYear,
      recentNotifications,
      dailyApplications,
      dailyInstallations,
      dailyStatusChanges
    ] = await Promise.all([
      // System / dummy accounts (e.g. Web Inquiry placeholder) are excluded
      // from all subscriber counters so the KPI matches the GIS view.
      req.prisma.subscribers.count({ where: { is_system: false } }),
      req.prisma.subscribers.count({ where: { status: 'active', is_system: false } }),
      req.prisma.subscribers.count({ where: { status: 'pending', is_system: false } }),
      req.prisma.subscribers.count({ where: { status: 'suspended', is_system: false } }),
      req.prisma.subscribers.count({ where: { status: 'disconnected', is_system: false } }),
      req.prisma.tickets.count({ where: { status: { in: ['open', 'in_progress'] } } }),
      req.prisma.tickets.count({ where: { status: { in: ['open', 'in_progress'] }, priority: 'critical' } }),
      // Owed but not yet late, and owed and past due. Both by due date — nothing
      // writes status='overdue', so counting it reported 0 while 17 bills were
      // weeks past due. Splitting them also stops the two KPIs double-counting.
      req.prisma.invoices.count({ where: notYetDueWhere() }),
      req.prisma.invoices.count({ where: overdueWhere() }),
      // Monthly revenue — bound to the actual calendar month. The upper bound
      // (lt firstOfNextMonth) keeps future-dated payments (data-entry errors
      // with paid_at in later months) from inflating this month's revenue.
      req.prisma.payments.findMany({
        where: { status: 'success', paid_at: { gte: firstOfMonth, lt: firstOfNextMonth } },
        select: { amount: true, method: true }
      }),
      // Year-to-date paid payments — used for quarterly breakdown.
      // Cap upper bound at "now" so future-dated payments (data-entry
      // errors with paid_at in the future) don't show as "collected"
      // for quarters that haven't happened yet.
      req.prisma.payments.findMany({
        where: { status: 'success', paid_at: { gte: yearStart, lte: now } },
        select: { amount: true, paid_at: true }
      }),
      // Outstanding (not yet due) invoices generated this year
      // Joined with subscriber so we can group by subscriber status
      req.prisma.invoices.findMany({
        where: notYetDueWhere({ generated_at: { gte: yearStart, lt: yearEnd } }),
        select: { amount: true, generated_at: true, subscriber: { select: { status: true } } }
      }),
      // Outstanding (past due) invoices generated this year
      req.prisma.invoices.findMany({
        where: overdueWhere({ generated_at: { gte: yearStart, lt: yearEnd } }),
        select: { amount: true, generated_at: true, subscriber: { select: { status: true } } }
      }),
      req.prisma.notifications.findMany({
        where: { target_type: 'admin' },
        orderBy: { created_at: 'desc' },
        take: 10
      }),
      // Daily applications — new prospective subscribers via website apply form
      req.prisma.subscribers.count({
        where: { is_system: false, application_date: { gte: todayStart, lt: tomorrowStart } }
      }),
      // Daily installations — subscribers whose installed_at landed today
      req.prisma.subscribers.count({
        where: { is_system: false, installed_at: { gte: todayStart, lt: tomorrowStart } }
      }),
      // Daily status changes — count audit entries today where status changed to surveyed or approved
      req.prisma.$queryRaw`
        SELECT details->'changes'->>'status' AS new_status, COUNT(*)::int AS cnt
        FROM audit_log
        WHERE action = 'subscriber_updated'
          AND created_at >= ${todayStart}
          AND created_at < ${tomorrowStart}
          AND details->'changes'->>'status' IN ('surveyed','approved')
        GROUP BY 1
      `
    ]);

    const _statusMap = Object.fromEntries((dailyStatusChanges || []).map(r => [r.new_status, Number(r.cnt) || 0]));
    const dailySurveyed = _statusMap.surveyed || 0;
    const dailyApproved = _statusMap.approved || 0;

    const monthlyRevenue = paidThisMonth.reduce((sum, p) => sum + Number(p.amount), 0);
    // Credit applications are ledger moves from existing balance, not new cash.
    // Split them out so the dashboard can optionally exclude them (matching the report).
    const monthlyRevenueCredit = paidThisMonth
      .filter(p => p.method === 'credit')
      .reduce((sum, p) => sum + Number(p.amount), 0);

    // Quarterly breakdown — collected (paid) and outstanding per quarter for current year
    const quarterly = { Q1: { collected: 0, outstanding: 0 },
                        Q2: { collected: 0, outstanding: 0 },
                        Q3: { collected: 0, outstanding: 0 },
                        Q4: { collected: 0, outstanding: 0 } };
    function quarterKey(d) {
      const m = new Date(d).getMonth();
      return m < 3 ? 'Q1' : m < 6 ? 'Q2' : m < 9 ? 'Q3' : 'Q4';
    }
    for (const p of paidThisYear) {
      quarterly[quarterKey(p.paid_at)].collected += Number(p.amount);
    }
    // Outstanding by subscriber status (active / inactive / suspended /
    // disconnected / declined etc.) — per-quarter amounts so the
    // dashboard can show "this is how much each cohort owes you".
    const owedByStatus = {};
    for (const inv of [...pendingInvoicesThisYear, ...overdueInvoicesThisYear]) {
      if (!inv.generated_at) continue;
      const q = quarterKey(inv.generated_at);
      quarterly[q].outstanding += Number(inv.amount);
      const subStatus = (inv.subscriber && inv.subscriber.status) || 'unknown';
      if (!owedByStatus[subStatus]) owedByStatus[subStatus] = { Q1:0, Q2:0, Q3:0, Q4:0, total:0, invoices:0 };
      owedByStatus[subStatus][q] += Number(inv.amount);
      owedByStatus[subStatus].total += Number(inv.amount);
      owedByStatus[subStatus].invoices += 1;
    }
    const ytdCollected = Object.values(quarterly).reduce((s, q) => s + q.collected, 0);
    const ytdOutstanding = Object.values(quarterly).reduce((s, q) => s + q.outstanding, 0);

    // Revenue by plan
    const activePlans = await req.prisma.plans.findMany({
      where: { is_active: true },
      orderBy: { sort_order: 'asc' },
      include: {
        subscribers: {
          where: { status: 'active' },
          select: { id: true }
        }
      }
    });

    const revenueByPlan = activePlans.map(p => ({
      id: p.id,
      name: p.name,
      speed: p.speed_label,
      price: Number(p.price),
      subscriberCount: p.subscribers.length,
      revenue: p.subscribers.length * Number(p.price)
    })).filter(p => p.subscriberCount > 0);

    res.json({
      kpi: {
        totalSubscribers: totalSubs,
        activeSubscribers: activeSubs,
        pendingSubscribers: pendingSubs,
        suspendedSubscribers: suspendedSubs,
        disconnectedSubscribers: disconnectedSubs,
        monthlyRevenue,
        monthlyRevenueCredit,
        openTickets,
        criticalTickets,
        pendingPayments: pendingInvoices + overdueInvoices,
        quarterly,
        owedByStatus,
        ytdCollected,
        ytdOutstanding,
        year: now.getFullYear(),
        dailyApplications,
        dailySurveyed,
        dailyApproved,
        dailyInstallations
      },
      revenueByPlan,
      notifications: recentNotifications.map(n => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        isRead: n.is_read,
        createdAt: n.created_at
      }))
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ============================================
// GET /api/admin/subscribers - List with search & filter
// ============================================
router.get('/subscribers', adminAuth(), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const search = req.query.search || '';
    const status = req.query.status;
    const planId = req.query.planId;
    const municipalityId = req.query.municipalityId;

    const where = { is_system: false };

    if (search) {
      where.OR = [
        { first_name: { contains: search, mode: 'insensitive' } },
        { last_name: { contains: search, mode: 'insensitive' } },
        { company_name: { contains: search, mode: 'insensitive' } },
        { account_number: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } }
      ];
    }

    if (status && status !== 'all') { if (status.includes(',')) { where.status = { in: status.split(',') }; } else { where.status = status; } }
    if (planId) where.plan_id = parseInt(planId);
    if (municipalityId) where.municipality_id = parseInt(municipalityId);

    const [subscribers, total] = await Promise.all([
      req.prisma.subscribers.findMany({
        where,
        include: {
          plan: { select: { id: true, name: true, speed_label: true, price: true } },
          barangay: { select: { name: true } },
          municipality: { select: { name: true } }
        },
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit
      }),
      req.prisma.subscribers.count({ where })
    ]);

    // ── Referral tagging: which of these subscribers were referred (are a referee) ──
    const subIds = subscribers.map(s => s.id);
    const refMap = {};
    if (subIds.length) {
      const refRows = await req.prisma.referrals.findMany({
        where: { referee_id: { in: subIds } },
        select: { referee_id: true, referrer_id: true, referrer_account: true, status: true, created_at: true },
        orderBy: { created_at: 'desc' }
      });
      const referrerIds = [...new Set(refRows.map(r => r.referrer_id).filter(Boolean))];
      const referrerMap = {};
      if (referrerIds.length) {
        const referrers = await req.prisma.subscribers.findMany({
          where: { id: { in: referrerIds } },
          select: { id: true, first_name: true, last_name: true, company_name: true, account_number: true }
        });
        for (const rr of referrers) referrerMap[rr.id] = rr;
      }
      for (const r of refRows) {
        if (refMap[r.referee_id]) continue; // keep most recent
        const rr = referrerMap[r.referrer_id];
        const rrName = rr ? (rr.company_name || `${rr.first_name || ''} ${rr.last_name || ''}`.trim()) : null;
        refMap[r.referee_id] = {
          status: r.status,
          referrerId: r.referrer_id,
          referredByAccount: r.referrer_account || rr?.account_number || null,
          referredByName: rrName || null
        };
      }
    }

    res.json({
      subscribers: subscribers.map(s => ({
        id: s.id,
        accountNumber: s.account_number,
        firstName: s.first_name,
        lastName: s.last_name,
        companyName: s.company_name || null,
        email: s.email,
        phone: s.phone,
        address: s.address,
        barangay: s.barangay?.name || s.barangay_name || null,
        barangayId: s.barangay_id,
        municipality: s.municipality?.name || s.municipality_name || null,
        municipalityId: s.municipality_id,
        middleName: s.middle_name || null,
        subdivision: s.address_street2 || null,
        plan: s.plan ? { id: s.plan.id, name: s.plan.name, speed: s.plan.speed_label, price: Number(s.plan.price) } : null,
        status: s.status,
        balance: Number(s.balance),
        creditBalance: Number(s.credit_balance || 0),
        installedAt: s.installed_at,
        latitude: s.latitude ? Number(s.latitude) : null,
        longitude: s.longitude ? Number(s.longitude) : null,
        installationPackage: s.installation_package || null,
        macAddress: s.mac_address || null,
        notes: s.notes || "",
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        altContacts: Array.isArray(s.alt_contacts) ? s.alt_contacts : [],
        proofOfBilling: s.proof_of_billing || null,
        validId1: s.valid_id1 || null,
        validId2: s.valid_id2 || null,
        otherAttachment: s.other_attachment || null,
        xuiUserId: s.xui_user_id || null,
        referred: !!refMap[s.id],
        referralStatus: refMap[s.id] ? refMap[s.id].status : null,
        referredByName: refMap[s.id] ? refMap[s.id].referredByName : null,
        referredByAccount: refMap[s.id] ? refMap[s.id].referredByAccount : null
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('Subscribers list error:', err);
    res.status(500).json({ error: 'Failed to load subscribers' });
  }
});

// ============================================
// GET /api/admin/subscribers/:id - Single subscriber detail
// ============================================

// ── POST /admin/invoices/:id/send-payment-link ──────────────
// Emails the subscriber a link that opens this one invoice and a Xendit checkout,
// with no portal login involved. This exists because pending applicants have no
// portal account at all — credentials are only minted at activation — so a link is
// the only way they can settle anything online.
//
// The email carries a link to OUR page, never a Xendit URL: Xendit checkouts expire
// after 24h, and a link that dies in a day is worse than no link. The page mints a
// fresh checkout when the customer actually clicks Pay.
router.post('/invoices/:id/send-payment-link', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const invoice = await req.prisma.invoices.findUnique({
      where: { id },
      include: { subscriber: true },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const sub = invoice.subscriber;
    if (!sub) return res.status(400).json({ error: 'Invoice has no subscriber' });
    if (!sub.email && !(req.body && req.body.email)) return res.status(400).json({ error: 'This subscriber has no email address on file' });

    const settled = ['paid', 'cancelled', 'void', 'voided'].includes(String(invoice.status || '').toLowerCase());
    if (settled) return res.status(400).json({ error: 'Invoice is already ' + invoice.status });

    // Optional recipient override, for sending a test copy to staff before any of this
    // is aimed at customers. Superadmin only, and recorded in the audit trail with BOTH
    // addresses: a link that can pay an invoice went somewhere other than the account
    // holder, and that needs to be visible afterwards rather than inferred.
    let recipient = sub.email;
    const override = (req.body && req.body.email ? String(req.body.email) : '').trim();
    if (override) {
      if (req.admin.role !== 'superadmin') {
        return res.status(403).json({ error: 'Only a superadmin may send a payment link to a different address' });
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(override)) {
        return res.status(400).json({ error: 'That does not look like a valid email address' });
      }
      recipient = override;
    }

    const { signPayToken } = require('./paylink');
    const token = signPayToken(invoice.id, sub.id);
    const co = await getCompany(req.prisma).catch(() => null);
    const coName = co?.name || 'Netfactory';
    const base = process.env.APP_URL || 'https://netfactory.com.ph';
    const payUrl = base + '/pay/?t=' + encodeURIComponent(token);

    const amount = Number(invoice.amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const due = invoice.due_date
      ? new Date(invoice.due_date).toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' })
      : null;
    const greeting = sub.first_name || sub.company_name || 'there';

    await req.config.email.sendWithPrisma(req.prisma, {
      to: recipient,
      subject: coName + ' — Payment for ' + invoice.invoice_number,
      html: '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">' +
        '<div style="text-align:center;padding:20px 0;border-bottom:2px solid #3b82f6;">' +
        '<h1 style="color:#0f172a;margin:0;">' + coName + '</h1>' +
        '<p style="color:#3b82f6;margin:4px 0 0;">Payment Request</p></div>' +
        '<div style="padding:24px 0;">' +
        '<p>Hi <strong>' + greeting + '</strong>,</p>' +
        '<p>Here are the details for your account. You can settle this online — no login needed.</p>' +
        '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:20px 0;">' +
        '<p style="margin:0;"><strong>Account:</strong> ' + sub.account_number + '</p>' +
        '<p style="margin:8px 0 0;"><strong>Invoice:</strong> ' + invoice.invoice_number + '</p>' +
        (invoice.billing_period ? '<p style="margin:8px 0 0;"><strong>Period:</strong> ' + invoice.billing_period + '</p>' : '') +
        (due ? '<p style="margin:8px 0 0;"><strong>Due:</strong> ' + due + '</p>' : '') +
        '<p style="margin:12px 0 0;font-size:20px;"><strong>Amount Due: PHP ' + amount + '</strong></p></div>' +
        '<p style="text-align:center;margin:28px 0;">' +
        '<a href="' + payUrl + '" style="background:#3b82f6;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Pay Now</a></p>' +
        '<p style="font-size:12px;color:#64748b;">If the button does not work, copy this link into your browser:<br>' +
        '<span style="word-break:break-all;">' + payUrl + '</span></p>' +
        '<p style="font-size:12px;color:#64748b;">Keep this email private — anyone with the link can pay this invoice.</p>' +
        '</div>' +
        '<div style="border-top:1px solid #e2e8f0;padding-top:16px;color:#94a3b8;font-size:12px;text-align:center;">' + coName +
        (co?.email ? ' &middot; ' + co.email : '') + (co?.phone ? ' &middot; ' + co.phone : '') + '</div></div>',
    });

    req.auditLog('PAYMENT_LINK_SENT', {
      invoice: invoice.invoice_number,
      account: sub.account_number,
      email: recipient,
      accountEmail: sub.email,
      redirected: recipient !== sub.email,
      amount: Number(invoice.amount),
    }).catch(() => {});

    console.log('[paylink] link emailed for ' + invoice.invoice_number + ' to ' + recipient +
      (recipient !== sub.email ? ' (override; account email is ' + sub.email + ')' : ''));
    res.json({ sent: true, email: recipient, invoice: invoice.invoice_number, redirected: recipient !== sub.email });
  } catch (err) {
    console.error('[paylink] send failed:', err);
    res.status(500).json({ error: err.message || 'Failed to send payment link' });
  }
});

// ── POST /admin/subscribers/:id/reset-password ──────────────
router.post('/subscribers/:id/reset-password', adminAuth(), async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const id = parseInt(req.params.id);
    const sub = await req.prisma.subscribers.findUnique({ where: { id } });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    // Generate random password: CAPS (no L,I,O) + digits 2-9, 8 chars
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let newPassword = '';
    for (let i = 0; i < 8; i++) newPassword += chars[Math.floor(Math.random() * chars.length)];

    const hash = await bcrypt.hash(newPassword, 12);

    await req.prisma.subscriber_auth.upsert({
      where: { subscriber_id: id },
      update: { password_hash: hash },
      create: { subscriber_id: id, password_hash: hash },
    });

    const co2 = await getCompany(req.prisma).catch(() => null);
    const co2Name = co2?.name || 'Netfactory';
    const portalUrl2 = co2?.portalUrl || 'https://netfactory.com.ph/portal/';

    // Send email if subscriber has email
    if (sub.email) {
      try {
        await req.config.email.sendWithPrisma(req.prisma, {
          to: sub.email,
          subject: co2Name + ' - Your Password Has Been Reset',
          html: '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">' +
            '<div style="text-align:center;padding:20px 0;border-bottom:2px solid #3b82f6;">' +
            '<h1 style="color:#0f172a;margin:0;">' + co2Name + '</h1>' +
            '<p style="color:#3b82f6;margin:4px 0 0;">Password Reset</p></div>' +
            '<div style="padding:24px 0;">' +
            '<p>Hi <strong>' + (sub.first_name || '') + '</strong>,</p>' +
            '<p>Your account password has been reset by our support team.</p>' +
            '<div style="background:#f0f9ff;border:1px solid #93c5fd;border-radius:10px;padding:16px;margin:20px 0;">' +
            '<p style="margin:0;"><strong>Account:</strong> ' + sub.account_number + '</p>' +
            '<p style="margin:8px 0 0;"><strong>New Password:</strong> <span style="font-family:monospace;font-size:18px;letter-spacing:2px;color:#1d4ed8;">' + newPassword + '</span></p></div>' +
            '<p>Please log in and change your password immediately for security.</p>' +
            '<p style="text-align:center;margin:24px 0;">' +
            '<a href="' + portalUrl2 + '" style="background:#3b82f6;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Log In Now</a></p></div>' +
            '<div style="border-top:1px solid #e2e8f0;padding-top:16px;color:#94a3b8;font-size:12px;text-align:center;">' + co2Name + '</div></div>',
        });
        console.log('Password reset email sent to ' + sub.email);
      } catch (emailErr) { console.error('Password reset email failed:', emailErr.message); }
    }

    // Send SMS if subscriber has phone
    if (sub.phone) {
      try {
        await req.config.sms.sendWithPrisma(req.prisma, sub.phone,
          co2Name + ': Your password has been reset. Account: ' + sub.account_number + ' New Password: ' + newPassword + ' Log in at ' + portalUrl2.replace(/^https?:\/\//, '') + ' and change it immediately.'
        );
        console.log('Password reset SMS sent to ' + sub.phone);
      } catch (smsErr) { console.error('Password reset SMS failed:', smsErr.message); }
    }

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin',
        user_id: req.adminId,
        action: 'subscriber_password_reset',
        entity_type: 'subscribers',
        entity_id: id,
        details: { accountNumber: sub.account_number, resetBy: req.admin.full_name, emailSent: !!sub.email, smsSent: !!sub.phone },
        ip_address: req.ip,
      },
    });
      req.auditLog('PASSWORD_RESET', { target: 'subscriber', account: sub.account_number }).catch(() => {});

    res.json({ message: 'Password reset successfully', accountNumber: sub.account_number, newPassword: newPassword, emailSent: !!sub.email, smsSent: !!sub.phone });
  } catch (err) {
    console.error('Password reset error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

router.get('/subscribers/:id', adminAuth(), async (req, res) => {
  try {
    const sub = await req.prisma.subscribers.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        plan: { include: { features: { where: { is_active: true }, orderBy: { sort_order: 'asc' } } } },
        barangay: true,
        municipality: true,
        invoices: { orderBy: { due_date: 'desc' }, take: 12, include: { payments: { where: { status: 'success' } } } },
        tickets: { orderBy: { created_at: 'desc' }, take: 10, include: { updates: { orderBy: { created_at: 'asc' } } } }
      }
    });

    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    res.json({
      id: sub.id,
      accountNumber: sub.account_number,
      firstName: sub.first_name,
      lastName: sub.last_name,
      companyName: sub.company_name || null,
      email: sub.email,
      phone: sub.phone,
      address: sub.address,
      middleName: sub.middle_name || null,
      subdivision: sub.address_street2 || null,
      barangay: sub.barangay?.name,
      barangayId: sub.barangay_id,
      municipality: sub.municipality?.name,
      municipalityId: sub.municipality_id,
      plan: sub.plan ? {
        id: sub.plan.id, name: sub.plan.name, speed: sub.plan.speed_label,
        price: Number(sub.plan.price), features: sub.plan.features.map(f => f.feature_text)
      } : null,
      status: sub.status,
      balance: Number(sub.balance),
      latitude: sub.latitude ? Number(sub.latitude) : null,
      longitude: sub.longitude ? Number(sub.longitude) : null,
      installedAt: sub.installed_at,
      nextBillDate: sub.next_bill_date,
      ontSerial: sub.ont_serial,
      routerSerial: sub.router_serial,
      macAddress: sub.mac_address,
      notes: sub.notes,
      idType: sub.id_type,
      installationPackage: sub.installation_package || null,
      altContacts: Array.isArray(sub.alt_contacts) ? sub.alt_contacts : [],
      createdAt: sub.created_at,
      proofOfBilling: sub.proof_of_billing || null,
      validId1: sub.valid_id1 || null,
      validId2: sub.valid_id2 || null,
      otherAttachment: sub.other_attachment || null,
      invoices: sub.invoices.map(inv => ({
        id: inv.id, number: inv.invoice_number, amount: Number(inv.amount),
        period: inv.billing_period, dueDate: inv.due_date, status: inv.status,
        payments: inv.payments.map(p => ({ amount: Number(p.amount), method: p.method, paidAt: p.paid_at }))
      })),
      tickets: sub.tickets.map(tk => ({
        id: tk.id, number: tk.ticket_number, category: tk.category,
        priority: tk.priority, status: tk.status, subject: tk.subject,
        createdAt: tk.created_at,
        updates: tk.updates.map(u => ({ message: u.message, by: u.created_by, date: u.created_at }))
      }))
    });
  } catch (err) {
    console.error('Subscriber detail error:', err);
    res.status(500).json({ error: 'Failed to load subscriber' });
  }
});

// ============================================
// GET /api/admin/subscribers/:id/network
// Returns the full network attachment for a subscriber:
// NAP + port + strand + main FOC feeder + lateral FOC (Side C of NAP's closure).
// Used by the CRM subscriber GPS modal to plot the connection chain.
// ============================================
router.get('/subscribers/:id/network', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const sub = await req.prisma.$queryRaw`
      SELECT s.id, s.account_number, s.first_name, s.last_name,
             s.address, s.latitude, s.longitude
      FROM subscribers s WHERE s.id = ${id}
    `;
    if (!sub.length) return res.status(404).json({ error: 'Subscriber not found' });
    // Port + NAP + strand + main FOC (the route attached to the NAP)
    const port = await req.prisma.$queryRaw`
      SELECT p.port_number, p.subscriber_label,
             n.id AS nap_id, n.name AS nap_name, n.type AS nap_type,
             n.total_ports, n.used_ports,
             n.latitude AS nap_lat, n.longitude AS nap_lng,
             n.olt AS nap_olt, n.pon AS nap_pon,
             n.access_core, n.nap_core, n.is_lcp_port, n.lcp_nap_id,
             n.closure_id, c.name AS closure_name,
             c.latitude AS closure_lat, c.longitude AS closure_lng,
             s.id AS strand_id, s.strand_number, s.color_code AS strand_color, s.tube_number,
             f.id AS foc_id, f.name AS foc_name, f.cable_size AS foc_cable_size, f.type AS foc_type
      FROM nap_ports p
      JOIN naps n ON n.id = p.nap_id
      LEFT JOIN closures c ON c.id = n.closure_id
      LEFT JOIN foc_strands s ON s.id = p.strand_id
      LEFT JOIN foc_routes f ON f.id = s.foc_route_id
      WHERE p.subscriber_id = ${id}
      LIMIT 1
    `;
    let lateral = null;
    if (port.length && port[0].closure_id) {
      // Lateral = any FOC route attached on Side C of this closure.
      const lat = await req.prisma.$queryRaw`
        SELECT f.id, f.name, f.cable_size, f.type
        FROM closure_connections cc
        JOIN foc_routes f ON f.id = cc.ref_id
        WHERE cc.closure_id = ${port[0].closure_id}
          AND cc.connection_type = 'foc_route'
          AND cc.side = 'C'
        ORDER BY cc.sort_order
        LIMIT 1
      `;
      if (lat.length) lateral = { id: Number(lat[0].id), name: lat[0].name, cableSize: lat[0].cable_size, type: lat[0].type };
    }
    const s = sub[0];
    const p = port[0];

    // ── OLT / PON ───────────────────────────────────────────────────
    // Two sources, and they mean different things. The ONU registration is
    // what the OLT actually reports for this subscriber, so it wins. The
    // naps.olt / naps.pon columns are the *planned* feed recorded against the
    // NAP during survey — they stand in when no ONU has been mapped yet, and
    // `source` says which one the caller is looking at so the UI can label it.
    const onu = await req.prisma.$queryRaw`
      SELECT m.pon_port, m.onu_id, m.serial_number, m.status,
             d.id AS olt_id, d.label AS olt_label, d.olt_model
      FROM olt_onu_mappings m
      JOIN olt_devices d ON d.id = m.olt_device_id
      WHERE m.subscriber_id = ${id}
      ORDER BY m.last_seen DESC NULLS LAST, m.id DESC
      LIMIT 1
    `;
    const o = onu[0] || null;
    const olt = o
      ? { id: Number(o.olt_id), name: o.olt_label, model: o.olt_model, source: 'onu' }
      : (p && p.nap_olt ? { id: null, name: p.nap_olt, model: null, source: 'nap' } : null);
    const pon = o
      ? {
          port: Number(o.pon_port), onuId: Number(o.onu_id),
          label: `PON ${o.pon_port}/${o.onu_id}`,
          serial: o.serial_number, status: o.status, source: 'onu'
        }
      : (p && p.nap_pon
          ? { port: null, onuId: null, label: p.nap_pon, serial: null, status: null, source: 'nap' }
          : null);

    // ── LCP ─────────────────────────────────────────────────────────
    // Prefer the modelled link (naps.lcp_nap_id → the NAP acting as the LCP),
    // which carries a surveyed position. Nothing sets it yet in this dataset,
    // so fall back to the LCP encoded in the NAP name and stand the group up
    // from its sibling NAPs. That fallback has no surveyed coordinate, so the
    // plotted point is the centroid of its NAPs — `source: 'derived'` marks it
    // as approximate and the map labels it that way.
    let lcp = null;
    if (p && p.lcp_nap_id) {
      const parent = await req.prisma.$queryRaw`
        SELECT id, name, type, latitude, longitude, total_ports, used_ports
        FROM naps WHERE id = ${Number(p.lcp_nap_id)}
      `;
      if (parent.length) {
        const L = parent[0];
        lcp = {
          id: Number(L.id), name: L.name, type: L.type,
          lat: L.latitude !== null ? Number(L.latitude) : null,
          lng: L.longitude !== null ? Number(L.longitude) : null,
          napCount: null, totalPorts: Number(L.total_ports || 0), usedPorts: Number(L.used_ports || 0),
          source: 'linked'
        };
      }
    }
    if (!lcp && p) {
      const parsed = parseLcp(p.nap_name);
      if (parsed) {
        const grp = await req.prisma.$queryRaw`
          SELECT COUNT(*)::int          AS nap_count,
                 SUM(total_ports)::int  AS total_ports,
                 SUM(used_ports)::int   AS used_ports,
                 AVG(latitude)          AS lat,
                 AVG(longitude)         AS lng
          FROM naps WHERE name ~* ${lcpSiblingRegex(parsed)}
        `;
        const g = grp[0] || {};
        lcp = {
          id: null, name: parsed.name, type: 'lcp',
          area: parsed.area, number: parsed.number,
          lat: g.lat !== null && g.lat !== undefined ? Number(g.lat) : null,
          lng: g.lng !== null && g.lng !== undefined ? Number(g.lng) : null,
          napCount: Number(g.nap_count || 0),
          totalPorts: Number(g.total_ports || 0),
          usedPorts: Number(g.used_ports || 0),
          source: 'derived'
        };
      }
    }

    res.json({
      subscriber: {
        id: Number(s.id),
        accountNumber: s.account_number,
        name: `${s.first_name||''} ${s.last_name||''}`.trim(),
        address: s.address,
        lat: s.latitude !== null ? Number(s.latitude) : null,
        lng: s.longitude !== null ? Number(s.longitude) : null
      },
      nap: p ? {
        id: Number(p.nap_id), name: p.nap_name, type: p.nap_type,
        portNumber: Number(p.port_number),
        totalPorts: Number(p.total_ports || 0),
        usedPorts: Number(p.used_ports || 0),
        lat: p.nap_lat !== null ? Number(p.nap_lat) : null,
        lng: p.nap_lng !== null ? Number(p.nap_lng) : null,
        accessCore: p.access_core, napCore: p.nap_core,
        isLcpPort: !!p.is_lcp_port
      } : null,
      olt,
      pon,
      lcp,
      strand: (p && p.strand_id) ? {
        id: Number(p.strand_id), number: Number(p.strand_number),
        color: p.strand_color, tube: p.tube_number !== null ? Number(p.tube_number) : null
      } : null,
      foc: (p && p.foc_id) ? {
        id: Number(p.foc_id), name: p.foc_name,
        cableSize: p.foc_cable_size, type: p.foc_type
      } : null,
      closure: (p && p.closure_id) ? {
        id: Number(p.closure_id), name: p.closure_name,
        lat: p.closure_lat !== null ? Number(p.closure_lat) : null,
        lng: p.closure_lng !== null ? Number(p.closure_lng) : null
      } : null,
      lateral
    });
  } catch (err) {
    console.error('Subscriber network error:', err);
    res.status(500).json({ error: 'Failed to load network attachment' });
  }
});

// ============================================
// OSP PICKERS — LCP → NAP → Port, for assigning a drop from the
// subscriber record instead of hunting for the port on the map.
// ============================================

// Distance in metres between two WGS84 points. Only used for ordering the LCP
// list by proximity, so the equirectangular approximation is more than enough
// at these distances and avoids the cost of a real geodesic.
function metresBetween(aLat, aLng, bLat, bLng) {
  const R = 6371000, rad = Math.PI / 180;
  const x = (bLng - aLng) * rad * Math.cos((aLat + bLat) / 2 * rad);
  const y = (bLat - aLat) * rad;
  return Math.round(Math.sqrt(x * x + y * y) * R);
}

// GET /api/admin/osp/lcps?sub=<id>
// The LCPs a drop can hang off, with live capacity. When the subscriber has
// GPS the list comes back nearest-first, because the right LCP is almost
// always the closest one with a free port.
router.get('/osp/lcps', adminAuth(), async (req, res) => {
  try {
    const rows = await req.prisma.$queryRaw`
      SELECT n.id, n.name, n.latitude, n.longitude, n.lcp_nap_id,
             ln.name AS lcp_nap_name,
             (COUNT(p.id) FILTER (WHERE p.status = 'available'))::int AS free_ports,
             COUNT(p.id)::int AS total_ports
      FROM naps n
      LEFT JOIN naps ln ON ln.id = n.lcp_nap_id
      LEFT JOIN nap_ports p ON p.nap_id = n.id
      GROUP BY n.id, n.name, n.latitude, n.longitude, n.lcp_nap_id, ln.name
    `;

    let origin = null;
    if (req.query.sub) {
      const sub = await req.prisma.subscribers.findUnique({
        where: { id: parseInt(req.query.sub) },
        select: { latitude: true, longitude: true },
      });
      if (sub && sub.latitude != null && sub.longitude != null) {
        origin = { lat: Number(sub.latitude), lng: Number(sub.longitude) };
      }
    }

    const groups = new Map();
    for (const n of rows) {
      const key = n.lcp_nap_name || (parseLcp(n.name) || {}).name;
      if (!key) continue;
      const g = groups.get(key) || { name: key, naps: 0, freePorts: 0, totalPorts: 0, _lat: [], _lng: [] };
      g.naps += 1;
      g.freePorts += Number(n.free_ports || 0);
      g.totalPorts += Number(n.total_ports || 0);
      if (n.latitude != null) { g._lat.push(Number(n.latitude)); g._lng.push(Number(n.longitude)); }
      groups.set(key, g);
    }

    const lcps = [...groups.values()].map(g => {
      // No surveyed position for a derived LCP, so it sits at the centroid of
      // its NAPs — the same point the map plots it at.
      const lat = g._lat.length ? g._lat.reduce((a, b) => a + b, 0) / g._lat.length : null;
      const lng = g._lat.length ? g._lng.reduce((a, b) => a + b, 0) / g._lng.length : null;
      delete g._lat; delete g._lng;
      return {
        ...g, lat, lng,
        distanceM: (origin && lat != null) ? metresBetween(origin.lat, origin.lng, lat, lng) : null,
      };
    });

    lcps.sort((a, b) =>
      a.distanceM != null && b.distanceM != null ? a.distanceM - b.distanceM
        : a.distanceM != null ? -1 : b.distanceM != null ? 1
        : a.name.localeCompare(b.name));

    res.json({ lcps, orderedByDistance: !!origin });
  } catch (err) {
    console.error('OSP lcps error:', err);
    res.status(500).json({ error: 'Failed to load LCPs' });
  }
});

// GET /api/admin/osp/naps?lcp=<name>&sub=<id>
// The NAPs on one LCP, with free-port counts and (when the subscriber has GPS)
// how far each one is from them.
router.get('/osp/naps', adminAuth(), async (req, res) => {
  try {
    const want = (req.query.lcp || '').trim();
    if (!want) return res.status(400).json({ error: 'lcp is required' });

    const rows = await req.prisma.$queryRaw`
      SELECT n.id, n.name, n.type, n.latitude, n.longitude, n.pole_number,
             n.olt, n.pon, n.lcp_nap_id, ln.name AS lcp_nap_name,
             (COUNT(p.id) FILTER (WHERE p.status = 'available'))::int AS free_ports,
             COUNT(p.id)::int AS total_ports
      FROM naps n
      LEFT JOIN naps ln ON ln.id = n.lcp_nap_id
      LEFT JOIN nap_ports p ON p.nap_id = n.id
      GROUP BY n.id, n.name, n.type, n.latitude, n.longitude, n.pole_number,
               n.olt, n.pon, n.lcp_nap_id, ln.name
      ORDER BY n.name
    `;

    let origin = null;
    if (req.query.sub) {
      const sub = await req.prisma.subscribers.findUnique({
        where: { id: parseInt(req.query.sub) },
        select: { latitude: true, longitude: true },
      });
      if (sub && sub.latitude != null && sub.longitude != null) {
        origin = { lat: Number(sub.latitude), lng: Number(sub.longitude) };
      }
    }

    const naps = rows
      .filter(n => (n.lcp_nap_name || (parseLcp(n.name) || {}).name) === want)
      .map(n => ({
        id: Number(n.id), name: n.name, type: n.type,
        lat: n.latitude != null ? Number(n.latitude) : null,
        lng: n.longitude != null ? Number(n.longitude) : null,
        poleNumber: n.pole_number, olt: n.olt, pon: n.pon,
        freePorts: Number(n.free_ports || 0), totalPorts: Number(n.total_ports || 0),
        distanceM: (origin && n.latitude != null)
          ? metresBetween(origin.lat, origin.lng, Number(n.latitude), Number(n.longitude)) : null,
      }));

    res.json({ lcp: want, naps });
  } catch (err) {
    console.error('OSP naps error:', err);
    res.status(500).json({ error: 'Failed to load NAPs' });
  }
});

// PUT /api/admin/subscribers/:id/nap-port
// Assign this subscriber to a NAP port, or release the one they hold.
// Body: { portId: <id> } to assign, { portId: null } to release.
//
// This writes the same nap_ports row the GIS port panel writes, so an
// assignment made here shows on the map immediately and vice versa — there is
// one record of the drop, not two.
router.put('/subscribers/:id/nap-port', adminAuth(), async (req, res) => {
  try {
    const subId = parseInt(req.params.id);
    const sub = await req.prisma.subscribers.findUnique({ where: { id: subId } });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    const raw = req.body.portId;
    const portId = (raw === null || raw === undefined || raw === '') ? null : parseInt(raw);
    if (portId !== null && !Number.isFinite(portId)) {
      return res.status(400).json({ error: 'portId must be a port id or null' });
    }

    // A subscriber holds one drop. Whatever they were on is freed first, so
    // reassigning cannot silently leave them occupying two ports.
    const held = await req.prisma.$queryRaw`
      SELECT id, nap_id FROM nap_ports WHERE subscriber_id = ${subId}
    `;
    const touchedNaps = new Set(held.map(h => Number(h.nap_id)));

    if (portId !== null) {
      const target = await req.prisma.$queryRaw`
        SELECT p.id, p.nap_id, p.port_number, p.status, p.subscriber_id, p.subscriber_label,
               n.name AS nap_name
        FROM nap_ports p JOIN naps n ON n.id = p.nap_id
        WHERE p.id = ${portId}
      `;
      if (!target.length) return res.status(404).json({ error: 'Port not found' });
      const t = target[0];
      // Refuse to steal a port from another subscriber — that would silently
      // disconnect them on the map with no trace of who moved it.
      if (t.subscriber_id && Number(t.subscriber_id) !== subId) {
        return res.status(409).json({
          error: `Port ${t.port_number} on ${t.nap_name} is already assigned to ${t.subscriber_label || 'subscriber #' + t.subscriber_id}. Release it there first.`,
        });
      }
      if (t.status === 'damaged') {
        return res.status(409).json({ error: `Port ${t.port_number} on ${t.nap_name} is marked damaged.` });
      }
      touchedNaps.add(Number(t.nap_id));
    }

    await req.prisma.$executeRaw`
      UPDATE nap_ports
      SET subscriber_id = NULL, subscriber_label = NULL, status = 'available', updated_at = NOW()
      WHERE subscriber_id = ${subId}
    `;

    let assigned = null;
    if (portId !== null) {
      // Label matches what the GIS port panel writes — "Name (account)" — so
      // the two entry points cannot drift apart in the port table.
      const display = (sub.company_name
        || `${sub.first_name || ''} ${sub.last_name || ''}`.trim()
        || sub.account_number).replace(/\s+/g, ' ').trim();
      const label = display + (sub.account_number ? ` (${sub.account_number})` : '');
      const upd = await req.prisma.$queryRaw`
        UPDATE nap_ports
        SET subscriber_id = ${subId}, subscriber_label = ${label},
            status = 'used', updated_at = NOW()
        WHERE id = ${portId}
        RETURNING id, nap_id, port_number
      `;
      const u = upd[0];
      const nap = await req.prisma.$queryRaw`SELECT name FROM naps WHERE id = ${Number(u.nap_id)}`;
      assigned = { portId: Number(u.id), napId: Number(u.nap_id), portNumber: Number(u.port_number), napName: nap[0]?.name || null };
    }

    // Recount every NAP this touched — both the one released and the one taken.
    for (const napId of touchedNaps) {
      await req.prisma.$executeRaw`
        UPDATE naps SET used_ports = (SELECT COUNT(*) FROM nap_ports WHERE nap_id = ${napId} AND status = 'used')
        WHERE id = ${napId}
      `;
    }

    req.auditLog(assigned ? 'NAP_PORT_ASSIGN' : 'NAP_PORT_RELEASE', {
      subscriberId: subId, account: sub.account_number, ...(assigned || {}),
    }).catch(() => {});

    res.json({ message: assigned ? 'Port assigned' : 'Port released', assigned });
  } catch (err) {
    console.error('NAP port assign error:', err);
    res.status(500).json({ error: 'Failed to update NAP port' });
  }
});


// ============================================
// POST /api/admin/subscribers - Add subscriber
// ✅ UPDATED: Sends welcome email/SMS when created as active
// ============================================
// Link a referral: an existing subscriber (referrer) referred this referee.
// Awards the configured referral_reward_amount credit to the referrer when the
// referee is active. No-op on missing/self referrer or if the referee is already
// linked to a referral (avoids overwriting a portal-submitted one / double credit).
async function linkReferral(prisma, { referrerId, referee, award = true }) {
  if (!referrerId || !referee) return { ok: false, reason: 'missing' };
  const rid = parseInt(referrerId);
  if (!rid || rid === referee.id) return { ok: false, reason: 'self' };
  const referrer = await prisma.subscribers.findUnique({ where: { id: rid } });
  if (!referrer) return { ok: false, reason: 'no_referrer' };
  const existing = await prisma.referrals.findFirst({ where: { referee_id: referee.id } });
  if (existing) return { ok: false, reason: 'already_linked' };
  const active = referee.status === 'active';
  await prisma.referrals.create({
    data: {
      referrer_id: rid,
      referrer_account: referrer.account_number,
      referee_id: referee.id,
      status: active ? 'converted' : 'pending',
      converted_at: active ? new Date() : null,
    }
  });
  let awarded = 0;
  // Award whenever the referee is already active — ignore award=false here. The
  // `award` flag can only DEFER crediting to a later pending→active activation, but
  // an already-active referee has no future activation, so honouring award=false
  // would strand the referrer's credit forever (the exact bug this guards against).
  // The one-referral-per-referee check above prevents any double award.
  if (active) {
    const rewardSetting = await prisma.system_settings.findUnique({ where: { key: 'referral_reward_amount' } });
    const rewardAmount = +parseFloat(rewardSetting?.value || '0').toFixed(2);
    if (rewardAmount > 0) {
      const refereeName = `${referee.first_name || ''} ${referee.last_name || ''}`.trim() || referee.company_name || referee.account_number;
      const refUpd = await prisma.$queryRaw`UPDATE subscribers SET credit_balance = ROUND(COALESCE(credit_balance, 0) + ${rewardAmount}::numeric, 2) WHERE id = ${rid} RETURNING credit_balance`;
      const newBal = Number(refUpd[0].credit_balance);
      await prisma.$queryRaw`
        INSERT INTO subscriber_credits (subscriber_id, type, amount, running_balance, notes, created_by)
        VALUES (${rid}, 'referral_reward', ${rewardAmount}, ${newBal},
                ${`Referral reward — ${refereeName} (${referee.account_number})`}, ${'admin-referral'})`;
      awarded = rewardAmount;
      console.log(`[REFERRAL] Linked + awarded ₱${rewardAmount} to referrer ${rid} for referee ${referee.id}`);
    }
  }
  return { ok: true, status: active ? 'converted' : 'pending', awarded };
}

// ── Referrals: list + manual entry (backfill previous referrals) ──
router.get('/referrals', adminAuth(), async (req, res) => {
  try {
    const rows = await req.prisma.referrals.findMany({
      orderBy: { created_at: 'desc' },
      take: 200,
      include: {
        referrer: { select: { id: true, account_number: true, first_name: true, last_name: true, company_name: true } },
        referee:  { select: { id: true, account_number: true, first_name: true, last_name: true, company_name: true, status: true } },
      },
    });
    const nm = (s) => !s ? null : (`${s.first_name || ''} ${s.last_name || ''}`.trim() || s.company_name || s.account_number);
    res.json({
      referrals: rows.map(r => ({
        id: r.id,
        status: r.status,
        createdAt: r.created_at,
        convertedAt: r.converted_at,
        referrerId: r.referrer_id,
        referrerName: nm(r.referrer),
        referrerAccount: r.referrer_account || r.referrer?.account_number,
        refereeId: r.referee_id,
        refereeName: nm(r.referee),
        refereeAccount: r.referee?.account_number,
        refereeStatus: r.referee?.status,
      })),
    });
  } catch (err) {
    console.error('List referrals error:', err);
    res.status(500).json({ error: 'Failed to load referrals' });
  }
});

// Manually record a referral between two existing subscribers.
router.post('/referrals', adminAuth(), async (req, res) => {
  try {
    const { referrerId, refereeId, award } = req.body;
    if (!referrerId || !refereeId) return res.status(400).json({ error: 'referrerId and refereeId are required' });
    if (parseInt(referrerId) === parseInt(refereeId)) return res.status(400).json({ error: 'A subscriber cannot refer themselves' });
    const referee = await req.prisma.subscribers.findUnique({ where: { id: parseInt(refereeId) } });
    if (!referee) return res.status(404).json({ error: 'Referee subscriber not found' });

    const result = await linkReferral(req.prisma, { referrerId, referee, award: award !== false });
    if (!result.ok) {
      const msg = result.reason === 'already_linked' ? 'This subscriber is already linked to a referral'
        : result.reason === 'self' ? 'A subscriber cannot refer themselves'
        : result.reason === 'no_referrer' ? 'Referrer subscriber not found'
        : 'Could not record referral';
      return res.status(409).json({ error: msg });
    }
    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'referral_recorded', entity_type: 'referrals', entity_id: referee.id,
        details: { referrerId: parseInt(referrerId), refereeId: referee.id, status: result.status, awarded: result.awarded },
        ip_address: req.ip,
      },
    }).catch(() => {});
    res.json({ ok: true, status: result.status, awarded: result.awarded });
  } catch (err) {
    console.error('Record referral error:', err);
    res.status(500).json({ error: 'Failed to record referral' });
  }
});

router.post('/subscribers', adminAuth(), async (req, res) => {
  try {
    const { firstName, middleName, lastName, email, phone, address, barangayId, municipalityId, planId, installationPackage, status, notes, ontSerial, routerSerial, macAddress, latitude, longitude, companyName, altContacts, referrerId, accountNumber, advanceSequence } = req.body;
    const altContactsClean = Array.isArray(altContacts)
      ? altContacts
          .map(c => ({
            name: typeof c?.name === 'string' ? c.name.trim().slice(0, 100) : '',
            phone: typeof c?.phone === 'string' ? c.phone.trim().slice(0, 30) : ''
          }))
          .filter(c => c.phone)
      : [];

    // Require either personal name or company name
    if ((!firstName || !lastName) && !companyName) {
      return res.status(400).json({ error: 'Required: (firstName + lastName) or companyName, plus phone and address' });
    }
    if (!phone || !address) {
      return res.status(400).json({ error: 'Required: phone, address' });
    }

    if (email) {
      const cleanEmail = email.toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      const existing = await req.prisma.subscribers.findUnique({ where: { email: cleanEmail } });
      if (existing) return res.status(409).json({ error: 'Email already registered' });
    }

    // ── Account number ──
    // Left out, this stays '' and the BEFORE INSERT trigger assigns the next one
    // in sequence. Supplied — a number carried over from the old system — it goes
    // through the same verification the reassign modal uses, so the two cannot
    // drift apart on what counts as a valid or safe number.
    let chosenAccount = '';
    if (accountNumber !== undefined && String(accountNumber).trim()) {
      chosenAccount = acctNum.normalise(accountNumber);
      const report = await acctNum.verify(req.prisma, null, chosenAccount, 'manual');
      if (report.blocking) {
        const blocker = report.checks.find(c => c.level === 'block');
        return res.status(409).json({ error: blocker.title, detail: blocker.detail, checks: report.checks });
      }
    }

    // Get plan info for notifications
    let plan = null;
    if (planId) {
      plan = await req.prisma.plans.findUnique({ where: { id: parseInt(planId) } });
    }

    const subscriber = await req.prisma.subscribers.create({
      data: {
        account_number: chosenAccount,
        first_name: firstName ? firstName.trim() : null,
        // middle_name was missing here while the CRM's Add Subscriber form has always
        // posted it, so it was silently dropped on create and staff had to retype it in
        // the edit dialog afterwards. Column is varchar(50) — same cap the edit form uses.
        middle_name: middleName ? middleName.trim().slice(0, 50) : null,
        last_name: lastName ? lastName.trim() : null,
        company_name: companyName ? companyName.trim() : null,
        email: email ? email.toLowerCase().trim() : null,
        phone: phone.trim(),
        address: address.trim(),
        barangay_id: barangayId ? parseInt(barangayId) : null,
        municipality_id: municipalityId ? parseInt(municipalityId) : null,
        plan_id: planId ? parseInt(planId) : null,
        status: status || 'pending',
        notes: notes || null,
        ont_serial: ontSerial || null,
        router_serial: routerSerial || null,
        mac_address: macAddress || null,
        latitude: latitude || null,
        longitude: longitude || null,
        installation_package: installationPackage || null,
        installed_at: status === 'active' ? new Date() : null,
        alt_contacts: altContactsClean
      }
    });

    // Refetch for auto-generated account number
    const created = await req.prisma.subscribers.findUnique({ where: { id: subscriber.id } });

    // A manual number ahead of the counter would eventually be handed out again
    // and fail on the unique index. Only ever moves the counter forward.
    if (chosenAccount && advanceSequence && acctNum.HOUSE_FORMAT.test(chosenAccount)) {
      try {
        const serial = Number(chosenAccount.slice(4));
        await req.prisma.$executeRawUnsafe(
          `SELECT setval('subscriber_account_seq', GREATEST(${serial}, (SELECT last_value FROM subscriber_account_seq)), true)`);
      } catch (seqErr) { console.error('[SUBSCRIBER] Sequence advance failed:', seqErr.message); }
    }

    // ── Referral link (referred by an existing subscriber) ──
    if (referrerId) {
      try { await linkReferral(req.prisma, { referrerId, referee: created }); }
      catch (refErr) { console.error('[REFERRAL] Link on create failed:', refErr.message); }
    }

    // If active, create portal auth with default password
    if (status === 'active') {
      const defaultPassword = await bcrypt.hash(defaultPortalPassword(created.account_number), 12);
      await req.prisma.subscriber_auth.create({
        data: { subscriber_id: created.id, password_hash: defaultPassword }
      });

      // ── Send welcome EMAIL for new active subscriber ──
      if (created.email) {
        req.config.email.sendTemplateWithPrisma(req.prisma, created.email, 'welcome', {
          name: firstName || companyName,
          accountNumber: created.account_number,
          plan: plan ? plan.name : 'N/A',
        }).catch(err => console.error('[EMAIL] Welcome send failed:', err.message));
      }

      // ── Send welcome SMS for new active subscriber ──
      if (created.phone || phone) {
        // The welcome SMS template reads accountNumber and plan, not name — passing
        // only name is what produced "Account: undefined, Plan: undefined" in the
        // text customers received. Same three fields as the welcome email above.
        req.config.sms.sendTemplateWithPrisma(req.prisma, created.phone || phone, 'welcome', {
          name: firstName || companyName,
          accountNumber: created.account_number,
          plan: plan ? plan.name : 'N/A',
        }).catch(err => console.error('[SMS] Welcome send failed:', err.message));
      }
    }

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'subscriber_created', entity_type: 'subscribers', entity_id: created.id,
        details: { accountNumber: created.account_number, status: created.status },
        ip_address: req.ip
      }
    });
      req.auditLog('SUBSCRIBER_CREATE', { account: created.account_number, status: created.status }).catch(() => {});

    res.status(201).json({
      message: 'Subscriber created',
      subscriber: { id: created.id, accountNumber: created.account_number, status: created.status }
    });
  } catch (err) {
    console.error('Create subscriber error:', err);
    res.status(500).json({ error: 'Failed to create subscriber' });
  }
});

// ============================================
// PUT /api/admin/subscribers/:id - Update subscriber
// ✅ UPDATED: Sends email/SMS on status changes (activation, suspension)
// ============================================
router.put('/subscribers/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const sub = await req.prisma.subscribers.findUnique({ where: { id } });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    const allowed = ['first_name', 'middle_name', 'last_name', 'company_name', 'email', 'phone', 'address', 'address_street2', 'barangay_id', 'municipality_id', 'plan_id', 'installation_package', 'status', 'balance', 'latitude', 'longitude', 'installed_at', 'next_bill_date', 'ont_serial', 'router_serial', 'mac_address', 'notes', 'remarks'];
    const data = {};

    for (const key of allowed) {
      // Convert camelCase from request body to snake_case
      const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (req.body[camel] !== undefined) {
        data[key] = req.body[camel];
      } else if (req.body[key] !== undefined) {
        data[key] = req.body[key];
      }
    }

    // Handle 'subdivision' alias → address_street2
    if (req.body.subdivision !== undefined && data.address_street2 === undefined) {
      data.address_street2 = req.body.subdivision;
    }

    // Handle altContacts → alt_contacts (JSONB array of {name, phone})
    if (req.body.altContacts !== undefined || req.body.alt_contacts !== undefined) {
      const raw = req.body.altContacts ?? req.body.alt_contacts;
      const arr = Array.isArray(raw) ? raw : [];
      data.alt_contacts = arr
        .map(c => ({
          name: typeof c?.name === 'string' ? c.name.trim().slice(0, 100) : '',
          phone: typeof c?.phone === 'string' ? c.phone.trim().slice(0, 30) : ''
        }))
        .filter(c => c.phone);
    }

    // Convert empty strings to null for nullable fields
    const nullableFields = ['email', 'first_name', 'middle_name', 'last_name', 'company_name', 'mac_address', 'ont_serial', 'router_serial', 'notes', 'remarks', 'address_street2'];
    for (const field of nullableFields) {
      if (data[field] !== undefined && (data[field] === '' || data[field] === null)) {
        data[field] = null;
      }
    }

    if (data.email) {
      data.email = data.email.toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
    }
    if (data.mac_address) data.mac_address = data.mac_address.toUpperCase().trim();
    if (data.plan_id) data.plan_id = parseInt(data.plan_id);
    if (data.barangay_id) data.barangay_id = parseInt(data.barangay_id);
    if (data.municipality_id) data.municipality_id = parseInt(data.municipality_id);
    if (data.balance !== undefined) data.balance = parseFloat(data.balance);
    if (data.installed_at) data.installed_at = new Date(data.installed_at + 'T12:00:00.000Z');
    if (data.next_bill_date) data.next_bill_date = new Date(data.next_bill_date + 'T12:00:00.000Z');

    // Auto-sync ONU MAC address to subscriber if not already set
    if (!data.mac_address && !sub.mac_address) {
      const assignedOnu = await req.prisma.onu_inventory.findFirst({
        where: { subscriber_id: id, status: 'deployed' }
      });
      if (assignedOnu?.mac_address) {
        data.mac_address = assignedOnu.mac_address;
      }
    }

    // If activating a subscriber, create portal auth + RADIUS.
    //
    // This used to require the PREVIOUS status to be 'pending'. An account approved
    // first and activated from there — approved -> active, which is how the CRM's own
    // approval flow moves a subscriber — matched neither this nor the create path
    // (which only makes a login when the subscriber is created as 'active' outright).
    // The result was a live, billed customer with no subscriber_auth row, and because
    // /portal/login answers "Invalid account number or password" for a missing
    // credential exactly as it does for a wrong one, it read as a password problem.
    // Found on one account — the only one of 194 active subscribers without a login.
    //
    // Any transition INTO active now provisions it. The existing-auth check below
    // already makes this idempotent, so accounts that arrived another way are
    // untouched and a re-activation never overwrites a password the customer changed.
    let activationPassword = null;
    if (data.status === 'active' && sub.status !== 'active') {
      data.installed_at = data.installed_at || new Date();
      activationPassword = defaultPortalPassword(sub.account_number);

      // Create portal auth
      const existingAuth = await req.prisma.subscriber_auth.findUnique({ where: { subscriber_id: id } });
      if (!existingAuth) {
        const passwordHash = await bcrypt.hash(activationPassword, 12);
        await req.prisma.subscriber_auth.create({
          data: { subscriber_id: id, password_hash: passwordHash }
        });
      }

      // Auto-provision RADIUS credentials
      if (radiusDb) {
        try {
          const plan = sub.plan_id ? await req.prisma.plans.findUnique({ where: { id: sub.plan_id } }) : null;
          const radiusUsername = sub.account_number;
          const radiusGroup = plan?.slug || 'radsys';
          const [existingRadius] = await radiusDb.query('SELECT id FROM subscriber_radius WHERE subscriber_id = ?', [id]);
          if (existingRadius.length === 0) {
            await radiusDb.query("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)", [radiusUsername, activationPassword]);
            await radiusDb.query('INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)', [radiusUsername, radiusGroup]);
            await radiusDb.query(
              'INSERT INTO subscriber_radius (subscriber_id, radius_username, radius_group, radius_password, enabled) VALUES (?, ?, ?, ?, true)',
              [id, radiusUsername, radiusGroup, activationPassword]
            );
            console.log(`[RADIUS] Provisioned ${radiusUsername} → ${radiusGroup}`);
          }
        } catch (radErr) {
          console.error('[RADIUS] Auto-provision failed:', radErr.message);
        }
      }
    }

    const updated = await req.prisma.subscribers.update({ where: { id }, data });

    // ── Referral conversion + reward ──
    // When a referred prospect is activated in the CRM, flip its pending
    // referral to 'converted' (so the referrer's portal reflects it) and, if a
    // referral reward is configured, credit the referrer's account.
    if (data.status === 'active' && sub.status !== 'active') {
      try {
        const pending = await req.prisma.referrals.findMany({
          where: { referee_id: id, status: 'pending' }
        });
        if (pending.length) {
          await req.prisma.referrals.updateMany({
            where: { referee_id: id, status: 'pending' },
            data: { status: 'converted', converted_at: new Date() }
          });
          console.log(`[REFERRAL] Marked ${pending.length} referral(s) converted for subscriber ${id}`);

          // Award reward credit to each referrer, if configured (> 0).
          const rewardSetting = await req.prisma.system_settings.findUnique({ where: { key: 'referral_reward_amount' } });
          const rewardAmount = +parseFloat(rewardSetting?.value || '0').toFixed(2);
          if (rewardAmount > 0) {
            const refereeName = `${updated.first_name}${updated.middle_name ? ' ' + updated.middle_name : ''} ${updated.last_name}`.trim();
            for (const ref of pending) {
              const referrer = await req.prisma.subscribers.findUnique({ where: { id: ref.referrer_id } });
              if (!referrer) continue;
              const refUpd = await req.prisma.$queryRaw`UPDATE subscribers SET credit_balance = ROUND(COALESCE(credit_balance, 0) + ${rewardAmount}::numeric, 2) WHERE id = ${ref.referrer_id} RETURNING credit_balance`;
              const newBal = Number(refUpd[0].credit_balance);
              await req.prisma.$queryRaw`
                INSERT INTO subscriber_credits (subscriber_id, type, amount, running_balance, notes, created_by)
                VALUES (${ref.referrer_id}, 'referral_reward', ${rewardAmount}, ${newBal},
                        ${`Referral reward — ${refereeName} (${updated.account_number}) activated`},
                        ${'system-referral'})`;
              console.log(`[REFERRAL] Awarded ₱${rewardAmount} credit to referrer ${ref.referrer_id} (new balance ₱${newBal})`);
            }
          }
        }
      } catch (refErr) {
        console.error('[REFERRAL] Conversion/reward failed:', refErr.message);
      }
    }

    // ── Referral link via admin edit (referred by an existing subscriber) ──
    if (req.body.referrerId) {
      try { await linkReferral(req.prisma, { referrerId: req.body.referrerId, referee: updated }); }
      catch (refErr) { console.error('[REFERRAL] Link on update failed:', refErr.message); }
    }

    // Create notification for status changes
    if (data.status && data.status !== sub.status) {
      await req.prisma.notifications.create({
        data: {
          type: data.status === 'active' ? 'success' : data.status === 'suspended' ? 'danger' : 'warning',
          title: `${sub.first_name}${sub.middle_name ? ' ' + sub.middle_name : ''} ${sub.last_name} — account ${data.status}`,
          message: `Account ${sub.account_number} status changed from ${sub.status} to ${data.status}`,
          target_type: 'admin'
        }
      });

      // ── Send status change notifications to subscriber ──
      // Uses centralized templates from notifications.js + sendWithPrisma for DB toggle support
      const statusNotifications = {
        // prospective → surveyed: Survey scheduled
        surveyed: async () => {
          const company = await getCompanyInfo(req.prisma);
          const td = {
            name: sub.first_name,
            accountNumber: sub.account_number,
            address: sub.address,
            scheduleDate: req.body.scheduleDate || 'To be confirmed',
            scheduleTime: req.body.scheduleTime || '',
          };
          if (sub.email) {
            const tmpl = getEmailTemplate('survey_scheduled', td, company);
            if (tmpl) req.config.email.sendWithPrisma(req.prisma, { to: sub.email, subject: tmpl.subject, html: tmpl.html })
              .catch(err => console.error('[EMAIL] Survey scheduled failed:', err.message));
          }
          if (sub.phone) {
            const smsText = getSmsTemplate('survey_scheduled', td, company);
            if (smsText) req.config.sms.sendWithPrisma(req.prisma, sub.phone, smsText)
              .catch(err => console.error('[SMS] Survey scheduled failed:', err.message));
          }
        },
        // approved → pending: Installation scheduled
        pending: async () => {
          const company = await getCompanyInfo(req.prisma);
          const plan = sub.plan_id ? await req.prisma.plans.findUnique({ where: { id: sub.plan_id } }) : null;
          const td = {
            name: sub.first_name,
            accountNumber: sub.account_number,
            plan: plan?.name || '—',
            address: sub.address,
            scheduleDate: req.body.scheduleDate || req.body.installDate || 'To be confirmed',
            scheduleTime: req.body.scheduleTime || req.body.installTime || '',
          };
          if (sub.email) {
            const tmpl = getEmailTemplate('installation_scheduled', td, company);
            if (tmpl) req.config.email.sendWithPrisma(req.prisma, { to: sub.email, subject: tmpl.subject, html: tmpl.html })
              .catch(err => console.error('[EMAIL] Installation scheduled failed:', err.message));
          }
          if (sub.phone) {
            const smsText = getSmsTemplate('installation_scheduled', td, company);
            if (smsText) req.config.sms.sendWithPrisma(req.prisma, sub.phone, smsText)
              .catch(err => console.error('[SMS] Installation scheduled failed:', err.message));
          }
        },
        // pending → active: Welcome with credentials + RADIUS
        active: async () => {
          const company = await getCompanyInfo(req.prisma);
          if (sub.status === 'pending') {
            const plan = sub.plan_id ? await req.prisma.plans.findUnique({ where: { id: sub.plan_id } }) : null;
            const td = {
              name: sub.first_name,
              accountNumber: sub.account_number,
              username: sub.account_number,
              password: activationPassword || defaultPortalPassword(sub.account_number),
              plan: plan?.name || '—',
              speed: plan ? (plan.download_mbps || '') + 'Mbps' : '—',
              monthlyRate: plan?.price ? Number(plan.price).toLocaleString() : '—',
            };
            if (sub.email) {
              const tmpl = getEmailTemplate('welcome_active', td, company);
              if (tmpl) req.config.email.sendWithPrisma(req.prisma, { to: sub.email, subject: tmpl.subject, html: tmpl.html })
                .catch(err => console.error('[EMAIL] Welcome send failed:', err.message));
            }
            if (sub.phone) {
              const smsText = getSmsTemplate('welcome_active', td, company);
              if (smsText) req.config.sms.sendWithPrisma(req.prisma, sub.phone, smsText)
                .catch(err => console.error('[SMS] Welcome send failed:', err.message));
            }
          } else if (sub.status === 'suspended') {
            // Reactivation from suspended — send service_restored
            const restorePrefs = await getPrefs(req.prisma, sub.id);
            const td = { name: sub.first_name, accountNumber: sub.account_number };
            if (restorePrefs.outageAlerts && sub.email) {
              const tmpl = getEmailTemplate('service_restored', td, company);
              if (tmpl) req.config.email.sendWithPrisma(req.prisma, { to: sub.email, subject: tmpl.subject, html: tmpl.html })
                .catch(err => console.error('[EMAIL] Service restored failed:', err.message));
            }
            if (restorePrefs.outageAlerts && sub.phone) {
              const smsText = getSmsTemplate('service_restored', td, company);
              if (smsText) req.config.sms.sendWithPrisma(req.prisma, sub.phone, smsText)
                .catch(err => console.error('[SMS] Service restored failed:', err.message));
            }
          }
        },
        // → suspended: Suspension notice
        suspended: async () => {
          const company = await getCompanyInfo(req.prisma);
          const suspendPrefs = await getPrefs(req.prisma, sub.id);
          const td = {
            name: sub.first_name,
            accountNumber: sub.account_number,
            balance: `₱${Number(sub.balance).toLocaleString()}`,
            reason: req.body.suspensionReason || 'non-payment',
          };
          if (suspendPrefs.outageAlerts && sub.email) {
            const tmpl = getEmailTemplate('account_suspended', td, company);
            if (tmpl) req.config.email.sendWithPrisma(req.prisma, { to: sub.email, subject: tmpl.subject, html: tmpl.html })
              .catch(err => console.error('[EMAIL] Suspension notice failed:', err.message));
          }
          if (suspendPrefs.outageAlerts && sub.phone) {
            const smsText = getSmsTemplate('account_suspended', td, company);
            if (smsText) req.config.sms.sendWithPrisma(req.prisma, sub.phone, smsText)
              .catch(err => console.error('[SMS] Suspension notice failed:', err.message));
          }
        },
        // → disconnected: Disconnection notice
        disconnected: async () => {
          const company = await getCompanyInfo(req.prisma);
          const td = {
            name: sub.first_name,
            accountNumber: sub.account_number,
            reason: req.body.disconnectReason || 'Account closure',
          };
          if (sub.email) {
            const tmpl = getEmailTemplate('account_disconnected', td, company);
            if (tmpl) req.config.email.sendWithPrisma(req.prisma, { to: sub.email, subject: tmpl.subject, html: tmpl.html })
              .catch(err => console.error('[EMAIL] Disconnection notice failed:', err.message));
          }
          if (sub.phone) {
            const smsText = getSmsTemplate('account_disconnected', td, company);
            if (smsText) req.config.sms.sendWithPrisma(req.prisma, sub.phone, smsText)
              .catch(err => console.error('[SMS] Disconnection notice failed:', err.message));
          }
        },
      };

      if (statusNotifications[data.status]) {
        statusNotifications[data.status]().catch(err =>
          console.error("[NOTIFY] Status change notification failed:", err.message)
        );
      }
    }

    // ── Rescheduling: pending → pending with new date (no status change) ──
    if (sub.status === 'pending' && (!data.status || data.status === 'pending') && (req.body.reschedule || req.body.scheduleDate || req.body.installDate)) {
      const company = await getCompanyInfo(req.prisma);
      const plan = sub.plan_id ? await req.prisma.plans.findUnique({ where: { id: sub.plan_id } }) : null;
      const td = {
        name: sub.first_name,
        accountNumber: sub.account_number,
        plan: plan?.name || '—',
        address: sub.address,
        scheduleDate: req.body.scheduleDate || req.body.installDate || 'To be confirmed',
        scheduleTime: req.body.scheduleTime || req.body.installTime || '',
      };
      if (sub.email) {
        const tmpl = getEmailTemplate('installation_scheduled', td, company);
        if (tmpl) req.config.email.sendWithPrisma(req.prisma, { to: sub.email, subject: tmpl.subject, html: tmpl.html })
          .catch(err => console.error('[EMAIL] Reschedule notification failed:', err.message));
      }
      if (sub.phone) {
        const smsText = getSmsTemplate('installation_scheduled', td, company);
        if (smsText) req.config.sms.sendWithPrisma(req.prisma, sub.phone, smsText)
          .catch(err => console.error('[SMS] Reschedule notification failed:', err.message));
      }
      console.log(`[NOTIFY] Reschedule notification sent for ${sub.account_number}`);
    }

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'subscriber_updated', entity_type: 'subscribers', entity_id: id,
        details: { changes: data, previous_status: sub.status },
        ip_address: req.ip
      }
    });
      req.auditLog('SUBSCRIBER_UPDATE', { subscriberId: id, account: updated.account_number, changes: Object.keys(data) }).catch(() => {});

    res.json({
      message: 'Subscriber updated',
      subscriber: {
        id,
        accountNumber: updated.account_number,
        firstName: updated.first_name,
        middleName: updated.middle_name || null,
        lastName: updated.last_name,
        companyName: updated.company_name || null,
        email: updated.email,
        phone: updated.phone,
        address: updated.address,
        subdivision: updated.address_street2 || null,
        barangayId: updated.barangay_id,
        municipalityId: updated.municipality_id,
        status: updated.status,
        macAddress: updated.mac_address || null,
        ontSerial: updated.ont_serial || null,
        routerSerial: updated.router_serial || null,
        latitude: updated.latitude ? Number(updated.latitude) : null,
        longitude: updated.longitude ? Number(updated.longitude) : null,
        installedAt: updated.installed_at,
        installationPackage: updated.installation_package || null,
        notes: updated.notes || null,
      }
    });
  } catch (err) {
    console.error('Update subscriber error:', err);
    res.status(500).json({ error: 'Failed to update subscriber' });
  }
});

// ============================================
// DELETE /api/admin/subscribers/:id - Delete subscriber (superadmin only)
// ============================================
router.delete('/subscribers/:id', adminAuth(), async (req, res) => {
  try {
    if (req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only Super Administrators can delete subscriber accounts' });
    }
    const id = parseInt(req.params.id);
    const sub = await req.prisma.subscribers.findUnique({ where: { id } });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    // Check for payments — block delete if financial transactions exist
    const paymentCount = await req.prisma.payments.count({ where: { subscriber_id: id } });
    if (paymentCount > 0) {
      return res.status(400).json({ error: `Cannot delete subscriber with ${paymentCount} payment record(s). Set status to "disconnected" instead.` });
    }

    // Credits are financial records too — same rule as payments.
    const creditCount = await req.prisma.subscriber_credits.count({ where: { subscriber_id: id } });
    if (creditCount > 0) {
      return res.status(400).json({ error: `Cannot delete subscriber with ${creditCount} credit record(s). Set status to "disconnected" instead.` });
    }

    // An OPEN restriction means this subscriber's MACs are sitting in the
    // plan-restricted RADIUS group and on the router's nf-restricted address list.
    // Deleting the subscriber destroys the only record that could ever lift them,
    // so the cutoff would outlive the account with nothing left to undo it.
    if (radiusDb) {
      try {
        const [openR] = await radiusDb.query(
          'SELECT COUNT(*) AS c FROM subscriber_restrictions WHERE subscriber_id = ? AND lifted_at IS NULL', [id]);
        if (Number(openR && openR[0] ? openR[0].c : 0) > 0) {
          return res.status(400).json({ error: 'Cannot delete a subscriber who is currently restricted. Restore their internet first, then delete.' });
        }
      } catch (e) {
        console.error('Delete subscriber: restriction check failed:', e.message);
        return res.status(503).json({ error: 'Cannot verify restriction status right now, so the subscriber was not deleted. Try again shortly.' });
      }
    }

    // Delete unpaid invoices (safe — no payments were made)
    await req.prisma.invoices.deleteMany({ where: { subscriber_id: id } });

    // Clean up related records
    await req.prisma.subscriber_auth.deleteMany({ where: { subscriber_id: id } });
    await req.prisma.subscriber_notification_prefs.deleteMany({ where: { subscriber_id: id } });
    await req.prisma.subscriber_radius.deleteMany({ where: { subscriber_id: id } });
    await req.prisma.tickets.deleteMany({ where: { subscriber_id: id } });
    await req.prisma.surveys.deleteMany({ where: { subscriber_id: id } });
    await req.prisma.usage_data.deleteMany({ where: { subscriber_id: id } });
    await req.prisma.work_orders.deleteMany({ where: { subscriber_id: id } });

    // subscriber_restrictions is managed with raw SQL and is deliberately not in
    // schema.prisma (see the header there), so it has no prisma model to call.
    // Its FK is NO ACTION, which is what made the delete fail with a bare
    // "Failed to delete subscriber" — the restriction history has to go first.
    if (radiusDb) {
      try {
        await radiusDb.query('DELETE FROM subscriber_restrictions WHERE subscriber_id = ?', [id]);
      } catch (e) {
        console.error('Delete subscriber: restriction cleanup failed:', e.message);
        return res.status(500).json({ error: 'Could not clear the restriction history for this subscriber, so nothing was deleted.' });
      }
    }

    // Unlink nullable FK references
    // Conversations are inbox threads with a person, not with an account — keep the
    // support history and just detach it rather than destroying the messages.
    await req.prisma.conversations.updateMany({ where: { subscriber_id: id }, data: { subscriber_id: null } });
    await req.prisma.onu_inventory.updateMany({ where: { subscriber_id: id }, data: { subscriber_id: null } });
    await req.prisma.nap_ports.updateMany({ where: { subscriber_id: id }, data: { subscriber_id: null, status: 'available' } });

    await req.prisma.subscribers.delete({ where: { id } });

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'subscriber_deleted', entity_type: 'subscribers', entity_id: id,
        details: { account: sub.account_number, name: `${sub.first_name} ${sub.last_name}` },
        ip_address: req.ip
      }
    });
    req.auditLog('SUBSCRIBER_DELETE', { subscriberId: id, account: sub.account_number }).catch(() => {});

    res.json({ message: 'Subscriber deleted successfully' });
  } catch (err) {
    console.error('Delete subscriber error:', err);
    res.status(500).json({ error: 'Failed to delete subscriber' });
  }
});

// ============================================
// POST /api/admin/subscribers/:id/attachments - Upload attachment
// ============================================
const multerSub = require('multer');
const pathLib2 = require('path');
const fsLib2 = require('fs');

const subAttachDir = '/var/www/netfactory.com.ph/html/uploads/subscribers';
if (!fsLib2.existsSync(subAttachDir)) fsLib2.mkdirSync(subAttachDir, { recursive: true });

const ALLOWED_ATTACH_FIELDS = ['proof_of_billing', 'valid_id1', 'valid_id2', 'other_attachment'];

const subAttachStorage = multerSub.diskStorage({
  destination: (req, file, cb) => cb(null, subAttachDir),
  filename: (req, file, cb) => {
    const ext = pathLib2.extname(file.originalname).toLowerCase();
    const field = (req.body.field || req.query.field || 'file').replace(/[^a-z0-9_]/gi, '');
    cb(null, `sub_${req.params.id}_${field}_${Date.now()}${ext}`);
  }
});
const subAttachUpload = multerSub({
  storage: subAttachStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.pdf', '.webp'];
    const ext = pathLib2.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only JPG, PNG, PDF, and WEBP files are allowed'));
  }
});

router.post('/subscribers/:id/attachments', adminAuth(), subAttachUpload.single('file'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const field = req.body.field;
    if (!ALLOWED_ATTACH_FIELDS.includes(field)) return res.status(400).json({ error: 'Invalid attachment field' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const sub = await req.prisma.subscribers.findUnique({ where: { id } });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    // Delete old file if exists
    const oldVal = sub[field];
    if (oldVal) {
      const oldPath = `/var/www/netfactory.com.ph/html${oldVal}`;
      if (fsLib2.existsSync(oldPath)) fsLib2.unlinkSync(oldPath);
    }

    const fileUrl = `/uploads/subscribers/${req.file.filename}`;
    await req.prisma.subscribers.update({ where: { id }, data: { [field]: fileUrl } });

    res.json({ message: 'Attachment uploaded', field, url: fileUrl });
  } catch (err) {
    console.error('Attachment upload error:', err);
    res.status(500).json({ error: err.message || 'Failed to upload attachment' });
  }
});

// ============================================
// DELETE /api/admin/subscribers/:id/attachments/:field - Remove attachment
// ============================================
router.delete('/subscribers/:id/attachments/:field', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const field = req.params.field;
    if (!ALLOWED_ATTACH_FIELDS.includes(field)) return res.status(400).json({ error: 'Invalid attachment field' });

    const sub = await req.prisma.subscribers.findUnique({ where: { id } });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    const oldVal = sub[field];
    if (oldVal) {
      const oldPath = `/var/www/netfactory.com.ph/html${oldVal}`;
      if (fsLib2.existsSync(oldPath)) fsLib2.unlinkSync(oldPath);
    }

    await req.prisma.subscribers.update({ where: { id }, data: { [field]: null } });
    res.json({ message: 'Attachment removed', field });
  } catch (err) {
    console.error('Attachment remove error:', err);
    res.status(500).json({ error: 'Failed to remove attachment' });
  }
});

// ============================================
// GET /api/admin/payment-methods - All active payment methods
// ============================================
router.get("/payment-methods", adminAuth(), async (req, res) => {
  try {
    const methods = await req.prisma.$queryRaw`SELECT id, code, name, description, is_active, sort_order FROM payment_methods WHERE is_active = true ORDER BY sort_order`;
    res.json({ methods });
  } catch (err) {
    console.error("Payment methods error:", err);
    res.status(500).json({ error: "Failed to load payment methods" });
  }
});

// GET /api/admin/invoices - All invoices
// ============================================
// Attribute how much *referral-reward* credit was applied to each invoice.
// Credits are fungible once in the balance, so we reconstruct it by walking each
// subscriber's ledger oldest-first (FIFO): every positive entry is a "lot" tagged
// referral-or-not, and every applied/deduct consumes lots from the front. The
// referral portion consumed by an `applied` entry is booked to its invoice.
// Returns { [invoiceId]: referralAmount }.
async function computeReferralDiscounts(prisma, subIds) {
  const out = {};
  if (!subIds || !subIds.length) return out;
  const ledger = await prisma.subscriber_credits.findMany({
    where: { subscriber_id: { in: subIds } },
    select: { subscriber_id: true, type: true, amount: true, applied_invoice_id: true, created_at: true, id: true },
    orderBy: [{ subscriber_id: 'asc' }, { created_at: 'asc' }, { id: 'asc' }],
  });
  const bySub = {};
  for (const e of ledger) (bySub[e.subscriber_id] = bySub[e.subscriber_id] || []).push(e);
  for (const sid of Object.keys(bySub)) {
    const lots = []; // FIFO queue: { remaining, isReferral }
    for (const e of bySub[sid]) {
      const amt = Number(e.amount);
      if (amt > 0) {
        lots.push({ remaining: amt, isReferral: e.type === 'referral_reward' });
      } else if (amt < 0) {
        let need = -amt, referralConsumed = 0;
        while (need > 0.0001 && lots.length) {
          const lot = lots[0];
          const take = Math.min(lot.remaining, need);
          if (lot.isReferral) referralConsumed += take;
          lot.remaining -= take; need -= take;
          if (lot.remaining <= 0.0001) lots.shift();
        }
        if (e.applied_invoice_id && referralConsumed > 0.0001) {
          out[e.applied_invoice_id] = +( (out[e.applied_invoice_id] || 0) + referralConsumed ).toFixed(2);
        }
      }
    }
  }
  return out;
}

router.get('/invoices', adminAuth(), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const status = req.query.status;

    const where = {};
    if (status && status !== 'all') { if (status.includes(',')) { where.status = { in: status.split(',') }; } else { where.status = status; } }

    const [invoices, total] = await Promise.all([
      req.prisma.invoices.findMany({
        where,
        include: {
          subscriber: { select: { account_number: true, first_name: true, middle_name: true, last_name: true, credit_balance: true } },
          payments: { where: { status: 'success' }, select: { amount: true, method: true, paid_at: true } }
        },
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit
      }),
      req.prisma.invoices.count({ where })
    ]);

    const referralByInvoice = await computeReferralDiscounts(
      req.prisma, [...new Set(invoices.map(i => i.subscriber_id))]
    );

    res.json({
      invoices: invoices.map(inv => ({
        id: inv.id,
        subscriberId: inv.subscriber_id,
        number: inv.invoice_number,
        subscriber: {
          id: inv.subscriber_id,
          accountNumber: inv.subscriber.account_number,
          name: `${inv.subscriber.first_name}${inv.subscriber.middle_name ? ' ' + inv.subscriber.middle_name : ''} ${inv.subscriber.last_name}`,
          creditBalance: Number(inv.subscriber.credit_balance || 0)
        },
        amount: Number(inv.amount),
        period: inv.billing_period,
        dueDate: inv.due_date,
        invoiceDate: inv.generated_at || inv.created_at,
        status: inv.status,
        isAdvance: inv.is_advance === true,
        referralDiscount: referralByInvoice[inv.id] || 0,
        payments: inv.payments.map(p => ({ amount: Number(p.amount), method: p.method, paidAt: p.paid_at }))
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('Invoices list error:', err);
    res.status(500).json({ error: 'Failed to load invoices' });
  }
});


// GET /api/admin/invoices/:id/receipt — thermal receipt (POS58 / POS80)
// Returns a self-contained HTML page sized for a continuous roll that prints
// itself on load. Same query-token auth as /pdf below, because it is opened in
// a print window rather than fetched by the SPA.
//   ?w=58|80   roll width in mm (default 58)
//   ?copies=N  1..5 copies in one job (payer + collector is the usual two)
//   ?auto=0    render without firing the print dialog (for previewing)
router.get('/invoices/:id/receipt', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.query.token;
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded || decoded.type !== 'admin') return res.status(401).json({ error: 'Invalid token' });

    const { renderThermalReceipt, PAPER } = require('../utils/thermalReceipt');
    const width = PAPER[req.query.w] ? parseInt(req.query.w) : 58;
    const copies = Math.min(5, Math.max(1, parseInt(req.query.copies) || 1));
    const html = await renderThermalReceipt(req.prisma, req.params.id, {
      width, copies, autoPrint: req.query.auto !== '0'
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (/not found/i.test(err.message || '')) return res.status(404).json({ error: 'Invoice not found' });
    console.error('Thermal receipt error:', err);
    res.status(500).json({ error: err.message || 'Failed to render receipt' });
  }
});


// GET /api/admin/invoices/:id/pdf — Download invoice as PDF
// Accepts token via Authorization header OR ?token= query param (for browser/print)
router.get('/invoices/:id/pdf', async (req, res) => {
  try {
    // Accept token from header OR query parameter
    const token = req.headers.authorization?.split(' ')[1] || req.query.token;
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded) return res.status(401).json({ error: 'Invalid token' });

    const { generateInvoicePDF } = require('../utils/invoicePdf');
    const pdfBuffer = await generateInvoicePDF(req.prisma, req.params.id);

    const invoice = await req.prisma.invoices.findUnique({
      where: { id: parseInt(req.params.id) },
      select: { invoice_number: true }
    });

    const filename = `${invoice?.invoice_number || 'invoice'}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    console.error('Invoice PDF error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate PDF' });
  }
});




// ============================================
// POST /api/admin/invoices/create - Single invoice (activation, one-off)
// ============================================
router.post('/invoices/create', adminAuth(), async (req, res) => {
  try {
    const { subscriberId, amount, billingPeriod, dueDate, description, notes, type, isAdvance } = req.body;

    if (!subscriberId || !amount || !dueDate) {
      return res.status(400).json({ error: 'subscriberId, amount, and dueDate are required' });
    }

    const subscriber = await req.prisma.subscribers.findUnique({
      where: { id: parseInt(subscriberId) },
      include: { plan: true }
    });
    if (!subscriber) {
      return res.status(404).json({ error: 'Subscriber not found' });
    }

    // Generate invoice number: INV-YYMM#### (4-digit sequential, resets monthly)
    const yy = String(new Date().getFullYear()).slice(-2);
    const mm = String(new Date().getMonth() + 1).padStart(2, '0');
    const prefix = `INV-${yy}${mm}`;
    const maxInv = await req.prisma.$queryRawUnsafe(
      "SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 9 FOR 4) AS INTEGER)), 0) + 1 AS next_num FROM invoices WHERE invoice_number LIKE $1 AND LENGTH(invoice_number) = 12",
      prefix + '%'
    );
    const invoiceNumber = `${prefix}${String(maxInv[0].next_num).padStart(4, '0')}`;

    const MANUAL_CATS = ['subscription', 'installation', 'reconnection', 'other'];
    const isManualCat = MANUAL_CATS.includes((billingPeriod || '').toLowerCase());

    const invoice = await req.prisma.invoices.create({
      data: {
        subscriber_id: parseInt(subscriberId),
        invoice_number: invoiceNumber,
        amount: parseFloat(amount),
        billing_period: billingPeriod || "Activation",
        due_date: new Date(dueDate),
        status: "pending",
        // An advance invoice collects money before there is service to bill for — a
        // downpayment taken while the customer is still 'approved', with no plan, no
        // ONU and no period to consume. Paying it credits the subscriber instead of
        // settling a service charge, so the money is still there when the first real
        // invoice is raised. The emailed pay link works exactly as it does for any
        // other invoice; only what happens on payment differs.
        is_advance: isAdvance === true || isAdvance === 'true',
        notes: [
          // For manual category invoices, only store what the user typed — no plan info
          !isManualCat && subscriber.plan ? `${subscriber.plan.name} (${subscriber.plan.speed_mbps} Mbps) — Service for ${billingPeriod || 'Activation'}` : null,
          type ? `TYPE: ${type.toUpperCase()}` : null,
          description || null,
          notes || null,
        ].filter(Boolean).join('\n') || null,
      }
    });

    // Update subscriber balance
    await req.prisma.subscribers.update({
      where: { id: parseInt(subscriberId) },
      data: { balance: { increment: parseFloat(amount) } }
    });

    // Audit log
    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin',
        user_id: req.adminId || 0,
        action: 'invoice_created',
        entity_type: 'invoices',
        entity_id: invoice.id,
        details: { type: type || 'manual', amount, subscriberId: parseInt(subscriberId), invoiceNumber },
        ip_address: req.ip,
      }
    }).catch(() => {});
      req.auditLog('INVOICE_CREATE', { invoice: invoiceNumber, amount, subscriberId: parseInt(subscriberId), advance: invoice.is_advance || undefined }).catch(() => {});

    res.status(201).json({
      message: 'Invoice created successfully',
      id: invoice.id,
      invoiceNumber: invoice.invoice_number,
      number: invoice.invoice_number,
      amount: Number(invoice.amount),
    });
  } catch (err) {
    console.error('Create invoice error:', err);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// ============================================
// POST /api/admin/invoices/generate - Monthly batch
// ✅ UPDATED: Sends invoice reminder email/SMS to each subscriber
// ============================================
router.post('/invoices/generate', adminAuth(), async (req, res) => {
  try {
    const { billingPeriod, dueDate, sendNotifications } = req.body;

    if (!billingPeriod || !dueDate) {
      return res.status(400).json({ error: 'billingPeriod and dueDate required' });
    }

    // Get all active subscribers (skip system / dummy accounts)
    const activeSubscribers = await req.prisma.subscribers.findMany({
      where: { status: { in: ['active', 'suspended'] }, plan_id: { not: null }, is_system: false },
      include: { plan: true }
    });

    // Check for existing invoices this period
    const existing = await req.prisma.invoices.findMany({
      where: { billing_period: billingPeriod },
      select: { subscriber_id: true }
    });
    const existingIds = new Set(existing.map(e => e.subscriber_id));

    let created = 0;
    let skipped = 0;
    let notified = 0;

    // Get next sequential number for this month's invoices
    const bulkYY = String(new Date().getFullYear()).slice(-2);
    const bulkMM = String(new Date().getMonth() + 1).padStart(2, '0');
    const bulkPrefix = `INV-${bulkYY}${bulkMM}`;
    const bulkMax = await req.prisma.$queryRawUnsafe(
      "SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 9 FOR 4) AS INTEGER)), 0) AS max_num FROM invoices WHERE invoice_number LIKE $1 AND LENGTH(invoice_number) = 12",
      bulkPrefix + '%'
    );
    let bulkSeq = bulkMax[0].max_num;

    // Format due date for notifications
    const dueDateFormatted = new Date(dueDate).toLocaleDateString('en-PH', {
      year: 'numeric', month: 'short', day: 'numeric'
    });

    for (const sub of activeSubscribers) {
      if (existingIds.has(sub.id)) {
        skipped++;
        continue;
      }

      bulkSeq++;
      const invoiceNumber = `${bulkPrefix}${String(bulkSeq).padStart(4, '0')}`;

      await req.prisma.invoices.create({
        data: {
          subscriber_id: sub.id,
          invoice_number: invoiceNumber,
          amount: sub.plan.price,
          notes: `${sub.plan.name} (${sub.plan.speed_mbps} Mbps) — Service for ${billingPeriod}`,
          billing_period: billingPeriod,
          due_date: new Date(dueDate),
          status: 'pending'
        }
      });

      // Update subscriber balance
      await req.prisma.subscribers.update({
        where: { id: sub.id },
        data: { balance: { increment: Number(sub.plan.price) }, next_bill_date: new Date(dueDate) }
      });

      created++;

      // ── Auto-apply subscriber credit (if available) ──
      try {
        const subCreditRow = await req.prisma.$queryRaw`
          SELECT credit_balance FROM subscribers WHERE id = ${sub.id}
        `;
        const availableCredit = Number(subCreditRow[0]?.credit_balance || 0);
        if (availableCredit > 0) {
          const invAmount = Number(sub.plan.price);
          const creditToApply = Math.min(availableCredit, invAmount);

          // Create payment record from credit
          await req.prisma.payments.create({
            data: {
              invoice_id: (await req.prisma.invoices.findFirst({ where: { invoice_number: invoiceNumber } })).id,
              subscriber_id: sub.id,
              amount: creditToApply,
              method: 'credit',
              reference_number: 'CREDIT-AUTO-' + invoiceNumber,
              status: 'success',
              paid_at: new Date()
            }
          });

          // Update invoice status
          const invObj = await req.prisma.invoices.findFirst({ where: { invoice_number: invoiceNumber } });
          const newInvStatus = creditToApply >= invAmount ? 'paid' : 'partial';
          await req.prisma.invoices.update({
            where: { id: invObj.id },
            data: { status: newInvStatus }
          });

          // Reduce subscriber balance by credit applied (since we just incremented it)
          await req.prisma.subscribers.update({
            where: { id: sub.id },
            data: { balance: { decrement: creditToApply } }
          });

          // Deduct from credit_balance — atomic, returns authoritative post-update balance
          const credUpd = await req.prisma.$queryRaw`
            UPDATE subscribers SET credit_balance = ROUND(GREATEST(COALESCE(credit_balance, 0) - ${creditToApply}::numeric, 0), 2) WHERE id = ${sub.id} RETURNING credit_balance
          `;
          const newCreditBal = Number(credUpd[0].credit_balance);

          // Record credit application
          await req.prisma.$queryRaw`
            INSERT INTO subscriber_credits (subscriber_id, type, amount, running_balance, applied_invoice_id, notes, created_by)
            VALUES (${sub.id}, 'applied', ${-creditToApply}, ${newCreditBal}, ${invObj.id},
                    ${'Auto-applied to invoice ' + invoiceNumber},
                    'system')
          `;

          // Sync AR: if credit fully paid, also record in AR
          try {
            const subName = (sub.first_name + ' ' + sub.last_name).trim();
            const subAddr = [sub.address, sub.barangay_name, sub.municipality_name].filter(Boolean).join(', ');
            const arNew = await req.prisma.$queryRaw`
              INSERT INTO accounts_receivable
                (invoice_number, subscriber_id, customer_name, customer_address, invoice_date, due_date, total_amount, amount_paid, category, description, billing_invoice_id, created_by)
              VALUES (${invoiceNumber}, ${sub.id}, ${subName}, ${subAddr || ''},
                CURRENT_DATE, ${new Date(dueDate)}::date, ${invAmount}, 0, 'subscription',
                ${'Billing invoice ' + invoiceNumber}, ${invObj.id}, 'system')
              ON CONFLICT (billing_invoice_id) DO NOTHING
              RETURNING id
            `;
            if (arNew.length > 0) {
              await recordArPayment(req.prisma, {
                arId: arNew[0].id,
                amount: creditToApply,
                method: 'credit',
                referenceNumber: 'CREDIT-AUTO-' + invoiceNumber,
                notes: 'Credit auto-applied to ' + invoiceNumber,
                receivedBy: 'system',
              });
            }
          } catch (arErr) { console.error('Credit AR sync error:', arErr.message); }
        }
      } catch (creditErr) { console.error('Credit auto-apply error for', sub.account_number, ':', creditErr.message); }

      // ── Send invoice reminder notifications (unless explicitly disabled) ──
      if (sendNotifications !== false) {
        const amount = `₱${Number(sub.plan.price).toLocaleString()}`;
        const reminderPrefs = await getPrefs(req.prisma, sub.id);

        // Email notification
        if (reminderPrefs.emailBilling && sub.email) {
          req.config.email.sendTemplateWithPrisma(req.prisma, sub.email, 'invoice_reminder', {
            name: sub.first_name,
            amount,
            dueDate: dueDateFormatted,
            invoiceNumber,
          }).catch(err => console.error(`[EMAIL] Invoice reminder failed for ${sub.account_number}:`, err.message));
        }

        // SMS notification
        if (reminderPrefs.smsPayment && sub.phone) {
          req.config.sms.sendTemplateWithPrisma(req.prisma, sub.phone, 'invoice_reminder', {
            amount,
            dueDate: dueDateFormatted,
            invoiceNumber,
          }).catch(err => console.error(`[SMS] Invoice reminder failed for ${sub.account_number}:`, err.message));
        }

        notified++;
      }
    }

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'invoices_batch_generated', entity_type: 'invoices',
        details: { billingPeriod, dueDate, created, skipped, notified, total: activeSubscribers.length },
        ip_address: req.ip
      }
    });

    res.json({ message: `Invoices generated`, created, skipped, notified, total: activeSubscribers.length });
  } catch (err) {
    console.error('Generate invoices error:', err);
    res.status(500).json({ error: 'Failed to generate invoices' });
  }
});

// ============================================
// GET /api/admin/tickets - All tickets
// ============================================
router.get('/tickets', adminAuth(), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const status = req.query.status;
    const priority = req.query.priority;

    const where = {};
    if (status && status !== 'all') { if (status.includes(',')) { where.status = { in: status.split(',') }; } else { where.status = status; } }
    if (priority && priority !== 'all') where.priority = priority;

    const [tickets, total] = await Promise.all([
      req.prisma.tickets.findMany({
        where,
        include: {
          subscriber: { select: { account_number: true, first_name: true, middle_name: true, last_name: true } },
          admin: { select: { id: true, full_name: true } },
          updates: { orderBy: { created_at: 'desc' }, take: 3 }
        },
        orderBy: [{ priority: 'asc' }, { created_at: 'desc' }],
        skip: (page - 1) * limit,
        take: limit
      }),
      req.prisma.tickets.count({ where })
    ]);

    res.json({
      tickets: tickets.map(tk => ({
        id: tk.id,
        number: tk.ticket_number,
        subscriber: {
          accountNumber: tk.subscriber.account_number,
          name: `${tk.subscriber.first_name}${tk.subscriber.middle_name ? ' ' + tk.subscriber.middle_name : ''} ${tk.subscriber.last_name}`
        },
        category: tk.category,
        priority: tk.priority,
        status: tk.status,
        subject: tk.subject,
        description: tk.description,
        assignedTo: tk.admin ? { id: tk.admin.id, name: tk.admin.full_name } : null,
        createdAt: tk.created_at,
        latestUpdates: tk.updates.map(u => ({ message: u.message, by: u.created_by, date: u.created_at }))
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('Tickets list error:', err);
    res.status(500).json({ error: 'Failed to load tickets' });
  }
});


// ============================================
// GET /api/admin/tickets/:id - Get ticket details
// ============================================
router.get('/tickets/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const ticket = await req.prisma.tickets.findUnique({
      where: { id },
      include: {
        subscriber: { select: { id: true, account_number: true, first_name: true, last_name: true, email: true, phone: true } },
        admin: { select: { id: true, full_name: true } },
        updates: { orderBy: { created_at: 'desc' }, include: { } }
      }
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json({
      id: ticket.id,
      number: ticket.ticket_number,
      subscriber: {
        id: ticket.subscriber.id,
        accountNumber: ticket.subscriber.account_number,
        name: `${ticket.subscriber.first_name}${ticket.subscriber.middle_name ? ' ' + ticket.subscriber.middle_name : ''} ${ticket.subscriber.last_name}`,
        email: ticket.subscriber.email,
        phone: ticket.subscriber.phone
      },
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      subject: ticket.subject,
      description: ticket.description,
      assignedTo: ticket.admin ? { id: ticket.admin.id, name: ticket.admin.full_name } : null,
      createdAt: ticket.created_at,
      resolvedAt: ticket.resolved_at,
      closedAt: ticket.closed_at,
      updates: ticket.updates.map(u => ({
        id: u.id,
        message: u.message,
        createdBy: u.created_by,
        isInternal: u.is_internal,
        createdAt: u.created_at
      }))
    });
  } catch (err) {
    console.error('Get ticket error:', err);
    res.status(500).json({ error: 'Failed to load ticket' });
  }
});

// ============================================
// PUT /api/admin/tickets/:id - Update ticket
// ✅ UPDATED: Sends ticket update SMS to subscriber
// ============================================
router.put('/tickets/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status, priority, assignedTo, message, isInternal } = req.body;

    const ticket = await req.prisma.tickets.findUnique({
      where: { id },
      include: { subscriber: { select: { phone: true, email: true, first_name: true } } }
    });

    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const data = {};
    if (status) data.status = status;
    if (priority) data.priority = priority;
    if (assignedTo !== undefined) data.assigned_to = assignedTo ? parseInt(assignedTo) : null;
    if (status === 'resolved') data.resolved_at = new Date();
    if (status === 'closed') data.closed_at = new Date();

    await req.prisma.tickets.update({ where: { id }, data });

    // Add update message if provided
    if (message) {
      await req.prisma.ticket_updates.create({
        data: {
          ticket_id: id,
          message: message.trim(),
          created_by: req.admin.full_name,
          is_internal: isInternal || false
        }
      });
    }

    // ── Send ticket update SMS to subscriber (only for non-internal updates) ──
    if (status && status !== ticket.status && !isInternal) {
      const statusLabels = {
        in_progress: 'In Progress',
        resolved: 'Resolved',
        closed: 'Closed',
        open: 'Open',
      };

      if (ticket.subscriber?.phone) {
        req.config.sms.sendTemplateWithPrisma(req.prisma, ticket.subscriber.phone, 'ticket_update', {
          ticketId: ticket.ticket_number,
          status: statusLabels[status] || status,
        }).catch(err => console.error('[SMS] Ticket update failed:', err.message));
      }

      // Also send email for resolved/closed tickets
      if ((status === 'resolved' || status === 'closed') && ticket.subscriber?.email) {
        req.config.email.sendWithPrisma(req.prisma, {
          to: ticket.subscriber.email,
          subject: `Ticket ${ticket.ticket_number} — ${statusLabels[status] || status}`,
          html: `
            <h2>Ticket Update</h2>
            <p>Hi ${ticket.subscriber.first_name},</p>
            <p>Your support ticket <strong>${ticket.ticket_number}</strong> has been marked as <strong>${statusLabels[status] || status}</strong>.</p>
            ${message && !isInternal ? `<p><strong>Note:</strong> ${message}</p>` : ''}
            <p>If you have any further concerns, you can open a new ticket through the Customer Portal.</p>
            <p>— ${(await getCompany(req.prisma).catch(() => null))?.name || 'Netfactory'} Support</p>
          `,
        }).catch(err => console.error('[EMAIL] Ticket update failed:', err.message));
      }
    }

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'ticket_updated', entity_type: 'tickets', entity_id: id,
        details: data, ip_address: req.ip
      }
    });
      req.auditLog('TICKET_UPDATE', { ticketId: id, changes: data }).catch(() => {});

    res.json({ message: 'Ticket updated' });
  } catch (err) {
    console.error('Update ticket error:', err);
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});


// ============================================
// POST /api/admin/tickets - Create ticket from CRM
// ============================================
router.post('/tickets', adminAuth(), async (req, res) => {
  try {
    const { subscriberId, category, priority, subject, description, assignedTo } = req.body;
    if (!subscriberId || !category || !subject) {
      return res.status(400).json({ error: 'subscriberId, category, and subject are required' });
    }

    const subscriber = await req.prisma.subscribers.findUnique({ where: { id: parseInt(subscriberId) } });
    if (!subscriber) return res.status(404).json({ error: 'Subscriber not found' });

    const now = new Date(); const yy = String(now.getFullYear()).slice(-2); const mm = String(now.getMonth()+1).padStart(2,'0'); const lastTicket = await req.prisma.tickets.findFirst({ orderBy: { id: 'desc' } });
    const seq = (lastTicket ? lastTicket.id : 0) + 1; const ticketNumber = `TKT-${yy}${mm}${String(seq).padStart(5, '0')}`;

    const ticket = await req.prisma.tickets.create({
      data: {
        ticket_number: ticketNumber,
        subscriber_id: parseInt(subscriberId),
        category: category,
        priority: priority || 'medium',
        subject: subject.trim(),
        description: (description || '').trim(),
        status: 'open',
        assigned_to: assignedTo ? parseInt(assignedTo) : null,
      }
    });

    // Log it
    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'ticket_created', entity_type: 'tickets', entity_id: ticket.id,
        details: { ticketNumber, category, priority: priority || 'medium' },
        ip_address: req.ip
      }
    });
      req.auditLog('TICKET_CREATE', { ticket: ticketNumber, category, priority: priority || 'medium' }).catch(() => {});

    // Notification
    await req.prisma.notifications.create({
      data: {
        type: 'info',
        title: `Ticket ${ticketNumber} created`,
        message: `${req.admin.full_name} created ticket ${ticketNumber}: ${subject}`,
        target_type: 'admin'
      }
    });

    res.status(201).json({
      message: 'Ticket created',
      ticket: { id: ticket.id, number: ticketNumber, status: 'open' }
    });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Duplicate ticket number, please retry' });
    console.error('Create ticket error:', err);
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});


// ============================================
// POST /api/admin/tickets/:id/duplicate - Duplicate a ticket
// ============================================
router.post('/tickets/:id/duplicate', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const original = await req.prisma.tickets.findUnique({
      where: { id },
      include: { subscriber: { select: { first_name: true, last_name: true } } }
    });
    if (!original) return res.status(404).json({ error: 'Ticket not found' });

    const now = new Date(); const yy = String(now.getFullYear()).slice(-2); const mm = String(now.getMonth()+1).padStart(2,'0'); const lastTicket = await req.prisma.tickets.findFirst({ orderBy: { id: 'desc' } });
    const seq = (lastTicket ? lastTicket.id : 0) + 1; const ticketNumber = `TKT-${yy}${mm}${String(seq).padStart(5, '0')}`;

    const ticket = await req.prisma.tickets.create({
      data: {
        ticket_number: ticketNumber,
        subscriber_id: original.subscriber_id,
        category: original.category,
        priority: original.priority,
        subject: `[COPY] ${original.subject}`,
        description: original.description,
        status: 'open',
        assigned_to: original.assigned_to,
      }
    });

    await req.prisma.ticket_updates.create({
      data: {
        ticket_id: ticket.id,
        message: `Duplicated from ticket ${original.ticket_number}`,
        created_by: req.admin.full_name,
        is_internal: true
      }
    });

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'ticket_duplicated', entity_type: 'tickets', entity_id: ticket.id,
        details: { originalTicket: original.ticket_number, newTicket: ticketNumber },
        ip_address: req.ip
      }
    });

    res.status(201).json({
      message: 'Ticket duplicated',
      ticket: { id: ticket.id, number: ticketNumber, status: 'open', originalNumber: original.ticket_number }
    });
  } catch (err) {
    console.error('Duplicate ticket error:', err);
    res.status(500).json({ error: 'Failed to duplicate ticket' });
  }
});

// ============================================
// PUT /api/admin/tickets/:id/archive - Archive/unarchive a ticket
// ============================================
router.put('/tickets/:id/archive', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { archive } = req.body; // true to archive, false to unarchive

    const ticket = await req.prisma.tickets.findUnique({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const updateData = { status: archive ? 'archived' : 'closed' };
    if (archive) { updateData.closed_at = new Date(); }
    await req.prisma.tickets.update({ where: { id }, data: updateData });

    await req.prisma.ticket_updates.create({
      data: {
        ticket_id: id,
        message: archive ? 'Ticket archived' : 'Ticket unarchived',
        created_by: req.admin.full_name,
        is_internal: true
      }
    });

    res.json({ message: archive ? 'Ticket archived' : 'Ticket unarchived' });
  } catch (err) {
    console.error('Archive ticket error:', err);
    res.status(500).json({ error: 'Failed to archive ticket' });
  }
});

// ============================================
// DEBUG: Simple plans query
router.get('/plans-debug', adminAuth(), async (req, res) => {
  try {
    const plans = await req.prisma.plans.findMany();
    res.json({ count: plans.length, plans: plans.map(p => ({ id: p.id, name: p.name })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/plans - All plans (including inactive)
// ============================================
router.get('/plans', adminAuth(), async (req, res) => {
  try {
    const plans = await req.prisma.plans.findMany({
      include: {
        features: { orderBy: { sort_order: 'asc' } },
        subscribers: { where: { status: 'active' }, select: { id: true } }
      },
      orderBy: { sort_order: 'asc' }
    });

    res.json({
      plans: plans.map(p => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        speedMbps: p.speed_mbps,
        speedLabel: p.speed_label,
        price: Number(p.price),
        description: p.description,
        longDescription: p.long_description,
        color: p.color_hex,
        isPopular: p.is_popular,
        isActive: p.is_active,
        sortOrder: p.sort_order,
        dataCap: p.data_cap_gb,
        routerType: p.router_type,
        hasLockIn: p.has_lock_in,
        lockInMonths: p.lock_in_months,
        installationFee: Number(p.installation_fee || 0),
        activationFee: Number(p.activation_fee || 0),
        showFeesOnWebsite: p.show_fees_on_website || false,
        burstDownloadMbps: p.burst_download_mbps,
        burstUploadMbps:   p.burst_upload_mbps,
        burstThresholdPct: p.burst_threshold_pct,
        burstTimeS:        p.burst_time_s,
        billingType: p.billing_type || 'postpaid',
        validityPeriod: p.validity_period,
        subscriberCount: p.subscribers.length,
        features: p.features.map(f => ({
          id: f.id,
          text: f.feature_text,
          isActive: f.is_active,
          sortOrder: f.sort_order
        }))
      }))
    });
  } catch (err) {
    console.error('Plans list error:', err);
    res.status(500).json({ error: 'Failed to load plans' });
  }
});

// ============================================
// PUT /api/admin/plans/:id - Edit plan (enable/disable, pricing, info)
// ============================================
router.put('/plans/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const plan = await req.prisma.plans.findUnique({ where: { id } });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const { name, speedMbps, speedLabel, price, description, longDescription, colorHex, isPopular, isActive, sortOrder, dataCap, routerType, hasLockIn, lockInMonths, installationFee, activationFee, showFeesOnWebsite, features } = req.body;

    const data = {};
    if (name !== undefined) data.name = name;
    if (speedMbps !== undefined) data.speed_mbps = parseInt(speedMbps);
    if (speedLabel !== undefined) data.speed_label = speedLabel;
    if (price !== undefined) data.price = parseFloat(price) || 0;
    if (description !== undefined) data.description = description;
    if (longDescription !== undefined) data.long_description = longDescription;
    if (colorHex !== undefined) data.color_hex = colorHex;
    if (isPopular !== undefined) data.is_popular = isPopular;
    if (isActive !== undefined) data.is_active = isActive;
    if (req.body.allowedPages !== undefined) data.allowed_pages = req.body.allowedPages;
    if (req.body.allowedPages !== undefined) data.allowed_pages = req.body.allowedPages;
    if (sortOrder !== undefined) data.sort_order = parseInt(sortOrder);
    if (dataCap !== undefined) data.data_cap_gb = dataCap;
    if (routerType !== undefined) data.router_type = routerType;
    if (hasLockIn !== undefined) data.has_lock_in = hasLockIn;
    if (lockInMonths !== undefined) data.lock_in_months = lockInMonths;
    if (activationFee !== undefined) data.activation_fee = parseFloat(activationFee);
    if (showFeesOnWebsite !== undefined) data.show_fees_on_website = showFeesOnWebsite;
    if (installationFee !== undefined) data.installation_fee = parseFloat(installationFee);
    // Keep radius_group in sync with slug
    data.radius_group = plan.slug;
    // Sync download/upload if speed changed
    if (speedMbps !== undefined) {
      data.download_mbps = parseInt(speedMbps);
      data.upload_mbps = parseInt(speedMbps);
    }
    // Burst shaping. Empty / 0 / null all mean "no burst on this plan".
    const numOrNull = v => (v === '' || v === null || v === undefined) ? null : (parseInt(v, 10) || null);
    if (req.body.burstDownloadMbps !== undefined) data.burst_download_mbps = numOrNull(req.body.burstDownloadMbps);
    if (req.body.burstUploadMbps   !== undefined) data.burst_upload_mbps   = numOrNull(req.body.burstUploadMbps);
    if (req.body.burstThresholdPct !== undefined) data.burst_threshold_pct = numOrNull(req.body.burstThresholdPct);
    if (req.body.burstTimeS        !== undefined) data.burst_time_s        = numOrNull(req.body.burstTimeS);

    // Prepaid. billingType and validityPeriod are a pair — a prepaid plan with no
    // validity period sells an unbounded amount of time for a fixed price, and the
    // expiry job would never pick it up (isPrepaidPlan requires both), so the plan
    // would look prepaid in the CRM and behave postpaid on the network.
    if (req.body.billingType !== undefined) {
      const bt = String(req.body.billingType).toLowerCase();
      if (!['postpaid', 'prepaid'].includes(bt)) {
        return res.status(400).json({ error: 'billingType must be "postpaid" or "prepaid"' });
      }
      data.billing_type = bt;
      if (bt === 'prepaid') {
        const vp = parseInt(req.body.validityPeriod, 10);
        if (!(vp > 0)) {
          return res.status(400).json({ error: 'A prepaid plan needs validityPeriod (days) greater than 0' });
        }
        data.validity_period = vp;
      }
    } else if (req.body.validityPeriod !== undefined) {
      data.validity_period = numOrNull(req.body.validityPeriod);
    }

    // Switching a plan that has live subscribers changes how they are billed and cut
    // off, so it is refused rather than applied quietly. Move the subscribers first.
    if (data.billing_type && data.billing_type !== plan.billing_type) {
      const inUse = await req.prisma.subscribers.count({
        where: { plan_id: id, status: { in: ['active', 'suspended'] } } });
      if (inUse > 0 && req.body.confirmBillingTypeChange !== true) {
        return res.status(409).json({
          error: `${inUse} active subscriber(s) are on this plan. Changing its billing type changes how they are billed and disconnected. Re-send with confirmBillingTypeChange:true to proceed.`,
          subscriberCount: inUse,
        });
      }
    }

    await req.prisma.plans.update({ where: { id }, data });

    // Update features if provided
    if (features && Array.isArray(features)) {
      // Delete existing and recreate
      await req.prisma.plan_features.deleteMany({ where: { plan_id: id } });
      for (let i = 0; i < features.length; i++) {
        await req.prisma.plan_features.create({
          data: {
            plan_id: id,
            feature_text: features[i].text || features[i],
            sort_order: i + 1,
            is_active: features[i].isActive !== undefined ? features[i].isActive : true
          }
        });
      }
    }

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'plan_updated', entity_type: 'plans', entity_id: id,
        details: { changes: data, previousActive: plan.is_active },
        ip_address: req.ip
      }
    });
      req.auditLog('PLAN_CHANGE', { planId: id, changes: data }).catch(() => {});

    res.json({ message: `Plan "${plan.name}" updated` });
    // Auto-sync to RADIUS
    const updatedPlan = await req.prisma.plans.findUnique({ where: { id } });
    if (updatedPlan) syncPlanToRadius(updatedPlan.slug, updatedPlan.download_mbps || updatedPlan.speed_mbps, updatedPlan.upload_mbps || updatedPlan.speed_mbps, updatedPlan.is_active, updatedPlan);
  } catch (err) {
    console.error('Update plan error:', err);
    res.status(500).json({ error: 'Failed to update plan' });
  }
});

// ============================================
// POST /api/admin/plans - Create new plan
// ============================================
router.post('/plans', adminAuth(), async (req, res) => {
  try {
    const { name, slug, speedMbps, speedLabel, price, description, colorHex, isPopular, sortOrder, routerType, installationFee, activationFee, showFeesOnWebsite, features } = req.body;

    if (!name || !speedMbps || !speedLabel || price === undefined || price === null || price === '') {
      return res.status(400).json({ error: 'Required: name, speedMbps, speedLabel, price' });
    }

    // Prepaid plans must carry a validity period. Without one the plan sells time
    // with no end, isPrepaidPlan() rejects it, and the expiry job silently never
    // touches its subscribers — prepaid in the CRM, postpaid on the network.
    const billingType = String(req.body.billingType || 'postpaid').toLowerCase();
    if (!['postpaid', 'prepaid'].includes(billingType)) {
      return res.status(400).json({ error: 'billingType must be "postpaid" or "prepaid"' });
    }
    const validityPeriod = parseInt(req.body.validityPeriod, 10);
    if (billingType === 'prepaid' && !(validityPeriod > 0)) {
      return res.status(400).json({ error: 'A prepaid plan needs validityPeriod (days) greater than 0' });
    }

    const plan = await req.prisma.plans.create({
      data: {
        name: name.toUpperCase(),
        slug: slug || name.toLowerCase().replace(/\s+/g, '-'),
        speed_mbps: parseInt(speedMbps),
        speed_label: speedLabel,
        price: parseFloat(price),
        description: description || null,
        color_hex: colorHex || '#3b82f6',
        is_popular: isPopular || false,
        sort_order: sortOrder || 0,
        router_type: routerType || null,
        installation_fee: parseFloat(installationFee) || 0,
        activation_fee: parseFloat(activationFee) || 0,
        show_fees_on_website: showFeesOnWebsite || false,
        radius_group: slug || name.toLowerCase().replace(/\s+/g, '-'),
        download_mbps: parseInt(speedMbps),
        upload_mbps: parseInt(speedMbps),
        burst_download_mbps: parseInt(req.body.burstDownloadMbps, 10) || null,
        burst_upload_mbps:   parseInt(req.body.burstUploadMbps, 10) || null,
        burst_threshold_pct: parseInt(req.body.burstThresholdPct, 10) || 80,
        burst_time_s:        parseInt(req.body.burstTimeS, 10) || 16,
        billing_type: billingType,
        validity_period: billingType === 'prepaid' ? validityPeriod : null
      }
    });

    // Add features
    if (features && Array.isArray(features)) {
      for (let i = 0; i < features.length; i++) {
        await req.prisma.plan_features.create({
          data: { plan_id: plan.id, feature_text: typeof features[i] === 'string' ? features[i] : features[i].text, sort_order: i + 1 }
        });
      }
    }

    res.status(201).json({ message: 'Plan created', plan: { id: plan.id, name: plan.name, slug: plan.slug } });
    // Auto-sync to RADIUS
    syncPlanToRadius(plan.slug, parseInt(speedMbps), parseInt(speedMbps), true, plan);
  } catch (err) {
    console.error('Create plan error:', err);
    res.status(500).json({ error: 'Failed to create plan' });
  }
});

// ============================================
// DELETE /api/admin/plans/:id - Delete a plan
// ============================================
// Deliberately narrow. A plan is the only surviving record of what a historical
// invoice was for — invoices store an amount and nothing else, and the invoice/SOA
// PDFs read the plan live off subscribers.plan_id. So this refuses anything that
// still carries meaning and exists only to remove a plan created by mistake.
// Everything it declines can be retired instead with the Active toggle, which is
// what the rest of the system already expects.
router.delete('/plans/:id', adminAuth(), async (req, res) => {
  try {
    // Administrators and Super Administrators only. Everything below still applies
    // to both — the role check decides who may ask, the guards decide what may go.
    const PLAN_DELETE_ROLES = ['superadmin', 'admin'];
    if (!PLAN_DELETE_ROLES.includes(req.admin.role)) {
      return res.status(403).json({ error: 'Only Administrators and Super Administrators can delete plans' });
    }

    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid plan id' });

    const plan = await req.prisma.plans.findUnique({
      where: { id },
      include: { features: { orderBy: { sort_order: 'asc' } } }
    });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    // ── Guard 1: subscribers. Counts EVERY status, not just active — a
    // disconnected subscriber's billing history is exactly what this protects.
    // Postgres would refuse anyway (subscribers_plan_id_fkey is ON DELETE NO ACTION),
    // but a raw FK violation reaches the user as "Failed to delete plan", so the
    // check is here to say which subscribers and what to do about them.
    const subs = await req.prisma.subscribers.findMany({
      where: { plan_id: id },
      select: { account_number: true, first_name: true, last_name: true, status: true },
      orderBy: { account_number: 'asc' }
    });
    if (subs.length > 0) {
      const byStatus = {};
      subs.forEach(x => { byStatus[x.status] = (byStatus[x.status] || 0) + 1; });
      const breakdown = Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(', ');
      return res.status(409).json({
        error: `Cannot delete "${plan.name}" — ${subs.length} subscriber${subs.length !== 1 ? 's are' : ' is'} still on this plan (${breakdown}). Move them to another plan first, or set the plan to Inactive instead.`,
        reason: 'subscribers_linked',
        subscriberCount: subs.length,
        byStatus,
        subscribers: subs.slice(0, 20).map(x => ({
          account: x.account_number,
          name: [x.first_name, x.last_name].filter(Boolean).join(' '),
          status: x.status
        }))
      });
    }

    // ── Guard 2: staff notes. plan_notes is ON DELETE CASCADE, so these would
    // vanish silently. Make the operator clear them deliberately.
    const noteCount = await req.prisma.plan_notes.count({ where: { plan_id: id } });
    if (noteCount > 0) {
      return res.status(409).json({
        error: `Cannot delete "${plan.name}" — it has ${noteCount} note${noteCount !== 1 ? 's' : ''} attached. Delete the notes first if you really mean to remove this plan.`,
        reason: 'notes_exist',
        noteCount
      });
    }

    // ── Guard 3: live RADIUS assignments. radusergroup lives in a separate
    // database with no foreign key to here, so nothing would stop us — but a
    // device authenticating against a group whose plan is gone is unrecoverable
    // from the CRM.
    const group = plan.radius_group || plan.slug;
    if (radiusDb && group) {
      try {
        const [assigned] = await radiusDb.query('SELECT COUNT(*) AS c FROM radusergroup WHERE groupname = ?', [group]);
        const n = Number(assigned && assigned[0] ? assigned[0].c : 0);
        if (n > 0) {
          return res.status(409).json({
            error: `Cannot delete "${plan.name}" — ${n} device${n !== 1 ? 's are' : ' is'} still assigned to RADIUS group "${group}". Move them off the group first.`,
            reason: 'radius_devices_assigned',
            radiusGroup: group,
            deviceCount: n
          });
        }
      } catch (e) {
        // Can't prove it is safe, so don't proceed.
        console.error('Plan delete: RADIUS check failed:', e.message);
        return res.status(503).json({
          error: 'Cannot verify RADIUS assignments right now, so the plan was not deleted. Try again once RADIUS is reachable.',
          reason: 'radius_unavailable'
        });
      }
    }

    // ── Snapshot before deleting. This audit row is the only thing left of the
    // plan afterwards, so record the whole price book, not just the name.
    const snapshot = {
      id: plan.id, name: plan.name, slug: plan.slug, radius_group: plan.radius_group,
      speed_mbps: plan.speed_mbps, speed_label: plan.speed_label,
      download_mbps: plan.download_mbps, upload_mbps: plan.upload_mbps,
      burst_download_mbps: plan.burst_download_mbps, burst_upload_mbps: plan.burst_upload_mbps,
      burst_threshold_pct: plan.burst_threshold_pct, burst_time_s: plan.burst_time_s,
      price: plan.price != null ? Number(plan.price) : null,
      installation_fee: plan.installation_fee != null ? Number(plan.installation_fee) : null,
      activation_fee: plan.activation_fee != null ? Number(plan.activation_fee) : null,
      plan_type: plan.plan_type, billing_type: plan.billing_type,
      is_active: plan.is_active, sort_order: plan.sort_order,
      description: plan.description, router_type: plan.router_type,
      created_at: plan.created_at,
      features: (plan.features || []).map(f => f.feature_text)
    };

    // plan_features cascades on delete; it is part of the plan definition, not history.
    await req.prisma.plans.delete({ where: { id } });

    // Mirror what deactivation already does — leave no orphan group behind.
    let radiusCleaned = 0;
    if (radiusDb && group && group !== 'plan-suspended' && group !== 'plan-restricted') {
      try {
        // The radiusDb wrapper normalises every result to [rows] for mysql2 parity,
        // so a DELETE reports no affectedRows — count the rows first instead.
        const [before] = await radiusDb.query('SELECT COUNT(*) AS c FROM radgroupreply WHERE groupname = ?', [group]);
        radiusCleaned = Number(before && before[0] ? before[0].c : 0);
        await radiusDb.query('DELETE FROM radgroupreply WHERE groupname = ?', [group]);
      } catch (e) {
        console.error('Plan delete: RADIUS cleanup failed for ' + group + ':', e.message);
      }
    }

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'plan_deleted', entity_type: 'plans', entity_id: id,
        details: { plan: snapshot, radiusGroupRowsRemoved: radiusCleaned },
        ip_address: req.ip
      }
    });
    req.auditLog('PLAN_DELETE', { planId: id, name: plan.name, slug: plan.slug }).catch(() => {});

    res.json({
      message: `Plan "${plan.name}" deleted`,
      radiusGroupRowsRemoved: radiusCleaned
    });
  } catch (err) {
    console.error('Delete plan error:', err);
    res.status(500).json({ error: 'Failed to delete plan' });
  }
});

// ============================================
// GET /api/admin/packages - All installation packages
// ============================================
router.get('/packages', adminAuth(), async (req, res) => {
  try {
    const packages = await req.prisma.installation_packages.findMany({
      include: { items: { orderBy: { sort_order: 'asc' } } },
      orderBy: { sort_order: 'asc' }
    });
    const subscriberCounts = await req.prisma.subscribers.groupBy({
      by: ['installation_package'],
      _count: { id: true },
      where: { status: 'active' }
    });
    const countMap = {};
    subscriberCounts.forEach(sc => { if (sc.installation_package) countMap[sc.installation_package] = sc._count.id; });

    res.json({
      packages: packages.map(p => ({
        id: p.id, code: p.code, name: p.name, description: p.description,
        color: p.color_hex, isActive: p.is_active, sortOrder: p.sort_order,
        subscriberCount: countMap[p.code] || 0,
        items: p.items.map(item => ({ id: item.id, text: item.item_text, isActive: item.is_active, sortOrder: item.sort_order }))
      }))
    });
  } catch (err) {
    console.error('Packages list error:', err);
    res.status(500).json({ error: 'Failed to load packages' });
  }
});

// ============================================
// POST /api/admin/packages - Create installation package
// ============================================
router.post('/packages', adminAuth(), async (req, res) => {
  try {
    const { code, name, description, colorHex, sortOrder, isActive, items } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'Required: code, name' });

    const existing = await req.prisma.installation_packages.findUnique({ where: { code: code.toUpperCase() } });
    if (existing) return res.status(409).json({ error: 'Package code already exists' });

    const pkg = await req.prisma.installation_packages.create({
      data: {
        code: code.toUpperCase(), name,
        description: description || null,
        color_hex: colorHex || '#3b82f6',
        sort_order: sortOrder || 0,
        is_active: isActive !== false
      }
    });

    if (items && Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        await req.prisma.installation_package_items.create({
          data: { package_id: pkg.id, item_text: typeof items[i] === 'string' ? items[i] : items[i].text, sort_order: i + 1 }
        });
      }
    }

    await req.prisma.audit_log.create({
      data: { user_type: 'admin', user_id: req.adminId, action: 'package_created', entity_type: 'installation_packages', entity_id: pkg.id, details: { code: pkg.code, name: pkg.name }, ip_address: req.ip }
    });
    req.auditLog('PACKAGE_CREATE', { code: pkg.code, name: pkg.name }).catch(() => {});

    res.status(201).json({ message: 'Package created', package: { id: pkg.id, code: pkg.code, name: pkg.name } });
  } catch (err) {
    console.error('Create package error:', err);
    res.status(500).json({ error: 'Failed to create package' });
  }
});

// ============================================
// PUT /api/admin/packages/:id - Edit installation package
// ============================================
router.put('/packages/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const pkg = await req.prisma.installation_packages.findUnique({ where: { id } });
    if (!pkg) return res.status(404).json({ error: 'Package not found' });

    const { name, description, colorHex, isActive, sortOrder, items } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (colorHex !== undefined) data.color_hex = colorHex;
    if (isActive !== undefined) data.is_active = isActive;
    if (sortOrder !== undefined) data.sort_order = parseInt(sortOrder);
    data.updated_at = new Date();

    await req.prisma.installation_packages.update({ where: { id }, data });

    if (items && Array.isArray(items)) {
      await req.prisma.installation_package_items.deleteMany({ where: { package_id: id } });
      for (let i = 0; i < items.length; i++) {
        await req.prisma.installation_package_items.create({
          data: { package_id: id, item_text: items[i].text || items[i], sort_order: i + 1, is_active: items[i].isActive !== undefined ? items[i].isActive : true }
        });
      }
    }

    await req.prisma.audit_log.create({
      data: { user_type: 'admin', user_id: req.adminId, action: 'package_updated', entity_type: 'installation_packages', entity_id: id, details: { changes: data }, ip_address: req.ip }
    });
    req.auditLog('PACKAGE_CHANGE', { packageId: id, changes: data }).catch(() => {});

    res.json({ message: `Package "${pkg.name}" updated` });
  } catch (err) {
    console.error('Update package error:', err);
    res.status(500).json({ error: 'Failed to update package' });
  }
});

// ============================================
// GET /api/admin/map/nodes - Network infrastructure
// ============================================
router.get('/map/nodes', adminAuth(), async (req, res) => {
  try {
    const nodes = await req.prisma.network_nodes.findMany({ orderBy: { type: 'asc' } });
    res.json({ nodes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load nodes' });
  }
});

// ============================================
// GET /api/admin/map/routes - Fiber routes
// ============================================
router.get('/map/routes', adminAuth(), async (req, res) => {
  try {
    const routes = await req.prisma.fiber_routes.findMany({ orderBy: { name: 'asc' } });
    res.json({ routes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load routes' });
  }
});

// ============================================
// GET /api/admin/map/subscribers - Subscriber pins for GIS
// ============================================

// GET /api/admin/map/barangays
router.get('/map/barangays', adminAuth(), async (req, res) => {
  try {
    const rows = await req.prisma.$queryRaw`
      SELECT DISTINCT barangay FROM (
        SELECT barangay FROM naps        WHERE barangay IS NOT NULL AND barangay <> ''
        UNION
        SELECT barangay FROM closures    WHERE barangay IS NOT NULL AND barangay <> ''
        UNION
        SELECT barangay FROM foc_routes  WHERE barangay IS NOT NULL AND barangay <> ''
        UNION
        SELECT barangay_name AS barangay FROM subscribers WHERE barangay_name IS NOT NULL AND barangay_name <> ''
      ) combined
      ORDER BY barangay ASC
    `;
    res.json({ barangays: rows.map(r => r.barangay) });
  } catch (err) {
    console.error('Barangays fetch error:', err);
    res.status(500).json({ error: 'Failed to load barangays' });
  }
});

router.get('/map/subscribers', adminAuth(), async (req, res) => {
  try {
    // Return ALL subscribers (no GPS filter) so the GIS counters match the CRM.
    // Subscribers without coordinates are tracked as "untagged" and don't get
    // rendered as markers — but they still count toward status totals.
    // System / dummy accounts (e.g. the "Web Inquiry" placeholder) are excluded.
    const subs = await req.prisma.subscribers.findMany({
      where: { is_system: false },
      select: {
        id: true, account_number: true, first_name: true, last_name: true,
        status: true, latitude: true, longitude: true,
        email: true, phone: true, address: true, address_street2: true,
        mac_address: true, installed_at: true, middle_name: true, barangay_name: true, municipality_name: true,
        barangay: { select: { name: true } },
        municipality: { select: { name: true } },
        plan: { select: { name: true, speed_label: true, price: true } }
      }
    });

    res.json({
      subscribers: subs.map(s => ({
        id: s.id,
        accountNumber: s.account_number,
        name: `${s.first_name}${s.middle_name ? ' ' + s.middle_name : ''} ${s.last_name}`,
        status: s.status,
        lat: s.latitude !== null ? Number(s.latitude) : null,
        lng: s.longitude !== null ? Number(s.longitude) : null,
        barangay: s.barangay?.name || s.barangay_name || null,
        municipality: s.municipality?.name || s.municipality_name || null,
        middleName: s.middle_name || null,
        subdivision: s.address_street2 || null,
        plan: s.plan?.name,
        speed: s.plan?.speed_label || null,
        monthlyRate: s.plan?.price ? Number(s.plan.price) : null,
        email: s.email || null,
        phone: s.phone || null,
        address: s.address || null,
        macAddress: s.mac_address || null,
        installedAt: s.installed_at || null
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load map data' });
  }
});

// ============================================
// GET /api/admin/reports/:type - Generate reports
// ============================================
router.get('/reports/:type', adminAuth(), async (req, res) => {
  try {
    const type = req.params.type;
    const month = req.query.month; // e.g., "2026-02"

    switch (type) {
      case 'revenue': {
        const payments = await req.prisma.payments.findMany({
          where: { status: 'success' },
          include: {
            subscriber: { select: { first_name: true, last_name: true, account_number: true } },
            invoice: { select: { billing_period: true } }
          },
          orderBy: { paid_at: 'desc' },
          take: 200
        });

        const byMethod = {};
        const byPeriod = {};
        let total = 0;

        payments.forEach(p => {
          const amt = Number(p.amount);
          total += amt;
          byMethod[p.method] = (byMethod[p.method] || 0) + amt;
          const period = p.invoice?.billing_period || 'Unknown';
          byPeriod[period] = (byPeriod[period] || 0) + amt;
        });

        res.json({ total, byMethod, byPeriod, transactionCount: payments.length });
        break;
      }

      case 'collection': {
        const [paid, pending, overdue] = await Promise.all([
          req.prisma.invoices.aggregate({ where: { status: 'paid' }, _sum: { amount: true }, _count: true }),
          req.prisma.invoices.aggregate({ where: notYetDueWhere(), _sum: { amount: true }, _count: true }),
          req.prisma.invoices.aggregate({ where: overdueWhere(), _sum: { amount: true }, _count: true })
        ]);

        res.json({
          paid: { count: paid._count, total: Number(paid._sum.amount || 0) },
          pending: { count: pending._count, total: Number(pending._sum.amount || 0) },
          overdue: { count: overdue._count, total: Number(overdue._sum.amount || 0) },
          collectionRate: paid._count > 0
            ? Math.round(paid._count / (paid._count + pending._count + overdue._count) * 100)
            : 0
        });
        break;
      }

      case 'subscribers': {
        const byStatus = await req.prisma.subscribers.groupBy({
          by: ['status'], _count: true
        });
        const byPlan = await req.prisma.subscribers.groupBy({
          by: ['plan_id'], _count: true, where: { status: 'active' }
        });
        const plans = await req.prisma.plans.findMany({ select: { id: true, name: true } });
        const planMap = {};
        plans.forEach(p => { planMap[p.id] = p.name; });

        res.json({
          byStatus: byStatus.map(s => ({ status: s.status, count: s._count })),
          byPlan: byPlan.map(s => ({ plan: planMap[s.plan_id] || 'No Plan', count: s._count })),
          total: byStatus.reduce((sum, s) => sum + s._count, 0)
        });
        break;
      }

      case 'tickets': {
        const byStatus = await req.prisma.tickets.groupBy({ by: ['status'], _count: true });
        const byCategory = await req.prisma.tickets.groupBy({ by: ['category'], _count: true });
        const byPriority = await req.prisma.tickets.groupBy({ by: ['priority'], _count: true });

        res.json({
          byStatus: byStatus.map(s => ({ status: s.status, count: s._count })),
          byCategory: byCategory.map(s => ({ category: s.category, count: s._count })),
          byPriority: byPriority.map(s => ({ priority: s.priority, count: s._count })),
          total: byStatus.reduce((sum, s) => sum + s._count, 0)
        });
        break;
      }

      default:
        return res.status(400).json({ error: 'Invalid report type. Use: revenue, collection, subscribers, tickets' });
    }
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// ============================================
// GET /api/admin/notifications - CRM notifications
// ============================================
router.get('/notifications', adminAuth(), async (req, res) => {
  try {
    const notifications = await req.prisma.notifications.findMany({
      where: { target_type: 'admin' },
      orderBy: { created_at: 'desc' },
      take: 20
    });
    res.json({ notifications });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// ============================================
// PUT /api/admin/notifications/:id/read
// ============================================
router.put('/notifications/:id/read', adminAuth(), async (req, res) => {
  try {
    await req.prisma.notifications.update({
      where: { id: parseInt(req.params.id) },
      data: { is_read: true }
    });
    res.json({ message: 'Notification marked as read' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// ============================================
// GET /api/admin/settings - System settings
// ============================================
router.get('/settings', adminAuth(), async (req, res) => {
  try {
    const settings = await req.prisma.system_settings.findMany({ orderBy: { category: 'asc' } });
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// ============================================
// PUT /api/admin/settings - Update settings
// ============================================
const AUTO_RESTRICT_KEY = 'billing_auto_restrict_enabled';

router.put('/settings', adminAuth(), async (req, res) => {
  try {
    const { settings } = req.body; // Array of { key, value }
    if (!settings || !Array.isArray(settings)) {
      return res.status(400).json({ error: 'Settings array required' });
    }

    // Read the CURRENT state of the cutoff switch before writing anything. The Settings
    // page re-sends every key on save, so "the payload contains this key set to true" is
    // not the same question as "someone just turned it on" — without the before-value,
    // saving an unrelated field while the feature was already on would launch a fresh
    // sweep every time.
    const touchesAutoRestrict = settings.some(s => s.key === AUTO_RESTRICT_KEY);
    const wasEnabled = touchesAutoRestrict && typeof restriction.isAutoRestrictEnabled === 'function'
      ? await restriction.isAutoRestrictEnabled(req.prisma)
      : false;

    for (const s of settings) {
      await req.prisma.system_settings.upsert({
        where: { key: s.key },
        update: { value: s.value },
        create: { key: s.key, value: s.value, category: s.category || 'general' }
      });
    }

      req.auditLog('SETTINGS_CHANGE', { keys: settings.map(s => s.key) }).catch(() => {});

    // Off -> on means now, not at the next daily pass. Enforcement runs detached; what
    // comes back is the preview, so the response can state how many accounts are being
    // cut off rather than just "Settings updated".
    let autoRestrict = null;
    if (touchesAutoRestrict && !wasEnabled && radiusDb &&
        typeof restriction.sweepOnEnable === 'function' &&
        await restriction.isAutoRestrictEnabled(req.prisma)) {
      try {
        autoRestrict = await restriction.sweepOnEnable(req.prisma, radiusDb, {
          // adminAuth attaches req.admin, not req.adminUser — the latter is undefined
          // everywhere it appears in this file and silently degrades to 'admin', which
          // would make the audit row unable to say who threw the switch.
          by: req.admin?.username || req.admin?.email || 'admin',
        });
      } catch (err) {
        // The setting is saved either way — say the sweep failed rather than the save.
        console.error('[settings] auto-restrict sweep could not start: ' + err.message);
        autoRestrict = { triggered: false, error: err.message };
      }
    }

    res.json({ message: 'Settings updated', autoRestrict });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});


// ============================================
// POST /api/admin/settings/logo - Upload company logo
// ============================================
const multerLogo = require('multer');
const pathLib = require('path');
const fsLib = require('fs');
const logoDir = '/var/www/netfactory.com.ph/html/uploads/logo';
if (!fsLib.existsSync(logoDir)) fsLib.mkdirSync(logoDir, { recursive: true });
const logoStorage = multerLogo.diskStorage({
  destination: (req, file, cb) => cb(null, logoDir),
  filename: (req, file, cb) => {
    const ext = pathLib.extname(file.originalname).toLowerCase();
    cb(null, 'company-logo' + ext);
  }
});
const logoUpload = multerLogo({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg'];
    const ext = pathLib.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only PNG and JPG files are allowed'));
  }
}).single('logo');

router.post('/settings/logo', adminAuth(), (req, res) => {
  logoUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const logoPath = req.file.path;
      const logoUrl = '/uploads/logo/' + req.file.filename;
      await req.prisma.system_settings.upsert({
        where: { key: 'company_logo' },
        update: { value: logoPath },
        create: { key: 'company_logo', value: logoPath, category: 'company' }
      });
      res.json({ message: 'Logo uploaded', logoUrl, logoPath });
    } catch (e) {
      console.error('Logo save error:', e);
      res.status(500).json({ error: 'Failed to save logo setting' });
    }
  });
});

router.delete('/settings/logo', adminAuth(), async (req, res) => {
  try {
    const setting = await req.prisma.system_settings.findUnique({ where: { key: 'company_logo' } });
    if (setting && setting.value && fsLib.existsSync(setting.value)) {
      fsLib.unlinkSync(setting.value);
    }
    await req.prisma.system_settings.upsert({
      where: { key: 'company_logo' },
      update: { value: '' },
      create: { key: 'company_logo', value: '', category: 'company' }
    });
    res.json({ message: 'Logo removed' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to remove logo' });
  }
});

// ============================================
// GET /api/admin/staff - Staff management
// ============================================
router.get('/staff', adminAuth(), async (req, res) => {
  try {
    const staff = await req.prisma.admin_users.findMany({
      select: { id: true, username: true, email: true, phone: true, full_name: true, role: true, is_active: true, last_login_at: true, allowed_pages: true, receive_email_alerts: true, receive_sms_alerts: true },
      orderBy: { full_name: 'asc' }
    });
    res.json({ staff });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load staff' });
  }
});

// ============================================
// POST /api/admin/staff - Create staff member
// ============================================
router.post('/staff', adminAuth(), async (req, res) => {
  try {
    const { username, email, password, fullName, role } = req.body;
    if (!username || !email || !password || !fullName || !role) {
      return res.status(400).json({ error: 'All fields required' });
    }

    const hash = await bcrypt.hash(password, 12);
    const admin = await req.prisma.admin_users.create({
      data: {
        username: username.toLowerCase().trim(),
        email: email.toLowerCase().trim(),
        phone: req.body.phone ? req.body.phone.replace(/\D/g,'') : null,
        password_hash: hash,
        full_name: fullName.trim(),
        role,
        allowed_pages: req.body.allowedPages || ['dashboard'],}
    });

    const co3 = await getCompany(req.prisma).catch(() => null);
    const co3Name = co3?.name || 'Netfactory';
    const crmUrl3 = (co3?.crmUrl || 'https://netfactory.com.ph/crm') + '/';
    const crmHost3 = crmUrl3.replace(/^https?:\/\//, '');

    // Send welcome email with credentials
    if (email) {
      try {
        await req.config.email.sendWithPrisma(req.prisma, {
          to: email.toLowerCase().trim(),
          subject: co3Name + ' CRM - Your Account Has Been Created',
          html: '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">' +
            '<div style="text-align:center;padding:20px 0;border-bottom:2px solid #3b82f6;">' +
            '<h1 style="color:#0f172a;margin:0;">' + co3Name + '</h1>' +
            '<p style="color:#3b82f6;margin:4px 0 0;">CRM Staff Account</p></div>' +
            '<div style="padding:24px 0;">' +
            '<p>Hi <strong>' + fullName.trim() + '</strong>,</p>' +
            '<p>A CRM staff account has been created for you. Here are your login credentials:</p>' +
            '<div style="background:#f0f9ff;border:1px solid #93c5fd;border-radius:10px;padding:16px;margin:20px 0;">' +
            '<p style="margin:0;"><strong>Username:</strong> <span style="font-family:monospace;color:#1d4ed8;">' + username.toLowerCase().trim() + '</span></p>' +
            '<p style="margin:8px 0 0;"><strong>Password:</strong> <span style="font-family:monospace;font-size:16px;letter-spacing:1px;color:#1d4ed8;">' + password + '</span></p>' +
            '<p style="margin:8px 0 0;"><strong>Login URL:</strong> <a href="' + crmUrl3 + '" style="color:#3b82f6;">' + crmHost3 + '</a></p></div>' +
            '<p style="color:#ef4444;font-weight:600;">Please change your password immediately after your first login.</p>' +
            '<p style="text-align:center;margin:24px 0;">' +
            '<a href="' + crmUrl3 + '" style="background:#3b82f6;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Log In to CRM</a></p></div>' +
            '<div style="border-top:1px solid #e2e8f0;padding-top:16px;color:#94a3b8;font-size:12px;text-align:center;">' + co3Name + '<br>This is an automated message. Do not share your credentials with anyone.</div></div>',
        });
        console.log('Staff welcome email sent to ' + email);
      } catch (emailErr) { console.error('Staff welcome email failed:', emailErr.message); }
    }

    // Send welcome SMS with credentials
    const staffPhone = req.body.phone ? req.body.phone.replace(/\D/g,'') : null;
    if (staffPhone) {
      try {
        await req.config.sms.sendWithPrisma(req.prisma, staffPhone,
          co3Name + ' CRM: Welcome ' + fullName.trim() + '! Your account is ready. Username: ' + username.toLowerCase().trim() + ' Password: ' + password + ' Login at ' + crmHost3 + ' Change your password after first login.'
        );
        console.log('Staff welcome SMS sent to ' + staffPhone);
      } catch (smsErr) { console.error('Staff welcome SMS failed:', smsErr.message); }
    }

      req.auditLog('STAFF_MANAGE', { action: 'created', username: username.toLowerCase().trim(), role }).catch(() => {});
    res.status(201).json({ message: 'Staff created', staff: { id: admin.id, username: admin.username, allowed_pages: admin.allowed_pages } });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Username or email already exists' });
    res.status(500).json({ error: 'Failed to create staff' });
  }
});


// ============================================
// PUT /api/admin/staff/:id - Update staff member
// ============================================
router.put('/staff/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { email, fullName, role, isActive } = req.body;
    const data = {};
    if (email !== undefined) data.email = email.toLowerCase().trim();
    if (fullName !== undefined) data.full_name = fullName.trim();
    if (role !== undefined) data.role = role;
    if (isActive !== undefined) data.is_active = isActive;
    if (req.body.phone !== undefined) data.phone = req.body.phone ? req.body.phone.replace(/\D/g,'') : null;
    if (req.body.allowedPages !== undefined) data.allowed_pages = req.body.allowedPages;

    const updated = await req.prisma.admin_users.update({ where: { id }, data });
    res.json({ message: 'Staff updated', staff: { id: updated.id, username: updated.username, fullName: updated.full_name, email: updated.email, phone: updated.phone, role: updated.role, isActive: updated.is_active, allowedPages: updated.allowed_pages } });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Email already exists' });
    if (err.code === 'P2025') return res.status(404).json({ error: 'Staff not found' });
    console.error('Update staff error:', err);
    res.status(500).json({ error: 'Failed to update staff' });
  }
});

// ============================================
// PUT /api/admin/staff/:id/password - Reset staff password (admin only)
// ============================================
router.put('/staff/:id/password', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const hash = await bcrypt.hash(password, 12);
    await req.prisma.admin_users.update({ where: { id }, data: { password_hash: hash } });

    await req.prisma.audit_log.create({
      data: { user_type: 'admin', user_id: req.adminId, action: 'staff_password_reset', entity_type: 'admin_users', entity_id: id, details: { resetBy: req.admin.full_name }, ip_address: req.ip }
    });
      req.auditLog('PASSWORD_RESET', { target: 'staff', staffId: id }).catch(() => {});

    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Staff not found' });
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ============================================
// DELETE /api/admin/staff/:id - Delete staff member (superadmin only)
// ============================================
router.delete('/staff/:id', adminAuth(), async (req, res) => {
  try {
    if (req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only Super Administrators can delete staff accounts' });
    }

    const id = parseInt(req.params.id);

    if (id === req.adminId) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    const staff = await req.prisma.admin_users.findUnique({ where: { id } });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    if (staff.role === 'superadmin') {
      return res.status(403).json({ error: 'Cannot delete a Super Administrator account' });
    }

    await req.prisma.admin_users.delete({ where: { id } });

    await req.prisma.audit_log.create({
      data: { user_type: 'admin', user_id: req.adminId, action: 'staff_deleted', entity_type: 'admin_users', entity_id: id, details: { deletedUser: staff.full_name, deletedUsername: staff.username, deletedBy: req.admin.full_name }, ip_address: req.ip }
    });
    req.auditLog('DELETE_STAFF', { staffId: id, username: staff.username, name: staff.full_name }).catch(() => {});

    res.json({ message: `Staff member "${staff.full_name}" has been deleted` });
  } catch (err) {
    console.error('Delete staff error:', err);
    res.status(500).json({ error: 'Failed to delete staff member' });
  }
});

// GET /api/admin/staff/alerts/recipients - Get all staff who should receive alerts
router.get('/staff/alerts/recipients', adminAuth(), async (req, res) => {
  try {
    const emailRecipients = await req.prisma.admin_users.findMany({
      where: { 
        receive_email_alerts: true,
        is_active: true,
        email: { not: "" }
      },
      select: {
        id: true,
        username: true,
        email: true,
        full_name: true,
      }
    });

    const smsRecipients = await req.prisma.admin_users.findMany({
      where: { 
        receive_sms_alerts: true,
        is_active: true,
        phone: { not: "" }
      },
      select: {
        id: true,
        username: true,
        phone: true,
        full_name: true,
      }
    });

    res.json({ 
      emailRecipients,
      smsRecipients,
      total: {
        email: emailRecipients.length,
        sms: smsRecipients.length,
      }
    });
  } catch (err) {
    console.error('Get alert recipients error:', err);
    res.status(500).json({ error: 'Failed to fetch alert recipients' });
  }
});


// ============================================================
// SMS BLAST — bulk SMS to subscribers
// ============================================================
function smsSegments(text) {
  const len = text ? text.length : 0;
  if (len === 0) return 0;
  if (len <= 160) return 1;
  return Math.ceil(len / 153);
}

function buildRecipientName(sub) {
  if (sub.company_name && sub.company_name.trim()) return sub.company_name.trim();
  const parts = [sub.first_name, sub.last_name].filter(Boolean).map(s => String(s).trim());
  return parts.join(' ') || 'Customer';
}

function applyVars(template, sub, planName) {
  const balance = sub.balance != null ? Number(sub.balance) : 0;
  return String(template)
    .replace(/\{name\}/gi, buildRecipientName(sub))
    .replace(/\{accountNumber\}/gi, sub.account_number || '')
    .replace(/\{balance\}/gi, `PHP ${balance.toFixed(2)}`)
    .replace(/\{plan\}/gi, planName || '');
}

router.post('/sms/blast', adminAuth(), async (req, res) => {
  try {
    const { message, recipients = {}, priority = false, preview = false } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }
    const trimmed = String(message).trim();
    if (trimmed.length > 459) {
      return res.status(400).json({ error: 'Message exceeds 459 characters (3 segments max)' });
    }

    const where = { is_system: false, phone: { not: '' } };
    const ids = Array.isArray(recipients.ids) ? recipients.ids.map(Number).filter(n => n > 0) : [];

    // Status: array (statuses) preferred; single (status) for backward compat
    const statuses = Array.isArray(recipients.statuses)
      ? recipients.statuses.filter(Boolean).map(String)
      : (recipients.status && recipients.status !== 'all' ? [String(recipients.status)] : []);

    // Barangay: array (barangays) preferred; single (barangay) for backward compat
    const barangays = Array.isArray(recipients.barangays)
      ? recipients.barangays.filter(Boolean).map(String)
      : (recipients.barangay ? [String(recipients.barangay)] : []);

    if (ids.length > 0) {
      where.id = { in: ids };
    } else if (statuses.length > 0) {
      where.status = { in: statuses };
    }

    // Fetch with joined barangay relation; barangay filter applied in JS to match
    // the same effective-name rule the subscribers list uses (relation OR denorm column).
    let subs = await req.prisma.subscribers.findMany({
      where,
      select: {
        id: true, account_number: true, first_name: true, last_name: true,
        company_name: true, phone: true, balance: true, plan_id: true, status: true,
        barangay_name: true,
        barangay: { select: { name: true } },
      },
    });

    if (ids.length === 0 && barangays.length > 0) {
      const set = new Set(barangays);
      subs = subs.filter(s => {
        const effective = (s.barangay && s.barangay.name) || s.barangay_name || null;
        const key = effective && String(effective).trim() ? String(effective).trim() : 'Unspecified';
        return set.has(key);
      });
    }

    let planMap = {};
    if (/\{plan\}/i.test(trimmed)) {
      const planIds = [...new Set(subs.map(s => s.plan_id).filter(Boolean))];
      if (planIds.length > 0) {
        const plans = await req.prisma.plans.findMany({
          where: { id: { in: planIds } },
          select: { id: true, name: true },
        });
        plans.forEach(p => { planMap[p.id] = p.name; });
      }
    }

    const valid = subs.filter(s => s.phone && /\d{10,}/.test(String(s.phone).replace(/\D/g, '')));
    const skipped = subs.length - valid.length;

    let totalSegments = 0;
    const personalized = valid.map(s => {
      const text = applyVars(trimmed, s, planMap[s.plan_id]);
      const segs = smsSegments(text);
      totalSegments += segs;
      return { sub: s, text, segs };
    });

    const creditsPerSeg = priority ? 2 : 1;
    const totalCredits = totalSegments * creditsPerSeg;

    if (preview) {
      return res.json({
        preview: true,
        totalMatched: subs.length,
        validRecipients: valid.length,
        skippedNoPhone: skipped,
        totalSegments,
        creditsPerSegment: creditsPerSeg,
        totalCredits,
        sample: personalized.slice(0, 3).map(p => ({
          to: p.sub.phone,
          name: buildRecipientName(p.sub),
          text: p.text,
          segments: p.segs,
        })),
      });
    }

    if (valid.length === 0) {
      return res.status(400).json({ error: 'No valid recipients (no phone numbers)' });
    }

    const adminUserId = req.admin && req.admin.id ? req.admin.id : null;
    const sendOne = priority
      ? (to, text) => req.config.sms.sendPriority(to, text)
      : (to, text) => req.config.sms.sendWithPrisma(req.prisma, to, text);

    let sent = 0, failed = 0;
    const failures = [];
    const concurrency = 5;
    let cursor = 0;

    async function worker() {
      while (cursor < personalized.length) {
        const idx = cursor++;
        const item = personalized[idx];
        let ok = false;
        let result = null;
        try {
          result = await sendOne(item.sub.phone, item.text);
          ok = !!(result && result.ok);
          if (ok) sent++; else { failed++; failures.push({ id: item.sub.id, phone: item.sub.phone, error: (result && result.error) || 'unknown' }); }
        } catch (err) {
          failed++;
          failures.push({ id: item.sub.id, phone: item.sub.phone, error: err.message });
        }

        try {
          await req.prisma.sms_logs.create({
            data: {
              direction: 'outbound',
              phone_number: item.sub.phone,
              subscriber_id: item.sub.id,
              subscriber_name: buildRecipientName(item.sub),
              message: item.text,
              status: ok ? 'sent' : 'failed',
              admin_user_id: adminUserId,
              sent_via: priority ? 'semaphore_priority' : 'semaphore',
              error_message: ok ? null : ((result && result.error) || null),
              raw_response: result && result.data ? result.data : null,
            },
          });
        } catch (logErr) {
          console.warn('[SMS blast] log write failed:', logErr.message);
        }
      }
    }

    const t0 = Date.now();
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const elapsedMs = Date.now() - t0;

    console.log(`[SMS blast] admin=${adminUserId} sent=${sent} failed=${failed} segments=${totalSegments} credits=${totalCredits} elapsed=${elapsedMs}ms`);

    res.json({
      ok: true,
      total: valid.length,
      sent,
      failed,
      skippedNoPhone: skipped,
      totalSegments,
      creditsUsed: totalCredits,
      elapsedMs,
      failures: failures.slice(0, 50),
    });
  } catch (err) {
    console.error('SMS blast error:', err);
    res.status(500).json({ error: err.message || 'Failed to send SMS blast' });
  }
});


// DISASTER RECOVERY BACKUP ENDPOINTS


// ============================================
// DISASTER RECOVERY BACKUP ENDPOINTS
// ============================================

// POST /api/admin/backup/create - Create disaster recovery backup
router.post('/backup/create', adminAuth(), async (req, res) => {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);

  try {
    const { stdout } = await execAsync('/home/ashraf/scripts/dr_backup.sh', { timeout: 120000, maxBuffer: 1024 * 1024 });
    const match = stdout.match(/(dr_backup_\d{8}_\d{6})\.tar\.gz/);
    
    if (!match) {
      return res.status(500).json({ error: 'Backup created but filename not found' });
    }
    
    const timestamp = match[1];
    const filename = `${timestamp}.tar.gz`;
    const filepath = `/home/ashraf/disaster_recovery_backups/${filename}`;
    
    const { stdout: sizeOutput } = await execAsync(`stat -c%s ${filepath}`);
    const fileSize = parseInt(sizeOutput.trim());
    
    res.json({
      success: true,
      backup: {
        id: timestamp,
        filename: filename,
        path: filepath,
        size: fileSize,
        sizeFormatted: (fileSize / 1024 / 1024).toFixed(2) + ' MB',
        created: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: 'Failed to create backup: ' + err.message });
  }
});

// GET /api/admin/backup/list - List backups
router.get('/backup/list', adminAuth(), async (req, res) => {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  try {
    const { stdout } = await execAsync(`ls -lt /home/ashraf/disaster_recovery_backups/*.tar.gz 2>/dev/null || echo ""`);
    
    if (!stdout.trim()) {
      return res.json({ backups: [] });
    }
    
    const lines = stdout.trim().split('\n');
    const backups = [];
    
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 9) {
        const filename = parts[8].split('/').pop();
        const size = parseInt(parts[4]);
        backups.push({
          filename,
          size,
          sizeFormatted: (size / 1024 / 1024).toFixed(2) + ' MB',
          created: `${parts[5]} ${parts[6]} ${parts[7]}`
        });
      }
    }
    
    res.json({ backups });
  } catch (err) {
    res.json({ backups: [] });
  }
});

// GET /api/admin/backup/download/:filename - Download backup
router.get('/backup/download/:filename', adminAuth(), (req, res) => {
  const filename = req.params.filename;
  
  if (!filename.endsWith('.tar.gz') || filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  
  const filePath = `/home/ashraf/disaster_recovery_backups/${filename}`;
  
  res.download(filePath, filename, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'Backup file not found' });
    }
  });
});


// POST /api/admin/backup/create-simple - Create simple system backup
router.post('/backup/create-simple', adminAuth(), async (req, res) => {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);

  try {
    const { stdout } = await execAsync('/home/ashraf/scripts/simple_backup.sh');
    const filename = stdout.trim();
    
    if (!filename) {
      return res.status(500).json({ error: 'Backup created but filename not found' });
    }
    
    const timestamp = filename.replace('.tar.gz', '');
    const filepath = `/home/ashraf/backups/${filename}`;
    
    const { stdout: sizeOutput } = await execAsync(`stat -c%s ${filepath}`);
    const fileSize = parseInt(sizeOutput.trim());
    
    res.json({
      success: true,
      backup: {
        id: timestamp,
        filename: filename,
        path: filepath,
        size: fileSize,
        sizeFormatted: (fileSize / 1024 / 1024).toFixed(2) + ' MB',
        created: new Date().toISOString(),
        type: 'simple'
      }
    });
  } catch (err) {
    console.error('Simple backup error:', err);
    res.status(500).json({ error: 'Failed to create backup: ' + err.message });
  }
});

// GET /api/admin/backup/list-all - List all backups (both types)
router.get('/backup/list-all', adminAuth(), async (req, res) => {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  try {
    const backups = [];
    
    // Get disaster recovery backups
    try {
      const { stdout: drList } = await execAsync(`ls -lt /home/ashraf/disaster_recovery_backups/*.tar.gz 2>/dev/null || echo ""`);
      if (drList.trim()) {
        const lines = drList.trim().split('\n');
        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length >= 9) {
            const filename = parts[8].split('/').pop();
            const size = parseInt(parts[4]);
            backups.push({
              filename,
              size,
              sizeFormatted: (size / 1024 / 1024).toFixed(2) + ' MB',
              created: `${parts[5]} ${parts[6]} ${parts[7]}`,
              type: 'disaster_recovery',
              path: 'disaster_recovery_backups'
            });
          }
        }
      }
    } catch (e) {}
    
    // Get simple backups
    try {
      const { stdout: simpleList } = await execAsync(`ls -lt /home/ashraf/backups/*.tar.gz 2>/dev/null || echo ""`);
      if (simpleList.trim()) {
        const lines = simpleList.trim().split('\n');
        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length >= 9) {
            const filename = parts[8].split('/').pop();
            const size = parseInt(parts[4]);
            backups.push({
              filename,
              size,
              sizeFormatted: (size / 1024 / 1024).toFixed(2) + ' MB',
              created: `${parts[5]} ${parts[6]} ${parts[7]}`,
              type: 'simple',
              path: 'backups'
            });
          }
        }
      }
    } catch (e) {}
    
    res.json({ backups });
  } catch (err) {
    res.json({ backups: [] });
  }
});

// GET /api/admin/backup/download-simple/:filename - Download simple backup
router.get('/backup/download-simple/:filename', adminAuth(), (req, res) => {
  const filename = req.params.filename;
  
  if (!filename.endsWith('.tar.gz') || filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  
  const filePath = `/home/ashraf/backups/${filename}`;
  
  res.download(filePath, filename, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'Backup file not found' });
    }
  });
});


// DELETE /api/admin/backup/delete/:filename - Delete a single backup
router.delete('/backup/delete/:filename', adminAuth(), async (req, res) => {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  const filename = req.params.filename;
  if (!filename.endsWith('.tar.gz') || filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  try {
    // Check both directories
    const drPath = `/home/ashraf/disaster_recovery_backups/${filename}`;
    const simplePath = `/home/ashraf/backups/${filename}`;
    const fsNode = require('fs');
    if (fsNode.existsSync(drPath)) {
      fsNode.unlinkSync(drPath);
      return res.json({ success: true, message: `Deleted ${filename}` });
    } else if (fsNode.existsSync(simplePath)) {
      fsNode.unlinkSync(simplePath);
      return res.json({ success: true, message: `Deleted ${filename}` });
    } else {
      return res.status(404).json({ error: 'Backup file not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/backup/delete-all - Delete all backups
router.delete('/backup/delete-all', adminAuth(), async (req, res) => {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  try {
    let deleted = 0;
    try {
      const { stdout } = await execAsync('rm -f /home/ashraf/disaster_recovery_backups/*.tar.gz && echo "done"');
      const { stdout: count } = await execAsync('ls /home/ashraf/disaster_recovery_backups/*.tar.gz 2>/dev/null | wc -l || echo "0"');
      deleted += parseInt(count) || 0;
    } catch(e) {}
    try {
      await execAsync('rm -f /home/ashraf/backups/*.tar.gz');
    } catch(e) {}
    res.json({ success: true, message: 'All backups deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/backup/config - Get automation config
router.get('/backup/config', adminAuth(), async (req, res) => {
  const fs = require('fs');
  const configPath = '/home/ashraf/backup-automation-config.json';
  
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      res.json(config);
    } else {
      // Default config
      res.json({
        enabled: false,
        schedule: 'daily',
        time: '02:00',
        backupType: 'system',
        retention: 30,
        sftp: {
          enabled: false,
          host: '',
          port: 22,
          username: '',
          remotePath: '/backups'
        }
      });
    }
  } catch (err) {
    console.error('Get backup config error:', err);
    res.status(500).json({ error: 'Failed to load config' });
  }
});

// POST /api/admin/backup/config - Update automation config
router.post('/backup/config', adminAuth(), async (req, res) => {
  const fs = require('fs');
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  const configPath = '/home/ashraf/backup-automation-config.json';
  
  try {
    const config = req.body;
    
    // Save config
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    
    // Update cron job
    if (config.enabled) {
      const [hour, minute] = config.time.split(':');
      const cronSchedule = config.schedule === 'daily' 
        ? `${minute} ${hour} * * *`
        : config.schedule === 'weekly'
        ? `${minute} ${hour} * * 0`
        : `${minute} ${hour} 1 * *`; // monthly
      
      const cronJob = `${cronSchedule} /home/ashraf/scripts/automated-backup.sh >> /home/ashraf/backup-automation.log 2>&1`;
      
      // Remove old cron job
      await execAsync(`(crontab -l 2>/dev/null | grep -v "automated-backup" || true) | crontab -`);
      
      // Add new cron job
      await execAsync(`(crontab -l 2>/dev/null; echo "${cronJob}") | crontab -`);
    } else {
      // Remove cron job
      await execAsync(`(crontab -l 2>/dev/null | grep -v "automated-backup" || true) | crontab -`);
    }
    
    res.json({ success: true, message: 'Automation configured' });
  } catch (err) {
    console.error('Update backup config error:', err);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// POST /api/admin/backup/test-sftp - Test SFTP connection
router.post('/backup/test-sftp', adminAuth(), async (req, res) => {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  const { host, port, username, password, remotePath } = req.body;
  
  try {
    // Create test file
    await execAsync('echo "SFTP connection test" > /tmp/sftp-test.txt');
    
    // Test SFTP connection using sshpass
    const sftpCommand = `sshpass -p '${password}' sftp -o StrictHostKeyChecking=no -P ${port} ${username}@${host} <<EOF
cd ${remotePath}
put /tmp/sftp-test.txt
rm sftp-test.txt
bye
EOF`;
    
    await execAsync(sftpCommand);
    await execAsync('rm /tmp/sftp-test.txt');
    
    res.json({ success: true, message: 'SFTP connection successful' });
  } catch (err) {
    console.error('SFTP test error:', err);
    res.status(500).json({ error: 'SFTP connection failed: ' + err.message });
  }
});


// ── Coverage Management ──────────────────────────────────────
router.get('/coverage/municipalities', adminAuth(), async (req, res) => {
  try {
    const munis = await req.prisma.municipalities.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { barangays: true } }, barangays: { orderBy: { name: 'asc' }, select: { id: true, name: true } } }
    });
    res.json({ municipalities: munis });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/coverage/municipalities', adminAuth(), async (req, res) => {
  try {
    const { name, province, is_serviceable } = req.body;
    const muni = await req.prisma.municipalities.create({
      data: { name, province: province || 'Bataan', is_serviceable: is_serviceable !== false }
    });
    res.json({ municipality: muni });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/coverage/municipalities/:id', adminAuth(), async (req, res) => {
  try {
    const { name, province, is_serviceable } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (province !== undefined) data.province = province;
    if (is_serviceable !== undefined) data.is_serviceable = is_serviceable;
    const muni = await req.prisma.municipalities.update({
      where: { id: parseInt(req.params.id) }, data
    });
    res.json({ municipality: muni });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── SYSTEM TOGGLES ──────────────────────────────────────────
// GET /api/admin/system/toggles — Get all toggle states
router.get('/system/toggles', adminAuth(), async (req, res) => {
  try {
    await refreshCache(req.prisma);
    const rows = await req.prisma.system_settings.findMany({
      where: { key: { in: TOGGLE_KEYS } },
      select: { key: true, value: true, updated_at: true, updated_by: true },
    });
    const toggles = {};
    TOGGLE_KEYS.forEach(k => { toggles[k] = false; });
    rows.forEach(r => { toggles[r.key] = r.value === 'true' || r.value === '1'; });
    // Include updated info
    const meta = {};
    rows.forEach(r => { meta[r.key] = { updated_at: r.updated_at, updated_by: r.updated_by }; });
    res.json({ toggles, meta });
  } catch (err) {
    console.error('Toggle fetch error:', err);
    res.status(500).json({ error: 'Failed to load toggles' });
  }
});

// PUT /api/admin/system/toggles — Update a toggle
router.put('/system/toggles', adminAuth(), async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!TOGGLE_KEYS.includes(key)) {
      return res.status(400).json({ error: 'Invalid toggle key: ' + key });
    }
    const updatedBy = req.admin?.username || 'admin';
    const newValue = await setToggle(req.prisma, key, !!value, updatedBy);

    // Audit log
    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin',
        user_id: req.adminId,
        action: 'toggle_' + key,
        details: JSON.stringify({ key, value: newValue, previous: !newValue }),
        ip_address: req.ip,
      }
    });

    console.log('[Toggle] ' + key + ' set to ' + newValue + ' by ' + updatedBy);
    res.json({ key, value: newValue, updated_by: updatedBy });
  } catch (err) {
    console.error('Toggle update error:', err);
    res.status(500).json({ error: 'Failed to update toggle' });
  }
});

module.exports = router;

// ============================================
// GET /api/admin/plans/:id/notes - Get plan notes
// ============================================
router.get('/plans/:id/notes', adminAuth(), async (req, res) => {
  try {
    const planId = parseInt(req.params.id);
    const notes = await req.prisma.plan_notes.findMany({
      where: { plan_id: planId },
      orderBy: { created_at: 'desc' }
    });
    res.json({ notes });
  } catch (err) {
    console.error('Get plan notes error:', err);
    res.status(500).json({ error: 'Failed to load notes' });
  }
});

// ============================================
// POST /api/admin/plans/:id/notes - Add plan note
// ============================================
router.post('/plans/:id/notes', adminAuth(), async (req, res) => {
  try {
    const planId = parseInt(req.params.id);
    const { note } = req.body;
    if (!note || !note.trim()) return res.status(400).json({ error: 'Note is required' });
    const created = await req.prisma.plan_notes.create({
      data: { plan_id: planId, note: note.trim(), created_by: req.adminId }
    });
    res.status(201).json({ message: 'Note added', note: created });
  } catch (err) {
    console.error('Add plan note error:', err);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

// ============================================
// DELETE /api/admin/plans/:id/notes/:noteId - Delete plan note
// ============================================
router.delete('/plans/:id/notes/:noteId', adminAuth(), async (req, res) => {
  try {
    const noteId = parseInt(req.params.noteId);
    await req.prisma.plan_notes.delete({ where: { id: noteId } });
    res.json({ message: 'Note deleted' });
  } catch (err) {
    console.error('Delete plan note error:', err);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// ============================================
// POST /api/admin/invoices/:id/pay - Record payment (with partial support + AR integration)
// ============================================
router.post('/invoices/:id/pay', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { method, referenceNumber: inputRef, amount, orNumber, paymentDate, invoiceDate } = req.body;
    if (!method) return res.status(400).json({ error: 'Payment method required' });

    // Auto-generate reference number if blank: PYMYYMM######
    let referenceNumber = inputRef;
    if (!referenceNumber) {
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const prefix = 'PYM' + yy + mm;
      const lastRef = await req.prisma.$queryRaw`
        SELECT reference_number FROM payments 
        WHERE reference_number LIKE ${prefix + '%'} 
        ORDER BY reference_number DESC LIMIT 1
      `;
      let seq = 1;
      if (lastRef.length > 0) {
        const lastSeq = parseInt(lastRef[0].reference_number.slice(-6)) || 0;
        seq = lastSeq >= 999999 ? 1 : lastSeq + 1;
      }
      referenceNumber = prefix + String(seq).padStart(6, '0');
    }

    const invoice = await req.prisma.invoices.findUnique({ where: { id }, include: { subscriber: true } });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });

    const invoiceAmount = Number(invoice.amount);

    // Read what has already been paid BEFORE resolving the amount: an omitted amount
    // means "settle what is left", which cannot be known without it. Defaulting to the
    // invoice total instead would overpay a part-paid invoice and mint a credit nobody
    // handed over money for.
    const existingPayments = await req.prisma.payments.aggregate({
      where: { invoice_id: id, status: 'success' },
      _sum: { amount: true }
    });
    const previouslyPaid = Number(existingPayments._sum.amount || 0);
    const remainingBalance = +(invoiceAmount - previouslyPaid).toFixed(2);

    // `amount ? parseFloat(amount) : invoiceAmount` used to sit here, and 0 is falsy in
    // JavaScript — so typing 0 was indistinguishable from leaving the box empty, which
    // means "settle in full". A cashier entering 0 silently recorded the whole invoice as
    // paid, and the guard below could not catch it because payAmount was already the full
    // amount. It marked INV-26080004 (₱967.10) paid on 12 Aug from an input of 0.
    //
    // Absence and zero must therefore be distinguished explicitly, before any coercion.
    const amountOmitted = amount === undefined || amount === null || String(amount).trim() === '';
    const payAmount = amountOmitted ? remainingBalance : Number(String(amount).trim());

    // Number() rather than parseFloat(): parseFloat('12abc') yields 12, quietly recording
    // a different figure than the one typed. NaN must be rejected on its own — every
    // comparison against NaN is false, so `NaN <= 0` would have sailed through.
    if (!Number.isFinite(payAmount)) {
      return res.status(400).json({ error: 'Payment amount must be a number' });
    }
    if (payAmount <= 0) {
      return res.status(400).json({ error: 'Payment amount must be greater than 0. Leave the amount blank to settle the balance in full.' });
    }

    // Allow overpayment — excess becomes subscriber credit
    const effectivePayment = Math.min(payAmount, remainingBalance);
    const overpayment = payAmount > remainingBalance ? +(payAmount - remainingBalance).toFixed(2) : 0;

    const totalAfterPayment = previouslyPaid + effectivePayment;
    const newStatus = totalAfterPayment >= invoiceAmount ? 'paid' : 'partial';

    // 1. Record payment in payments table
    const paidAtDate = paymentDate ? new Date(paymentDate + 'T12:00:00.000Z') : new Date();
    await req.prisma.payments.create({
      data: {
        invoice_id: id,
        subscriber_id: invoice.subscriber_id,
        amount: payAmount,
        method,
        reference_number: referenceNumber || null,
        or_number: orNumber || null,
        status: 'success',
        paid_at: paidAtDate
      }
    });

    // 2. Update invoice status (and invoice date if provided)
    const invoiceUpdateData = { status: newStatus };
    if (invoiceDate) invoiceUpdateData.generated_at = new Date(invoiceDate + 'T00:00:00.000Z');
    await req.prisma.invoices.update({
      where: { id },
      data: invoiceUpdateData
    });

    // 3. Decrease subscriber balance (only invoice portion, not overpayment)
    await req.prisma.subscribers.update({
      where: { id: invoice.subscriber_id },
      data: { balance: { decrement: effectivePayment } }
    });

    // 4. Sync to Accounts Receivable
    const arMethod = method;

    try {
      // Find or create AR entry linked to this billing invoice
      let arRecord = await req.prisma.$queryRaw`
        SELECT id FROM accounts_receivable WHERE billing_invoice_id = ${id} LIMIT 1
      `;

      let arId;
      if (arRecord.length === 0) {
        const subscriberName = `${invoice.subscriber.first_name} ${invoice.subscriber.last_name}`.trim();
        const subscriberAddress = [invoice.subscriber.address, invoice.subscriber.barangay, invoice.subscriber.municipality].filter(Boolean).join(', ');

        const newAr = await req.prisma.$queryRaw`
          INSERT INTO accounts_receivable 
            (invoice_number, subscriber_id, customer_name, customer_address, invoice_date, due_date, total_amount, amount_paid, category, description, billing_invoice_id, created_by)
          VALUES 
            (${invoice.invoice_number}, ${invoice.subscriber_id}, ${subscriberName}, ${subscriberAddress || ''}, 
             ${new Date(invoice.created_at)}::date, 
             ${invoice.due_date ? new Date(invoice.due_date) : new Date()}::date, 
             ${invoiceAmount}, 0, 'subscription', 
             ${'Billing invoice ' + invoice.invoice_number}, ${id}, ${'admin-' + req.adminId})
          RETURNING id
        `;
        arId = newAr[0].id;
      } else {
        arId = arRecord[0].id;
      }

      // recordArPayment also brings amount_paid, status and the generated balance
      // back in line. The comment that used to sit here said a trigger did that;
      // no such trigger exists, which is why every receivable read 'pending'.
      await recordArPayment(req.prisma, {
        arId,
        amount: effectivePayment,
        method: arMethod,
        referenceNumber: referenceNumber || null,
        notes: 'Payment via CRM billing - ' + invoice.invoice_number,
        receivedBy: 'admin-' + req.adminId,
        paymentDate: paymentDate || null,
      });
    } catch (arErr) {
      console.error('AR sync error (payment still recorded):', arErr);
    }

    // 5. Audit log
    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'payment_recorded', entity_type: 'invoices', entity_id: id,
        details: { method, amount: payAmount, effectivePayment, overpayment, referenceNumber, orNumber: orNumber || null, paymentDate: paidAtDate, invoiceNumber: invoice.invoice_number, newStatus, totalPaid: totalAfterPayment, invoiceTotal: invoiceAmount },
        ip_address: req.ip
      }
    });

      // ── New audit trail ──
      req.auditLog('PAYMENT_ACCEPT', { invoice: invoice.invoice_number, amount: payAmount, method, reference: referenceNumber, newStatus }).catch(() => {});

    // 6. Handle overpayment → subscriber credit
    //
    // An advance invoice credits its whole settled amount as well: it was never a
    // service charge, only a way to collect a downpayment through the ordinary invoice
    // and pay-link machinery. Counter payments have to do this too, not just the
    // webhook — staff take downpayments in cash at least as often as by link.
    const advanceCredit = invoice.is_advance ? effectivePayment : 0;
    const creditAmount = Math.round((overpayment + advanceCredit) * 100) / 100;
    let creditBalance = 0;
    if (creditAmount > 0) {
      const opUpd = await req.prisma.$queryRaw`
        UPDATE subscribers SET credit_balance = ROUND(COALESCE(credit_balance, 0) + ${creditAmount}::numeric, 2) WHERE id = ${invoice.subscriber_id} RETURNING credit_balance
      `;
      creditBalance = Number(opUpd[0].credit_balance);

      const lastPayment = await req.prisma.payments.findFirst({
        where: { invoice_id: id, subscriber_id: invoice.subscriber_id, status: 'success' },
        orderBy: { id: 'desc' }
      });

      await req.prisma.$queryRaw`
        INSERT INTO subscriber_credits (subscriber_id, type, amount, running_balance, source_payment_id, notes, created_by)
        VALUES (${invoice.subscriber_id}, 'overpayment', ${creditAmount}, ${creditBalance}, ${lastPayment?.id || null},
                ${invoice.is_advance
                    ? 'Advance payment ' + invoice.invoice_number + ' (P' + advanceCredit + ' credited' +
                      (overpayment > 0 ? ', plus P' + overpayment + ' overpaid' : '') + ')'
                    : 'Overpayment on invoice ' + invoice.invoice_number + ' (paid ' + payAmount + ' on balance ' + remainingBalance + ')'},
                ${'admin-' + req.adminId})
      `;
    }

    // 7. Send payment confirmation email + SMS
    const crmMethodLabels = { cash:'Cash', gcash:'GCash', maya:'Maya', paymaya:'Maya', xendit:'Online (Xendit)', bank_transfer:'Bank Transfer', credit:'Credit Applied', check:'Check', online:'Online Payment', '7-eleven':'7-Eleven', bayad_center:'Bayad Center' };
    const crmMethodLabel = crmMethodLabels[method?.toLowerCase()] || method || 'Payment';
    const crmCo = await require('../utils/company').getCompany(req.prisma).catch(() => null);
    const paymentPrefs = await getPrefs(req.prisma, invoice.subscriber_id);

    if (paymentPrefs.emailBilling && newStatus === 'paid' && req.config?.email && invoice.subscriber?.email) {
      try {
        const { generateInvoicePDF } = require('../utils/invoicePdf');
        const pdfBuffer = await generateInvoicePDF(req.prisma, id)
          .catch(e => { console.error('[EMAIL] PDF gen failed:', e.message); return null; });
        const attachments = pdfBuffer
          ? [{ filename: `Invoice-${invoice.invoice_number}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
          : undefined;
        await req.config.email.sendTemplateWithPrisma(req.prisma, invoice.subscriber.email, 'payment_received', {
          name: invoice.subscriber.first_name,
          amount: `P${effectivePayment.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          amountReceived: payAmount !== effectivePayment ? `P${payAmount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null,
          overpayment: overpayment > 0 ? `P${overpayment.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null,
          invoiceNumber: invoice.invoice_number,
          method: crmMethodLabel,
          date: paidAtDate.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }),
          reference: referenceNumber || 'N/A',
          orNumber: orNumber || null,
        }, crmCo, attachments);
      } catch (e) { console.error('Payment email error:', e); }
    } else if (paymentPrefs.emailBilling && newStatus === 'partial' && req.config?.email && invoice.subscriber?.email) {
      req.config.email.sendWithPrisma(req.prisma, {
        to: invoice.subscriber.email,
        subject: `Partial Payment Received — ${invoice.invoice_number}`,
        html: `<p>Hi ${invoice.subscriber.first_name},</p><p>We've received your partial payment of ₱${payAmount.toLocaleString()} for invoice ${invoice.invoice_number}.</p><p>Method: ${crmMethodLabel}${referenceNumber ? ' (Ref: ' + referenceNumber + ')' : ''}</p><p>Remaining balance: <strong>₱${(invoiceAmount - totalAfterPayment).toLocaleString()}</strong></p><p>Thank you!</p>`,
      }).catch(e => console.error('Partial payment email error:', e));
    }

    if (paymentPrefs.smsPayment && newStatus === 'paid' && req.config?.sms && invoice.subscriber?.phone) {
      req.config.sms.sendTemplateWithPrisma(req.prisma, invoice.subscriber.phone, 'payment_received', {
        amount: `P${effectivePayment.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        invoiceNumber: invoice.invoice_number,
        reference: referenceNumber || 'N/A',
        overpayment: overpayment > 0 ? `P${overpayment.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null,
      }).catch(e => console.error('Payment SMS error:', e));
    }

    // Paying restores service on the spot, rather than waiting for the reconcile tick.
    // Best effort by design: a router that is unreachable must not fail a payment that
    // has already been recorded, and the job will catch anything missed here.
    const restore = await restriction.restoreIfSettled(
      req.prisma, radiusDb, invoice.subscriber_id,
      { by: 'auto (payment ' + (referenceNumber || invoice.invoice_number) + ')' });
    if (restore.restored) {
      req.auditLog('SUBSCRIBER_UNRESTRICT', {
        subscriberId: invoice.subscriber_id, trigger: 'payment',
        invoice: invoice.invoice_number, reference: referenceNumber || null,
        restrictionId: restore.restrictionId, devices: restore.devices,
        routerApplied: restore.routerApplied,
        unshaped: restore.unshaped, rebuiltGroup: restore.rebuiltGroup,
      }).catch(() => {});
    }

    res.json({
      message: (newStatus === 'paid'
        ? (overpayment > 0 ? 'Payment recorded - Invoice fully paid. \u20B1' + overpayment.toLocaleString() + ' credited to account.' : 'Payment recorded - Invoice fully paid')
        : 'Partial payment recorded')
        + (restore.restored ? ' Internet access restored.' : ''),
      invoiceNumber: invoice.invoice_number,
      status: newStatus,
      accessRestored: !!restore.restored,
      accessRestoreNote: restore.restored ? null : (restore.reason || restore.error || null),
      amountPaid: payAmount,
      effectivePayment,
      overpayment,
      creditBalance,
      totalPaid: totalAfterPayment,
      invoiceTotal: invoiceAmount,
      remainingBalance: invoiceAmount - totalAfterPayment,
      orNumber: orNumber || null,
      paidAt: paidAtDate
    });
  } catch (err) {
    console.error('Record payment error:', err);
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

// ============================================
// POST /api/admin/invoices/:id/void-payment — Void/reverse a specific payment
// Reverses: payment record, invoice status, subscriber balance, A/R, credits
// ============================================
router.post('/invoices/:id/void-payment', adminAuth(), async (req, res) => {
  try {
    if (req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only Super Administrators can void payments' });
    }
    const invoiceId = parseInt(req.params.id);
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'Payment ID required' });

    const payment = await req.prisma.payments.findFirst({
      where: { id: parseInt(paymentId), invoice_id: invoiceId }
    });
    if (!payment) return res.status(404).json({ error: 'Payment not found for this invoice' });
    if (payment.status === 'voided') return res.status(400).json({ error: 'Payment already voided' });

    const invoice = await req.prisma.invoices.findUnique({
      where: { id: invoiceId }, include: { subscriber: true }
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const payAmount = Number(payment.amount);
    const isCredit = payment.method === 'credit';
    const invoiceAmount = Number(invoice.amount);
    const effectiveReverse = isCredit ? payAmount : Math.min(payAmount, invoiceAmount);
    let newStatus, totalRemaining;

    // All mutations run in one transaction — a void can never leave a half-finished state
    // (e.g. payment marked voided but credit not restored). All-or-nothing.
    await req.prisma.$transaction(async (tx) => {
      // 1. Mark payment as voided (soft-delete to keep audit trail)
      await tx.payments.update({
        where: { id: payment.id },
        data: { status: 'voided' }
      });

      // 2. Recalculate invoice status based on remaining valid payments
      const remainingPayments = await tx.payments.aggregate({
        where: { invoice_id: invoiceId, status: 'success' },
        _sum: { amount: true }
      });
      totalRemaining = Number(remainingPayments._sum.amount || 0);
      newStatus = totalRemaining <= 0 ? 'pending' : totalRemaining >= invoiceAmount ? 'paid' : 'partial';

      await tx.invoices.update({
        where: { id: invoiceId },
        data: { status: newStatus }
      });

      // 3. Reverse subscriber balance (add back the effective payment amount)
      await tx.subscribers.update({
        where: { id: invoice.subscriber_id },
        data: { balance: { increment: effectiveReverse } }
      });

      // 4. If credit payment, restore credit balance (atomic) + ledger reversal entry
      if (isCredit) {
        const revUpd = await tx.$queryRaw`
          UPDATE subscribers SET credit_balance = ROUND(COALESCE(credit_balance, 0) + ${payAmount}::numeric, 2)
          WHERE id = ${invoice.subscriber_id} RETURNING credit_balance
        `;
        const newCreditBal = Number(revUpd[0]?.credit_balance || 0);
        await tx.$queryRaw`
          INSERT INTO subscriber_credits (subscriber_id, type, amount, running_balance, source_payment_id, applied_invoice_id, notes, created_by)
          VALUES (${invoice.subscriber_id}, 'reversal', ${payAmount}, ${newCreditBal}, ${payment.id}, ${invoiceId},
                  ${'Payment voided — credit restored for ' + invoice.invoice_number},
                  ${'admin-' + req.adminId})
        `;
      }

      // 5. Remove the original 'applied' ledger entry tied to this payment
      await tx.$executeRawUnsafe(
        `DELETE FROM subscriber_credits WHERE source_payment_id = $1 AND type != 'reversal'`, payment.id
      );

      // 6. If this payment generated an overpayment credit, reverse that too
      const auditEntry = await tx.audit_log.findFirst({
        where: { action: 'payment_recorded', entity_id: invoiceId, entity_type: { in: ['invoices', 'invoice'] } },
        orderBy: { created_at: 'desc' }
      });
      const auditDetails = auditEntry?.details && typeof auditEntry.details === 'object' ? auditEntry.details : null;
      if (auditDetails?.overpayment && Number(auditDetails.overpayment) > 0 && auditDetails.referenceNumber === payment.reference_number) {
        const overAmt = Number(auditDetails.overpayment);
        await tx.$queryRaw`
          UPDATE subscribers SET credit_balance = GREATEST(ROUND(COALESCE(credit_balance, 0) - ${overAmt}::numeric, 2), 0)
          WHERE id = ${invoice.subscriber_id}
        `;
      }

      // 7. Reverse A/R payment (best-effort; failure here should not abort the void)
      try {
        const arRecord = await tx.$queryRaw`
          SELECT id FROM accounts_receivable WHERE billing_invoice_id = ${invoiceId} LIMIT 1
        `;
        if (arRecord.length > 0) {
          const arId = arRecord[0].id;
          if (payment.reference_number) {
            await tx.$executeRawUnsafe(
              `DELETE FROM ar_payments WHERE ar_id = $1 AND reference_number = $2`, arId, payment.reference_number
            );
          } else {
            await tx.$queryRaw`
              DELETE FROM ar_payments WHERE id = (
                SELECT id FROM ar_payments WHERE ar_id = ${arId} AND amount = ${effectiveReverse}
                ORDER BY created_at DESC LIMIT 1
              )
            `;
          }
          const arPaidSum = await tx.$queryRaw`
            SELECT COALESCE(SUM(amount), 0) as total FROM ar_payments WHERE ar_id = ${arId}
          `;
          const arPaid = Number(arPaidSum[0]?.total || 0);
          const arStatus = arPaid <= 0 ? 'pending' : arPaid >= invoiceAmount ? 'paid' : 'partial';
          await tx.$queryRaw`
            UPDATE accounts_receivable SET amount_paid = ${arPaid}, status = ${arStatus}, updated_at = NOW()
            WHERE id = ${arId}
          `;
        }
      } catch (arErr) { console.error('Void payment AR reversal error:', arErr.message); }

      // 8. Audit log
      await tx.audit_log.create({
        data: {
          user_type: 'admin', user_id: req.adminId,
          action: 'payment_voided', entity_type: 'invoices', entity_id: invoiceId,
          details: {
            paymentId: payment.id, amount: payAmount, method: payment.method,
            reference: payment.reference_number, invoiceNumber: invoice.invoice_number,
            previousStatus: invoice.status, newStatus, isCredit
          },
          ip_address: req.ip
        }
      });
    });

    req.auditLog('PAYMENT_VOID', { invoice: invoice.invoice_number, amount: payAmount, method: payment.method, reference: payment.reference_number }).catch(() => {});

    res.json({
      message: `Payment of ₱${payAmount.toLocaleString('en-PH', { minimumFractionDigits: 2 })} voided — Invoice ${invoice.invoice_number} is now ${newStatus}`,
      invoiceNumber: invoice.invoice_number,
      newStatus,
      amountReversed: payAmount,
      totalRemaining
    });
  } catch (err) {
    console.error('Void payment error:', err);
    res.status(500).json({ error: 'Failed to void payment' });
  }
});

// ============================================
// POST /api/admin/invoices/:id/apply-credit — Apply subscriber credit to an invoice
// ============================================
router.post('/invoices/:id/apply-credit', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    const invoice = await req.prisma.invoices.findUnique({
      where: { id },
      include: { subscriber: true }
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });
    if (invoice.status === 'cancelled') return res.status(400).json({ error: 'Invoice is cancelled' });

    // Get current credit balance
    const creditRow = await req.prisma.$queryRaw`
      SELECT credit_balance FROM subscribers WHERE id = ${invoice.subscriber_id}
    `;
    const availableCredit = Number(creditRow[0]?.credit_balance || 0);
    if (availableCredit <= 0) return res.status(400).json({ error: 'Subscriber has no credit balance' });

    // Calculate remaining invoice balance
    const invoiceAmount = Number(invoice.amount);
    const existingPayments = await req.prisma.payments.aggregate({
      where: { invoice_id: id, status: 'success' },
      _sum: { amount: true }
    });
    const previouslyPaid = Number(existingPayments._sum.amount || 0);
    const remainingBalance = +(invoiceAmount - previouslyPaid).toFixed(2);
    if (remainingBalance <= 0) return res.status(400).json({ error: 'Invoice already fully paid' });

    const creditToApply = +Math.min(availableCredit, remainingBalance).toFixed(2);
    let newCreditBal = +(availableCredit - creditToApply).toFixed(2);
    const totalAfterPayment = +(previouslyPaid + creditToApply).toFixed(2);
    const newStatus = totalAfterPayment >= invoiceAmount ? 'paid' : 'partial';
    const referenceNumber = 'CREDIT-' + invoice.invoice_number;

    // 1. Record payment
    const payment = await req.prisma.payments.create({
      data: {
        invoice_id: id,
        subscriber_id: invoice.subscriber_id,
        amount: creditToApply,
        method: 'credit',
        reference_number: referenceNumber,
        status: 'success',
        paid_at: new Date()
      }
    });

    // 2. Update invoice status
    await req.prisma.invoices.update({ where: { id }, data: { status: newStatus } });

    // 3. Decrement subscriber balance
    await req.prisma.subscribers.update({
      where: { id: invoice.subscriber_id },
      data: { balance: { decrement: creditToApply } }
    });

    // 4. Deduct from credit_balance — atomic, returns authoritative post-update balance
    const credUpd = await req.prisma.$queryRaw`
      UPDATE subscribers SET credit_balance = ROUND(GREATEST(COALESCE(credit_balance, 0) - ${creditToApply}::numeric, 0), 2)
      WHERE id = ${invoice.subscriber_id} RETURNING credit_balance
    `;
    newCreditBal = Number(credUpd[0].credit_balance);

    // 5. Record in subscriber_credits ledger (running_balance = true post-update field value)
    await req.prisma.$queryRaw`
      INSERT INTO subscriber_credits (subscriber_id, type, amount, running_balance, source_payment_id, applied_invoice_id, notes, created_by)
      VALUES (${invoice.subscriber_id}, 'applied', ${-creditToApply}, ${newCreditBal}, ${payment.id}, ${id},
              ${'Credit applied to invoice ' + invoice.invoice_number + ' by admin'},
              ${'admin-' + req.adminId})
    `;

    // 6. Sync AR
    try {
      const arRecord = await req.prisma.$queryRaw`
        SELECT id FROM accounts_receivable WHERE billing_invoice_id = ${id} LIMIT 1
      `;
      let arId;
      if (arRecord.length === 0) {
        const subName = `${invoice.subscriber.first_name} ${invoice.subscriber.last_name}`.trim();
        const subAddr = [invoice.subscriber.address, invoice.subscriber.barangay, invoice.subscriber.municipality].filter(Boolean).join(', ');
        const arNew = await req.prisma.$queryRaw`
          INSERT INTO accounts_receivable
            (invoice_number, subscriber_id, customer_name, customer_address, invoice_date, due_date, total_amount, amount_paid, category, description, billing_invoice_id, created_by)
          VALUES (${invoice.invoice_number}, ${invoice.subscriber_id}, ${subName}, ${subAddr || ''},
            ${new Date(invoice.created_at)}::date, ${invoice.due_date ? new Date(invoice.due_date) : new Date()}::date,
            ${invoiceAmount}, 0, 'subscription', ${'Billing invoice ' + invoice.invoice_number}, ${id}, ${'admin-' + req.adminId})
          ON CONFLICT (billing_invoice_id) DO NOTHING
          RETURNING id
        `;
        arId = arNew[0]?.id;
      } else {
        arId = arRecord[0].id;
      }
      if (arId) {
        await recordArPayment(req.prisma, {
          arId,
          amount: creditToApply,
          method: 'credit',
          referenceNumber,
          notes: 'Credit applied to invoice ' + invoice.invoice_number,
          receivedBy: 'admin-' + req.adminId,
        });
      }
    } catch (arErr) { console.error('Apply-credit AR sync error:', arErr.message); }

    // 7. Audit log
    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'credit_applied', entity_type: 'invoices', entity_id: id,
        details: { invoiceNumber: invoice.invoice_number, creditApplied: creditToApply, newCreditBal, newStatus },
        ip_address: req.ip
      }
    });

    res.json({
      message: newStatus === 'paid'
        ? `Credit applied — Invoice ${invoice.invoice_number} is now fully paid`
        : `Credit applied — ₱${creditToApply.toLocaleString()} applied, balance remaining`,
      creditApplied: creditToApply,
      remainingCredit: newCreditBal,
      invoiceStatus: newStatus
    });
  } catch (err) {
    console.error('Apply-credit error:', err);
    res.status(500).json({ error: 'Failed to apply credit' });
  }
});

// ============================================
// PUT /api/admin/invoices/:id/status - Update invoice status
// ============================================
router.put('/invoices/:id/status', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    if (!['pending', 'paid', 'overdue', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const invoice = await req.prisma.invoices.findUnique({ where: { id } });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    await req.prisma.invoices.update({ where: { id }, data: { status } });

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'invoice_status_changed', entity_type: 'invoices', entity_id: id,
        details: { from: invoice.status, to: status, invoiceNumber: invoice.invoice_number },
        ip_address: req.ip
      }
    });

    res.json({ message: `Invoice ${invoice.invoice_number} marked as ${status}` });
  } catch (err) {
    console.error('Update invoice status error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ============================================
// PUT /api/admin/invoices/:id - Manual invoice edit (superadmin only)
// Editable: amount, billing_period, due_date, notes
// Diff-based audit_log captures every changed field with before/after
// ============================================
router.put('/invoices/:id', adminAuth(), async (req, res) => {
  try {
    if (req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only Super Administrators can edit invoices' });
    }
    const id = parseInt(req.params.id);
    const invoice = await req.prisma.invoices.findUnique({ where: { id } });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const data = {};
    const before = {};
    const after = {};

    if (req.body.amount !== undefined && req.body.amount !== null && req.body.amount !== '') {
      const newAmt = parseFloat(req.body.amount);
      if (isNaN(newAmt) || newAmt < 0) return res.status(400).json({ error: 'Invalid amount' });
      if (Number(invoice.amount) !== newAmt) {
        if (invoice.status === 'paid' || invoice.status === 'cancelled') {
          return res.status(400).json({ error: 'Void payments first before changing the amount of a paid or cancelled invoice' });
        }
        data.amount = newAmt;
        before.amount = Number(invoice.amount);
        after.amount = newAmt;
      }
    }
    if (req.body.billing_period !== undefined && req.body.billing_period !== invoice.billing_period) {
      data.billing_period = String(req.body.billing_period).slice(0, 100);
      before.billing_period = invoice.billing_period;
      after.billing_period = data.billing_period;
    }
    if (req.body.due_date !== undefined) {
      const newDue = req.body.due_date ? new Date(req.body.due_date) : null;
      const oldDueIso = invoice.due_date ? new Date(invoice.due_date).toISOString().slice(0,10) : null;
      const newDueIso = newDue ? newDue.toISOString().slice(0,10) : null;
      if (newDueIso !== oldDueIso) {
        data.due_date = newDue;
        before.due_date = oldDueIso;
        after.due_date = newDueIso;
      }
    }
    if (req.body.notes !== undefined && (req.body.notes || '') !== (invoice.notes || '')) {
      data.notes = req.body.notes || null;
      before.notes = invoice.notes;
      after.notes = data.notes;
    }

    if (Object.keys(data).length === 0) {
      return res.json({ message: 'No changes', invoice });
    }

    // Adjust subscriber balance by amount delta (only if amount changed and invoice is open)
    if (data.amount !== undefined) {
      const delta = data.amount - Number(invoice.amount);
      if (delta !== 0) {
        await req.prisma.subscribers.update({
          where: { id: invoice.subscriber_id },
          data: { balance: { increment: delta } }
        });
      }
      // Keep A/R total in sync AND recompute its status — the ar_payments trigger
      // only fires on payment changes, so an amount edit alone can otherwise strand
      // a fully-paid invoice at 'partial'/'pending' (shows as a ₱0.00 aging ghost).
      await req.prisma.$executeRawUnsafe(
        `UPDATE accounts_receivable
           SET total_amount = $1,
               status = CASE WHEN amount_paid >= $1 THEN 'paid' WHEN amount_paid > 0 THEN 'partial' ELSE 'pending' END,
               updated_at = NOW()
         WHERE billing_invoice_id = $2`,
        data.amount, id
      ).catch(() => {});

      // Recompute the billing invoice status too (paid amount = sum of successful payments).
      if (invoice.status !== 'cancelled') {
        const paidAgg = await req.prisma.payments.aggregate({
          where: { invoice_id: id, status: 'success' }, _sum: { amount: true }
        });
        const paidSum = Number(paidAgg._sum.amount || 0);
        const recomputed = paidSum >= Number(data.amount) ? 'paid' : paidSum > 0 ? 'partial' : 'pending';
        if (recomputed !== invoice.status) {
          data.status = recomputed;
          before.status = invoice.status;
          after.status = recomputed;
        }
      }
    }

    const updated = await req.prisma.invoices.update({ where: { id }, data });

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'invoice_edited', entity_type: 'invoices', entity_id: id,
        details: {
          invoiceNumber: invoice.invoice_number,
          subscriberId: invoice.subscriber_id,
          changes: Object.keys(data).reduce((acc, k) => { acc[k] = { from: before[k], to: after[k] }; return acc; }, {})
        },
        ip_address: req.ip
      }
    });
    req.auditLog && req.auditLog('INVOICE_EDIT', { invoice: invoice.invoice_number, changes: Object.keys(data) }).catch(() => {});

    res.json({
      message: `Invoice ${invoice.invoice_number} updated (${Object.keys(data).join(', ')})`,
      invoice: { id: updated.id, amount: Number(updated.amount), billing_period: updated.billing_period, due_date: updated.due_date, notes: updated.notes }
    });
  } catch (err) {
    console.error('Edit invoice error:', err);
    res.status(500).json({ error: 'Failed to edit invoice' });
  }
});

// ============================================
// GET /api/admin/invoices/:id - Invoice detail
// ============================================
router.get('/invoices/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const invoice = await req.prisma.invoices.findUnique({
      where: { id },
      include: {
        subscriber: { select: { id: true, account_number: true, first_name: true, last_name: true, email: true, phone: true } },
        payments: { orderBy: { created_at: 'desc' } }
      }
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    const refMap = await computeReferralDiscounts(req.prisma, [invoice.subscriber_id]);
    res.json({
      id: invoice.id, number: invoice.invoice_number,
      subscriber: { id: invoice.subscriber.id, accountNumber: invoice.subscriber.account_number, name: `${invoice.subscriber.first_name}${invoice.subscriber.middle_name ? ' ' + invoice.subscriber.middle_name : ''} ${invoice.subscriber.last_name}`, email: invoice.subscriber.email, phone: invoice.subscriber.phone },
      amount: Number(invoice.amount), overdueFee: Number(invoice.overdue_fee || 0),
      period: invoice.billing_period, dueDate: invoice.due_date, invoiceDate: invoice.generated_at || invoice.created_at, status: invoice.status,
      referralDiscount: refMap[invoice.id] || 0,
      notes: invoice.notes, createdAt: invoice.created_at,
      payments: invoice.payments.map(p => ({ id: p.id, amount: Number(p.amount), method: p.method, reference: p.reference_number, orNumber: p.or_number || null, status: p.status, paidAt: p.paid_at }))
    });
  } catch (err) {
    console.error('Invoice detail error:', err);
    res.status(500).json({ error: 'Failed to load invoice' });
  }
});


// ============================================
// DELETE /api/admin/invoices/:id - Delete invoice (admin/superadmin only)
// ============================================
router.delete('/invoices/:id', adminAuth(), async (req, res) => {
  try {
    if (req.admin.role !== 'superadmin' && req.admin.role !== 'admin') {
      return res.status(403).json({ error: 'Only Administrators can delete invoices' });
    }
    const id = parseInt(req.params.id);
    const invoice = await req.prisma.invoices.findUnique({ where: { id }, include: { payments: true } });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    // Delete associated subscriber_credits linked to payments, then payments
    if (invoice.payments.length > 0) {
      const paymentIds = invoice.payments.map(p => p.id);
      await req.prisma.$executeRawUnsafe(
        `DELETE FROM subscriber_credits WHERE source_payment_id = ANY($1::int[])`,
        paymentIds
      );
      await req.prisma.payments.deleteMany({ where: { invoice_id: id } });
    }

    // Delete subscriber_credits linked to this invoice (applied credits)
    await req.prisma.$executeRawUnsafe(
      `DELETE FROM subscriber_credits WHERE applied_invoice_id = $1`, id
    ).catch(() => {});

    // Delete associated AR payments and AR record if exists
    await req.prisma.$executeRawUnsafe(
      `DELETE FROM ar_payments WHERE ar_id IN (SELECT id FROM accounts_receivable WHERE billing_invoice_id = $1)`, id
    ).catch(() => {});
    await req.prisma.$executeRawUnsafe('DELETE FROM accounts_receivable WHERE billing_invoice_id = $1', id).catch(() => {});

    await req.prisma.invoices.delete({ where: { id } });

    // Decrement subscriber balance by the unpaid portion of the invoice
    const paidAmount = invoice.payments.reduce((sum, p) => sum + (p.status === 'success' ? Number(p.amount) : 0), 0);
    const unpaidAmount = Math.max(0, Number(invoice.amount) - paidAmount);
    if (unpaidAmount > 0) {
      await req.prisma.subscribers.update({
        where: { id: invoice.subscriber_id },
        data: { balance: { decrement: unpaidAmount } }
      });
    }

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'invoice_deleted', entity_type: 'invoices', entity_id: id,
        details: { number: invoice.invoice_number, amount: Number(invoice.amount), status: invoice.status, balanceAdjusted: unpaidAmount },
        ip_address: req.ip
      }
    });

    res.json({ message: `Invoice ${invoice.invoice_number} deleted successfully` });
  } catch (err) {
    console.error('Delete invoice error:', err);
    res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

// ============================================
// GET /api/admin/me - Get current admin profile
// ============================================
router.get('/me', adminAuth(), async (req, res) => {
  try {
    const admin = await req.prisma.admin_users.findUnique({
      where: { id: req.adminId },
      select: { id: true, username: true, full_name: true, role: true, email: true, phone: true, is_active: true, last_login_at: true, created_at: true }
    });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    res.json(admin);
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// ============================================
// PUT /api/admin/me - Update admin profile
// ============================================
router.put('/me', adminAuth(), async (req, res) => {
  try {
    const { full_name, email, phone } = req.body;
    const updated = await req.prisma.admin_users.update({
      where: { id: req.adminId },
      data: { ...(full_name && { full_name }), ...(email && { email }), ...(phone !== undefined && { phone: phone ? phone.replace(/\D/g,'') : null }) }
    });
    await req.prisma.audit_log.create({
      data: { user_type: 'admin', user_id: req.adminId, action: 'profile_updated', entity_type: 'admin_users', entity_id: req.adminId, details: { full_name, email, phone }, ip_address: req.ip }
    });
      req.auditLog('ACCOUNT_UPDATE', { full_name, email, phone }).catch(() => {});
    res.json({ message: 'Profile updated', full_name: updated.full_name, email: updated.email, phone: updated.phone });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ============================================
// PUT /api/admin/me/password - Change own password
// ============================================
router.put('/me/password', adminAuth(), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both current and new password required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const admin = await req.prisma.admin_users.findUnique({ where: { id: req.adminId } });
    const bcrypt = require('bcryptjs');
    const valid = await bcrypt.compare(currentPassword, admin.password_hash);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    await req.prisma.admin_users.update({ where: { id: req.adminId }, data: { password_hash: hash } });

    await req.prisma.audit_log.create({
      data: { user_type: 'admin', user_id: req.adminId, action: 'password_changed', entity_type: 'admin_users', entity_id: req.adminId, details: {}, ip_address: req.ip }
    });
      req.auditLog('PASSWORD_CHANGE', { method: 'self_service' }).catch(() => {});
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ============================================
// GET /api/admin/audit-log - Activity log
// ============================================
router.get('/audit-log', adminAuth(), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const userId = req.query.userId;

    const where = userId ? { user_id: parseInt(userId) } : {};
    const [logs, total] = await Promise.all([
      req.prisma.audit_log.findMany({
        where, orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit, take: limit
      }),
      req.prisma.audit_log.count({ where })
    ]);

    res.json({
      logs: logs.map(l => ({
        id: l.id, userType: l.user_type, userId: l.user_id,
        action: l.action, entityType: l.entity_type, entityId: l.entity_id,
        details: l.details, ip: l.ip_address, createdAt: l.created_at
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('Audit log error:', err);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});



// NEW ROUTES

// ============================================================
// ONU Inventory API Routes
// ============================================================
// Add to your admin.js routes file or create as a separate
// routes/onu.js and mount in server.js
//
// Mount: app.use('/api/admin', onuRoutes);
// All routes require adminAuth middleware
// ============================================================

// ── If adding to existing admin.js, paste the route handlers below ──
// ── If creating separate file, uncomment this block: ──

/*
const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
*/

// ============================================================
// ONU INVENTORY ROUTES
// ============================================================

// ── GET /admin/onu — List all ONU devices ───────────────────
router.get('/onu', adminAuth(), async (req, res) => {
  try {
    const { status, vendor_id, model, search, subscriber_id, page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (status) where.status = status;
    if (vendor_id) where.vendor_id = parseInt(vendor_id);
    if (model) where.model = { contains: model, mode: 'insensitive' };
    if (subscriber_id) where.subscriber_id = parseInt(subscriber_id);
    if (search) {
      where.OR = [
        { mac_address: { contains: search, mode: 'insensitive' } },
        { serial_number: { contains: search, mode: 'insensitive' } },
        { model: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [devices, total] = await Promise.all([
      req.prisma.onu_inventory.findMany({
        where,
        include: {
          subscriber: { select: { id: true, account_number: true, first_name: true, last_name: true } },
          vendor: { select: { id: true, name: true } },
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      req.prisma.onu_inventory.count({ where }),
    ]);

    res.json({
      devices,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error('ONU list error:', err);
    res.status(500).json({ error: 'Failed to fetch ONU devices' });
  }
});

// ── GET /admin/onu/stats — Inventory summary ────────────────
router.get('/onu/stats', adminAuth(), async (req, res) => {
  try {
    const [statusCounts, modelCounts, vendorCounts, totalValue] = await Promise.all([
      req.prisma.onu_inventory.groupBy({
        by: ['status'],
        _count: true,
      }),
      req.prisma.onu_inventory.groupBy({
        by: ['model'],
        _count: true,
        orderBy: { _count: { model: 'desc' } },
        take: 10,
      }),
      req.prisma.$queryRaw`
        SELECT v.name AS vendor, COUNT(o.id)::int AS count
        FROM onu_inventory o
        JOIN vendors v ON o.vendor_id = v.id
        GROUP BY v.name
        ORDER BY count DESC
      `,
      req.prisma.onu_inventory.aggregate({
        _sum: { purchase_price: true },
        _count: true,
      }),
    ]);

    res.json({
      byStatus: statusCounts.reduce((acc, s) => ({ ...acc, [s.status]: s._count }), {}),
      byModel: modelCounts.map(m => ({ model: m.model, count: m._count })),
      byVendor: vendorCounts,
      totalDevices: totalValue._count,
      totalValue: totalValue._sum.purchase_price || 0,
    });
  } catch (err) {
    console.error('ONU stats error:', err);
    res.status(500).json({ error: 'Failed to fetch ONU stats' });
  }
});

// ── GET /admin/onu/:id — Single ONU detail ──────────────────
router.get('/onu/:id', adminAuth(), async (req, res) => {
  try {
    const device = await req.prisma.onu_inventory.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        subscriber: {
          select: {
            id: true, account_number: true, first_name: true, last_name: true,
            phone: true, address: true, barangay_name: true, municipality_name: true,
            status: true,
          },
        },
        vendor: true,
      },
    });

    if (!device) return res.status(404).json({ error: 'ONU device not found' });
    res.json(device);
  } catch (err) {
    console.error('ONU detail error:', err);
    res.status(500).json({ error: 'Failed to fetch ONU device' });
  }
});

// ── POST /admin/onu — Add new ONU device ────────────────────
router.post('/onu', adminAuth(), async (req, res) => {
  try {
    const {
      mac_address, serial_number, model, vendor_id,
      status = 'in_stock', purchase_date, purchase_price,
      warranty_until, subscriber_id, notes,
    } = req.body;

    // Validate required fields
    if (!mac_address || !model) {
      return res.status(400).json({ error: 'MAC address and model are required' });
    }

    // Normalize MAC address to uppercase with colons
    const normalizedMac = mac_address
      .replace(/[^0-9A-Fa-f]/g, '')
      .match(/.{1,2}/g)
      ?.join(':')
      .toUpperCase();

    if (!normalizedMac || normalizedMac.length !== 17) {
      return res.status(400).json({ error: 'Invalid MAC address format. Use AA:BB:CC:DD:EE:FF' });
    }

    // Check for duplicate MAC
    const existing = await req.prisma.onu_inventory.findUnique({
      where: { mac_address: normalizedMac },
    });
    if (existing) {
      return res.status(409).json({ error: 'MAC address already exists in inventory' });
    }

    const data = {
      mac_address: normalizedMac,
      serial_number: serial_number || null,
      model,
      vendor_id: vendor_id ? parseInt(vendor_id) : null,
      status,
      purchase_date: purchase_date ? new Date(purchase_date) : null,
      purchase_price: purchase_price ? parseFloat(purchase_price) : null,
      warranty_until: warranty_until ? new Date(warranty_until) : null,
      subscriber_id: subscriber_id ? parseInt(subscriber_id) : null,
      notes: notes || null,
    };

    // Auto-set deployed_at if assigning to subscriber
    if (subscriber_id) {
      data.status = 'deployed';
      data.deployed_at = new Date();
    }

    const device = await req.prisma.onu_inventory.create({
      data,
      include: {
        subscriber: { select: { id: true, account_number: true, first_name: true, last_name: true } },
        vendor: { select: { id: true, name: true } },
      },
    });

    // Audit log
    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin',
        user_id: req.admin?.id || 0,
        action: 'onu_added',
        entity_type: 'onu_inventory',
        entity_id: device.id,
        details: { mac_address: normalizedMac, model, status: data.status },
        ip_address: req.ip,
      },
    });

    res.status(201).json(device);
  } catch (err) {
    console.error('ONU create error:', err);
    res.status(500).json({ error: 'Failed to add ONU device' });
  }
});

// ── PUT /admin/onu/:id — Update ONU device ──────────────────
router.put('/onu/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await req.prisma.onu_inventory.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'ONU device not found' });

    const {
      mac_address, serial_number, model, vendor_id,
      status, purchase_date, purchase_price,
      warranty_until, subscriber_id, notes,
    } = req.body;

    const data = {};

    if (mac_address !== undefined) {
      const normalizedMac = mac_address
        .replace(/[^0-9A-Fa-f]/g, '')
        .match(/.{1,2}/g)
        ?.join(':')
        .toUpperCase();
      if (!normalizedMac || normalizedMac.length !== 17) {
        return res.status(400).json({ error: 'Invalid MAC address format' });
      }
      // Check duplicate (excluding self)
      const dup = await req.prisma.onu_inventory.findFirst({
        where: { mac_address: normalizedMac, NOT: { id } },
      });
      if (dup) return res.status(409).json({ error: 'MAC address already exists' });
      data.mac_address = normalizedMac;
    }

    if (serial_number !== undefined) data.serial_number = serial_number || null;
    if (model !== undefined) data.model = model;
    if (vendor_id !== undefined) data.vendor_id = vendor_id ? parseInt(vendor_id) : null;
    if (status !== undefined) data.status = status;
    if (purchase_date !== undefined) data.purchase_date = purchase_date ? new Date(purchase_date) : null;
    if (purchase_price !== undefined) data.purchase_price = purchase_price ? parseFloat(purchase_price) : null;
    if (warranty_until !== undefined) data.warranty_until = warranty_until ? new Date(warranty_until) : null;
    if (notes !== undefined) data.notes = notes || null;

    // Handle subscriber assignment changes
    if (subscriber_id !== undefined) {
      data.subscriber_id = subscriber_id ? parseInt(subscriber_id) : null;
      if (subscriber_id && !existing.subscriber_id) {
        // Newly deployed
        data.status = data.status || 'deployed';
        data.deployed_at = new Date();
      } else if (!subscriber_id && existing.subscriber_id) {
        // Returned to stock
        data.status = data.status || 'in_stock';
        data.deployed_at = null;
      }
    }

    const device = await req.prisma.onu_inventory.update({
      where: { id },
      data,
      include: {
        subscriber: { select: { id: true, account_number: true, first_name: true, last_name: true } },
        vendor: { select: { id: true, name: true } },
      },
    });

    // Audit log
    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin',
        user_id: req.admin?.id || 0,
        action: 'onu_updated',
        entity_type: 'onu_inventory',
        entity_id: id,
        details: data,
        ip_address: req.ip,
      },
    });

    res.json(device);
  } catch (err) {
    console.error('ONU update error:', err);
    res.status(500).json({ error: 'Failed to update ONU device' });
  }
});

// ── DELETE /admin/onu/:id — Remove ONU device ───────────────
router.delete('/onu/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await req.prisma.onu_inventory.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'ONU device not found' });

    if (existing.status === 'deployed' && existing.subscriber_id) {
      return res.status(400).json({ error: 'Cannot delete a deployed ONU. Return it to stock first.' });
    }

    await req.prisma.onu_inventory.delete({ where: { id } });

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin',
        user_id: req.admin?.id || 0,
        action: 'onu_deleted',
        entity_type: 'onu_inventory',
        entity_id: id,
        details: { mac_address: existing.mac_address, model: existing.model },
        ip_address: req.ip,
      },
    });

    res.json({ message: 'ONU device deleted' });
  } catch (err) {
    console.error('ONU delete error:', err);
    res.status(500).json({ error: 'Failed to delete ONU device' });
  }
});

// ── POST /admin/onu/:id/assign — Assign ONU to subscriber ──
router.post('/onu/:id/assign', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { subscriber_id } = req.body;

    if (!subscriber_id) {
      return res.status(400).json({ error: 'subscriber_id is required' });
    }

    const device = await req.prisma.onu_inventory.findUnique({ where: { id } });
    if (!device) return res.status(404).json({ error: 'ONU device not found' });
    if (device.status === 'deployed') {
      return res.status(400).json({ error: 'ONU is already deployed. Return it first.' });
    }
    if (device.status === 'defective' || device.status === 'retired') {
      return res.status(400).json({ error: `Cannot deploy a ${device.status} ONU` });
    }

    // Check subscriber exists
    const sub = await req.prisma.subscribers.findUnique({
      where: { id: parseInt(subscriber_id) },
    });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    const updated = await req.prisma.onu_inventory.update({
      where: { id },
      data: {
        subscriber_id: parseInt(subscriber_id),
        status: 'deployed',
        deployed_at: new Date(),
      },
      include: {
        subscriber: { select: { id: true, account_number: true, first_name: true, last_name: true } },
        vendor: { select: { id: true, name: true } },
      },
    });

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin',
        user_id: req.admin?.id || 0,
        action: 'onu_assigned',
        entity_type: 'onu_inventory',
        entity_id: id,
        details: { subscriber_id: parseInt(subscriber_id), subscriber_acct: sub.account_number },
        ip_address: req.ip,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error('ONU assign error:', err);
    res.status(500).json({ error: 'Failed to assign ONU' });
  }
});

// ── POST /admin/onu/:id/return — Return ONU to stock ────────
router.post('/onu/:id/return', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { reason, mark_defective = false } = req.body;

    const device = await req.prisma.onu_inventory.findUnique({ where: { id } });
    if (!device) return res.status(404).json({ error: 'ONU device not found' });

    const updated = await req.prisma.onu_inventory.update({
      where: { id },
      data: {
        subscriber_id: null,
        status: mark_defective ? 'defective' : 'in_stock',
        deployed_at: null,
        notes: reason ? `${device.notes ? device.notes + '\n' : ''}Returned: ${reason}` : device.notes,
      },
      include: {
        vendor: { select: { id: true, name: true } },
      },
    });

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin',
        user_id: req.admin?.id || 0,
        action: 'onu_returned',
        entity_type: 'onu_inventory',
        entity_id: id,
        details: {
          previous_subscriber: device.subscriber_id,
          reason,
          mark_defective,
        },
        ip_address: req.ip,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error('ONU return error:', err);
    res.status(500).json({ error: 'Failed to return ONU' });
  }
});

// ── POST /admin/onu/bulk — Bulk add ONUs ────────────────────
router.post('/onu/bulk', adminAuth(), async (req, res) => {
  try {
    const { devices } = req.body;
    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'devices array is required' });
    }
    if (devices.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 devices per batch' });
    }

    const results = { created: 0, errors: [] };

    for (const d of devices) {
      try {
        if (!d.mac_address || !d.model) {
          results.errors.push({ mac: d.mac_address, error: 'Missing mac_address or model' });
          continue;
        }

        const normalizedMac = d.mac_address
          .replace(/[^0-9A-Fa-f]/g, '')
          .match(/.{1,2}/g)
          ?.join(':')
          .toUpperCase();

        if (!normalizedMac || normalizedMac.length !== 17) {
          results.errors.push({ mac: d.mac_address, error: 'Invalid MAC format' });
          continue;
        }

        await req.prisma.onu_inventory.create({
          data: {
            mac_address: normalizedMac,
            serial_number: d.serial_number || null,
            model: d.model,
            vendor_id: d.vendor_id ? parseInt(d.vendor_id) : null,
            status: d.status || 'in_stock',
            purchase_date: d.purchase_date ? new Date(d.purchase_date) : null,
            purchase_price: d.purchase_price ? parseFloat(d.purchase_price) : null,
            warranty_until: d.warranty_until ? new Date(d.warranty_until) : null,
            notes: d.notes || null,
          },
        });
        results.created++;
      } catch (err) {
        results.errors.push({ mac: d.mac_address, error: err.message.includes('Unique') ? 'Duplicate MAC' : err.message });
      }
    }

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin',
        user_id: req.admin?.id || 0,
        action: 'onu_bulk_add',
        entity_type: 'onu_inventory',
        entity_id: 0,
        details: { attempted: devices.length, created: results.created, errors: results.errors.length },
        ip_address: req.ip,
      },
    });

    res.status(201).json(results);
  } catch (err) {
    console.error('ONU bulk error:', err);
    res.status(500).json({ error: 'Bulk add failed' });
  }
});

// ============================================================
// ONU VENDOR ROUTES
// ============================================================

// ── GET /admin/onu-vendors — List vendors ───────────────────
router.get('/onu-vendors', adminAuth(), async (req, res) => {
  try {
    const { include_inactive } = req.query;
    const where = include_inactive ? {} : { is_active: true };
    const vendors = await req.prisma.vendors.findMany({
      where,
      include: { _count: { select: { onu_devices: true } } },
      orderBy: [{ is_active: "desc" }, { name: "asc" }],
      orderBy: { name: 'asc' },
    });
    res.json(vendors);
  } catch (err) {
    console.error('Vendor list error:', err);
    res.status(500).json({ error: 'Failed to fetch vendors' });
  }
});

// ── POST /admin/onu-vendors — Add vendor ────────────────────
router.post('/onu-vendors', adminAuth(), async (req, res) => {
  try {
    const { name, contact, phone, email, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Vendor name is required' });

    const vendor = await req.prisma.vendors.create({
      data: { name, contact, phone, email, notes },
    });
    res.status(201).json(vendor);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Vendor name already exists' });
    }
    console.error('Vendor create error:', err);
    res.status(500).json({ error: 'Failed to add vendor' });
  }
});

// ── PUT /admin/onu-vendors/:id — Update vendor ──────────────
router.put('/onu-vendors/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, contact, phone, email, notes, is_active } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (contact !== undefined) data.contact = contact;
    if (phone !== undefined) data.phone = phone;
    if (email !== undefined) data.email = email;
    if (notes !== undefined) data.notes = notes;
    if (is_active !== undefined) data.is_active = is_active;

    const vendor = await req.prisma.vendors.update({ where: { id }, data });
    res.json(vendor);
  } catch (err) {
    console.error('Vendor update error:', err);
    res.status(500).json({ error: 'Failed to update vendor' });
  }
});

// ============================================
// SURVEY ENDPOINTS
// ============================================

// POST /api/admin/surveys - Submit survey with photo + GPS
router.post('/surveys', adminAuth(), async (req, res) => {
  try {
    const { subscriber_id, latitude, longitude, notes, result, photo } = req.body;
    if (!subscriber_id || !result) return res.status(400).json({ error: 'subscriber_id and result required' });
    if (!['approved', 'declined'].includes(result)) return res.status(400).json({ error: 'result must be approved or declined' });

    // adminAuth attaches req.admin, not req.adminUser — the latter is undefined, so
    // every survey note ever written was attributed to a generic 'Admin'.
    const who = subNotes.adminName(req);
    let photoPath = null;

    // Save photo if provided (base64)
    if (photo) {
      const fs = require('fs');
      const base64Data = photo.replace(/^data:image\/\w+;base64,/, '');
      const ext = photo.startsWith('data:image/png') ? 'png' : 'jpg';
      const filename = `survey_${subscriber_id}_${Date.now()}.${ext}`;
      const fullPath = `/var/www/netfactory.com.ph/html/uploads/surveys/${filename}`;
      fs.writeFileSync(fullPath, base64Data, 'base64');
      photoPath = `/uploads/surveys/${filename}`;
    }

    // Create survey record
    const survey = await req.prisma.$queryRaw`
      INSERT INTO surveys (subscriber_id, surveyed_by, latitude, longitude, photo_path, notes, result)
      VALUES (${parseInt(subscriber_id)}, ${who}, ${latitude ? parseFloat(latitude) : null}, ${longitude ? parseFloat(longitude) : null}, ${photoPath}, ${notes || null}, ${result})
      RETURNING id, subscriber_id, surveyed_by, latitude, longitude, photo_path, notes, result, created_at
    `;

    // Update subscriber status based on result
    const newStatus = result === 'approved' ? 'approved' : 'declined';
    const surveyNote = `SURVEY ${result.toUpperCase()}: ${new Date().toLocaleDateString('en-PH')} by ${who}${notes ? ' — ' + notes : ''}${latitude ? ' | GPS: ' + parseFloat(latitude).toFixed(6) + ',' + parseFloat(longitude).toFixed(6) : ''}`;

    const sub = await req.prisma.subscribers.findUnique({ where: { id: parseInt(subscriber_id) } });
    await req.prisma.subscribers.update({
      where: { id: parseInt(subscriber_id) },
      data: {
        status: newStatus,
        latitude: latitude ? parseFloat(latitude) : sub.latitude,
        longitude: longitude ? parseFloat(longitude) : sub.longitude,
        notes: sub.notes ? sub.notes + '\n' + surveyNote : surveyNote
      }
    });

    // The remark also becomes a timeline row. No summary is appended here: surveyNote
    // above already put this sentence into subscribers.notes.
    await subNotes.add(req.prisma, parseInt(subscriber_id),
      result === 'approved' ? 'approval' : 'decline', notes, who);

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'survey_submitted', entity_type: 'subscribers', entity_id: parseInt(subscriber_id),
        details: { result, surveyed_by: who, latitude, longitude, has_photo: !!photo },
        ip_address: req.ip
      }
    });

    // ── Send survey result notification to subscriber ──
    try {
      const company = await getCompanyInfo(req.prisma);
      const plan = sub.plan_id ? await req.prisma.plans.findUnique({ where: { id: sub.plan_id } }) : null;
      const template = result === 'approved' ? 'application_approved' : 'application_declined';
      const td = {
        name: sub.first_name,
        accountNumber: sub.account_number,
        plan: plan?.name || '—',
        monthlyRate: plan?.price ? Number(plan.price).toLocaleString() : '—',
        reason: notes || 'Coverage or technical limitations in your area',
      };
      if (sub.email && req.config?.email) {
        const tmpl = getEmailTemplate(template, td, company);
        if (tmpl) req.config.email.sendWithPrisma(req.prisma, { to: sub.email, subject: tmpl.subject, html: tmpl.html })
          .catch(err => console.error(`[EMAIL] ${template} failed:`, err.message));
      }
      if (sub.phone && req.config?.sms) {
        const smsText = getSmsTemplate(template, td, company);
        if (smsText) req.config.sms.sendWithPrisma(req.prisma, sub.phone, smsText)
          .catch(err => console.error(`[SMS] ${template} failed:`, err.message));
      }
      console.log(`[NOTIFY] Survey ${result} notification sent for ${sub.account_number}`);
    } catch (notifErr) {
      console.error('[NOTIFY] Survey notification failed:', notifErr.message);
    }

    res.json({ message: `Survey ${result}`, survey: survey[0] });
  } catch (err) {
    console.error('Survey error:', err);
    res.status(500).json({ error: 'Failed to submit survey' });
  }
});

// ── Stage remarks ───────────────────────────────────────────
// A remark can be attached at any lifecycle step. The row in subscriber_notes is the
// record; the one-line summary appended to subscribers.notes is there because the CRM
// still parses that blob for the installation date and the decline reason.
// See src/utils/subscriber-notes.js.

// GET /api/admin/subscribers/:id/notes - the remark timeline, newest first
router.get('/subscribers/:id/notes', adminAuth(), async (req, res) => {
  try {
    const sid = parseInt(req.params.id);
    if (!Number.isInteger(sid)) return res.status(400).json({ error: 'Invalid subscriber id' });
    const notes = await subNotes.list(req.prisma, sid);
    res.json({ notes, stages: subNotes.STAGES });
  } catch (err) {
    console.error('Subscriber notes list error:', err);
    res.status(500).json({ error: 'Failed to load remarks' });
  }
});

// POST /api/admin/subscribers/:id/notes - record a remark
// { stage, remark, summarise?: boolean }
// summarise defaults to true. The stage handlers that already write their own line into
// subscribers.notes pass false, so the blob does not get the same sentence twice.
router.post('/subscribers/:id/notes', adminAuth(), async (req, res) => {
  try {
    const sid = parseInt(req.params.id);
    if (!Number.isInteger(sid)) return res.status(400).json({ error: 'Invalid subscriber id' });

    const remark = String(req.body.remark == null ? '' : req.body.remark).trim();
    if (!remark) return res.status(400).json({ error: 'Remark is required' });
    const stage = subNotes.isStage(req.body.stage) ? req.body.stage : 'general';
    const author = subNotes.adminName(req);

    const sub = await req.prisma.subscribers.findUnique({
      where: { id: sid }, select: { id: true, notes: true },
    });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    const saved = await subNotes.add(req.prisma, sid, stage, remark, author);
    if (!saved) return res.status(500).json({ error: 'Could not save the remark' });

    // The blob update is best-effort: the remark is already recorded, and failing the
    // request here would tell the user it was lost when it was not.
    if (req.body.summarise !== false) {
      try {
        await req.prisma.subscribers.update({
          where: { id: sid },
          data: { notes: subNotes.appendSummary(sub.notes, stage, remark, author, saved.created_at) },
        });
      } catch (e) {
        console.error('[subscriber-notes] summary line not appended for ' + sid + ': ' + e.message);
      }
    }

    req.auditLog('SUBSCRIBER_NOTE_ADD', { subscriberId: sid, stage }).catch(() => {});
    res.status(201).json({ note: saved });
  } catch (err) {
    console.error('Subscriber note add error:', err);
    res.status(500).json({ error: 'Failed to save the remark' });
  }
});

// GET /api/admin/surveys/:subscriberId - Get surveys for a subscriber
router.get('/surveys/:subscriberId', adminAuth(), async (req, res) => {
  try {
    const surveys = await req.prisma.$queryRaw`
      SELECT * FROM surveys WHERE subscriber_id = ${parseInt(req.params.subscriberId)} ORDER BY created_at DESC
    `;
    res.json({ surveys });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch surveys' });
  }
});


// PUT /api/admin/staff/:id/alerts - Update alert notification preferences
router.put('/staff/:id/alerts', adminAuth(), async (req, res) => {
  try {
    const { id } = req.params;
    const { receive_email_alerts, receive_sms_alerts } = req.body;

    if (typeof receive_email_alerts !== 'boolean' && typeof receive_sms_alerts !== 'boolean') {
      return res.status(400).json({ error: 'At least one alert preference must be provided' });
    }

    const updateData = {};
    if (typeof receive_email_alerts === 'boolean') updateData.receive_email_alerts = receive_email_alerts;
    if (typeof receive_sms_alerts === 'boolean') updateData.receive_sms_alerts = receive_sms_alerts;

    const staff = await req.prisma.admin_users.update({
      where: { id: parseInt(id) },
      data: updateData,
      select: {
        id: true,
        username: true,
        email: true,
        phone: true,
        receive_email_alerts: true,
        receive_sms_alerts: true,
      }
    });


    res.json({ 
      success: true, 
      message: 'Alert preferences updated successfully',
      staff 
    });
  } catch (err) {
    console.error('Update staff alerts error:', err);
    res.status(500).json({ error: 'Failed to update alert preferences' });
  }
});

// GET /api/admin/staff/alerts/recipients - Get all staff who should receive alerts
router.get('/staff/alerts/recipients', adminAuth(), async (req, res) => {
  try {
    const emailRecipients = await req.prisma.admin_users.findMany({
      where: { 
        receive_email_alerts: true,
        is_active: true,
        email: { not: null }
      },
      select: {
        id: true,
        username: true,
        email: true,
        full_name: true,
      }
    });

    const smsRecipients = await req.prisma.admin_users.findMany({
      where: { 
        receive_sms_alerts: true,
        is_active: true,
        phone: { not: null }
      },
      select: {
        id: true,
        username: true,
        phone: true,
        full_name: true,
      }
    });

    res.json({ 
      emailRecipients,
      smsRecipients,
      total: {
        email: emailRecipients.length,
        sms: smsRecipients.length,
      }
    });
  } catch (err) {
    console.error('Get alert recipients error:', err);
    res.status(500).json({ error: 'Failed to fetch alert recipients' });
  }
});





module.exports = router;


// ── GET /api/admin/website/content ──────────────────────────
router.get('/website/content', adminAuth(), async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const rows = await prisma.system_settings.findMany({
      where: { category: 'website' },
      orderBy: { key: 'asc' }
    });
    const content = {};
    rows.forEach(r => { content[r.key] = r.value || ''; });
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load website content' });
  }
});

// ── PUT /api/admin/website/content ──────────────────────────
router.put('/website/content', adminAuth(), async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const updates = req.body;
    if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Invalid body' });
    const ops = Object.entries(updates).map(([key, value]) =>
      prisma.system_settings.upsert({
        where: { key },
        update: { value: String(value), updated_at: new Date() },
        create: { key, value: String(value), category: 'website' }
      })
    );
    await Promise.all(ops);
    res.json({ ok: true, updated: Object.keys(updates).length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save website content' });
  }
});

// ── GET /api/admin/website/faqs ─────────────────────────────
router.get('/website/faqs', adminAuth(), async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const faqs = await prisma.$queryRaw`
      SELECT id, question, answer, sort_order, is_active, created_at, updated_at
      FROM website_faqs ORDER BY sort_order ASC, id ASC
    `;
    res.json({ faqs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load FAQs' });
  }
});

// ── POST /api/admin/website/faqs ────────────────────────────
router.post('/website/faqs', adminAuth(), async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const { question, answer, sort_order = 0, is_active = true } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'question and answer are required' });
    const faq = await prisma.$queryRaw`
      INSERT INTO website_faqs (question, answer, sort_order, is_active, created_at, updated_at)
      VALUES (${question}, ${answer}, ${Number(sort_order)}, ${Boolean(is_active)}, NOW(), NOW())
      RETURNING id, question, answer, sort_order, is_active
    `;
    res.json({ ok: true, faq: faq[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create FAQ' });
  }
});

// ── PUT /api/admin/website/faqs/:id ─────────────────────────
router.put('/website/faqs/:id', adminAuth(), async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const id = parseInt(req.params.id);
    const { question, answer, sort_order, is_active } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;
    if (question   !== undefined) { fields.push(`question = $${idx++}`);   values.push(question); }
    if (answer     !== undefined) { fields.push(`answer = $${idx++}`);     values.push(answer); }
    if (sort_order !== undefined) { fields.push(`sort_order = $${idx++}`); values.push(Number(sort_order)); }
    if (is_active  !== undefined) { fields.push(`is_active = $${idx++}`);  values.push(Boolean(is_active)); }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    fields.push(`updated_at = NOW()`);
    values.push(id);
    const result = await prisma.$queryRawUnsafe(
      `UPDATE website_faqs SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, question, answer, sort_order, is_active`,
      ...values
    );
    if (!result.length) return res.status(404).json({ error: 'FAQ not found' });
    res.json({ ok: true, faq: result[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update FAQ' });
  }
});

// ── DELETE /api/admin/website/faqs/:id ──────────────────────
router.delete('/website/faqs/:id', adminAuth(), async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const id = parseInt(req.params.id);
    const result = await prisma.$queryRaw`DELETE FROM website_faqs WHERE id = ${id} RETURNING id`;
    if (!result.length) return res.status(404).json({ error: 'FAQ not found' });
    res.json({ ok: true, deleted: id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete FAQ' });
  }
});

// ── POST /api/admin/website/faqs/reorder ────────────────────
router.post('/website/faqs/reorder', adminAuth(), async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of IDs' });
    await Promise.all(
      order.map((id, index) =>
        prisma.$queryRaw`UPDATE website_faqs SET sort_order = ${index + 1}, updated_at = NOW() WHERE id = ${Number(id)}`
      )
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reorder FAQs' });
  }
});

// ============================================================
// PROMOTIONS CRUD
// ============================================================

// ── GET /api/admin/promotions ───────────────────────────────
router.get('/promotions', adminAuth(), async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const promos = await prisma.$queryRaw`
      SELECT id, title, description, badge_text, cta_text, cta_link, is_active,
             start_date, end_date, sort_order, created_by, created_at, updated_at
      FROM promotions ORDER BY sort_order ASC, id DESC
    `;
    res.json({ promotions: promos });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load promotions' });
  }
});

// ── POST /api/admin/promotions ──────────────────────────────
router.post('/promotions', adminAuth(), async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const { title, description, badge_text, cta_text, cta_link, is_active = true, start_date, end_date, sort_order = 0 } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const adminName = req.admin?.username || req.admin?.full_name || 'ADMIN';

    const promo = await prisma.$queryRawUnsafe(
      `INSERT INTO promotions (title, description, badge_text, cta_text, cta_link, is_active, start_date, end_date, sort_order, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, NOW(), NOW())
       RETURNING *`,
      title, description || null, badge_text || null, cta_text || null, cta_link || null,
      Boolean(is_active), start_date || null, end_date || null, Number(sort_order), adminName
    );

    // Notify opted-in subscribers if toggle is ON
    if (Boolean(is_active)) {
      const { getToggle } = require('../middleware/systemToggles');
      if (getToggle('promotions_notify_subscribers')) {
        notifySubscribersOfPromo(req, promo[0]).catch(err =>
          console.error('[PROMO NOTIFY] Error:', err.message)
        );
      }
    }

    if (req.auditLog) await req.auditLog('PROMOTION_CREATE', { id: promo[0].id, title }).catch(() => {});
    res.json({ ok: true, promotion: promo[0] });
  } catch (err) {
    console.error('Create promotion error:', err);
    res.status(500).json({ error: 'Failed to create promotion' });
  }
});

// ── PUT /api/admin/promotions/:id ───────────────────────────
router.put('/promotions/:id', adminAuth(), async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const id = parseInt(req.params.id);
    const { title, description, badge_text, cta_text, cta_link, is_active, start_date, end_date, sort_order } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;
    if (title       !== undefined) { fields.push(`title = $${idx++}`);       values.push(title); }
    if (description !== undefined) { fields.push(`description = $${idx++}`); values.push(description); }
    if (badge_text  !== undefined) { fields.push(`badge_text = $${idx++}`);  values.push(badge_text); }
    if (cta_text    !== undefined) { fields.push(`cta_text = $${idx++}`);    values.push(cta_text); }
    if (cta_link    !== undefined) { fields.push(`cta_link = $${idx++}`);    values.push(cta_link); }
    if (is_active   !== undefined) { fields.push(`is_active = $${idx++}`);   values.push(Boolean(is_active)); }
    if (start_date  !== undefined) { fields.push(`start_date = $${idx}::date`); idx++; values.push(start_date || null); }
    if (end_date    !== undefined) { fields.push(`end_date = $${idx}::date`); idx++; values.push(end_date || null); }
    if (sort_order  !== undefined) { fields.push(`sort_order = $${idx++}`);  values.push(Number(sort_order)); }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    fields.push(`updated_at = NOW()`);
    values.push(id);
    const result = await prisma.$queryRawUnsafe(
      `UPDATE promotions SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      ...values
    );
    if (!result.length) return res.status(404).json({ error: 'Promotion not found' });
    if (req.auditLog) await req.auditLog('PROMOTION_UPDATE', { id, title: result[0].title }).catch(() => {});
    res.json({ ok: true, promotion: result[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update promotion' });
  }
});

// ── DELETE /api/admin/promotions/:id ────────────────────────
router.delete('/promotions/:id', adminAuth(), async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const id = parseInt(req.params.id);
    const result = await prisma.$queryRaw`DELETE FROM promotions WHERE id = ${id} RETURNING id, title`;
    if (!result.length) return res.status(404).json({ error: 'Promotion not found' });
    if (req.auditLog) await req.auditLog('PROMOTION_DELETE', { id, title: result[0].title }).catch(() => {});
    res.json({ ok: true, deleted: id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete promotion' });
  }
});

// ── Helper: notify subscribers of new promotion ─────────────
async function notifySubscribersOfPromo(req, promo) {
  const promoCo = await getCompany(req.config.db.prisma).catch(() => null);
  const promoName = promoCo?.name || 'Netfactory';
  const promoDomain = promoCo?.domain || 'netfactory.com.ph';
  const promoPortal = promoCo?.portalUrl || 'https://netfactory.com.ph/portal/';
  const prisma = req.config.db.prisma;
  // Find active subscribers who opted in to promos
  const subscribers = await prisma.$queryRaw`
    SELECT s.id, s.first_name, s.phone, s.email
    FROM subscribers s
    JOIN subscriber_notification_prefs p ON p.subscriber_id = s.id
    WHERE s.status = 'active' AND p.promos = true
  `;
  if (!subscribers.length) return;

  let smsSent = 0, emailSent = 0;
  for (const sub of subscribers) {
    // SMS
    if (sub.phone && req.config?.sms) {
      req.config.sms.sendWithPrisma(prisma, sub.phone,
        `${promoName}: ${promo.badge_text ? promo.badge_text + ' - ' : ''}${promo.title}${promo.description ? '. ' + promo.description.substring(0, 100) : ''}. Visit ${promoDomain} for details!`
      ).then(() => smsSent++).catch(() => {});
    }
    // Email
    if (sub.email && req.config?.email) {
      req.config.email.sendWithPrisma(prisma, {
        to: sub.email,
        subject: `${promoName} — ${promo.title}`,
        html: `<h2>${promo.badge_text ? '<span style="color:#7c3aed;">' + promo.badge_text + '</span> — ' : ''}${promo.title}</h2>
               <p>${promo.description || ''}</p>
               ${promo.cta_link ? '<p><a href="' + promo.cta_link + '" style="background:#7c3aed;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;display:inline-block;">' + (promo.cta_text || 'Learn More') + '</a></p>' : ''}
               <p style="color:#666;font-size:12px;">You received this because you opted in to promotional notifications. Manage preferences in your <a href="${promoPortal}#account">Client Portal</a>.</p>`
      }).then(() => emailSent++).catch(() => {});
    }
  }
  console.log(`[PROMO NOTIFY] Sent to ${subscribers.length} subscribers (SMS: ${smsSent}, Email: ${emailSent})`);
}

// ============================================================
// CAREERS CRUD
// ============================================================

// ── GET /api/admin/careers ──────────────────────────────────
router.get('/careers', adminAuth(), async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const careers = await prisma.$queryRaw`
      SELECT id, title, department, location, type, description, requirements,
             is_active, sort_order, created_by, created_at, updated_at
      FROM careers ORDER BY sort_order ASC, id DESC
    `;
    res.json({ careers });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load careers' });
  }
});

// ── POST /api/admin/careers ─────────────────────────────────
router.post('/careers', adminAuth(), async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const { title, department, location, type = 'Full-time', description, requirements, is_active = true, sort_order = 0 } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const adminName = req.admin?.username || req.admin?.full_name || 'ADMIN';
    const career = await prisma.$queryRawUnsafe(
      `INSERT INTO careers (title, department, location, type, description, requirements, is_active, sort_order, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       RETURNING *`,
      title, department || null, location || 'Balanga City, Bataan', type, description || null,
      requirements || null, Boolean(is_active), Number(sort_order), adminName
    );
    if (req.auditLog) await req.auditLog('CAREER_CREATE', { id: career[0].id, title }).catch(() => {});
    res.json({ ok: true, career: career[0] });
  } catch (err) {
    console.error('Create career error:', err);
    res.status(500).json({ error: 'Failed to create career posting' });
  }
});

// ── PUT /api/admin/careers/:id ──────────────────────────────
router.put('/careers/:id', adminAuth(), async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const id = parseInt(req.params.id);
    const { title, department, location, type, description, requirements, is_active, sort_order } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;
    if (title        !== undefined) { fields.push(`title = $${idx++}`);        values.push(title); }
    if (department   !== undefined) { fields.push(`department = $${idx++}`);   values.push(department); }
    if (location     !== undefined) { fields.push(`location = $${idx++}`);     values.push(location); }
    if (type         !== undefined) { fields.push(`type = $${idx++}`);         values.push(type); }
    if (description  !== undefined) { fields.push(`description = $${idx++}`);  values.push(description); }
    if (requirements !== undefined) { fields.push(`requirements = $${idx++}`); values.push(requirements); }
    if (is_active    !== undefined) { fields.push(`is_active = $${idx++}`);    values.push(Boolean(is_active)); }
    if (sort_order   !== undefined) { fields.push(`sort_order = $${idx++}`);   values.push(Number(sort_order)); }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    fields.push(`updated_at = NOW()`);
    values.push(id);
    const result = await prisma.$queryRawUnsafe(
      `UPDATE careers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      ...values
    );
    if (!result.length) return res.status(404).json({ error: 'Career posting not found' });
    if (req.auditLog) await req.auditLog('CAREER_UPDATE', { id, title: result[0].title }).catch(() => {});
    res.json({ ok: true, career: result[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update career posting' });
  }
});

// ============================================
// GET /api/admin/subscribers/:id/soa-pdf — Statement of Account PDF
// ============================================
router.get('/subscribers/:id/soa-pdf', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.query.token;
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded) return res.status(401).json({ error: 'Invalid token' });

    const { generateSOAPDF } = require('../utils/soaPdf');
    const periodFrom = req.query.from || null;
    const periodTo = req.query.to || null;
    const includeAll = req.query.includeAll === 'true';
    const pdfBuffer = await generateSOAPDF(req.prisma, req.params.id, periodFrom, periodTo, includeAll);

    const sub = await req.prisma.subscribers.findUnique({
      where: { id: parseInt(req.params.id) },
      select: { account_number: true, first_name: true, last_name: true }
    });
    const filename = `SOA-${sub?.account_number || 'subscriber'}-${sub?.last_name || ''}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    console.error('SOA PDF error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate SOA PDF' });
  }
});

// ── DELETE /api/admin/careers/:id ───────────────────────────
router.delete('/careers/:id', adminAuth(), async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const id = parseInt(req.params.id);
    const result = await prisma.$queryRaw`DELETE FROM careers WHERE id = ${id} RETURNING id, title`;
    if (!result.length) return res.status(404).json({ error: 'Career posting not found' });
    if (req.auditLog) await req.auditLog('CAREER_DELETE', { id, title: result[0].title }).catch(() => {});
    res.json({ ok: true, deleted: id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete career posting' });
  }
});
