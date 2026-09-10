'use strict';
// ============================================================
// routes/firmware-upload.js — Basic-Auth-gated file manager
// ============================================================
// Backs the /upload-firmware.html page. All endpoints share a
// single Basic-Auth credential pair (timing-safe compare) and
// operate on files under /home/ashraf/firmware/. Path traversal
// is blocked: every request resolves its target against ROOT and
// rejects anything outside.
//
// Endpoints (mounted at /api/upload-firmware):
//   GET  /health                 — auth probe
//   GET  /list?path=...          — directory listing
//   POST /mkdir                  — create a new folder
//   POST /upload?path=...        — upload one or more files
//                                  (preserves webkitRelativePath
//                                  for "Upload folder" mode)
//   GET  /download?path=...      — stream a single file
//   GET  /download-zip?path=...  — stream a folder as zip
//   POST /rename                 — rename file or folder
//   POST /move                   — move file or folder
//   DELETE /delete?path=...      — delete file or folder
// ============================================================

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const archiver = require('archiver');
const acs = require('../utils/genieacs');

const router = express.Router();

// ── GenieACS auto-mirror ─────────────────────────────────
// When an operator drops firmware/config files into the file
// manager, also push them to the GenieACS file store so they
// appear in the TR-069 Manager → Push firmware / Lock-all flows
// without a second manual upload.
function classifyForGenieAcs(filename) {
  const n = String(filename).toLowerCase();
  if (/\.(rom|bin|fw|img)$/.test(n)) {
    return { fileType: '1 Firmware Upgrade Image', oui: '001565' };
  }
  if (/\.cfg$/.test(n)) {
    return { fileType: '3 Vendor Configuration File', oui: '001565' };
  }
  return null; // not a CWMP-pushable file type
}

// Filename like "T21P_E2-52.84.0.125.rom" → productClass + version.
function extractYealinkMeta(filename) {
  const base = String(filename).replace(/\.[^.]+$/, '');
  const m = base.match(/^([A-Z]\d+[A-Z0-9_-]+?)[-_]?(\d{1,3}(?:\.\d{1,3}){2,3})$/);
  if (m) return { productClass: m[1].replace(/-/g, '_'), version: m[2] };
  const v = base.match(/(\d{1,3}(?:\.\d{1,3}){2,3})/);
  return v ? { productClass: null, version: v[1] } : { productClass: null, version: null };
}

async function mirrorToGenieAcs(filename, buffer) {
  const cls = classifyForGenieAcs(filename);
  if (!cls) return null;
  const meta = extractYealinkMeta(filename);
  try {
    await acs.uploadFile(filename, buffer, {
      fileType: cls.fileType,
      oui: cls.oui,
      productClass: meta.productClass,
      version: meta.version,
    });
    return { ok: true, fileType: cls.fileType, ...meta };
  } catch (e) {
    return { ok: false, error: e.message, fileType: cls.fileType };
  }
}

const ROOT = process.env.FW_UPLOAD_ROOT || '/home/ashraf/firmware';
const ALLOWED_USER = process.env.FW_UPLOAD_USER || 'jmallari';
const ALLOWED_PASS = process.env.FW_UPLOAD_PASS || 'CHANGE_ME_SET_FW_UPLOAD_PASS';

// ── Lockout policy ───────────────────────────────────────
// Combined failure counter: a bad password OR a wrong captcha
// both count toward the same threshold. 5 strikes within 15 min
// locks the IP for 15 min.
const LOCKOUT_THRESHOLD = Number(process.env.FW_LOCKOUT_THRESHOLD || 5);
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const failures = new Map(); // ip -> { count, firstAt, lockedUntil }

