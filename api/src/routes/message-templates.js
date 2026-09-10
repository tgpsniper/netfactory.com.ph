// ============================================================
// NETFACTORY — Message Template Admin API
// ============================================================
// Backs the "Subscriber Messages" panel in CRM → Settings. Lets staff edit the
// wording of the email and SMS that goes to subscribers, preview it against
// sample data, send a test, and reset any template back to the built-in text.
//
// Each template also carries an on/off switch. Off means the message is not sent
// at all — the wording is kept so it can be switched back on unchanged.
//
// (The sms_event_* keys in system_settings look like they do this job, but they
// are read nowhere in the code and set nowhere in the CRM. They are dead.)
// ============================================================

const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const msgT = require('../config/message-templates');
const notify = require('./notifications');
const emailSvc = require('../config/email');
const smsSvc = require('../config/sms');

// Editing the words customers receive is a brand and compliance decision, so it
// sits with the same roles that may delete a plan.
const EDIT_ROLES = ['superadmin', 'admin'];

// Switching these off does not just make things quieter — it removes the only
// copy of something the subscriber needs. password_reset carries the code that
// completes the reset; welcome_active carries the portal credentials. Staff can
// still turn them off, but the panel says what breaks first.
const CRITICAL = ['password_reset', 'welcome_active', 'welcome'];

// ── Catalog ─────────────────────────────────────────────────
// One entry per editable template. `fields` is what the sending code actually
// supplies — the panel shows these as clickable chips and warns about anything
// else, because a placeholder nobody fills renders as empty text in a real
// message. `sample` drives the preview and the test send.

const COMMON = {
  name: 'Juan Dela Cruz',
  accountNumber: '2608000646',
  plan: 'Fiber 300',
};

// `optional` names fields the sending code does not always supply. They still
// work, but the wording around them has to read correctly when they come out
// empty — the panel flags them so nobody writes "due on {{dueDate}}." and then
// ships "due on ." to a customer.
function entry(key, label, group, when, fields, sample, optional) {
  return { key, label, group, when, fields, optional: optional || [], sample: { ...COMMON, ...sample } };
}

// Status-flow messages — src/routes/notifications.js
const FLOW = [
  entry('application_received', 'Application Received', 'Application',
    'A new applicant is saved as prospective',
    ['name', 'accountNumber', 'plan', 'address'],
    { address: '123 Real St, Apalit, Pampanga' }),
  entry('survey_scheduled', 'Survey Scheduled', 'Application',
    'A site survey date is set',
    ['name', 'accountNumber', 'address', 'scheduleDate', 'scheduleTime'],
    { address: '123 Real St, Apalit, Pampanga', scheduleDate: 'Sept 2, 2026', scheduleTime: '9:00 AM' },
    ['scheduleTime']),
  entry('survey_completed', 'Survey Completed', 'Application',
    'The survey is done and under review',
    ['name', 'accountNumber', 'plan'], {}),
  entry('application_approved', 'Application Approved', 'Application',
    'The survey passed',
    ['name', 'accountNumber', 'plan', 'monthlyRate'], { monthlyRate: '1,499' }),
  entry('application_declined', 'Application Declined', 'Application',
    'The application is rejected',
    ['name', 'accountNumber', 'reason'], { reason: 'No coverage in your area yet' }),
  entry('installation_scheduled', 'Installation Scheduled', 'Installation',
    'An installation date is confirmed',
    ['name', 'accountNumber', 'plan', 'address', 'scheduleDate', 'scheduleTime'],
    { address: '123 Real St, Apalit, Pampanga', scheduleDate: 'Sept 5, 2026', scheduleTime: '1:00 PM' },
    ['scheduleTime']),
  entry('welcome_active', 'Welcome / Account Activated', 'Account',
    'A pending subscriber is switched to active — includes portal credentials',
    ['name', 'accountNumber', 'plan', 'speed', 'monthlyRate', 'username', 'password'],
    { speed: '300Mbps', monthlyRate: '1,499', username: '2608000646', password: 'nf0646' }),
  entry('service_restored', 'Service Restored', 'Account',
    'A suspended account is reactivated',
    ['name', 'accountNumber', 'plan'], {}),
  entry('account_suspended', 'Account Suspended', 'Account',
    'An account is suspended for non-payment',
    ['name', 'accountNumber', 'balance', 'reason'],
    { balance: 'PHP 1,499.00', reason: 'Unpaid balance past the grace period' },
    ['reason']),
  entry('account_disconnected', 'Account Disconnected', 'Account',
    'An account is disconnected',
    ['name', 'accountNumber', 'reason'], { reason: 'Requested by subscriber' }, ['reason']),
  entry('invoice_reminder', 'Invoice Reminder', 'Billing',
    'An invoice is approaching its due date',
    ['name', 'accountNumber', 'invoiceNumber', 'amount', 'dueDate'],
    { invoiceNumber: 'INV-26080012', amount: 'PHP 1,499.00', dueDate: 'Sept 15, 2026' }),
  entry('payment_received', 'Payment Received', 'Billing',
    'A payment is confirmed, including via the Xendit webhook',
    ['name', 'invoiceNumber', 'amount', 'method', 'reference', 'date', 'overpayment'],
    { invoiceNumber: 'INV-26080012', amount: 'PHP 1,499.00', method: 'GCash',
      reference: 'PYM2608000003', date: 'Aug 27, 2026', overpayment: '' },
    ['method', 'reference', 'date', 'overpayment']),
  entry('password_reset', 'Password Reset', 'Account',
    'A subscriber asks to reset their portal password',
    ['name', 'accountNumber', 'resetUrl', 'code'],
    { resetUrl: 'https://netfactory.com.ph/portal/reset?t=sample', code: '482913' },
    ['resetUrl', 'code']),
];

