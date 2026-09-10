// ============================================================
// NETFACTORY — Central Configuration
// ============================================================
// Usage in any route or module:
//   const config = require('../config');
//   config.db.prisma    → Prisma client instance
//   config.email        → email settings + sendMail()
//   config.sms          → sms settings + sendSMS()
//   config.jwt          → JWT secrets & expiry
//   config.server       → port, domain, env
// ============================================================

require('dotenv').config();

const database = require('./database');
const email = require('./email');
const sms = require('./sms');

// ── Server Settings ─────────────────────────────────────────
const server = {
  port: parseInt(process.env.PORT) || 3001,
  env: process.env.NODE_ENV || 'development',
  domain: process.env.DOMAIN || 'netfactory.com.ph',
  apiBaseUrl: process.env.API_BASE_URL || `http://localhost:${parseInt(process.env.PORT) || 3001}/api`,
  isProduction: (process.env.NODE_ENV || 'development') === 'production',
};

// ── JWT Settings ────────────────────────────────────────────
const jwt = {
  secret: process.env.JWT_SECRET,
  expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  adminExpiresIn: process.env.JWT_ADMIN_EXPIRES_IN || '8h',
};

// ── CORS Settings ───────────────────────────────────────────
const cors = {
  origins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    : [
        'https://netfactory.com.ph',
        'https://www.netfactory.com.ph',
        'http://localhost:3000',
        'http://localhost:5173',
      ],
};

// ── Rate Limiting ───────────────────────────────────────────
const rateLimit = {
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 500,
};

// ── Payment Gateways (placeholder) ─────────────────────────
const payments = {
  xendit: {
    secretKey: process.env.XENDIT_SECRET_KEY || null,
    webhookToken: process.env.XENDIT_WEBHOOK_TOKEN || null,
  },
  gcash: {
    apiKey: process.env.GCASH_API_KEY || null,
  },
  maya: {
    apiKey: process.env.MAYA_API_KEY || null,
  },
};

// ── Validate Required Settings ──────────────────────────────
function validate() {
  const missing = [];

  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!jwt.secret) missing.push('JWT_SECRET');

  if (missing.length > 0) {
    console.error('╔══════════════════════════════════════════════════╗');
    console.error('║  MISSING REQUIRED ENVIRONMENT VARIABLES         ║');
    console.error('╠══════════════════════════════════════════════════╣');
    missing.forEach(v => {
      console.error(`║  ✗ ${v.padEnd(45)}║`);
    });
    console.error('╠══════════════════════════════════════════════════╣');
    console.error('║  Copy .env.example to .env and fill in values   ║');
    console.error('╚══════════════════════════════════════════════════╝');
    process.exit(1);
  }

  // Warnings for optional services
  const warnings = [];
  if (!email.isConfigured()) warnings.push('EMAIL (SMTP) — email notifications disabled');
  if (!sms.isConfigured()) warnings.push('SMS (Semaphore) — SMS notifications disabled');
  if (!payments.xendit.secretKey) warnings.push('XENDIT — payment gateway not configured');

  if (warnings.length > 0) {
    console.warn('┌──────────────────────────────────────────────────┐');
    console.warn('│  Optional services not configured:               │');
    warnings.forEach(w => {
      console.warn(`│  ⚠ ${w.padEnd(47)}│`);
    });
    console.warn('└──────────────────────────────────────────────────┘');
  }
}

// ── Print Startup Summary ───────────────────────────────────
function printStatus() {
  console.log('');
  console.log('┌──────────────────────────────────────────────────┐');
  console.log('│      NETFACTORY — Service Configuration          │');
  console.log('├──────────────────────────────────────────────────┤');
  console.log(`│  Server:    ${server.env.padEnd(37)}│`);
  console.log(`│  Port:      ${String(server.port).padEnd(37)}│`);
  console.log(`│  Domain:    ${server.domain.padEnd(37)}│`);
  console.log(`│  Database:  ${'Connected (Prisma)'.padEnd(37)}│`);
  console.log(`│  Email:     ${(email.isConfigured() ? '✅ ' + email.settings.host : '❌ Not configured').padEnd(37)}│`);
  console.log(`│  SMS:       ${(sms.isConfigured() ? '✅ Semaphore' : '❌ Not configured').padEnd(37)}│`);
  console.log(`│  Xendit:    ${(payments.xendit.secretKey ? '✅ Connected' : '❌ Not configured').padEnd(37)}│`);
  console.log('└──────────────────────────────────────────────────┘');
  console.log('');
}

module.exports = {
  // Services
  db: database,
  email,
  sms,

  // Settings
  server,
  jwt,
  cors,
  rateLimit,
  payments,

  // Utilities
  validate,
  printStatus,
};
