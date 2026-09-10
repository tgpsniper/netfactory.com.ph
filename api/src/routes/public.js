const express = require('express');
const { getCompany } = require('../utils/company');
const router = express.Router();
const rateLimit = require("express-rate-limit");
const multer = require('multer');
const pathLib = require('path');
const fsLib = require('fs');

// Strict rate limiter for contact form: 3 per 15 min per IP
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { error: "Too many submissions. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for apply form: 5 per hour per IP
const applyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Too many applications. Please try again in 1 hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Multer config for application attachments (mirrors CRM admin attachment endpoint)
const applyAttachDir = '/var/www/netfactory.com.ph/html/uploads/subscribers';
if (!fsLib.existsSync(applyAttachDir)) fsLib.mkdirSync(applyAttachDir, { recursive: true });

const applyAttachStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, applyAttachDir),
  filename: (req, file, cb) => {
    const ext = pathLib.extname(file.originalname).toLowerCase();
    const field = file.fieldname.replace(/[^a-z0-9_]/gi, '');
    cb(null, `apply_${Date.now()}_${field}_${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const applyAttachUpload = multer({
  storage: applyAttachStorage,
  limits: { fileSize: 10 * 1024 * 1024, files: 4 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.pdf', '.webp'];
    const ext = pathLib.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only JPG, PNG, PDF, and WEBP files are allowed'));
  }
});
const applyUploadFields = applyAttachUpload.fields([
  { name: 'proof_of_billing', maxCount: 1 },
  { name: 'valid_id1', maxCount: 1 },
  { name: 'valid_id2', maxCount: 1 },
  { name: 'other_attachment', maxCount: 1 },
]);

// ============================================
// GET /api/public/plans - Active plans for website
// ============================================
router.get('/plans', async (req, res) => {
  try {
    const plans = await req.prisma.plans.findMany({
      where: { is_active: true },
      include: {
        features: {
          where: { is_active: true },
          orderBy: { sort_order: 'asc' },
          select: { id: true, feature_text: true }
        }
      },
      orderBy: { sort_order: 'asc' }
    });

    const formatted = plans.map(p => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      speed: p.speed_mbps,
      speedLabel: p.speed_label,
      price: Number(p.price),
      description: p.description,
      color: p.color_hex,
      isPopular: p.is_popular,
      routerType: p.router_type,
      hasLockIn: p.has_lock_in,
      lockInMonths: p.lock_in_months,
      installationFee: Number(p.installation_fee || 0),
      activationFee: Number(p.activation_fee || 0),
      showFeesOnWebsite: p.show_fees_on_website || false,
      dataCap: p.data_cap_gb,
      features: p.features.map(f => f.feature_text)
    }));

    res.json({ plans: formatted });
  } catch (err) {
    console.error('Error fetching plans:', err);
    res.status(500).json({ error: 'Failed to load plans' });
  }
});

// ============================================
// GET /api/public/plans/:slug - Single plan detail
// ============================================
router.get('/plans/:slug', async (req, res) => {
  try {
    const plan = await req.prisma.plans.findUnique({
      where: { slug: req.params.slug },
      include: {
        features: {
          where: { is_active: true },
          orderBy: { sort_order: 'asc' }
        }
      }
    });

    if (!plan || !plan.is_active) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    res.json({
      id: plan.id,
      name: plan.name,
      slug: plan.slug,
      speed: plan.speed_mbps,
      speedLabel: plan.speed_label,
      price: Number(plan.price),
      description: plan.description,
      longDescription: plan.long_description,
      color: plan.color_hex,
      isPopular: plan.is_popular,
      routerType: plan.router_type,
      hasLockIn: plan.has_lock_in,
      installationFee: Number(plan.installation_fee || 0),
      features: plan.features.map(f => f.feature_text)
    });
  } catch (err) {
    console.error('Error fetching plan:', err);
    res.status(500).json({ error: 'Failed to load plan' });
  }
});

// ============================================
// GET /api/public/coverage - Serviceable areas
// ============================================
router.get('/coverage', async (req, res) => {
  try {
    const municipalities = await req.prisma.municipalities.findMany({
      where: { is_serviceable: true },
      include: {
        barangays: {
          where: { is_serviceable: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true }
        }
      },
      orderBy: { name: 'asc' }
    });

    res.json({ coverage: municipalities });
  } catch (err) {
    console.error('Error fetching coverage:', err);
    res.status(500).json({ error: 'Failed to load coverage areas' });
  }
});

// ============================================
// GET /api/public/packages - Active installation packages
// ============================================
router.get('/packages', async (req, res) => {
  try {
    const packages = await req.prisma.installation_packages.findMany({
      where: { is_active: true },
      include: {
        items: {
          where: { is_active: true },
          orderBy: { sort_order: 'asc' },
          select: { item_text: true }
        }
      },
      orderBy: { sort_order: 'asc' }
    });
    res.json({
      packages: packages.map(p => ({
        code: p.code,
        name: p.name,
        description: p.description,
        color: p.color_hex,
        items: p.items.map(i => i.item_text)
      }))
    });
  } catch (err) {
    console.error('Error fetching packages:', err);
    res.status(500).json({ error: 'Failed to load packages' });
  }
});

// ============================================
// POST /api/public/apply - Prospective subscriber application
// Website form → status 'prospective' + CRM notification + email/SMS
// ============================================
router.post('/apply', applyLimiter, applyUploadFields, async (req, res) => {
  try {
    const { firstName, middleName, lastName, email, phone, address, subdivision, barangay, municipality, planId, packageId, idType, notes, altContacts } = req.body;

    // Parse altContacts — sent as JSON string in multipart form
    let altContactsClean = [];
    if (altContacts) {
      try {
        const parsed = typeof altContacts === 'string' ? JSON.parse(altContacts) : altContacts;
        if (Array.isArray(parsed)) {
          altContactsClean = parsed
            .map(c => ({
              name: (c && c.name ? String(c.name).trim().toUpperCase() : '').substring(0, 100),
              phone: (c && c.phone ? String(c.phone).replace(/\D/g, '') : '').substring(0, 20),
            }))
            .filter(c => c.phone);
        }
      } catch (e) { /* ignore bad JSON */ }
    }

    // Validation
    if (!firstName || !lastName || !phone || !barangay || !municipality) {
      return res.status(400).json({ error: 'Missing required fields: firstName, lastName, phone, barangay, municipality' });
    }

    // Clean name fields (UPPERCASE)
    const cleanFirst = firstName.trim().toUpperCase();
    const cleanMiddle = middleName ? middleName.trim().toUpperCase() : null;
    const cleanLast = lastName.trim().toUpperCase();

    // Clean phone: remove dashes/spaces, keep digits
    const cleanPhone = phone.replace(/[\s\-()]/g, '');

    // Check for duplicate phone
    const existingPhone = await req.prisma.subscribers.findFirst({ where: { phone: cleanPhone } });
    if (existingPhone) {
      return res.status(409).json({ error: 'A subscriber with this phone number already exists.' });
    }

    // Validate + check duplicate email (if provided)
    if (email) {
      const cleanEmail = email.toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      const existingEmail = await req.prisma.subscribers.findFirst({ where: { email: cleanEmail } });
      if (existingEmail) {
        return res.status(409).json({ error: 'A subscriber with this email already exists.' });
      }
    }

    // Verify plan if provided
    let plan = null;
    if (planId) {
      plan = await req.prisma.plans.findUnique({ where: { id: parseInt(planId) } });
    }

    // Lookup barangay for auto-GPS from barangay center point
    let autoLat = null, autoLng = null;
    if (barangay) {
      const brgy = await req.prisma.barangays.findFirst({
        where: { name: { equals: barangay, mode: 'insensitive' } },
        select: { latitude: true, longitude: true }
      });
      if (brgy) {
        autoLat = brgy.latitude ? Number(brgy.latitude) : null;
        autoLng = brgy.longitude ? Number(brgy.longitude) : null;
      }
    }

    // Lookup municipality for province
    let autoProvince = null;
    if (municipality) {
      var muni = await req.prisma.municipalities.findFirst({
        where: { name: { equals: municipality, mode: 'insensitive' } },
        select: { province: true, postal_code: true }
      });
      if (muni) {
        autoProvince = muni.province || null;
      }
    }

    // Build subscriber data
    const subData = {
      account_number: '', // Overwritten by DB trigger
      first_name: cleanFirst,
      last_name: cleanLast,
      middle_name: cleanMiddle,
      email: email ? email.toLowerCase().trim() : null,
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
      address_postal_code: muni ? muni.postal_code || null : null,
      address_city: municipality ? municipality.toUpperCase() : null,
      installation_package: packageId && ['A','B','C'].includes(packageId.toUpperCase()) ? packageId.toUpperCase() : null,
      alt_contacts: altContactsClean,
      notes: [
        idType ? `ID TYPE: ${idType.toUpperCase()}` : null,
        packageId ? `INSTALLATION PACKAGE: ${packageId.toUpperCase()}` : null,
        notes ? `APPLICANT NOTES: ${notes.toUpperCase()}` : null,
        `APPLIED VIA WEBSITE ON ${new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()}`
      ].filter(Boolean).join('\n'),
    };

    // Link plan if valid
    if (plan) {
      subData.plan_id = plan.id;
    }

    // Create subscriber (account_number auto-generated by DB trigger)
    const subscriber = await req.prisma.subscribers.create({ data: subData });

    // Refetch to get auto-generated account number
    const created = await req.prisma.subscribers.findUnique({
      where: { id: subscriber.id },
      select: { id: true, account_number: true, first_name: true, last_name: true, status: true }
    });

    // Save any uploaded attachments to the subscriber record
    const attachFields = ['proof_of_billing', 'valid_id1', 'valid_id2', 'other_attachment'];
    const attachUpdate = {};
    for (const f of attachFields) {
      const fileArr = req.files && req.files[f];
      if (fileArr && fileArr[0]) {
        attachUpdate[f] = `/uploads/subscribers/${fileArr[0].filename}`;
      }
    }
    if (Object.keys(attachUpdate).length > 0) {
      await req.prisma.subscribers.update({ where: { id: subscriber.id }, data: attachUpdate });
    }

    // Create CRM notification
    await req.prisma.notifications.create({
      data: {
        type: 'info',
        title: `New prospective subscriber: ${cleanFirst} ${cleanLast}`,
        message: `${cleanFirst} ${cleanLast} from ${barangay.toUpperCase()}, ${municipality.toUpperCase()} applied via the website.${plan ? ` Plan: ${plan.name}` : ' No plan selected.'}${packageId ? ` Package: ${packageId.toUpperCase()}` : ''}`,
        target_type: 'subscriber',
        target_id: created.id,
        is_read: false,
      }
    });

    // Log to audit
    await req.prisma.audit_log.create({
      data: {
        user_type: 'public',
        user_id: 0,
        action: 'prospective_application',
        entity_type: 'subscribers',
        entity_id: created.id,
        details: { source: 'website', municipality, barangay, planId: planId || null, packageId: packageId || null },
        ip_address: req.ip,
      }
    }).catch(() => {});

    const co = await getCompany(req.prisma).catch(() => null);
    const coName = co?.name || 'Netfactory';

    // Send confirmation EMAIL
    if (email && req.config?.email) {
      req.config.email.sendWithPrisma(req.prisma, {
        to: email.toLowerCase(),
        subject: `Application Received — ${coName}`,
        html: `
          <h2>Welcome to ${coName}, ${firstName}!</h2>
          <p>Thank you for applying for our internet service. Here's a summary of your application:</p>
          <table style="border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px 16px;background:#f3f4f6;font-weight:bold;">Reference #</td><td style="padding:8px 16px;">${created.account_number}</td></tr>
            ${plan ? `<tr><td style="padding:8px 16px;background:#f3f4f6;font-weight:bold;">Plan</td><td style="padding:8px 16px;">${plan.name} — ${plan.speed_label}</td></tr>
            <tr><td style="padding:8px 16px;background:#f3f4f6;font-weight:bold;">Monthly</td><td style="padding:8px 16px;">₱${Number(plan.price).toLocaleString()}</td></tr>` : ''}
            ${packageId ? `<tr><td style="padding:8px 16px;background:#f3f4f6;font-weight:bold;">Installation Package</td><td style="padding:8px 16px;">Package ${packageId.toUpperCase()}</td></tr>` : ''}
            <tr><td style="padding:8px 16px;background:#f3f4f6;font-weight:bold;">Status</td><td style="padding:8px 16px;">Prospective — awaiting review</td></tr>
          </table>
          <p><strong>What happens next?</strong></p>
          <p>Our team will contact you within 24-48 hours to schedule a site survey and discuss your installation. If you have questions, reply to this email or call our support hotline.</p>
          <p>— ${coName} Team</p>
        `,
      }).catch(err => console.error('[EMAIL] Application confirmation failed:', err.message));
    }

    // Send confirmation SMS
    if (cleanPhone && req.config?.sms) {
      req.config.sms.sendWithPrisma(req.prisma,
        cleanPhone,
        `${coName}: Hi ${cleanFirst}! Your application has been received (Ref: ${created.account_number}${plan ? ', Plan: ' + plan.name : ''}${packageId ? ', Pkg ' + packageId.toUpperCase() : ''}). We'll contact you within 24-48 hours. Thank you for choosing ${coName}!`
      ).catch(err => console.error('[SMS] Application confirmation failed:', err.message));
    }

    res.status(201).json({
      message: 'Application submitted successfully!',
      accountNumber: created.account_number,
    });
  } catch (err) {
    console.error('Application error:', err);
    res.status(500).json({ error: 'Failed to submit application. Please try again.' });
  }
});

