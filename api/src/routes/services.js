// ============================================================
// routes/services.js — Service Configuration Management
// Handles: SMTP test, SMS test, Xendit config, apply .env
// All service config stored in system_settings (category: services)
// Secrets stored in system_settings — DB is local & access-controlled
// ============================================================

const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ENV_PATH = path.resolve(__dirname, '../../.env');

// ── Helper: read .env into object ──────────────────────────
function readEnv() {
  try {
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
      env[key] = val;
    }
    return env;
  } catch (e) {
    console.error('[services] Failed to read .env:', e.message);
    return {};
  }
}

// ── Helper: write key=value pairs into .env ─────────────────
function writeEnvKeys(updates) {
  try {
    let content = fs.readFileSync(ENV_PATH, 'utf8');
    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}=${value}`;
      if (regex.test(content)) {
        content = content.replace(regex, line);
      } else {
        content += `\n${line}`;
      }
    }
    fs.writeFileSync(ENV_PATH, content, 'utf8');
    return true;
  } catch (e) {
    console.error('[services] Failed to write .env:', e.message);
    return false;
  }
}

// ── Helper: get setting value from DB ──────────────────────
async function getSetting(prisma, key) {
  const row = await prisma.system_settings.findUnique({ where: { key } });
  return row ? row.value : null;
}

// ── Helper: upsert setting in DB ───────────────────────────
async function setSetting(prisma, key, value, category = 'services') {
  await prisma.system_settings.upsert({
    where: { key },
    update: { value, category },
    create: { key, value, category, label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) },
  });
}

// ============================================================
// GET /api/admin/services/config
// Returns current service settings (secrets masked)
// ============================================================
router.get('/config', adminAuth(), async (req, res) => {
  try {
    const rows = await req.prisma.system_settings.findMany({
      where: { category: { in: ['services', 'company'] } }
    });
    const s = {};
    rows.forEach(r => { s[r.key] = r.value; });

    // Also pull from .env as fallback reference
    const env = readEnv();

    const mask = v => v ? '••••••••' : '';

    res.json({
      smtp: {
        host:       s.smtp_host       || env.SMTP_HOST       || '',
        port:       s.smtp_port       || env.SMTP_PORT       || '587',
        secure:     s.smtp_secure     || env.SMTP_SECURE     || 'false',
        user:       s.smtp_user       || env.SMTP_USER       || '',
        password:   s.smtp_password   ? mask(s.smtp_password) : (env.SMTP_PASS ? mask(env.SMTP_PASS) : ''),
        from_name:  s.smtp_from_name  || env.SMTP_FROM_NAME  || '',
        from_email: s.smtp_from_email || env.SMTP_FROM_EMAIL || '',
        has_password: !!(s.smtp_password || env.SMTP_PASS),
      },
      semaphore: {
        api_key:     s.semaphore_api_key ? mask(s.semaphore_api_key) : (env.SEMAPHORE_API_KEY ? mask(env.SEMAPHORE_API_KEY) : ''),
        sender_name: s.semaphore_sender  || env.SEMAPHORE_SENDER_NAME || '',
        has_key:     !!(s.semaphore_api_key || env.SEMAPHORE_API_KEY),
      },
      xendit: {
        mode:           s.xendit_mode           || 'test',
        public_key:     s.xendit_public_key      || '',
        secret_key:     s.xendit_secret_key      ? mask(s.xendit_secret_key) : (env.XENDIT_SECRET_KEY ? mask(env.XENDIT_SECRET_KEY) : ''),
        webhook_token:  s.xendit_webhook_token   ? mask(s.xendit_webhook_token) : (env.XENDIT_WEBHOOK_TOKEN ? mask(env.XENDIT_WEBHOOK_TOKEN) : ''),
        has_secret:     !!(s.xendit_secret_key || env.XENDIT_SECRET_KEY),
        callback_url:   s.xendit_callback_url    || '',
      },
      domain: {
        app_url:      s.app_url      || env.APP_URL      || '',
        cors_origins: s.cors_origins || env.CORS_ORIGINS || '',
        domain:       s.company_website || env.DOMAIN   || '',
      },
      ms365: {
        enabled:      s.ms365_enabled    || 'false',
        tenant_id:    s.ms365_tenant_id  || '',
        client_id:    s.ms365_client_id  || '',
        client_secret: s.ms365_client_secret ? mask(s.ms365_client_secret) : '',
        redirect_uri: s.ms365_redirect_uri || '',
        has_secret:   !!s.ms365_client_secret,
      },
      threecx: {
        enabled:           s['3cx_enabled'] || 'false',
        fqdn:              s['3cx_fqdn'] || '',
        client_id:         s['3cx_client_id'] || '',
        client_secret:     s['3cx_client_secret'] ? mask(s['3cx_client_secret']) : '',
        webhook_secret:    s['3cx_webhook_secret'] ? mask(s['3cx_webhook_secret']) : '',
        default_extension: s['3cx_default_extension'] || '100',
        has_secret:        !!s['3cx_client_secret'],
        has_webhook_secret: !!s['3cx_webhook_secret'],
      },
      mikrotik: {
        enabled:         s.mikrotik_enabled         || 'false',
        default_device:  s.mikrotik_default_device  || '',
        api_timeout:     s.mikrotik_api_timeout     || '10000',
      },
      olt: {
        enabled:                   s.olt_enabled                   || 'false',
        default_device:            s.olt_default_device            || '',
        snmp_timeout:              s.olt_snmp_timeout              || '5000',
        optical_warn_threshold:    s.olt_optical_warn_threshold    || '-25',
        optical_critical_threshold: s.olt_optical_critical_threshold || '-28',
      },
      gmail: {
        imap_user:     s.gmail_imap_user || '',
        imap_password: s.gmail_imap_password ? mask(s.gmail_imap_password) : '',
        imap_host:     s.gmail_imap_host || 'imap.gmail.com',
        imap_port:     s.gmail_imap_port || '993',
        has_password:  !!s.gmail_imap_password,
      },
      viber: {
        bot_name:   s.viber_bot_name || '',
        bot_avatar: s.viber_bot_avatar || '',
        auth_token: s.viber_auth_token ? mask(s.viber_auth_token) : '',
        has_token:  !!s.viber_auth_token,
      },
      facebook: {
        page_id:           s.fb_page_id || '',
        verify_token:      s.fb_verify_token || '',
        page_access_token: s.fb_page_access_token ? mask(s.fb_page_access_token) : '',
        app_secret:        s.fb_app_secret ? mask(s.fb_app_secret) : '',
        has_token:         !!s.fb_page_access_token,
        has_secret:        !!s.fb_app_secret,
      },
    });
  } catch (e) {
    console.error('[services] config error:', e.message);
    res.status(500).json({ error: 'Failed to load service config' });
  }
});

// ============================================================
// PUT /api/admin/services/config
// Save service settings to system_settings DB
// Does NOT modify .env — use /apply-env for that
// ============================================================
router.put('/config', adminAuth(), async (req, res) => {
  try {
    const { section, values } = req.body;
    if (!section || !values || typeof values !== 'object') {
      return res.status(400).json({ error: 'section and values required' });
    }

    // Map of section keys to DB keys
    const maps = {
      smtp: {
        host: 'smtp_host', port: 'smtp_port', secure: 'smtp_secure',
        user: 'smtp_user', from_name: 'smtp_from_name', from_email: 'smtp_from_email',
      },
      smtp_password: { password: 'smtp_password' },
      semaphore: { sender_name: 'semaphore_sender' },
      semaphore_key: { api_key: 'semaphore_api_key' },
      xendit: { mode: 'xendit_mode', public_key: 'xendit_public_key', callback_url: 'xendit_callback_url' },
      xendit_secrets: { secret_key: 'xendit_secret_key', webhook_token: 'xendit_webhook_token' },
      domain: { app_url: 'app_url', cors_origins: 'cors_origins' },
      ms365: {
        enabled: 'ms365_enabled', tenant_id: 'ms365_tenant_id',
        client_id: 'ms365_client_id', redirect_uri: 'ms365_redirect_uri',
      },
      ms365_secret: { client_secret: 'ms365_client_secret' },
      threecx: {
        enabled: '3cx_enabled', fqdn: '3cx_fqdn',
        client_id: '3cx_client_id', default_extension: '3cx_default_extension',
      },
      threecx_secrets: { client_secret: '3cx_client_secret', webhook_secret: '3cx_webhook_secret' },
      mikrotik: {
        enabled: 'mikrotik_enabled', default_device: 'mikrotik_default_device',
        api_timeout: 'mikrotik_api_timeout',
      },
      olt: {
        enabled: 'olt_enabled', default_device: 'olt_default_device',
        snmp_timeout: 'olt_snmp_timeout', optical_warn_threshold: 'olt_optical_warn_threshold',
        optical_critical_threshold: 'olt_optical_critical_threshold',
      },
      gmail: { imap_user: 'gmail_imap_user', imap_host: 'gmail_imap_host', imap_port: 'gmail_imap_port' },
      gmail_secret: { imap_password: 'gmail_imap_password' },
      viber: { bot_name: 'viber_bot_name', bot_avatar: 'viber_bot_avatar' },
      viber_secret: { auth_token: 'viber_auth_token' },
      facebook: { page_id: 'fb_page_id', verify_token: 'fb_verify_token' },
      facebook_secret: { page_access_token: 'fb_page_access_token', app_secret: 'fb_app_secret' },
    };

    const keyMap = maps[section];
    if (!keyMap) return res.status(400).json({ error: `Unknown section: ${section}` });

    for (const [field, dbKey] of Object.entries(keyMap)) {
      if (values[field] !== undefined && values[field] !== '••••••••') {
        await setSetting(req.prisma, dbKey, values[field]);
      }
    }

    res.json({ ok: true, message: 'Settings saved' });
  } catch (e) {
    console.error('[services] save error:', e.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ============================================================
// POST /api/admin/services/test-email
// Sends a test email using current SMTP settings from DB/.env
// ============================================================
router.post('/test-email', adminAuth(), async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'to email required' });

    // Get admin info for the test
    const admin = await req.prisma.admin_users.findFirst({ where: { username: req.admin?.username } });
    const co = await require('../utils/company').getCompany(req.prisma);

    const { email } = require('../config');

    const result = await email.send({
      to,
      subject: `✅ Test Email — ${co.name}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px;">
          <div style="background:linear-gradient(135deg,#0f172a,#1e293b);border-radius:12px;padding:24px;text-align:center;margin-bottom:20px;">
            <div style="background:#10b981;display:inline-block;border-radius:8px;padding:6px 16px;margin-bottom:10px;">
              <span style="color:#fff;font-size:18px;font-weight:900;">${co.shortName}</span>
            </div>
            <h1 style="color:#fff;margin:8px 0 4px;font-size:18px;">Email Test Successful</h1>
            <p style="color:#94a3b8;margin:0;font-size:13px;">SMTP configuration is working</p>
          </div>
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;margin-bottom:16px;">
            <p style="margin:0;font-size:13px;color:#166534;">✅ Your SMTP settings are correctly configured and sending emails successfully.</p>
          </div>
          <p style="color:#64748b;font-size:12px;text-align:center;">
            Sent from ${co.name} CRM<br>
            ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} PHT
          </p>
        </div>
      `,
    });

    if (result.ok) {
      res.json({ ok: true, message: `Test email sent to ${to}`, messageId: result.messageId });
    } else {
      res.status(500).json({ ok: false, error: result.error || 'Send failed' });
    }
  } catch (e) {
    console.error('[services] test-email error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// POST /api/admin/services/test-sms
// Sends a test SMS using Semaphore
// ============================================================
router.post('/test-sms', adminAuth(), async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'to phone number required' });

    const co = await require('../utils/company').getCompany(req.prisma);

    // Get API key from DB or .env
    const dbKey = await getSetting(req.prisma, 'semaphore_api_key');
    const apiKey = (dbKey && dbKey !== '••••••••') ? dbKey : process.env.SEMAPHORE_API_KEY;
    const senderName = await getSetting(req.prisma, 'semaphore_sender') || process.env.SEMAPHORE_SENDER_NAME || 'J2NET';

    if (!apiKey) return res.status(400).json({ error: 'Semaphore API key not configured' });

    const fetch = require('node-fetch');
    const response = await fetch('https://api.semaphore.co/api/v4/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: apiKey,
        number: to,
        message: `${co.shortName}: SMS test successful! Your Semaphore integration is working. - ${co.name}`,
        sendername: senderName,
      }),
    });

    const data = await response.json();
    if (response.ok) {
      res.json({ ok: true, message: `Test SMS sent to ${to}`, data });
    } else {
      res.status(500).json({ ok: false, error: data.message || 'SMS send failed', data });
    }
  } catch (e) {
    console.error('[services] test-sms error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// POST /api/admin/services/test-3cx
// Tests 3CX connection by acquiring token + calling systemStatus
// ============================================================
router.post('/test-3cx', adminAuth(), async (req, res) => {
  try {
    const { invalidateToken, invalidateConfig, getToken, xapiRequest } = require('../utils/threecx');
    // Force fresh config & token
    invalidateConfig();
    invalidateToken();
    const token = await getToken(req.prisma);
    const status = await xapiRequest(req.prisma, 'GET', '/systemStatus');
    res.json({
      ok: true,
      message: 'Connected to 3CX successfully',
      version: status?.Version || status?.version || 'Unknown',
      status,
    });
  } catch (err) {
    console.error('[services] test-3cx error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================
// POST /api/admin/services/apply-env
// Writes critical service settings from DB → .env, restarts PM2
// Only call after saving settings to DB
// ============================================================
router.post('/apply-env', adminAuth(), async (req, res) => {
  try {
    // Read current service settings from DB
    const rows = await req.prisma.system_settings.findMany({
      where: { category: 'services' }
    });
    const s = {};
    rows.forEach(r => { s[r.key] = r.value; });

    // Also get company domain
    const domainRow = await req.prisma.system_settings.findUnique({ where: { key: 'company_website' } });
    const domain = domainRow?.value || 'netfactory.com.ph';

    // Build env updates (only update keys that exist in DB)
    const updates = {};

    if (s.smtp_host)       updates.SMTP_HOST       = s.smtp_host;
    if (s.smtp_port)       updates.SMTP_PORT       = s.smtp_port;
    if (s.smtp_secure)     updates.SMTP_SECURE     = s.smtp_secure;
    if (s.smtp_user)       updates.SMTP_USER       = s.smtp_user;
    if (s.smtp_password && s.smtp_password !== '••••••••') updates.SMTP_PASS = s.smtp_password;
    if (s.smtp_from_name)  updates.SMTP_FROM_NAME  = s.smtp_from_name;
    if (s.smtp_from_email) updates.SMTP_FROM_EMAIL = s.smtp_from_email;

    if (s.semaphore_api_key && s.semaphore_api_key !== '••••••••') updates.SEMAPHORE_API_KEY = s.semaphore_api_key;
    if (s.semaphore_sender) updates.SEMAPHORE_SENDER_NAME = s.semaphore_sender;

    if (s.xendit_secret_key && s.xendit_secret_key !== '••••••••') updates.XENDIT_SECRET_KEY = s.xendit_secret_key;
    if (s.xendit_webhook_token && s.xendit_webhook_token !== '••••••••') updates.XENDIT_WEBHOOK_TOKEN = s.xendit_webhook_token;

    if (s.app_url)         updates.APP_URL         = s.app_url;
    if (s.app_url)         updates.API_BASE_URL    = s.app_url;
    if (s.cors_origins)    updates.CORS_ORIGINS    = s.cors_origins;

    // Always sync domain
    updates.DOMAIN = domain;

    if (Object.keys(updates).length === 0) {
      return res.json({ ok: true, message: 'No .env changes needed', restarted: false });
    }

    const written = writeEnvKeys(updates);
    if (!written) return res.status(500).json({ error: 'Failed to write .env' });

    // The process is registered with pm2 as "isp-api"; asking for a name pm2
    // doesn't know fails the whole save even though the .env write succeeded.
    const pm2App = process.env.PM2_APP_NAME || 'isp-api';

    // Answer BEFORE restarting. The restart kills this very process, so a
    // response written in the exec callback never reaches the browser — nginx
    // returns 502 and the UI reports "Failed" for a restart that worked.
    res.json({
      ok: true,
      message: `Applied ${Object.keys(updates).length} settings to server, restarting API`,
      updated_keys: Object.keys(updates),
      restarted: true,
    });

    // Give the response time to flush through nginx before we pull the rug.
    setTimeout(() => {
      exec(`/usr/bin/pm2 restart ${pm2App} --update-env`, (err, stdout) => {
        if (err) return console.error('[services] PM2 restart error:', err.message);
        console.log('[services] PM2 restarted:', (stdout || '').trim());
      });
    }, 1000);

  } catch (e) {
    console.error('[services] apply-env error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
