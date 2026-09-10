// ============================================================
// NETFACTORY — Email Configuration (Nodemailer)
// ============================================================
// Usage:
//   const { email } = require('../config');
//
//   // Send a simple email:
//   await email.send({ to: 'user@email.com', subject: 'Hi', html: '<h1>Hi</h1>' });
//
//   // Send using a template (pass company object from getCompany()):
//   const { getCompany } = require('../utils/company');
//   const co = await getCompany(req.prisma);
//   await email.sendTemplate(to, 'payment_received', { name, amount, ... }, co);
//
// All templates accept an optional `co` (company) argument.
// If omitted, a safe fallback is used — but always pass it for
// correct branding in outgoing emails.
// ============================================================

const nodemailer = require('nodemailer');
const { getToggle } = require('../middleware/systemToggles');

// ── Settings from .env (used as fallback when DB is unavailable) ─────────────
const settings = {
  host:      process.env.SMTP_HOST       || '',
  port:      parseInt(process.env.SMTP_PORT) || 465,
  secure:    process.env.SMTP_SECURE     === 'true',
  user:      process.env.SMTP_USER       || '',
  pass:      process.env.SMTP_PASS       || '',
  fromName:  process.env.SMTP_FROM_NAME  || 'Netfactory',
  fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '',
};

let transporter = null;

function isConfigured() {
  return !!(settings.host && settings.user && settings.pass);
}

function getTransporter() {
  if (!transporter && isConfigured()) {
    transporter = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: { user: settings.user, pass: settings.pass },
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 30000,
    });
  }
  return transporter;
}

/**
 * Read SMTP settings from the system_settings DB table.
 * Falls back to env vars if DB is unavailable or keys are missing.
 * DB keys: smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password,
 *          smtp_from_name, smtp_from_email
 *
 * @param {Object} prisma - Prisma client instance
 * @returns {Promise<Object>} SMTP settings object
 */
async function getEmailSettings(prisma) {
  if (!prisma) return settings;
  try {
    const rows = await prisma.system_settings.findMany({
      where: {
        key: { in: ['smtp_host','smtp_port','smtp_secure','smtp_user','smtp_password','smtp_from_name','smtp_from_email'] }
      },
    });
    const s = {};
    rows.forEach(r => { s[r.key] = r.value; });
    return {
      host:      s.smtp_host       || settings.host,
      port:      parseInt(s.smtp_port) || settings.port,
      secure:    s.smtp_secure !== undefined ? s.smtp_secure === 'true' : settings.secure,
      user:      s.smtp_user       || settings.user,
      pass:      s.smtp_password   || settings.pass,
      fromName:  s.smtp_from_name  || settings.fromName,
      fromEmail: s.smtp_from_email || settings.fromEmail || s.smtp_user || settings.user,
    };
  } catch {
    return settings;
  }
}

/**
 * Create a Nodemailer transporter from an explicit settings object.
 * Used by sendWithPrisma to apply DB-sourced settings.
 */
function createTransporterFromSettings(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
}