// ============================================
// GET /api/public/settings - Company info
// ============================================
router.get('/settings', async (req, res) => {
  try {
    const settings = await req.prisma.system_settings.findMany({
      where: { category: 'company' }
    });

    const config = {};
    settings.forEach(s => { config[s.key] = s.value; });

    res.json(config);
  } catch (err) {
    console.error('Error fetching settings:', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// ============================================
// POST /api/public/contact - Website contact form inquiry
// Creates a ticket under the WEBINQUIRY system account (account_number: 00000000)
// ============================================
router.post('/contact', contactLimiter, async (req, res) => {
  try {
    const { name, email, phone, subject, message } = req.body;

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Full name is required.' });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }
    if (!email?.trim() && !phone?.trim()) {
      return res.status(400).json({ error: 'Please provide an email or phone number.' });
    }

    const cleanName    = name.trim();
    const cleanEmail   = email?.trim() || null;
    const cleanPhone   = phone?.trim().replace(/[\s\-()]/g, '') || null;
    const cleanSubject = subject?.trim() || null;
    const cleanMessage = message.trim();

    // WEBINQUIRY system account — lookup by account number
    const webInq = await req.prisma.subscribers.findFirst({ where: { account_number: '00000000' } });
    if (!webInq) return res.status(500).json({ error: 'System account not found. Please contact support.' });
    const WEBINQUIRY_SUBSCRIBER_ID = webInq.id;

    // Build rich description for the ticket
    const description = [
      'WEBSITE CONTACT FORM SUBMISSION',
      '',
      `Name:    ${cleanName}`,
      cleanEmail   ? `Email:   ${cleanEmail}`   : null,
      cleanPhone   ? `Phone:   ${cleanPhone}`   : null,
      cleanSubject ? `Subject: ${cleanSubject}` : null,
      '',
      'Message:',
      cleanMessage,
    ].filter(l => l !== null).join('\n');

    const ticketSubject = cleanSubject
      ? `[Web] ${cleanSubject}`
      : `[Web] Inquiry from ${cleanName}`;

    // Generate ticket number
    const lastTicket = await req.prisma.tickets.findFirst({ orderBy: { id: 'desc' } });
    const _now = new Date(); const _yy = String(_now.getFullYear()).slice(-2); const _mm = String(_now.getMonth()+1).padStart(2,'0');
    const _seq = (lastTicket ? lastTicket.id : 0) + 1;
    const ticketNumber = `TKT-${_yy}${_mm}${String(_seq).padStart(5,'0')}`;
    // Create ticket under WEBINQUIRY account
    const ticket = await req.prisma.tickets.create({
      data: {
        subscriber_id: WEBINQUIRY_SUBSCRIBER_ID,
        ticket_number: ticketNumber,
        category:      'general',
        priority:      'medium',
        status:        'open',
        subject:       ticketSubject.substring(0, 200),
        description:   description,
      },
    });

    // CRM notification bell
    await req.prisma.notifications.create({
      data: {
        title:       `Web Inquiry from ${cleanName}`,
        type:        'info',
        message:     `New website inquiry from ${cleanName} — Ticket ${ticket.number || ticket.id}`,
        target_type: 'ticket',
        target_id:   ticket.id,
        is_read:     false,
      },
    }).catch(err => console.error('[NOTIF] Contact notification failed:', err.message));

    // Audit log
    await req.prisma.audit_log.create({
      data: {
        user_type:   'public',
        user_id:     0,
        action:      'contact_inquiry',
        entity_type: 'tickets',
        entity_id:   ticket.id,
        details:     { source: 'website_contact_form', name: cleanName, email: cleanEmail, phone: cleanPhone, subject: cleanSubject },
        ip_address:  req.ip,
      },
    }).catch(() => {});

    const contactCo = await getCompany(req.prisma).catch(() => null);
    const contactCoName = contactCo?.name || 'Netfactory';

    // Send SMS confirmation to user
    if (cleanPhone && req.config?.sms) {
      req.config.sms.sendWithPrisma(req.prisma,
        cleanPhone,
        `${contactCoName}: Hi ${cleanName}! Your inquiry has been received (Ref: ${ticket.ticket_number}). We'll get back to you within 24-48 hours. Thank you for reaching out to ${contactCoName}!`
      ).then(() => console.log(`📱 SMS sent to ${cleanPhone}`)).catch(err => console.error("[SMS] Contact SMS failed:", err.message));
    }
    console.log(`✅ Contact ticket created: ${ticket.number || ticket.id} from ${cleanName}`);

    res.status(201).json({
      success:      true,
      ticketNumber: ticket.ticket_number || String(ticket.id),
      message:      'Your message has been received! We\'ll get back to you within 24-48 hours.',
    });

  } catch (err) {
    console.error('Contact form error:', err);
    res.status(500).json({ error: 'Failed to submit your message. Please try again.' });
  }
});

module.exports = router;
// ── GET /api/public/company ──────────────────────────────────
router.get('/company', async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const rows = await prisma.system_settings.findMany({
      where: { category: { in: ['company', 'website'] } },
      select: { key: true, value: true }
    });
    const map = {};
    rows.forEach(r => { map[r.key] = r.value || ''; });
    res.json({
      company: {
        name: map.company_name || '', shortName: map.company_short_name || '',
        tagline: map.company_tagline || '', subtitle: map.company_subtitle || '',
        phone: map.company_phone || '', email: map.company_email || '',
        supportEmail: map.support_email || '', website: map.company_website || '',
        address1: map.company_address1 || '', address2: map.company_address2 || '',
        city: map.company_city || '', officeAddress: map.company_address || '',
        businessHours: map.business_hours || '',
        logo: map.website_logo || map.company_logo || '',
      },
      hero: {
        badge: map.website_hero_badge || '', headline1: map.website_hero_headline1 || '',
        headline2: map.website_hero_headline2 || '', subtext: map.website_hero_subtext || '',
        ctaPrimary: map.website_hero_cta_primary || 'Apply Now →',
        ctaSecondary: map.website_hero_cta_secondary || 'View Plans',
      },
      about: {
        headline1: map.website_about_headline1 || '', headline2: map.website_about_headline2 || '',
        paragraph: map.website_about_paragraph || '', mission: map.website_mission_text || '',
        vision: map.website_vision_text || '', promise: map.website_promise_text || '',
      },
      services: {
        headline1: map.website_services_headline1 || '', headline2: map.website_services_headline2 || '',
        subtext: map.website_services_subtext || '',
        items: [1,2,3,4,5,6].map(n => ({
          icon: map[`website_service${n}_icon`] || '',
          title: map[`website_service${n}_title`] || '',
          desc: map[`website_service${n}_desc`] || '',
        })).filter(s => s.title),
      },
      cta: { headline: map.website_cta_headline || '', subtext: map.website_cta_subtext || '' },
      social: {
        facebook: map.website_social_facebook || '',
        messenger: map.website_social_messenger || '',
        viber: map.website_social_viber || '',
      }
    });
  } catch (err) {
    console.error('GET /public/company error:', err);
    res.status(500).json({ error: 'Failed to load company data' });
  }
});

// ── GET /api/public/crm-lookup — 3CX Caller ID Lookup ───────
// 3CX queries this for caller ID popup (CRM template)
// Auth via API key in query string
router.get('/crm-lookup', async (req, res) => {
  try {
    const { phone, key } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone parameter required' });

    // Validate API key
    const secretRow = await req.prisma.system_settings.findUnique({ where: { key: '3cx_webhook_secret' } });
    const apiKey = secretRow?.value;
    if (apiKey && key !== apiKey) {
      return res.status(403).json({ error: 'Invalid API key' });
    }

    // Normalize and search by last 10 digits
    const digits = phone.replace(/\D/g, '');
    const last10 = digits.slice(-10);
    const last7 = digits.slice(-7);

    if (last7.length < 7) {
      return res.json({ found: false });
    }

    const subscriber = await req.prisma.subscribers.findFirst({
      where: {
        OR: [
          { phone: { endsWith: last10 } },
          { phone: { endsWith: last7 } },
        ]
      },
      select: {
        id: true, account_number: true, first_name: true, middle_name: true,
        last_name: true, status: true, phone: true, email: true,
        plan: { select: { name: true } },
        balance: true,
      }
    });

    if (!subscriber) {
      return res.json({ found: false });
    }

    const fullName = [subscriber.first_name, subscriber.middle_name, subscriber.last_name].filter(Boolean).join(' ');
    res.json({
      found: true,
      id: subscriber.id,
      name: fullName,
      accountNumber: subscriber.account_number,
      status: subscriber.status,
      plan: subscriber.plan?.name || 'No plan',
      balance: Number(subscriber.balance || 0),
      crmUrl: `/crm/#subscriber-${subscriber.id}`,
    });
  } catch (err) {
    console.error('[CRM Lookup] Error:', err.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// ── GET /api/public/stats ────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const prisma = req.prisma;
    const [activeCount, barangayCount, settingsRows] = await Promise.all([
      prisma.subscribers.count({ where: { status: 'active' } }),
      prisma.barangays.count({ where: { is_serviceable: true, municipality: { is_serviceable: true } } }),
      prisma.system_settings.findMany({
        where: { key: { in: ['website_stats_uptime', 'website_stats_max_speed'] } },
        select: { key: true, value: true }
      })
    ]);
    const statsMap = {};
    settingsRows.forEach(r => { statsMap[r.key] = r.value; });
    res.json({
      activeSubscribers: activeCount,
      barangaysCovered: barangayCount,
      networkUptime: statsMap.website_stats_uptime || '99.6',
      maxSpeed: statsMap.website_stats_max_speed || '500',
    });
  } catch (err) {
    console.error('GET /public/stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ── GET /api/public/faq ──────────────────────────────────────
router.get('/faq', async (req, res) => {
  try {
    const prisma = req.config.db.prisma;
    const faqs = await prisma.$queryRaw`
      SELECT id, question, answer, sort_order
      FROM website_faqs
      WHERE is_active = true
      ORDER BY sort_order ASC, id ASC
    `;
    res.json({ faqs });
  } catch (err) {
    console.error('GET /public/faq error:', err);
    res.status(500).json({ error: 'Failed to load FAQs' });
  }
});

// ── GET /api/public/promotions ──────────────────────────────
router.get('/promotions', async (req, res) => {
  try {
    const { getToggle } = require('../middleware/systemToggles');
    if (!getToggle('promotions_enabled')) return res.json({ promotions: [] });

    const prisma = req.config.db.prisma;
    const promos = await prisma.$queryRaw`
      SELECT id, title, description, badge_text, cta_text, cta_link, start_date, end_date
      FROM promotions
      WHERE is_active = true
        AND (start_date IS NULL OR start_date <= CURRENT_DATE)
        AND (end_date IS NULL OR end_date >= CURRENT_DATE)
      ORDER BY sort_order ASC, id DESC
    `;
    res.json({ promotions: promos });
  } catch (err) {
    console.error('GET /public/promotions error:', err);
    res.status(500).json({ error: 'Failed to load promotions' });
  }
});

// ── GET /api/public/careers ─────────────────────────────────
router.get('/careers', async (req, res) => {
  try {
    const { getToggle } = require('../middleware/systemToggles');
    if (!getToggle('careers_enabled')) return res.json({ careers: [] });

    const prisma = req.config.db.prisma;
    const careers = await prisma.$queryRaw`
      SELECT id, title, department, location, type, description, requirements
      FROM careers
      WHERE is_active = true
      ORDER BY sort_order ASC, id DESC
    `;
    res.json({ careers });
  } catch (err) {
    console.error('GET /public/careers error:', err);
    res.status(500).json({ error: 'Failed to load careers' });
  }
});