// Templates that exist only in the billing/notification services
const EXTRA_SMS = [
  entry('welcome', 'Welcome (new active subscriber)', 'Account',
    'A subscriber is CREATED already set to active',
    ['accountNumber', 'plan'], {}),
  entry('ticket_update', 'Support Ticket Update', 'Support',
    'A support ticket changes status',
    ['ticketNumber', 'status', 'note'],
    { ticketNumber: 'TKT-2608-0042', status: 'Resolved', note: 'Line tested OK.' },
    ['note']),
];

const EXTRA_EMAIL = [
  entry('welcome', 'Welcome (new active subscriber)', 'Account',
    'A subscriber is CREATED already set to active',
    ['name', 'accountNumber', 'plan'], {}),
];

/**
 * A stand-in data object where every field reads back as its own {{placeholder}}.
 *
 * The built-in templates are functions, so the only way to recover an EDITABLE
 * version of one is to run it with data that renders as placeholder text. Doing
 * it with a Proxy rather than a fixed list means a field the template uses but
 * the catalog forgot still comes out as "{{field}}" instead of "undefined".
 *
 * Every property is a non-empty string, so `d.x ? a : b` conditionals inside a
 * template take their "has a value" branch — the fuller wording, which is the
 * right thing to hand someone who is about to edit it.
 */
function tokenSource(prefix) {
  return new Proxy({}, {
    get: (_, k) => (typeof k === 'string' ? `{{${prefix}${k}}}` : undefined),
    has: () => true,
  });
}

/**
 * Resolve the built-in default for one template, or null if the key is unknown.
 * @param {object|null} data  per-message values, or null for placeholder form
 */
function defaultFor(channel, key, data, company) {
  const d = data || tokenSource('');
  const c = data ? company : tokenSource('company.');
  try {
    if (channel === 'sms') {
      if (notify.smsTemplates[key]) return { body: notify.smsTemplates[key](d, c) };
      if (smsSvc.templates[key]) return { body: smsSvc.templates[key](d) };
      return null;
    }
    const fn = notify.emailTemplates[key] || emailSvc.templates[key];
    if (!fn) return null;
    const out = fn(d, c);
    return { subject: out.subject, body: msgT.extractBody(out.html), html: out.html };
  } catch (err) {
    console.error(`[Templates] Default render failed for ${channel}/${key}:`, err.message);
    return null;
  }
}