async function verify() {
  if (!isConfigured()) return { ok: false, error: 'SMTP not configured' };
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function send({ to, subject, text, html, cc, bcc, attachments }) {
  if (!isConfigured()) {
    console.warn('⚠ Email not configured — skipping send to:', to);
    return { ok: false, error: 'SMTP not configured' };
  }
  try {
    const info = await getTransporter().sendMail({
      from: `"${settings.fromName}" <${settings.fromEmail}>`,
      to, cc, bcc, subject, text, html, attachments,
    });
    console.log(`📧 Email sent to ${to} — ${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error(`✗ Email failed to ${to}:`, err.message);
    return { ok: false, error: err.message };
  }
}

// ── Default company fallback (used only if caller forgets to pass co) ──
const msgTemplates = require('./message-templates');

function defaultCo() {
  return {
    name:       'Netfactory',
    shortName:  'NF',
    domain:     'netfactory.com.ph',
    portalUrl:  'https://netfactory.com.ph/portal',
    crmUrl:     'https://netfactory.com.ph/crm',
    email:      '',
    phone:      '',
    address:    'Paliqui Colgante, Apalit, Pampanga',
  };
}

// ── Shared email wrapper ─────────────────────────────────────
function emailShell(accentColor, badgeLabel, bodyHtml, co) {
  const c = co || defaultCo();
  const contactLine = [
    c.phone ? c.phone : '',
    c.email ? `<a href="mailto:${c.email}" style="color:#3b82f6;text-decoration:none;">${c.email}</a>` : '',
  ].filter(Boolean).join(' &nbsp;|&nbsp; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${c.name}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.09);max-width:600px;">
  <tr><td style="background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);padding:28px 36px;text-align:center;">
    <div style="display:inline-block;background:${accentColor};border-radius:10px;padding:8px 18px;margin-bottom:12px;">
      <span style="color:#fff;font-size:20px;font-weight:900;letter-spacing:2px;">${c.shortName}</span>
    </div>
    <h1 style="color:#fff;margin:8px 0 4px;font-size:20px;font-weight:800;">${c.name}</h1>
    <p style="color:#94a3b8;margin:0;font-size:13px;">${badgeLabel}</p>
  </td></tr>
  <tr><td style="padding:32px 36px;"><!--BODY_START-->${bodyHtml}<!--BODY_END--></td></tr>
  <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 36px;text-align:center;">
    <p style="margin:0;color:#64748b;font-size:12px;line-height:2;">
      <strong style="color:#1e293b;">${c.name}</strong><br>
      ${c.address ? c.address + '<br>' : ''}
      ${contactLine ? contactLine + '<br>' : ''}
      <a href="https://${c.domain}" style="color:#3b82f6;text-decoration:none;">https://${c.domain}</a>
    </p>
    <p style="margin:10px 0 0;color:#94a3b8;font-size:11px;">You received this because you are a subscriber of ${c.name}.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function ctaBtn(label, url, color) {
  return `<p style="text-align:center;margin:28px 0;">
    <a href="${url}" style="background:${color};color:#fff;padding:14px 38px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">${label}</a>
  </p>`;
}

function infoTable(rows) {
  return `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin:20px 0;">
    ${rows.map(([label, value], i) => `
    <tr style="background:${i % 2 === 0 ? '#f8fafc' : '#fff'};">
      <td style="padding:10px 14px;color:#64748b;font-size:13px;width:40%;border-bottom:1px solid #f1f5f9;">${label}</td>
      <td style="padding:10px 14px;font-weight:600;color:#0f172a;font-size:13px;border-bottom:1px solid #f1f5f9;">${value}</td>
    </tr>`).join('')}
  </table>`;
}

// ── Email Templates ──────────────────────────────────────────
// Each template accepts (data, co) where:
//   data = content-specific fields (name, amount, etc.)
//   co   = company object from getCompany() — always pass this!

const templates = {

  password_reset: (data, co) => {
    const c = co || defaultCo();
    return {
      subject: `${c.name} — Password Reset Request`,
      html: emailShell('#3b82f6', 'Password Reset',
        `<p>Hi <strong>${data.name}</strong>,</p>
         <p>We received a request to reset the password for account <strong>${data.accountNumber}</strong>.</p>
         <p style="color:#64748b;font-size:13px;">This link expires in 1 hour.</p>
         ${ctaBtn('Reset Password', data.resetUrl, '#3b82f6')}
         <p style="color:#94a3b8;font-size:12px;text-align:center;">If you didn't request this, you can safely ignore this email.</p>`,
        c
      ),
    };
  },

  payment_received: (data, co) => {
    const c = co || defaultCo();
    const rows = [['Invoice', data.invoiceNumber]];
    if (data.amountReceived && data.amountReceived !== data.amount) {
      rows.push(['Amount Received', data.amountReceived]);
      rows.push(['Applied to Invoice', data.amount]);
    } else {
      rows.push(['Amount Paid', data.amount]);
    }
    rows.push(['Payment Method', data.method || '—']);
    rows.push(['Date', data.date || '—']);
    rows.push(['Reference #', data.reference || '—']);

    const overpayNote = data.overpayment
      ? `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px 16px;margin:16px 0;">
           <p style="margin:0;font-size:13px;color:#166534;line-height:1.7;">
             <strong>Overpayment Notice:</strong> An overpayment of <strong>${data.overpayment}</strong> has been credited to your account and will be automatically applied to your next invoice.
           </p>
         </div>`
      : '';

    return {
      subject: `${c.name} — Payment Received (${data.invoiceNumber})`,
      html: emailShell('#10b981', 'Payment Confirmed',
        `<p>Hi <strong>${data.name}</strong>,</p>
         <p style="color:#475569;">We've received your payment. Invoice <strong>${data.invoiceNumber}</strong> is now <strong style="color:#10b981;">PAID</strong>. Thank you!</p>
         ${infoTable(rows)}
         ${overpayNote}
         <p style="color:#64748b;font-size:13px;">Your invoice PDF is attached to this email for your records.</p>
         ${ctaBtn('View Invoice Online →', c.portalUrl + '?page=billing', '#10b981')}
         <p style="color:#94a3b8;font-size:12px;text-align:center;">For concerns, contact ${c.phone || c.email || 'our support team'}.</p>`,
        c
      ),
    };
  },

  invoice_reminder: (data, co) => {
    const c = co || defaultCo();
    return {
      subject: `${c.name} — Invoice ${data.invoiceNumber} Due ${data.dueDate}`,
      html: emailShell('#f59e0b', 'Payment Reminder',
        `<p>Hi <strong>${data.name}</strong>,</p>
         <p>This is a friendly reminder that your invoice is due soon:</p>
         <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:10px;padding:16px;margin:20px 0;">
           <p style="margin:0;"><strong>Invoice:</strong> ${data.invoiceNumber}</p>
           <p style="margin:8px 0 0;"><strong>Amount:</strong> ${data.amount}</p>
           <p style="margin:8px 0 0;"><strong>Due Date:</strong> ${data.dueDate}</p>
         </div>
         ${ctaBtn('Pay Now', c.portalUrl, '#3b82f6')}`,
        c
      ),
    };
  },

  account_suspended: (data, co) => {
    const c = co || defaultCo();
    const contactInfo = [c.phone, c.supportEmail || c.email].filter(Boolean).join(' or ');
    return {
      subject: `${c.name} — Account Suspended`,
      html: emailShell('#ef4444', 'Account Notice',
        `<p>Hi <strong>${data.name}</strong>,</p>
         <p>Your account <strong>${data.accountNumber}</strong> has been suspended due to an outstanding balance of <strong>${data.balance}</strong>.</p>
         <p>To restore your service, please settle your balance at your earliest convenience.</p>
         ${ctaBtn('Pay Balance', c.portalUrl, '#ef4444')}
         ${contactInfo ? `<p style="color:#64748b;font-size:13px;text-align:center;">Need help? Contact us at ${contactInfo}</p>` : ''}`,
        c
      ),
    };
  },

  welcome: (data, co) => {
    const c = co || defaultCo();
    return {
      subject: `Welcome to ${c.name}!`,
      html: emailShell('#3b82f6', 'Welcome!',
        `<p>Hi <strong>${data.name}</strong>,</p>
         <p>Thank you for choosing ${c.name}! Your application has been received.</p>
         <div style="background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;padding:16px;margin:20px 0;">
           <p style="margin:0;"><strong>Account Number:</strong> ${data.accountNumber}</p>
           <p style="margin:8px 0 0;"><strong>Plan:</strong> ${data.plan}</p>
           <p style="margin:8px 0 0;"><strong>Status:</strong> Pending Installation</p>
         </div>
         <p>Our team will contact you within 2–3 business days to schedule the installation.</p>
         ${ctaBtn('Access Your Portal', c.portalUrl, '#3b82f6')}`,
        c
      ),
    };
  },

};

