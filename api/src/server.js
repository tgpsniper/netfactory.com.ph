// ============================================================
// NETFACTORY & DATA SOLUTION — API Server
// ============================================================
// All configuration is centralized in ./config/
// Database, Email, SMS, JWT, CORS — all managed from one place.
// ============================================================

const config = require('./config');
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { Server: SocketServer } = require('socket.io');
const jwt = require('jsonwebtoken');
const { csrfProtection } = require('./middleware/csrfProtection');
const { systemToggles } = require('./middleware/systemToggles');
const { geoblockMiddleware } = require('./middleware/geoblock');

const publicRoutes = require('./routes/public');
const portalRoutes = require('./routes/portal');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');
const logisticsRoutes = require("./routes/logistics");
const servicesRoutes = require('./routes/services');
const auditLogger = require('./middleware/auditLogger');
const auditRoutes = require('./routes/auditRoutes');

// ── Validate required config before anything else ───────────
config.validate();

const app = express();
app.set('trust proxy', 1);



// ============================================================
// MIDDLEWARE
// ============================================================

// Security headers
app.use(helmet());

// CORS — origins from central config
app.use(cors({
  origin: [
    ...config.cors.origins,
    /\.netfactory\.com\.ph$/,
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Local-IP'],
}));

// Body parsing
app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// Cookie parsing (required for httpOnly auth cookies)
app.use(cookieParser());

// CSRF protection for state-changing requests
const isProduction = process.env.NODE_ENV === 'production';
app.use(csrfProtection({ isProduction }));

// Global rate limiter — settings from central config
const globalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ── Attach shared services to every request ─────────────────
// This is what makes the central config available to ALL routes:
//   req.prisma  → database client
//   req.config  → full config (email, sms, jwt, etc.)
app.use(config.db.middleware());
app.use((req, res, next) => {
  req.config = config;
  next();
});
// System toggles (SMS/Email/GeoBlock on/off)
app.use(systemToggles());
// Staff-editable email/SMS wording — cached so template lookups stay synchronous.
app.use(require('./config/message-templates').messageTemplates());
// GeoIP blocking (only active when geoblock_enabled toggle is on)
app.use(geoblockMiddleware());

// Audit trail middleware
app.use(auditLogger());

// Request logging (production-friendly)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (!config.server.isProduction || res.statusCode >= 400) {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// ============================================================
// ROUTES
// ============================================================

// Public website (no auth required)
app.use('/api/public', publicRoutes);

// Customer portal (subscriber auth)
app.use('/api/portal', portalRoutes);
// Public, unauthenticated: the walled-garden page a restricted subscriber is redirected
// to. Sits beside /api/portal rather than inside it because portalRoutes is behind
// portalAuth, and a cut-off customer is precisely the one who cannot log in.
app.use('/api/restricted', require('./routes/restricted'));
// Public pay-by-link: an emailed link opens one invoice and a Xendit checkout,
// with no portal login. Token-scoped to that invoice; see routes/paylink.js.
app.use('/api/paylink', require('./routes/paylink'));

// GIS Map routes (must be before adminRoutes)
const mapRoutes = require("./routes/map");
app.use("/api/admin/map", mapRoutes);

// CRM admin (admin auth)
app.use('/api/admin', adminRoutes);

// Payment webhooks
app.use('/api/webhooks', webhookRoutes);

// Logistics
app.use("/api/logistics", logisticsRoutes);
app.use('/api/admin/services', servicesRoutes);
app.use('/api/admin/message-templates', require('./routes/message-templates'));
app.use('/api/admin/account-number', require('./routes/account-number'));

// Test Routes 021326
const testRoutes = require('./routes/test');
app.use('/api/test', require('./routes/test'));

// Bug Tracker
const bugRoutes = require('./routes/bugs');
const creditsRoutes = require('./routes/credits');
const radiusRoutes = require('./routes/radius');
app.use('/api/bugs', bugRoutes);
app.use('/api/admin/credits', creditsRoutes);
app.use('/api/admin/prepaid', require('./routes/prepaid'));
app.use('/api/ai', require('./routes/ai'));

// RADIUS Management (Phase 3)
app.use('/api/admin/radius', radiusRoutes);
app.use('/api/admin/radius-status', require('./routes/radius-status'));

// System Status
const systemRoutes = require('./routes/system');
app.use('/api/admin/system', systemRoutes);

//System Alerts
app.use('/api/admin/monitor', require('./routes/monitor'));
app.use('/api/admin/uat', require('./routes/uat'));

// SQL Console (superadmin only — see routes/sql.js for guardrails)
app.use('/api/admin/sql', require('./routes/sql'));

// XConnect (IPTV reseller panel)
app.use('/api/admin/xconnect', require('./routes/xconnect'));
app.use('/api/admin/inbox', require('./routes/inbox'));

// TR-069 / CWMP (GenieACS)
app.use('/api/admin/tr069', require('./routes/tr069'));
app.use('/api/portal/tr069', require('./routes/portal-tr069'));
// Hidden Basic-Auth-gated firmware upload (used by /upload-firmware.html)
const fwUpload = require('./routes/firmware-upload');
app.use('/api/upload-firmware', fwUpload);
// Cookie-issuing login endpoint for the public/private download links.
app.use('/api/upload-firmware', fwUpload.authRouter());
// Shareable download URLs:
//   /download-np/<file>  no password
//   /download-wp/<file>  password (redirects to login page when missing)
app.use('/', fwUpload.publicRouter());

// Dev Tools
app.use('/api/devtools', require('./routes/devtools'));
app.use('/api/accounting', require('./routes/accounting'));
app.use('/api/treasury', require('./routes/treasury'));

// 3CX PBX Integration
const pbxRoutes = require('./routes/pbx');
app.use('/api/admin/pbx', pbxRoutes);

// MikroTik Controller
app.use('/api/admin/mikrotik', require('./routes/mikrotik'));

// VSOL OLT Manager
app.use('/api/admin/olt', require('./routes/olt'));

// SmartOLT cloud integration (remote ZTE C650 over cloud API)
app.use('/api/admin/smartolt', require('./routes/smartolt'));

// OSP (Outside Plant) Module
app.use('/api/admin/osp', require('./routes/osp'));

// Sales Agents Module
app.use('/api/agents', require('./routes/agents'));

// Audit trail API
app.use('/api/audit', auditRoutes);


// ── Health check endpoint ───────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const dbHealth = await config.db.healthCheck();
    const emailOk = config.email.isConfigured();
    const smsOk = config.sms.isConfigured();

    res.json({
      status: dbHealth.ok ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        database: dbHealth.ok ? 'connected' : 'disconnected',
        dbLatency: `${dbHealth.latencyMs}ms`,
        email: emailOk ? 'configured' : 'not configured',
        sms: smsOk ? 'configured' : 'not configured',
        xendit: process.env.XENDIT_SECRET_KEY ? 'configured' : 'not configured',
      },
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      error: err.message,
    });
  }
});

