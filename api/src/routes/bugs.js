/**
 * Netfactory — Bug Tracker API Routes
 * 
 * Mount in server.js:
 *   const bugRoutes = require('./routes/bugs');
 *   app.use('/api/bugs', bugRoutes);
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ── Upload config ──
const UPLOAD_DIR = '/var/www/netfactory.com.ph/html/uploads/bugs';
const UPLOAD_URL = '/uploads/bugs';

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `bug-${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|bmp|mp4|webm|mov|pdf/;
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype;
    if (allowed.test(ext) || mime.startsWith('image/') || mime.startsWith('video/') || mime === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only images, videos, and PDFs are allowed'));
    }
  },
});

// ── Basic Auth ──
const basicAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Netfactory Bug Tracker"');
    return res.status(401).json({ error: 'Authentication required' });
  }
  const decoded = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const [user, pass] = decoded.split(':');
  if (user === 'admin' && pass === 'changeme123') return next();
  res.set('WWW-Authenticate', 'Basic realm="Netfactory Bug Tracker"');
  return res.status(401).json({ error: 'Invalid credentials' });
};

router.use(basicAuth);

async function getNextBugId(prisma) {
  const result = await prisma.$queryRaw`SELECT nextval('bug_id_seq')::int AS val`;
  return `BUG-${String(result[0].val).padStart(4, '0')}`;
}

function formatBug(b) {
  return {
    id: b.bug_id, dbId: b.id,
    dateFound: b.date_found ? new Date(b.date_found).toISOString().slice(0, 10) : null,
    tester: b.tester, module: b.module, severity: b.severity,
    testAccount: b.test_account, steps: b.steps, expected: b.expected, actual: b.actual,
    screenshotUrl: b.screenshot_url, consoleErrors: b.console_errors, serverLogs: b.server_logs,
    status: b.status, notes: b.notes,
    screenshots: (b.screenshots || []).map(s => ({
      id: s.id, filename: s.filename, url: `${UPLOAD_URL}/${s.filename}`,
      filesize: s.filesize, mimetype: s.mimetype, uploadedAt: s.uploaded_at,
    })),
    createdAt: b.created_at, updatedAt: b.updated_at,
  };
}

const bugInclude = { screenshots: { orderBy: { uploaded_at: 'asc' } } };

// GET /api/bugs
router.get('/', async (req, res) => {
  try {
    const { severity, status, module: mod, tester, search, sortBy = 'created_at', sortDir = 'desc', page = 1, limit = 50 } = req.query;
    const where = {};
    if (severity && severity !== 'All') where.severity = severity;
    if (status && status !== 'All') where.status = status;
    if (mod && mod !== 'All') where.module = mod;
    if (tester) where.tester = { contains: tester, mode: 'insensitive' };
    if (search) {
      where.OR = [
        { bug_id: { contains: search, mode: 'insensitive' } },
        { tester: { contains: search, mode: 'insensitive' } },
        { module: { contains: search, mode: 'insensitive' } },
        { steps: { contains: search, mode: 'insensitive' } },
        { actual: { contains: search, mode: 'insensitive' } },
        { expected: { contains: search, mode: 'insensitive' } },
        { notes: { contains: search, mode: 'insensitive' } },
      ];
    }
    const allowedSort = ['bug_id','date_found','tester','module','severity','status','created_at','updated_at'];
    const orderField = allowedSort.includes(sortBy) ? sortBy : 'created_at';
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);
    const [bugs, total] = await Promise.all([
      req.prisma.bugs.findMany({ where, include: bugInclude, orderBy: { [orderField]: sortDir === 'asc' ? 'asc' : 'desc' }, skip, take }),
      req.prisma.bugs.count({ where }),
    ]);
    res.json({ bugs: bugs.map(formatBug), total, page: parseInt(page), pages: Math.ceil(total / take) });
  } catch (err) { console.error('List bugs error:', err); res.status(500).json({ error: 'Failed to list bugs' }); }
});

// GET /api/bugs/stats
router.get('/stats', async (req, res) => {
  try {
    const all = await req.prisma.bugs.findMany({ select: { severity:true, status:true, module:true } });
    const bySeverity = {}, byStatus = {}, byModule = {};
    for (const b of all) {
      bySeverity[b.severity] = (bySeverity[b.severity] || 0) + 1;
      byStatus[b.status] = (byStatus[b.status] || 0) + 1;
      byModule[b.module] = byModule[b.module] || { total:0, open:0 };
      byModule[b.module].total++;
      if (b.status === 'Open' || b.status === 'In Progress') byModule[b.module].open++;
    }
    res.json({
      total: all.length, open: byStatus['Open']||0, inProgress: byStatus['In Progress']||0,
      fixed: byStatus['Fixed']||0, verified: byStatus['Verified']||0, closed: byStatus['Closed']||0,
      critical: all.filter(b => b.severity === 'Critical' && b.status !== 'Verified' && b.status !== 'Closed').length,
      bySeverity, byStatus, byModule,
    });
  } catch (err) { console.error('Bug stats error:', err); res.status(500).json({ error: 'Failed to get stats' }); }
});

// GET /api/bugs/export
router.get('/export', async (req, res) => {
  try {
    const bugs = await req.prisma.bugs.findMany({ include: bugInclude, orderBy: { created_at: 'desc' } });
    res.json({ bugs: bugs.map(formatBug) });
  } catch (err) { console.error('Export:', err); res.status(500).json({ error: 'Failed to export' }); }
});

// GET /api/bugs/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const bug = id.startsWith('BUG-')
      ? await req.prisma.bugs.findUnique({ where: { bug_id: id }, include: bugInclude })
      : await req.prisma.bugs.findUnique({ where: { id: parseInt(id) }, include: bugInclude });
    if (!bug) return res.status(404).json({ error: 'Bug not found' });
    res.json(formatBug(bug));
  } catch (err) { console.error('Get bug:', err); res.status(500).json({ error: 'Failed to get bug' }); }
});

// POST /api/bugs
router.post('/', async (req, res) => {
  try {
    const { dateFound, tester, module: mod, severity, testAccount, steps, expected, actual, screenshotUrl, consoleErrors, serverLogs, status, notes } = req.body;
    if (!tester || !mod || !steps || !actual) return res.status(400).json({ error: 'Required: tester, module, steps, actual' });
    const bugId = await getNextBugId(req.prisma);
    const bug = await req.prisma.bugs.create({
      data: {
        bug_id: bugId, date_found: dateFound ? new Date(dateFound) : new Date(),
        tester: tester.trim(), module: mod, severity: severity || 'Medium',
        test_account: testAccount || null, steps, expected: expected || null, actual,
        screenshot_url: screenshotUrl || null, console_errors: consoleErrors || null,
        server_logs: serverLogs || null, status: status || 'Open', notes: notes || null,
      },
      include: bugInclude,
    });
    console.log(`🐛 Bug ${bugId} created by ${tester} — [${severity}] ${mod}`);
    res.status(201).json(formatBug(bug));
  } catch (err) { console.error('Create bug:', err); res.status(500).json({ error: 'Failed to create bug' }); }
});

// PUT /api/bugs/:id
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { dateFound, tester, module: mod, severity, testAccount, steps, expected, actual, screenshotUrl, consoleErrors, serverLogs, status, notes } = req.body;
    let bug = id.startsWith('BUG-')
      ? await req.prisma.bugs.findUnique({ where: { bug_id: id } })
      : await req.prisma.bugs.findUnique({ where: { id: parseInt(id) } });
    if (!bug) return res.status(404).json({ error: 'Bug not found' });
    const data = {};
    if (dateFound !== undefined) data.date_found = new Date(dateFound);
    if (tester !== undefined) data.tester = tester.trim();
    if (mod !== undefined) data.module = mod;
    if (severity !== undefined) data.severity = severity;
    if (testAccount !== undefined) data.test_account = testAccount || null;
    if (steps !== undefined) data.steps = steps;
    if (expected !== undefined) data.expected = expected || null;
    if (actual !== undefined) data.actual = actual;
    if (screenshotUrl !== undefined) data.screenshot_url = screenshotUrl || null;
    if (consoleErrors !== undefined) data.console_errors = consoleErrors || null;
    if (serverLogs !== undefined) data.server_logs = serverLogs || null;
    if (status !== undefined) data.status = status;
    if (notes !== undefined) data.notes = notes || null;
    const updated = await req.prisma.bugs.update({ where: { id: bug.id }, data, include: bugInclude });
    console.log(`🐛 Bug ${bug.bug_id} updated — status: ${updated.status}`);
    res.json(formatBug(updated));
  } catch (err) { console.error('Update bug:', err); res.status(500).json({ error: 'Failed to update bug' }); }
});

// PATCH /api/bugs/:id/status
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status required' });
    const valid = ['Open','In Progress','Fixed','Verified','Closed',"Won't Fix"];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    let bug = id.startsWith('BUG-')
      ? await req.prisma.bugs.findUnique({ where: { bug_id: id } })
      : await req.prisma.bugs.findUnique({ where: { id: parseInt(id) } });
    if (!bug) return res.status(404).json({ error: 'Bug not found' });
    const updated = await req.prisma.bugs.update({ where: { id: bug.id }, data: { status }, include: bugInclude });
    console.log(`🐛 Bug ${bug.bug_id} → ${status}`);
    res.json(formatBug(updated));
  } catch (err) { console.error('Status update:', err); res.status(500).json({ error: 'Failed to update status' }); }
});

// DELETE /api/bugs/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let bug = id.startsWith('BUG-')
      ? await req.prisma.bugs.findUnique({ where: { bug_id: id }, include: { screenshots: true } })
      : await req.prisma.bugs.findUnique({ where: { id: parseInt(id) }, include: { screenshots: true } });
    if (!bug) return res.status(404).json({ error: 'Bug not found' });
    for (const s of bug.screenshots) {
      const fp = path.join(UPLOAD_DIR, s.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await req.prisma.bugs.delete({ where: { id: bug.id } });
    console.log(`🐛 Bug ${bug.bug_id} deleted (${bug.screenshots.length} files)`);
    res.json({ message: `${bug.bug_id} deleted` });
  } catch (err) { console.error('Delete bug:', err); res.status(500).json({ error: 'Failed to delete bug' }); }
});

// POST /api/bugs/:id/screenshots — Upload files
router.post('/:id/screenshots', upload.array('files', 20), async (req, res) => {
  try {
    const { id } = req.params;
    let bug = id.startsWith('BUG-')
      ? await req.prisma.bugs.findUnique({ where: { bug_id: id } })
      : await req.prisma.bugs.findUnique({ where: { id: parseInt(id) } });
    if (!bug) {
      (req.files || []).forEach(f => fs.existsSync(f.path) && fs.unlinkSync(f.path));
      return res.status(404).json({ error: 'Bug not found' });
    }
    const screenshots = [];
    for (const file of (req.files || [])) {
      const ss = await req.prisma.bug_screenshots.create({
        data: { bug_id: bug.bug_id, filename: file.filename, filepath: file.path, filesize: file.size, mimetype: file.mimetype },
      });
      screenshots.push({ id: ss.id, filename: ss.filename, url: `${UPLOAD_URL}/${ss.filename}`, filesize: ss.filesize, mimetype: ss.mimetype, uploadedAt: ss.uploaded_at });
    }
    console.log(`📸 ${screenshots.length} file(s) uploaded for ${bug.bug_id}`);
    res.json({ uploaded: screenshots.length, screenshots });
  } catch (err) { console.error('Upload:', err); res.status(500).json({ error: 'Failed to upload' }); }
});

// DELETE /api/bugs/:bugId/screenshots/:ssId
router.delete('/:bugId/screenshots/:ssId', async (req, res) => {
  try {
    const ss = await req.prisma.bug_screenshots.findUnique({ where: { id: parseInt(req.params.ssId) } });
    if (!ss) return res.status(404).json({ error: 'Screenshot not found' });
    const fp = path.join(UPLOAD_DIR, ss.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    await req.prisma.bug_screenshots.delete({ where: { id: ss.id } });
    console.log(`📸 Screenshot ${ss.id} deleted for ${ss.bug_id}`);
    res.json({ message: 'Screenshot deleted' });
  } catch (err) { console.error('Delete screenshot:', err); res.status(500).json({ error: 'Failed to delete screenshot' }); }
});

// Multer error handler
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large (max 10MB)' });
    if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: 'Too many files (max 20)' });
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message });
  next();
});

module.exports = router;