/** True when a key is defined in both the status-flow and the billing template sets. */
function hasTwoDefaults(channel, key) {
  return channel === 'sms'
    ? !!(notify.smsTemplates[key] && smsSvc.templates[key])
    : !!(notify.emailTemplates[key] && emailSvc.templates[key]);
}

function catalogFor(channel) {
  const list = channel === 'sms' ? [...FLOW, ...EXTRA_SMS] : [...FLOW, ...EXTRA_EMAIL];
  // Only advertise what the code can actually render, so the panel never offers
  // an entry that would come back blank.
  return list.filter(e => defaultFor(channel, e.key, null, null));
}

// ── GET / — every template, its default, and any saved edit ──
router.get('/', adminAuth(), async (req, res) => {
  try {
    const rows = await req.prisma.$queryRaw`
      SELECT channel, template_key, subject, body, enabled, updated_at, updated_by
        FROM message_templates`;
    const saved = new Map(rows.map(r => [`${r.channel}:${r.template_key}`, r]));

    const out = [];
    for (const channel of ['sms', 'email']) {
      for (const e of catalogFor(channel)) {
        // Placeholder form — what someone edits, never a sample value baked in.
        const def = defaultFor(channel, e.key, null, null);
        const s = saved.get(`${channel}:${e.key}`);
        out.push({
          channel, key: e.key, label: e.label, group: e.group, when: e.when,
          fields: e.fields, optional: e.optional || [],
          // Some names exist in BOTH the status-flow templates and the billing
          // ones, with slightly different built-in wording depending on which
          // code path fires. Saving here replaces both, which is usually the
          // point — but the panel says so rather than leaving it a surprise.
          dualDefault: hasTwoDefaults(channel, e.key),
          defaultSubject: def.subject || null,
          defaultBody: def.body || '',
          subject: (s && s.subject) ? s.subject : (def.subject || null),
          body: (s && s.body) ? s.body : (def.body || ''),
          customised: !!(s && s.body),
          enabled: s ? s.enabled : true,
          critical: CRITICAL.includes(e.key),
          updatedAt: s ? s.updated_at : null,
          updatedBy: s ? s.updated_by : null,
        });
      }
    }
    res.json({ templates: out, canEdit: EDIT_ROLES.includes(req.admin.role) });
  } catch (err) {
    console.error('[Templates] List failed:', err);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

// ── POST /preview — render without saving ───────────────────
router.post('/preview', adminAuth(), async (req, res) => {
  try {
    const { channel, key, subject, body } = req.body;
    const e = catalogFor(channel).find(x => x.key === key);
    if (!e) return res.status(404).json({ error: 'Unknown template' });

    const company = await notify.getCompanyInfo(req.prisma);
    const def = defaultFor(channel, key, e.sample, company);   // real values, for the wrapper
    const unknown = msgT.placeholdersUsed(`${subject || ''} ${body || ''}`)
      .filter(p => !p.startsWith('company.') && !e.fields.includes(p));

    if (channel === 'sms') {
      const text = msgT.render(body, e.sample, company);
      return res.json({ text, length: text.length, credits: Math.max(1, Math.ceil(text.length / 160)), unknown });
    }
    res.json({
      subject: msgT.render(subject || def.subject, e.sample, company),
      html: msgT.spliceBody(def.html, msgT.render(body, e.sample, company)),
      unknown,
    });
  } catch (err) {
    console.error('[Templates] Preview failed:', err);
    res.status(500).json({ error: 'Failed to render preview' });
  }
});

// ── PUT /:channel/:key — save an edit ───────────────────────
router.put('/:channel/:key', adminAuth(), async (req, res) => {
  try {
    if (!EDIT_ROLES.includes(req.admin.role)) {
      return res.status(403).json({ error: 'Only Administrators and Super Administrators can edit message templates' });
    }
    const { channel, key } = req.params;
    const { subject, body } = req.body;
    if (channel !== 'sms' && channel !== 'email') return res.status(400).json({ error: 'Invalid channel' });

    const e = catalogFor(channel).find(x => x.key === key);
    if (!e) return res.status(404).json({ error: 'Unknown template' });
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message body cannot be empty' });

    // Refuse a placeholder the sending code never supplies. It would render as
    // empty text in a real message while looking correct here, which is exactly
    // the failure this panel exists to prevent.
    const unknown = msgT.placeholdersUsed(`${subject || ''} ${body}`)
      .filter(p => !p.startsWith('company.') && !e.fields.includes(p));
    if (unknown.length) {
      return res.status(400).json({
        error: `Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map(u => '{{' + u + '}}').join(', ')}. This message only provides: ${e.fields.join(', ')}.`,
        unknown,
      });
    }

    const subj = channel === 'email' && subject ? String(subject).trim() : null;
    await req.prisma.$executeRaw`
      INSERT INTO message_templates (channel, template_key, subject, body, updated_by, updated_at)
      VALUES (${channel}, ${key}, ${subj}, ${String(body)}, ${req.adminId}, now())
      ON CONFLICT (channel, template_key)
      DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body,
                    updated_by = EXCLUDED.updated_by, updated_at = now()`;
      // enabled is deliberately NOT touched here — editing the wording of a
      // message that is switched off must not quietly switch it back on.

    // Refresh now rather than letting the 30s TTL decide — staff expect the next
    // message to use what they just saved.
    await msgT.refreshCache(req.prisma);

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'message_template_updated', entity_type: 'message_templates', entity_id: null,
        details: { channel, key, subject: subj, body: String(body) },
        ip_address: req.ip,
      },
    }).catch(() => {});

    res.json({ message: `${channel === 'sms' ? 'SMS' : 'Email'} template saved` });
  } catch (err) {
    console.error('[Templates] Save failed:', err);
    res.status(500).json({ error: 'Failed to save template' });
  }
});