// ── 404 handler ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ── Global error handler ────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: config.server.isProduction
      ? 'Internal server error'
      : err.message,
  });
});

// ============================================================
// START SERVER
// ============================================================

async function start() {
  try {
    // Connect database
    await config.db.connect();

    // Print service status summary
    config.printStatus();

    // Static file serving
    app.use('/uploads/nap', require('express').static(require('path').join(__dirname, '../uploads/nap')));
    app.use('/uploads/gis-photos', require('express').static(require('path').join(__dirname, '../uploads/gis-photos')));

    // Create HTTP server + Socket.IO
    const server = http.createServer(app);
    const io = new SocketServer(server, {
      cors: {
        origin: config.cors.origins,
        credentials: true,
      },
    });

    // Socket.IO JWT auth
    io.use((socket, next) => {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('Authentication required'));
      try {
        const decoded = jwt.verify(token, config.jwt.secret);
        if (decoded.type !== 'admin') return next(new Error('Admin access required'));
        socket.admin = decoded;
        next();
      } catch(err) {
        next(new Error('Invalid token'));
      }
    });

    io.on('connection', (socket) => {
      console.log(`[Socket.IO] Admin connected: ${socket.admin.username || socket.admin.id}`);
      socket.join('admins');
      socket.on('disconnect', () => {
        console.log(`[Socket.IO] Admin disconnected: ${socket.admin.username || socket.admin.id}`);
      });
    });

    // Store io on app for use in routes
    app.set('io', io);

    // Start scheduled jobs (TR-069 diagnostics + alerts)
    try {
      const { startJobs } = require('./jobs');
      startJobs(config.db.prisma, io);
    } catch (e) {
      console.error('[jobs] failed to start:', e.message);
    }

    // Start listening
    server.listen(config.server.port, () => {
      console.log(`✅ Netfactory API running on port ${config.server.port}`);
      console.log(`   Environment: ${config.server.env}`);
      console.log(`   WebSocket: Socket.IO enabled`);
      console.log(`   Health: http://localhost:${config.server.port}/api/health`);
    });
  } catch (err) {
    console.error('✗ Failed to start server:', err);
    process.exit(1);
  }
}

// ── Graceful shutdown ───────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await config.db.disconnect();
  const radiusDb = require('./config/radius-db');
  await radiusDb.disconnect();
  try { await require('./utils/mikrotik').disconnectAll(); } catch (_) {}
  try { require('./utils/olt-driver').disconnectAll(); } catch (_) {}
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await config.db.disconnect();
  const radiusDb = require('./config/radius-db');
  await radiusDb.disconnect();
  try { await require('./utils/mikrotik').disconnectAll(); } catch (_) {}
  try { require('./utils/olt-driver').disconnectAll(); } catch (_) {}
  process.exit(0);
});

start();