function clientIp(req) {
  const xri = req.headers['x-real-ip'];
  if (xri) return String(xri).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function isLocked(ip) {
  const e = failures.get(ip);
  if (!e) return 0;
  if (e.lockedUntil && Date.now() < e.lockedUntil) return Math.ceil((e.lockedUntil - Date.now()) / 1000);
  // Expire stale window
  if (e.firstAt && Date.now() - e.firstAt > LOCKOUT_WINDOW_MS) failures.delete(ip);
  return 0;
}

function recordFailure(ip) {
  const e = failures.get(ip) || { count: 0, firstAt: Date.now() };
  if (Date.now() - e.firstAt > LOCKOUT_WINDOW_MS) { e.count = 0; e.firstAt = Date.now(); }
  e.count++;
  if (e.count >= LOCKOUT_THRESHOLD) e.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  failures.set(ip, e);
  return { count: e.count, locked: !!e.lockedUntil };
}

function clearFailures(ip) { failures.delete(ip); }

function lockoutHeaders(res, secs) {
  res.set('Retry-After', String(secs));
}

// ── CAPTCHA store ────────────────────────────────────────
// In-memory map of {id → {answer, expires}}, single-use.
const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const captchas = new Map();

function reapCaptchas() {
  const now = Date.now();
  for (const [k, v] of captchas) if (v.expires < now) captchas.delete(k);
}
setInterval(reapCaptchas, 60_000).unref();

function genCaptchaText() {
  // Avoid easily-confused glyphs: 0/O, 1/I/L, B/8, S/5, Z/2
  const alphabet = 'ABCDEFGHJKMNPQRTUVWXY3469';
  let out = '';
  for (let i = 0; i < 5; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

function genCaptchaSvg(text) {
  const w = 200, h = 64;
  const colors = ['#3b82f6','#22c55e','#f59e0b','#a855f7','#ef4444'];
  const rand = (min, max) => min + Math.random() * (max - min);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="captcha">`;
  svg += `<rect width="${w}" height="${h}" rx="8" fill="#070b14"/>`;
  // Background dots
  for (let i = 0; i < 25; i++) {
    svg += `<circle cx="${rand(0,w).toFixed(1)}" cy="${rand(0,h).toFixed(1)}" r="${rand(0.5,1.6).toFixed(2)}" fill="${colors[Math.floor(Math.random()*colors.length)]}" fill-opacity="0.25"/>`;
  }
  // Noise lines
  for (let i = 0; i < 4; i++) {
    svg += `<line x1="${rand(0,w).toFixed(1)}" y1="${rand(0,h).toFixed(1)}" x2="${rand(0,w).toFixed(1)}" y2="${rand(0,h).toFixed(1)}" stroke="${colors[Math.floor(Math.random()*colors.length)]}" stroke-opacity="0.35" stroke-width="${rand(0.8,1.6).toFixed(2)}"/>`;
  }
  // Characters with small rotation
  const chars = text.split('');
  const slot = (w - 30) / chars.length;
  chars.forEach((c, i) => {
    const cx = (15 + slot * (i + 0.5)).toFixed(1);
    const cy = (38 + rand(-4, 4)).toFixed(1);
    const rot = rand(-22, 22).toFixed(1);
    svg += `<text x="${cx}" y="${cy}" font-family="'JetBrains Mono','Courier New',monospace" font-size="30" font-weight="700" fill="#e3e9f3" text-anchor="middle" transform="rotate(${rot} ${cx} ${cy})">${c}</text>`;
  });
  svg += `</svg>`;
  return svg;
}

function newCaptcha() {
  const id = crypto.randomBytes(12).toString('hex');
  const text = genCaptchaText();
  captchas.set(id, { answer: text.toUpperCase(), expires: Date.now() + CAPTCHA_TTL_MS });
  return { id, text };
}

// Returns true if captcha is correct AND consumed (removed). False
// otherwise. Caller still needs to record a failure on false.
function consumeCaptcha(id, answer) {
  if (!id || !answer) return false;
  const e = captchas.get(id);
  if (!e) return false;
  captchas.delete(id); // single-use regardless of correctness
  if (e.expires < Date.now()) return false;
  return e.answer === String(answer).trim().toUpperCase();
}

// ── Auth ──────────────────────────────────────────────────
function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function basicAuth(req, res, next) {
  const ip = clientIp(req);
  const lockedFor = isLocked(ip);
  if (lockedFor) {
    lockoutHeaders(res, lockedFor);
    return res.status(429).json({ error: 'Locked', retryAfter: lockedFor, message: `Too many failed attempts. Try again in ${Math.ceil(lockedFor / 60)} min.` });
  }
  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="File manager"');
    return res.status(401).json({ error: 'Authentication required' });
  }
  let user = '', pass = '';
  try {
    const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    user = decoded.slice(0, i);
    pass = decoded.slice(i + 1);
  } catch { /* fallthrough */ }
  if (!timingSafeEq(user, ALLOWED_USER) || !timingSafeEq(pass, ALLOWED_PASS)) {
    const f = recordFailure(ip);
    res.set('WWW-Authenticate', 'Basic realm="File manager"');
    return res.status(401).json({
      error: 'Invalid credentials',
      attempts: f.count,
      remaining: Math.max(0, LOCKOUT_THRESHOLD - f.count),
      locked: f.locked,
    });
  }
  // Successful auth — reset failure counter
  clearFailures(ip);
  next();
}

// CAPTCHA-additionally-required auth: used by /health (the login
// probe). Validates Basic Auth AND a captcha challenge. Failures
// of either count toward the lockout.
function basicAuthWithCaptcha(req, res, next) {
  const ip = clientIp(req);
  const lockedFor = isLocked(ip);
  if (lockedFor) {
    lockoutHeaders(res, lockedFor);
    return res.status(429).json({ error: 'Locked', retryAfter: lockedFor, message: `Too many failed attempts. Try again in ${Math.ceil(lockedFor / 60)} min.` });
  }
  const cId = req.headers['x-captcha-id'] || '';
  const cAns = req.headers['x-captcha-answer'] || '';
  if (!consumeCaptcha(cId, cAns)) {
    const f = recordFailure(ip);
    return res.status(401).json({
      error: 'Captcha incorrect or expired',
      attempts: f.count,
      remaining: Math.max(0, LOCKOUT_THRESHOLD - f.count),
      locked: f.locked,
      captcha_failed: true,
    });
  }
  // Captcha passed — fall through to Basic Auth check (which has its
  // own failure counter contribution).
  basicAuth(req, res, next);
}

// ── Path safety ───────────────────────────────────────────
// Resolve a user-supplied relative path against ROOT and reject
// any traversal that would escape it. Returns absolute path.
function safeResolve(rel) {
  const r = String(rel || '').replace(/^[/\\]+/, '');
  const abs = path.resolve(ROOT, r);
  const rootResolved = path.resolve(ROOT);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    const err = new Error('Path escapes root');
    err.status = 400;
    throw err;
  }
  return abs;
}

// Reject component names that would clobber on case-insensitive
// filesystems or sneak in via NUL / control chars.
function validName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (/[\x00-\x1f]/.test(name)) return false;
  if (name.length > 255) return false;
  return true;
}

// Ensure the root exists.
fs.mkdirSync(ROOT, { recursive: true });

// ── Multer (memory; we write atomically below) ────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 256 * 1024 * 1024 }, // 256 MB per file
});

// ── CAPTCHA — fresh challenge for the login form ─────────
router.get('/captcha', (req, res) => {
  const ip = clientIp(req);
  const lockedFor = isLocked(ip);
  if (lockedFor) {
    lockoutHeaders(res, lockedFor);
    return res.status(429).json({ error: 'Locked', retryAfter: lockedFor });
  }
  const c = newCaptcha();
  res.json({ id: c.id, svg: genCaptchaSvg(c.text), ttl: CAPTCHA_TTL_MS / 1000 });
});

// ── Lockout status — non-destructive, used by login UI ───
router.get('/status', (req, res) => {
  const ip = clientIp(req);
  const lockedFor = isLocked(ip);
  const e = failures.get(ip) || { count: 0 };
  res.json({
    locked: !!lockedFor,
    retryAfter: lockedFor || 0,
    attempts: e.count,
    threshold: LOCKOUT_THRESHOLD,
  });
});

// ── Health probe (login flow — captcha required) ─────────
// On success, also issues the fw_session cookie so /download-wp/* links
// downloaded by the same user (or anyone redirected here via ?next=) skip
// the login page next time.
router.get('/health', basicAuthWithCaptcha, (req, res) => {
  const exp = Date.now() + 24 * 60 * 60 * 1000;
  const payload = ALLOWED_USER + ':' + exp;
  const sig = crypto.createHmac('sha256', (process.env.FW_SESSION_SECRET || (ALLOWED_PASS + ':' + ALLOWED_USER))).update(payload).digest('hex');
  const token = Buffer.from(payload + ':' + sig).toString('base64url');
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('fw_session', token, { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 24*60*60*1000, path: '/' });
  res.json({ ok: true, allowedUser: ALLOWED_USER, root: ROOT });
});

// ── List directory ────────────────────────────────────────
router.get('/list', basicAuth, async (req, res) => {
  try {
    const dir = safeResolve(req.query.path || '');
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const items = await Promise.all(entries
      .filter(e => !e.name.startsWith('.'))
      .map(async (e) => {
        const full = path.join(dir, e.name);
        try {
          const s = await fsp.stat(full);
          return {
            name: e.name,
            type: e.isDirectory() ? 'dir' : 'file',
            size: e.isDirectory() ? null : s.size,
            modified: s.mtime.toISOString(),
          };
        } catch {
          return null;
        }
      }));
    res.json({
      path: path.relative(ROOT, dir).replace(/\\/g, '/'),
      items: items.filter(Boolean).sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      }),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Create folder ─────────────────────────────────────────
router.post('/mkdir', basicAuth, express.json(), async (req, res) => {
  try {
    const parent = safeResolve(req.body.path || '');
    const name = req.body.name;
    if (!validName(name)) return res.status(400).json({ error: 'Invalid folder name' });
    const dir = safeResolve(path.join(req.body.path || '', name));
    await fsp.mkdir(dir, { recursive: false });
    res.json({ ok: true, path: path.relative(ROOT, dir).replace(/\\/g, '/') });
  } catch (e) {
    if (e.code === 'EEXIST') return res.status(409).json({ error: 'Already exists' });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Upload (single or multiple, with optional relative paths) ─
// Multer captures the `file` (legacy) and `files[]` fields. Each
// uploaded file may carry a `relativePath` form field (one per
// file, in order) when the operator chose "Upload folder" — we
// recreate the directory tree under the target path.
router.post('/upload', basicAuth, (req, res) => {
  upload.array('files', 200)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });
    try {
      const targetDir = safeResolve(req.query.path || req.body.path || '');
      // Verify it's an existing directory (or create if relative paths require)
      try {
        const s = await fsp.stat(targetDir);
        if (!s.isDirectory()) return res.status(400).json({ error: 'Target is not a directory' });
      } catch (e) {
        if (e.code === 'ENOENT') return res.status(404).json({ error: 'Target directory not found' });
        throw e;
      }
      // relativePath body field can be a string or array (one per file)
      let relPaths = req.body.relativePath || req.body['relativePath[]'] || [];
      if (typeof relPaths === 'string') relPaths = [relPaths];
      const written = [];
      const mirrored = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const rel = relPaths[i] || f.originalname;
        const segments = String(rel).split(/[/\\]+/).filter(Boolean);
        if (!segments.length || segments.some(s => !validName(s))) {
          return res.status(400).json({ error: 'Invalid filename: ' + rel });
        }
        const baseName = segments[segments.length - 1];
        const fileDir = safeResolve(path.join(req.query.path || req.body.path || '', ...segments.slice(0, -1)));
        const filePath = path.join(fileDir, baseName);
        await fsp.mkdir(fileDir, { recursive: true });
        await fsp.writeFile(filePath, f.buffer);
        written.push({ name: baseName, size: f.size, path: path.relative(ROOT, filePath).replace(/\\/g, '/') });
        // Best-effort GenieACS mirror — don't fail the upload if NBI is down
        const m = await mirrorToGenieAcs(baseName, f.buffer);
        if (m) mirrored.push({ name: baseName, ...m });
      }
      res.json({ ok: true, count: written.length, files: written, mirrored });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });
});

// ── Download a single file ────────────────────────────────
router.get('/download', basicAuth, async (req, res) => {
  try {
    const target = safeResolve(req.query.path || '');
    const s = await fsp.stat(target);
    if (s.isDirectory()) return res.status(400).json({ error: 'Use /download-zip for folders' });
    res.download(target, path.basename(target));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Download a folder as ZIP (streamed) ───────────────────
router.get('/download-zip', basicAuth, async (req, res) => {
  try {
    const target = safeResolve(req.query.path || '');
    const s = await fsp.stat(target);
    if (!s.isDirectory()) return res.status(400).json({ error: 'Path is not a directory' });
    const zipName = (path.basename(target) || 'firmware') + '.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => { res.status(500).end(); });
    archive.pipe(res);
    archive.directory(target, false);
    archive.finalize();
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Rename ────────────────────────────────────────────────
router.post('/rename', basicAuth, express.json(), async (req, res) => {
  try {
    const src = safeResolve(req.body.path || '');
    const newName = req.body.newName;
    if (!validName(newName)) return res.status(400).json({ error: 'Invalid name' });
    const dst = path.join(path.dirname(src), newName);
    safeResolve(path.relative(ROOT, dst)); // re-validate
    await fsp.rename(src, dst);
    res.json({ ok: true, path: path.relative(ROOT, dst).replace(/\\/g, '/') });
  } catch (e) {
    if (e.code === 'EEXIST') return res.status(409).json({ error: 'Target already exists' });
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Source not found' });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Move (rename across directories) ──────────────────────
router.post('/move', basicAuth, express.json(), async (req, res) => {
  try {
    const src = safeResolve(req.body.from || '');
    const destDir = safeResolve(req.body.to || '');
    const ds = await fsp.stat(destDir).catch(() => null);
    if (!ds || !ds.isDirectory()) return res.status(400).json({ error: 'Destination is not a directory' });
    const dst = path.join(destDir, path.basename(src));
    if (dst === src) return res.json({ ok: true, message: 'Same location' });
    // Re-validate
    safeResolve(path.relative(ROOT, dst));
    try {
      await fsp.access(dst);
      return res.status(409).json({ error: 'Target already exists at destination' });
    } catch { /* good — no conflict */ }
    await fsp.rename(src, dst);
    res.json({ ok: true, path: path.relative(ROOT, dst).replace(/\\/g, '/') });
  } catch (e) {
    if (e.code === 'EXDEV') {
      // cross-device — would need a copy+unlink; not supported
      return res.status(500).json({ error: 'Cross-device move not supported' });
    }
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Manual sync to GenieACS ──────────────────────────────
// Re-pushes a single file (or every CWMP-eligible file under a
// folder, recursively) into the GenieACS file store. Used when
// the local file already exists but isn't yet in NBI — for
// instance, files that were uploaded before the auto-mirror was
// added, or files dropped via SCP / direct disk write.
router.post('/sync-to-genieacs', basicAuth, express.json(), async (req, res) => {
  try {
    const target = safeResolve(req.body.path || '');
    const s = await fsp.stat(target);
    const results = [];
    async function walk(p) {
      const st = await fsp.stat(p);
      if (st.isDirectory()) {
        const entries = await fsp.readdir(p, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          await walk(path.join(p, e.name));
        }
      } else {
        const m = classifyForGenieAcs(path.basename(p));
        if (!m) return; // skip files we can't push via CWMP
        const buf = await fsp.readFile(p);
        const r = await mirrorToGenieAcs(path.basename(p), buf);
        results.push({ name: path.basename(p), ...(r || {}) });
      }
    }
    await walk(target);
    if (!results.length) return res.status(400).json({ error: 'No CWMP-pushable files found at this path (.rom/.bin/.fw/.img/.cfg)' });
    res.json({ ok: true, count: results.length, results });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Delete (file or folder, recursive) ───────────────────
router.delete('/delete', basicAuth, async (req, res) => {
  try {
    const target = safeResolve(req.query.path || '');
    const rootResolved = path.resolve(ROOT);
    if (target === rootResolved) return res.status(400).json({ error: 'Cannot delete root' });
    const s = await fsp.stat(target);
    if (s.isDirectory()) await fsp.rm(target, { recursive: true, force: true });
    else await fsp.unlink(target);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;

// ── Public / private download links ──────────────────────────
// Two extra routes for shareable download URLs:
//   /download-np/<file>   no password — anyone with the link
//   /download-wp/<file>   with password — redirects to the
//                          login page (upload-firmware.html)
//                          which sets a short-lived cookie on
//                          successful auth, then redirects back.
// Mounted at the app level (see server.js).
const SESSION_SECRET = process.env.FW_SESSION_SECRET || (ALLOWED_PASS + ':' + ALLOWED_USER);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function signSession() {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = ALLOWED_USER + ':' + exp;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(payload + ':' + sig).toString('base64url');
}

function verifySession(token) {
  if (!token) return false;
  let raw;
  try { raw = Buffer.from(token, 'base64url').toString('utf8'); } catch { return false; }
  const parts = raw.split(':');
  if (parts.length !== 3) return false;
  const [user, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!exp || Date.now() > exp) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(user + ':' + exp).digest('hex');
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function publicRouter() {
  const r = express.Router();
  // Resolve a single filename inside one of the two folders. No traversal.
  const resolveIn = (dir, name) => {
    if (!validName(name)) { const e = new Error('Invalid filename'); e.status = 400; throw e; }
    const abs = path.resolve(ROOT, dir, name);
    const expected = path.resolve(ROOT, dir);
    if (!abs.startsWith(expected + path.sep)) {
      const e = new Error('Path escapes root'); e.status = 400; throw e;
    }
    return abs;
  };
  // Simple directory listing as plain HTML (no password / with password).
  const listingHtml = (dir, label) => async (req, res) => {
    try {
      const full = path.resolve(ROOT, dir);
      await fsp.mkdir(full, { recursive: true });
      const entries = (await fsp.readdir(full, { withFileTypes: true }))
        .filter(e => e.isFile() && !e.name.startsWith('.'));
      const rows = await Promise.all(entries.map(async e => {
        const s = await fsp.stat(path.join(full, e.name));
        return { name: e.name, size: s.size, mtime: s.mtime };
      }));
      rows.sort((a,b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const fmtSize = (n) => n >= 1048576 ? (n/1048576).toFixed(1)+' MB' : n >= 1024 ? (n/1024).toFixed(1)+' KB' : n+' B';
      const escape = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const items = rows.map(r => '<tr><td><a href="./'+encodeURIComponent(r.name)+'">'+escape(r.name)+'</a></td><td>'+fmtSize(r.size)+'</td><td>'+r.mtime.toISOString().slice(0,16).replace('T',' ')+'</td></tr>').join('') || '<tr><td colspan="3" style="text-align:center;color:#94a3b8;padding:24px">No files yet</td></tr>';
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${label} — Netfactory</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0b1120;color:#e2e8f0;min-height:100vh}.wrap{max-width:760px;margin:0 auto;padding:32px 20px}h1{font-size:18px;margin:0 0 4px;font-weight:700}.sub{color:#64748b;font-size:12px;margin-bottom:18px}table{width:100%;border-collapse:collapse;background:#111c2e;border:1px solid #1e293b;border-radius:10px;overflow:hidden}th{text-align:left;padding:10px 14px;background:#0f172a;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}td{padding:10px 14px;border-top:1px solid #1e293b;font-size:13px}a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}</style></head><body><div class="wrap"><h1>📁 ${label}</h1><div class="sub">${rows.length} file${rows.length===1?'':'s'} · Netfactory &amp; Data Solution</div><table><thead><tr><th>Name</th><th style="width:90px">Size</th><th style="width:140px">Modified</th></tr></thead><tbody>${items}</tbody></table></div></body></html>`);
    } catch (e) {
      res.status(500).send('Error: ' + e.message);
    }
  };
  // ── Public download (no password) ────────────────────────
  r.get('/download-np', listingHtml('download-np', 'Public Downloads'));
  r.get('/download-np/:filename', async (req, res) => {
    try {
      const file = resolveIn('download-np', req.params.filename);
      await fsp.stat(file);
      res.download(file, req.params.filename);
    } catch (e) {
      res.status(e.code === 'ENOENT' ? 404 : (e.status || 500)).send(e.code === 'ENOENT' ? 'File not found' : ('Error: ' + e.message));
    }
  });
  // ── Private download (password — uses login page) ────────
  // Cookie-protected. Missing/invalid cookie redirects to the
  // upload-firmware.html login with ?next=<original URL>. After
  // successful login, the page sets the cookie and bounces back.
  r.get('/download-wp', (req, res, next) => {
    if (!verifySession(req.cookies && req.cookies.fw_session)) {
      return res.redirect('/upload-firmware.html?next=' + encodeURIComponent(req.originalUrl));
    }
    return listingHtml('download-wp', 'Restricted Downloads')(req, res);
  });
  r.get('/download-wp/:filename', async (req, res) => {
    if (!verifySession(req.cookies && req.cookies.fw_session)) {
      return res.redirect('/upload-firmware.html?next=' + encodeURIComponent(req.originalUrl));
    }
    try {
      const file = resolveIn('download-wp', req.params.filename);
      await fsp.stat(file);
      res.download(file, req.params.filename);
    } catch (e) {
      res.status(e.code === 'ENOENT' ? 404 : (e.status || 500)).send(e.code === 'ENOENT' ? 'File not found' : ('Error: ' + e.message));
    }
  });
  return r;
}

// Issue / clear the wp session cookie. Called by the login page
// after a successful captcha + Basic Auth challenge so subsequent
// /download-wp/* hits work without re-prompting.
function authRouter() {
  const r = express.Router();
  r.post('/auth/login', basicAuthWithCaptcha, (req, res) => {
    const token = signSession();
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('fw_session', token, {
      httpOnly: true, sameSite: 'lax', secure: isProd,
      maxAge: SESSION_TTL_MS, path: '/'
    });
    res.json({ ok: true });
  });
  r.post('/auth/logout', (req, res) => {
    res.clearCookie('fw_session', { path: '/' });
    res.json({ ok: true });
  });
  return r;
}

module.exports.publicRouter = publicRouter;
module.exports.authRouter = authRouter;