// ── DELETE /:channel/:key — restore the built-in text ───────
router.delete('/:channel/:key', adminAuth(), async (req, res) => {
  try {
    if (!EDIT_ROLES.includes(req.admin.role)) {
      return res.status(403).json({ error: 'Only Administrators and Super Administrators can reset message templates' });
    }
    const { channel, key } = req.params;
    // Restore the built-in wording but keep the on/off state: someone asking for
    // the default text back is not asking for a switched-off message to resume.
    // The row is dropped entirely once there is nothing left to remember.
    await req.prisma.$executeRaw`
      UPDATE message_templates SET subject = NULL, body = NULL, updated_by = ${req.adminId},
             updated_at = now()
       WHERE channel = ${channel} AND template_key = ${key}`;
    await req.prisma.$executeRaw`
      DELETE FROM message_templates
       WHERE channel = ${channel} AND template_key = ${key} AND body IS NULL AND enabled = true`;
    await msgT.refreshCache(req.prisma);

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'message_template_reset', entity_type: 'message_templates', entity_id: null,
        details: { channel, key }, ip_address: req.ip,
      },
    }).catch(() => {});

    res.json({ message: 'Restored to the built-in text' });
  } catch (err) {
    console.error('[Templates] Reset failed:', err);
    res.status(500).json({ error: 'Failed to reset template' });
  }
});