async function sendTemplate(to, templateName, data, co, attachments) {
  const templateFn = templates[templateName];
  if (!templateFn) {
    console.error(`✗ Unknown email template: ${templateName}`);
    return { ok: false, error: `Unknown template: ${templateName}` };
  }
  // A staff edit saved from the CRM template panel wins over the built-in text;
  // null means the message is switched off there, so nothing goes out.
  const tmpl = msgTemplates.renderEmail(
    templateName, data, co || defaultCo(), () => templateFn(data, co));
  if (!tmpl) {
    console.log(`[EMAIL] ⏸ "${templateName}" is switched off — skipping send to ${to}`);
    return { ok: false, skipped: true, reason: `The "${templateName}" email is switched off in Settings` };
  }
  return send({ to, subject: tmpl.subject, html: tmpl.html, attachments });
}

/**
 * Send an email reading SMTP settings from the system_settings DB table.
 * Falls back to env vars if DB settings are not found.
 *
 * @param {Object} prisma - Prisma client instance
 * @param {Object} opts - { to, subject, html, text, cc, bcc, attachments }
 */
async function sendWithPrisma(prisma, opts) {
  if (!getToggle('email_enabled')) {
    console.log(`[EMAIL] ⏸ Globally disabled — skipping send to ${opts.to}`);
    return { ok: false, skipped: true, reason: 'Email disabled by system toggle' };
  }
  const cfg = await getEmailSettings(prisma);
  if (!cfg.host || !cfg.user || !cfg.pass) {
    console.warn('⚠ Email not configured — skipping send to:', opts.to);
    return { ok: false, error: 'SMTP not configured' };
  }
  try {
    const t = createTransporterFromSettings(cfg);
    const info = await t.sendMail({
      from: `"${cfg.fromName}" <${cfg.fromEmail}>`,
      ...opts,
    });
    console.log(`📧 Email sent to ${opts.to} — ${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error(`✗ Email failed to ${opts.to}:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Send an email template reading SMTP settings from the system_settings DB table.
 * Falls back to env vars if DB settings are not found.
 *
 * @param {Object} prisma - Prisma client instance
 * @param {string} to - Recipient email
 * @param {string} templateName - Template key
 * @param {Object} data - Template data
 * @param {Object} [co] - Company object from getCompany()
 * @param {Array}  [attachments] - Nodemailer attachments array
 */
async function sendTemplateWithPrisma(prisma, to, templateName, data, co, attachments) {
  if (!getToggle('email_enabled')) {
    console.log(`[EMAIL] ⏸ Globally disabled — skipping ${templateName} to ${to}`);
    return { ok: false, skipped: true, reason: 'Email disabled by system toggle' };
  }
  const templateFn = templates[templateName];
  if (!templateFn) {
    console.error(`✗ Unknown email template: ${templateName}`);
    return { ok: false, error: `Unknown template: ${templateName}` };
  }
  const tmpl = msgTemplates.renderEmail(
    templateName, data, co || defaultCo(), () => templateFn(data, co));
  if (!tmpl) {
    console.log(`[EMAIL] ⏸ "${templateName}" is switched off — skipping send to ${to}`);
    return { ok: false, skipped: true, reason: `The "${templateName}" email is switched off in Settings` };
  }
  return sendWithPrisma(prisma, { to, subject: tmpl.subject, html: tmpl.html, attachments });
}

module.exports = {
  // templates is exported so the CRM panel can show and restore the built-in default.
  templates, defaultCo,
  settings, isConfigured, getEmailSettings,
  verify, send, sendTemplate,
  sendWithPrisma, sendTemplateWithPrisma,
  getTransporter,
};
