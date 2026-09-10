// ─────────────────────────────────────────────────────────────
//  Netfactory Dev Tools API Route
//  Mount: app.use('/api/devtools', require('./routes/devtools'))
// ─────────────────────────────────────────────────────────────
const express  = require('express');
const router   = express.Router();
const { exec } = require('child_process');
const path     = require('path');
const fs       = require('fs');

// ── Storage (JSON file next to this script) ────────────────────
const STORE_PATH = path.join(__dirname, 'devtools-buttons.json');

function loadButtons() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed.buttons || [];
    }
  } catch (e) {
    console.error('[devtools] Failed to load buttons:', e.message);
  }
  return [];
}

function saveButtons(buttons) {
  fs.writeFileSync(STORE_PATH, JSON.stringify({ buttons }, null, 2), 'utf8');
}

// ── Auth middleware (reuse existing JWT check) ─────────────────
//    Assumes the main app attaches authenticateToken / verifyToken
//    as req.authMiddleware or similar — adjust name if needed.
//    Fallback: decode the Bearer token manually.
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'nfnet';

function auth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    // Only allow admin role
    if (payload.role !== 'admin' && payload.type !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── GET /api/devtools/buttons ──────────────────────────────────
router.get('/buttons', auth, (req, res) => {
  const buttons = loadButtons();
  res.json({ buttons });
});

// ── POST /api/devtools/buttons ─────────────────────────────────
router.post('/buttons', auth, (req, res) => {
  const { buttons } = req.body;
  if (!Array.isArray(buttons)) {
    return res.status(400).json({ error: 'buttons must be an array' });
  }
  try {
    saveButtons(buttons);
    res.json({ ok: true, saved: buttons.length });
  } catch (e) {
    console.error('[devtools] Save error:', e.message);
    res.status(500).json({ error: 'Failed to save buttons' });
  }
});

// ── POST /api/devtools/run ─────────────────────────────────────
const TIMEOUT_MS = 30000; // 30 s hard limit
const DETACH_CMDS = ['reboot', 'shutdown', 'pm2 restart', 'pm2 reload', 'service', 'systemctl restart'];

router.post('/run', auth, (req, res) => {
  const { command } = req.body;
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'command is required' });
  }

  const trimmed = command.trim();
  console.log(`[devtools] run by ${req.user.username}: ${trimmed}`);

  // Detect commands that restart the process (response may not arrive)
  const isDetach = DETACH_CMDS.some(k => trimmed.includes(k));

  if (isDetach) {
    // Fire and forget — reply immediately
    exec(trimmed, { timeout: 5000 });
    return res.json({ ok: true, detached: true, stdout: '', stderr: '' });
  }

  exec(trimmed, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
    res.json({
      ok: !err || err.code === 0,
      success: !err || err.code === 0,
      stdout: stdout || '',
      stderr: stderr || (err ? err.message : ''),
      exitCode: err ? err.code : 0
    });
  });
});

module.exports = router;