// ── PATCH /:channel/:key/enabled — switch a message on or off ──
router.patch('/:channel/:key/enabled', adminAuth(), async (req, res) => {
  try {
    if (!EDIT_ROLES.includes(req.admin.role)) {
      return res.status(403).json({ error: 'Only Administrators and Super Administrators can switch messages on or off' });
    }
    const { channel, key } = req.params;
    const enabled = req.body.enabled === true || req.body.enabled === 'true';

    const e = catalogFor(channel).find(x => x.key === key);
    if (!e) return res.status(404).json({ error: 'Unknown template' });

    if (enabled) {
      // Back on and never edited? Drop the row so the template reads as untouched.
      await req.prisma.$executeRaw`
        UPDATE message_templates SET enabled = true, updated_by = ${req.adminId}, updated_at = now()
         WHERE channel = ${channel} AND template_key = ${key}`;
      await req.prisma.$executeRaw`
        DELETE FROM message_templates
         WHERE channel = ${channel} AND template_key = ${key} AND body IS NULL`;
    } else {
      await req.prisma.$executeRaw`
        INSERT INTO message_templates (channel, template_key, enabled, updated_by, updated_at)
        VALUES (${channel}, ${key}, false, ${req.adminId}, now())
        ON CONFLICT (channel, template_key)
        DO UPDATE SET enabled = false, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    }
    await msgT.refreshCache(req.prisma);

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: enabled ? 'message_template_enabled' : 'message_template_disabled',
        entity_type: 'message_templates', entity_id: null,
        details: { channel, key, label: e.label, critical: CRITICAL.includes(key) },
        ip_address: req.ip,
      },
    }).catch(() => {});

    res.json({
      enabled,
      message: enabled
        ? `"${e.label}" ${channel === 'sms' ? 'SMS' : 'email'} will be sent again`
        : `"${e.label}" ${channel === 'sms' ? 'SMS' : 'email'} will no longer be sent`,
    });
  } catch (err) {
    console.error('[Templates] Toggle failed:', err);
    res.status(500).json({ error: 'Failed to change the on/off setting' });
  }
});

// ── POST /test — send one real message to a staff address ───
router.post('/test', adminAuth(), async (req, res) => {
  try {
    if (!EDIT_ROLES.includes(req.admin.role)) {
      return res.status(403).json({ error: 'Only Administrators and Super Administrators can send test messages' });
    }
    const { channel, key, to } = req.body;
    if (!to || !String(to).trim()) return res.status(400).json({ error: 'A recipient is required' });

    const e = catalogFor(channel).find(x => x.key === key);
    if (!e) return res.status(404).json({ error: 'Unknown template' });

    // Route the test the same way a real send of this key is routed. The two
    // template sets do not hold the same keys — sending an application_received
    // email through the billing service would just report "unknown template" —
    // so pick the sender that actually owns it. Either way the override, the
    // toggles and the provider are all exercised exactly as in production.
    const dest = String(to).trim();
    const company = await notify.getCompanyInfo(req.prisma);
    if (msgT.isDisabled(channel, key)) {
      return res.status(409).json({ error: `"${e.label}" is switched off, so nothing was sent. Switch it on to test it.` });
    }

    let result;
    if (channel === 'sms') {
      result = notify.smsTemplates[key]
        ? await smsSvc.sendWithPrisma(req.prisma, dest, notify.getSmsTemplate(key, e.sample, company))
        : await smsSvc.sendTemplateWithPrisma(req.prisma, dest, key, e.sample);
    } else if (notify.emailTemplates[key]) {
      const tmpl = notify.getEmailTemplate(key, e.sample, company);
      result = await emailSvc.sendWithPrisma(req.prisma, { to: dest, subject: tmpl.subject, html: tmpl.html });
    } else {
      result = await emailSvc.sendTemplateWithPrisma(req.prisma, dest, key, e.sample, company);
    }

    if (result && result.skipped) {
      // Two different reasons land here — the global Email/SMS switch, and this
      // template's own switch. Say which, so nobody hunts the wrong setting.
      return res.status(409).json({ error: `${result.reason || 'Sending is switched off'} — nothing was sent.` });
    }
    if (!result || !result.ok) {
      return res.status(502).json({ error: (result && result.error) || 'The provider rejected the message' });
    }
    res.json({ message: `Test ${channel === 'sms' ? 'SMS' : 'email'} sent to ${to}` });
  } catch (err) {
    console.error('[Templates] Test send failed:', err);
    res.status(500).json({ error: 'Failed to send test message' });
  }
});

module.exports = router;
