const express = require('express');
const { getCompany } = require('../utils/company');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// ============================================================
// AGENT AUTH MIDDLEWARE
// ============================================================
const AGENT_COOKIE_NAME = 'j2_agent_token';

const agentAuth = () => {
  return async (req, res, next) => {
    try {
      let token = null;
      if (req.cookies && req.cookies[AGENT_COOKIE_NAME]) {
        token = req.cookies[AGENT_COOKIE_NAME];
      } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
      }

      if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.type !== 'agent') {
        return res.status(403).json({ error: 'Invalid token type' });
      }

      const agent = await req.prisma.sales_agents.findUnique({ where: { id: decoded.id } });
      if (!agent || agent.status !== 'active') {
        return res.status(401).json({ error: 'Account disabled or not found' });
      }

      req.agent = agent;
      req.agentId = agent.id;
      req.token = token;
      next();
    } catch (err) {
      if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Session expired. Please login again.' });
      if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
      return res.status(500).json({ error: 'Authentication error' });
    }
  };
};

// ============================================================
// POST /login — Agent login
// ============================================================
router.post('/login', async (req, res) => {
  try {
    const { agentCode, password } = req.body;
    if (!agentCode || !password) {
      return res.status(400).json({ error: 'Agent code and password are required' });
    }

    const agent = await req.prisma.sales_agents.findUnique({
      where: { agent_code: agentCode.toUpperCase().trim() }
    });

    if (!agent) {
      return res.status(401).json({ error: 'Invalid agent code or password' });
    }

    if (agent.status !== 'active') {
      return res.status(403).json({ error: 'Account is suspended or inactive' });
    }

    const validPass = await bcrypt.compare(password, agent.password_hash);
    if (!validPass) {
      return res.status(401).json({ error: 'Invalid agent code or password' });
    }

    // Update last login
    await req.prisma.sales_agents.update({
      where: { id: agent.id },
      data: { last_login: new Date() }
    });

    const token = jwt.sign(
      { id: agent.id, type: 'agent', code: agent.agent_code },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Set httpOnly cookie
    res.cookie(AGENT_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      token,
      agent: {
        id: agent.id,
        agentCode: agent.agent_code,
        firstName: agent.first_name,
        lastName: agent.last_name,
        fullName: `${agent.first_name} ${agent.last_name}`,
        phone: agent.phone,
        email: agent.email,
        commissionRate: agent.commission_rate,
        areaAssigned: agent.area_assigned,
        totalSignups: agent.total_signups,
      }
    });
  } catch (err) {
    console.error('[AGENT LOGIN]', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================================
// POST /logout — Agent logout
// ============================================================
router.post('/logout', (req, res) => {
  res.clearCookie(AGENT_COOKIE_NAME);
  res.json({ message: 'Logged out' });
});

// ============================================================
// GET /profile — Agent profile
// ============================================================
router.get('/profile', agentAuth(), async (req, res) => {
  try {
    const agent = req.agent;
    res.json({
      agent: {
        id: agent.id,
        agentCode: agent.agent_code,
        firstName: agent.first_name,
        lastName: agent.last_name,
        fullName: `${agent.first_name} ${agent.last_name}`,
        phone: agent.phone,
        email: agent.email,
        commissionRate: Number(agent.commission_rate),
        areaAssigned: agent.area_assigned,
        totalSignups: agent.total_signups,
        status: agent.status,
        lastLogin: agent.last_login,
        createdAt: agent.created_at,
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// ============================================================
// GET /stats — Agent dashboard stats
// ============================================================
router.get('/stats', agentAuth(), async (req, res) => {
  try {
    const agentId = req.agentId;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [total, thisMonth, byStatus] = await Promise.all([
      req.prisma.subscribers.count({ where: { agent_id: agentId } }),
      req.prisma.subscribers.count({
        where: {
          agent_id: agentId,
          created_at: { gte: startOfMonth }
        }
      }),
      req.prisma.$queryRaw`
        SELECT status, COUNT(*)::int as count
        FROM subscribers
        WHERE agent_id = ${agentId}
        GROUP BY status
        ORDER BY count DESC
      `
    ]);

    res.json({ total, thisMonth, byStatus });
  } catch (err) {
    console.error('[AGENT STATS]', err.message);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ============================================================
// GET /signups — Agent's subscriber list
// ============================================================
router.get('/signups', agentAuth(), async (req, res) => {
  try {
    const { status, limit = 50, offset = 0, search } = req.query;
    const where = { agent_id: req.agentId };
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { first_name: { contains: search, mode: 'insensitive' } },
        { last_name: { contains: search, mode: 'insensitive' } },
        { account_number: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ];
    }

    const [subscribers, total] = await Promise.all([
      req.prisma.subscribers.findMany({
        where,
        select: {
          id: true, account_number: true, first_name: true, middle_name: true,
          last_name: true, phone: true, email: true, address: true,
          barangay_name: true, municipality_name: true, status: true,
          plan: { select: { id: true, name: true, speed_label: true, price: true } },
          installation_package: true, application_date: true, created_at: true,
        },
        orderBy: { created_at: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      req.prisma.subscribers.count({ where }),
    ]);

    res.json({ subscribers, total });
  } catch (err) {
    console.error('[AGENT SIGNUPS]', err.message);
    res.status(500).json({ error: 'Failed to load signups' });
  }
});

// ============================================================
// GET /coverage — Municipalities & barangays for dropdowns
// ============================================================
router.get('/coverage', async (req, res) => {
  try {
    const municipalities = await req.prisma.municipalities.findMany({
      where: { is_serviceable: true },
      include: {
        barangays: {
          where: { is_serviceable: true },
          orderBy: { name: 'asc' },
        }
      },
      orderBy: { name: 'asc' },
    });
    res.json({ coverage: municipalities });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load coverage' });
  }
});

// ============================================================
// GET /plans — Active plans for signup form
// ============================================================
router.get('/plans', async (req, res) => {
  try {
    const plans = await req.prisma.plans.findMany({
      where: { is_active: true },
      orderBy: { sort_order: 'asc' },
      select: {
        id: true, name: true, slug: true, speed_mbps: true,
        speed_label: true, price: true, description: true,
        is_popular: true, data_cap_gb: true,
      }
    });
    res.json({ plans });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load plans' });
  }
});

// ============================================================
// POST /apply — Agent signs up a new customer (→ prospective)
// Mirrors /api/public/apply but tags the agent
// ============================================================
router.post('/apply', agentAuth(), async (req, res) => {
  try {
    const {
      firstName, middleName, lastName, email, phone,
      address, subdivision, barangay, municipality,
      planId, packageId, idType, notes
    } = req.body;

    // Validation — same as website
    if (!firstName || !lastName || !phone || !barangay || !municipality) {
      return res.status(400).json({ error: 'Missing required fields: firstName, lastName, phone, barangay, municipality' });
    }

    const cleanFirst = firstName.trim().toUpperCase();
    const cleanMiddle = middleName ? middleName.trim().toUpperCase() : null;
    const cleanLast = lastName.trim().toUpperCase();
    const cleanPhone = phone.replace(/[\s\-()]/g, '');

    // Duplicate checks
    const existingPhone = await req.prisma.subscribers.findFirst({ where: { phone: cleanPhone } });
    if (existingPhone) {
      return res.status(409).json({ error: 'A subscriber with this phone number already exists.' });
    }

    if (email) {
      const existingEmail = await req.prisma.subscribers.findFirst({ where: { email: email.toLowerCase() } });
      if (existingEmail) {
        return res.status(409).json({ error: 'A subscriber with this email already exists.' });
      }
    }

    // Verify plan
    let plan = null;
    if (planId) {
      plan = await req.prisma.plans.findUnique({ where: { id: parseInt(planId) } });
    }

    // Auto-GPS from barangay center
    let autoLat = null, autoLng = null;
    const brgy = await req.prisma.barangays.findFirst({
      where: { name: { equals: barangay, mode: 'insensitive' } },
      select: { latitude: true, longitude: true }
    });
    if (brgy) {
      autoLat = brgy.latitude ? Number(brgy.latitude) : null;
      autoLng = brgy.longitude ? Number(brgy.longitude) : null;
    }

    // Province lookup
    let autoProvince = null, postalCode = null;
    const muni = await req.prisma.municipalities.findFirst({
      where: { name: { equals: municipality, mode: 'insensitive' } },
      select: { province: true, postal_code: true }
    });
    if (muni) {
      autoProvince = muni.province || null;
      postalCode = muni.postal_code || null;
    }

    const agentName = `${req.agent.first_name} ${req.agent.last_name}`;

    // Build subscriber data
    const subData = {
      account_number: '',
      first_name: cleanFirst,
      last_name: cleanLast,
      middle_name: cleanMiddle,
      email: email ? email.toLowerCase() : null,
      phone: cleanPhone || '',
      address: address ? address.toUpperCase() : '',
      barangay_name: barangay.toUpperCase(),
      municipality_name: municipality.toUpperCase(),
      address_street2: subdivision ? subdivision.toUpperCase() : null,
      status: 'prospective',
      application_date: new Date(),
      latitude: autoLat,
      longitude: autoLng,
      address_state: autoProvince,
      address_postal_code: postalCode,
      address_city: municipality ? municipality.toUpperCase() : null,
      installation_package: packageId && ['A', 'B', 'C'].includes(packageId.toUpperCase()) ? packageId.toUpperCase() : null,
      agent_id: req.agentId,
      agent: `${req.agent.agent_code} - ${agentName}`,
      notes: [
        idType ? `ID TYPE: ${idType.toUpperCase()}` : null,
        packageId ? `INSTALLATION PACKAGE: ${packageId.toUpperCase()}` : null,
        notes ? `APPLICANT NOTES: ${notes.toUpperCase()}` : null,
        `SIGNED UP BY AGENT: ${req.agent.agent_code} (${agentName})`,
        `APPLIED VIA AGENT APP ON ${new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()}`
      ].filter(Boolean).join('\n'),
    };

    if (plan) subData.plan_id = plan.id;

    // Create subscriber
    const subscriber = await req.prisma.subscribers.create({ data: subData });
    const created = await req.prisma.subscribers.findUnique({
      where: { id: subscriber.id },
      select: { id: true, account_number: true, first_name: true, last_name: true, status: true }
    });

    // Increment agent signup count
    await req.prisma.sales_agents.update({
      where: { id: req.agentId },
      data: { total_signups: { increment: 1 } }
    });

    // CRM notification
    await req.prisma.notifications.create({
      data: {
        type: 'info',
        title: `New signup by Agent ${req.agent.agent_code}: ${cleanFirst} ${cleanLast}`,
        message: `Agent ${agentName} (${req.agent.agent_code}) signed up ${cleanFirst} ${cleanLast} from ${barangay.toUpperCase()}, ${municipality.toUpperCase()}.${plan ? ` Plan: ${plan.name}` : ''}`,
        target_type: 'subscriber',
        target_id: created.id,
        is_read: false,
      }
    });

    // Audit log
    await req.prisma.audit_log.create({
      data: {
        user_type: 'agent',
        user_id: req.agentId,
        action: 'agent_signup',
        entity_type: 'subscribers',
        entity_id: created.id,
        details: { source: 'agent_app', agentCode: req.agent.agent_code, municipality, barangay, planId: planId || null },
        ip_address: req.ip,
      }
    }).catch(() => {});

    const agentCo = await getCompany(req.prisma).catch(() => null);
    const agentCoName = agentCo?.name || 'Netfactory';

    // Send confirmation SMS to customer
    if (cleanPhone && req.config?.sms) {
      req.config.sms.sendWithPrisma(req.prisma,
        cleanPhone,
        `${agentCoName}: Hi ${cleanFirst}! Your application has been received (Ref: ${created.account_number}${plan ? ', Plan: ' + plan.name : ''}). Our team will contact you within 24-48 hours. Thank you for choosing ${agentCoName}!`
      ).catch(err => console.error('[SMS] Agent signup confirmation failed:', err.message));
    }

    // Send confirmation email
    if (email && req.config?.email) {
      req.config.email.sendWithPrisma(req.prisma, {
        to: email.toLowerCase(),
        subject: 'Application Received — Netfactory',
        html: `
          <h2>Welcome to Netfactory, ${firstName}!</h2>
          <p>Your application has been submitted by our sales representative. Here's a summary:</p>
          <table style="border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px 16px;background:#f3f4f6;font-weight:bold;">Reference #</td><td style="padding:8px 16px;">${created.account_number}</td></tr>
            ${plan ? `<tr><td style="padding:8px 16px;background:#f3f4f6;font-weight:bold;">Plan</td><td style="padding:8px 16px;">${plan.name} — ${plan.speed_label}</td></tr>
            <tr><td style="padding:8px 16px;background:#f3f4f6;font-weight:bold;">Monthly</td><td style="padding:8px 16px;">₱${Number(plan.price).toLocaleString()}</td></tr>` : ''}
            <tr><td style="padding:8px 16px;background:#f3f4f6;font-weight:bold;">Status</td><td style="padding:8px 16px;">Prospective — awaiting review</td></tr>
          </table>
          <p>Our team will contact you within 24-48 hours to schedule a site survey. If you have questions, reply to this email.</p>
          <p>— Netfactory Team</p>
        `,
      }).catch(err => console.error('[EMAIL] Agent signup confirmation failed:', err.message));
    }

    res.status(201).json({
      message: 'Customer signed up successfully!',
      subscriber: {
        id: created.id,
        accountNumber: created.account_number,
        firstName: created.first_name,
        lastName: created.last_name,
        status: created.status,
      }
    });
  } catch (err) {
    console.error('[AGENT APPLY]', err.message);
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

// ============================================================
// ADMIN: GET /admin/list — List all agents (for CRM)
// ============================================================
const adminAuth = require('../middleware/adminAuth');

router.get('/admin/list', adminAuth(), async (req, res) => {
  try {
    const { status, search } = req.query;
    const where = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { first_name: { contains: search, mode: 'insensitive' } },
        { last_name: { contains: search, mode: 'insensitive' } },
        { agent_code: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ];
    }

    const agents = await req.prisma.sales_agents.findMany({
      where,
      select: {
        id: true, agent_code: true, first_name: true, last_name: true,
        phone: true, email: true, status: true, commission_rate: true,
        area_assigned: true, total_signups: true, last_login: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
    });

    res.json({ agents });
  } catch (err) {
    console.error('[AGENTS LIST]', err.message);
    res.status(500).json({ error: 'Failed to load agents' });
  }
});

// ============================================================
// ADMIN: POST /admin/create — Create a new agent
// ============================================================
router.post('/admin/create', adminAuth(), async (req, res) => {
  try {
    const { firstName, lastName, phone, email, password, commissionRate, areaAssigned, notes } = req.body;

    if (!firstName || !lastName || !phone || !password) {
      return res.status(400).json({ error: 'firstName, lastName, phone, and password are required' });
    }

    // Generate agent code: AGT-XXXX
    const lastAgent = await req.prisma.sales_agents.findFirst({ orderBy: { id: 'desc' } });
    const nextNum = lastAgent ? lastAgent.id + 1 : 1;
    const agentCode = `AGT-${String(nextNum).padStart(4, '0')}`;

    const hash = await bcrypt.hash(password, 10);

    const agent = await req.prisma.sales_agents.create({
      data: {
        agent_code: agentCode,
        first_name: firstName.trim().toUpperCase(),
        last_name: lastName.trim().toUpperCase(),
        phone: phone.replace(/[\s\-()]/g, ''),
        email: email ? email.toLowerCase() : null,
        password_hash: hash,
        commission_rate: commissionRate ? parseFloat(commissionRate) : 0,
        area_assigned: areaAssigned || null,
        notes: notes || null,
      }
    });

    res.status(201).json({
      message: 'Agent created',
      agent: {
        id: agent.id,
        agentCode: agent.agent_code,
        firstName: agent.first_name,
        lastName: agent.last_name,
      }
    });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Agent code already exists' });
    }
    console.error('[AGENT CREATE]', err.message);
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

// ============================================================
// ADMIN: PUT /admin/:id — Update agent
// ============================================================
router.put('/admin/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { firstName, lastName, phone, email, password, status, commissionRate, areaAssigned, notes } = req.body;

    const data = {};
    if (firstName) data.first_name = firstName.trim().toUpperCase();
    if (lastName) data.last_name = lastName.trim().toUpperCase();
    if (phone) data.phone = phone.replace(/[\s\-()]/g, '');
    if (email !== undefined) data.email = email ? email.toLowerCase() : null;
    if (status) data.status = status;
    if (commissionRate !== undefined) data.commission_rate = parseFloat(commissionRate);
    if (areaAssigned !== undefined) data.area_assigned = areaAssigned || null;
    if (notes !== undefined) data.notes = notes || null;
    if (password) data.password_hash = await bcrypt.hash(password, 10);
    data.updated_at = new Date();

    const agent = await req.prisma.sales_agents.update({ where: { id }, data });

    res.json({
      message: 'Agent updated',
      agent: { id: agent.id, agentCode: agent.agent_code, status: agent.status }
    });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Agent not found' });
    console.error('[AGENT UPDATE]', err.message);
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

// ============================================================
// ADMIN: DELETE /admin/:id — Delete agent
// ============================================================
router.delete('/admin/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    // Check if agent has signups
    const signupCount = await req.prisma.subscribers.count({ where: { agent_id: id } });

    if (signupCount > 0) {
      // Soft delete — set inactive
      await req.prisma.sales_agents.update({ where: { id }, data: { status: 'inactive' } });
      return res.json({ message: `Agent deactivated (has ${signupCount} signups). Use status update instead.` });
    }

    await req.prisma.sales_agents.delete({ where: { id } });
    res.json({ message: 'Agent deleted' });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Agent not found' });
    console.error('[AGENT DELETE]', err.message);
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

module.exports = router;
