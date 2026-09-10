// ============================================================
// NETFACTORY — Audit Trail API Routes
// ============================================================
// Deploy to: src/routes/auditRoutes.js
// Mount in server.js: app.use('/api/audit', auditRoutes);
//
// All endpoints require admin authentication.
// ============================================================

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Archive directory for log files
const ARCHIVE_DIR = process.env.AUDIT_ARCHIVE_DIR || path.join(__dirname, '..', '..', 'audit-archive');

// ── Admin Auth Middleware (reuse your existing pattern) ───────
// This should match your existing admin auth check.
// Adjust if your auth middleware has a different name/path.
const adminAuth = require('../middleware/adminAuth');
router.use(adminAuth());


// ============================================================
// GET /api/audit/logs — List logs with filters & pagination
// ============================================================
router.get('/logs', async (req, res) => {
  try {
    const {
      source,       // 'portal' or 'crm'
      action,       // action code filter
      user_id,      // specific user
      search,       // full-text search
      date_from,    // ISO date start
      date_to,      // ISO date end
      ip,           // IP address filter
      page = 1,
      limit = 50,
      sort = 'created_at',
      order = 'desc',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    // ── Build WHERE conditions ───────────────────────────────
    const where = {};

    if (source && ['portal', 'crm'].includes(source)) {
      where.log_source = source;
    }

    if (action) {
      where.action = action.toUpperCase();
    }

    if (user_id) {
      where.user_id = parseInt(user_id);
    }

    if (ip) {
      where.OR = [
        { public_ip: { contains: ip } },
        { local_ip: { contains: ip } },
      ];
    }

    // Date range filter
    if (date_from || date_to) {
      where.created_at = {};
      if (date_from) where.created_at.gte = new Date(date_from);
      if (date_to) {
        // End of day for date_to
        const endDate = new Date(date_to);
        endDate.setHours(23, 59, 59, 999);
        where.created_at.lte = endDate;
      }
    }

    // ── Full-text search (across multiple fields + JSONB) ────
    // For JSONB search we need raw SQL; for simple fields use Prisma
    let logs, total;

    if (search && search.trim()) {
      const searchTerm = `%${search.trim()}%`;

      // Build raw SQL for comprehensive search including JSONB
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      // Base conditions from filters
      if (source) {
        conditions.push(`log_source = $${paramIdx++}`);
        params.push(source);
      }
      if (action) {
        conditions.push(`action = $${paramIdx++}`);
        params.push(action.toUpperCase());
      }
      if (user_id) {
        conditions.push(`user_id = $${paramIdx++}`);
        params.push(parseInt(user_id));
      }
      if (date_from) {
        conditions.push(`created_at >= $${paramIdx++}`);
        params.push(new Date(date_from));
      }
      if (date_to) {
        const endDate = new Date(date_to);
        endDate.setHours(23, 59, 59, 999);
        conditions.push(`created_at <= $${paramIdx++}`);
        params.push(endDate);
      }
      if (ip) {
        conditions.push(`(public_ip ILIKE $${paramIdx} OR local_ip ILIKE $${paramIdx})`);
        params.push(`%${ip}%`);
        paramIdx++;
      }

      // Search condition across text fields + JSONB
      const searchParam = `$${paramIdx}`;
      params.push(searchTerm);
      paramIdx++;

      conditions.push(`(
        username ILIKE ${searchParam}
        OR action ILIKE ${searchParam}
        OR public_ip ILIKE ${searchParam}
        OR local_ip ILIKE ${searchParam}
        OR user_agent ILIKE ${searchParam}
        OR details::text ILIKE ${searchParam}
      )`);

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Validate sort column to prevent SQL injection
      const allowedSorts = ['created_at', 'action', 'username', 'log_source', 'public_ip'];
      const sortCol = allowedSorts.includes(sort) ? sort : 'created_at';
      const sortDir = order === 'asc' ? 'ASC' : 'DESC';

      // Count total
      const countResult = await req.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS total FROM audit_logs ${whereClause}`,
        ...params
      );
      total = countResult[0]?.total || 0;

      // Fetch page
      logs = await req.prisma.$queryRawUnsafe(
        `SELECT * FROM audit_logs ${whereClause}
         ORDER BY ${sortCol} ${sortDir}
         LIMIT ${limitNum} OFFSET ${offset}`,
        ...params
      );

    } else {
      // ── Standard Prisma query (no full-text search) ────────
      const allowedSorts = ['created_at', 'action', 'username', 'log_source', 'public_ip'];
      const sortCol = allowedSorts.includes(sort) ? sort : 'created_at';
      const sortDir = order === 'asc' ? 'asc' : 'desc';

      [logs, total] = await Promise.all([
        req.prisma.auditLog.findMany({
          where,
          orderBy: { [sortCol]: sortDir },
          skip: offset,
          take: limitNum,
        }),
        req.prisma.auditLog.count({ where }),
      ]);
    }

    res.json({
      success: true,
      data: logs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });

  } catch (err) {
    console.error('[AUDIT] Error fetching logs:', err);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});


// ============================================================
// GET /api/audit/logs/:id — Single log entry detail
// ============================================================
router.get('/logs/:id', async (req, res) => {
  try {
    const log = await req.prisma.auditLog.findUnique({
      where: { id: parseInt(req.params.id) },
    });

    if (!log) {
      return res.status(404).json({ error: 'Audit log entry not found' });
    }

    res.json({ success: true, data: log });

  } catch (err) {
    console.error('[AUDIT] Error fetching log detail:', err);
    res.status(500).json({ error: 'Failed to fetch audit log detail' });
  }
});


// ============================================================
// GET /api/audit/stats — Dashboard summary
// ============================================================
router.get('/stats', async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      totalToday,
      loginsToday,
      failedLogins24h,
      portalToday,
      crmToday,
      recentActions,
      topUsers,
    ] = await Promise.all([
      // Total events today
      req.prisma.auditLog.count({
        where: { created_at: { gte: todayStart } },
      }),

      // Logins today
      req.prisma.auditLog.count({
        where: {
          action: 'LOGIN',
          created_at: { gte: todayStart },
        },
      }),

      // Failed logins in last 24 hours
      req.prisma.auditLog.count({
        where: {
          action: 'LOGIN_FAILED',
          created_at: { gte: last24h },
        },
      }),

      // Portal events today
      req.prisma.auditLog.count({
        where: {
          log_source: 'portal',
          created_at: { gte: todayStart },
        },
      }),

      // CRM events today
      req.prisma.auditLog.count({
        where: {
          log_source: 'crm',
          created_at: { gte: todayStart },
        },
      }),

      // Recent action breakdown (last 7 days)
      req.prisma.$queryRaw`
        SELECT action, COUNT(*)::int AS count
        FROM audit_logs
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY action
        ORDER BY count DESC
        LIMIT 10
      `,

      // Top active users (last 7 days)
      req.prisma.$queryRaw`
        SELECT username, log_source, COUNT(*)::int AS count
        FROM audit_logs
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY username, log_source
        ORDER BY count DESC
        LIMIT 10
      `,
    ]);

    res.json({
      success: true,
      data: {
        today: {
          total: totalToday,
          logins: loginsToday,
          failed_logins_24h: failedLogins24h,
          portal: portalToday,
          crm: crmToday,
        },
        recent_actions: recentActions,
        top_users: topUsers,
      },
    });

  } catch (err) {
    console.error('[AUDIT] Error fetching stats:', err);
    res.status(500).json({ error: 'Failed to fetch audit stats' });
  }
});


// ============================================================
// GET /api/audit/export — CSV export with current filters
// ============================================================
router.get('/export', async (req, res) => {
  try {
    const { source, action, user_id, search, date_from, date_to, ip } = req.query;

    // Build where conditions (same logic as /logs)
    const where = {};
    if (source && ['portal', 'crm'].includes(source)) where.log_source = source;
    if (action) where.action = action.toUpperCase();
    if (user_id) where.user_id = parseInt(user_id);
    if (ip) {
      where.OR = [
        { public_ip: { contains: ip } },
        { local_ip: { contains: ip } },
      ];
    }
    if (date_from || date_to) {
      where.created_at = {};
      if (date_from) where.created_at.gte = new Date(date_from);
      if (date_to) {
        const endDate = new Date(date_to);
        endDate.setHours(23, 59, 59, 999);
        where.created_at.lte = endDate;
      }
    }

    // Limit export to 50,000 rows max
    const logs = await req.prisma.auditLog.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 50000,
    });

    // Build CSV
    const headers = ['ID', 'TIMESTAMP', 'SOURCE', 'USER_ID', 'USERNAME', 'ACTION', 'DETAILS', 'PUBLIC_IP', 'LOCAL_IP', 'USER_AGENT'];
    const rows = logs.map(log => [
      log.id,
      new Date(log.created_at).toISOString(),
      log.log_source,
      log.user_id || '',
      `"${(log.username || '').replace(/"/g, '""')}"`,
      log.action,
      `"${JSON.stringify(log.details || {}).replace(/"/g, '""')}"`,
      log.public_ip || '',
      log.local_ip || '',
      `"${(log.user_agent || '').replace(/"/g, '""')}"`,
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

    // Generate filename
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit_export_${yy}${mm}${dd}_${hh}${mi}.csv"`);
    res.send(csv);

    // Log the export action itself
    await req.auditLog('AUDIT_EXPORT', {
      filters: { source, action, user_id, date_from, date_to, ip },
      rows_exported: logs.length,
    });

  } catch (err) {
    console.error('[AUDIT] Error exporting logs:', err);
    res.status(500).json({ error: 'Failed to export audit logs' });
  }
});


// ============================================================
// GET /api/audit/actions — List distinct action codes
// ============================================================
router.get('/actions', async (req, res) => {
  try {
    const actions = await req.prisma.$queryRaw`
      SELECT DISTINCT action, log_source, COUNT(*)::int AS count
      FROM audit_logs
      GROUP BY action, log_source
      ORDER BY action ASC
    `;

    res.json({ success: true, data: actions });

  } catch (err) {
    console.error('[AUDIT] Error fetching actions:', err);
    res.status(500).json({ error: 'Failed to fetch action codes' });
  }
});


// ============================================================
// GET /api/audit/user-timeline/:userId — Timeline for a user
// ============================================================
router.get('/user-timeline/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { days = 30 } = req.query;
    const daysNum = Math.min(90, Math.max(1, parseInt(days)));

    const since = new Date();
    since.setDate(since.getDate() - daysNum);

    const timeline = await req.prisma.auditLog.findMany({
      where: {
        user_id: userId,
        created_at: { gte: since },
      },
      orderBy: { created_at: 'desc' },
      take: 500,
    });

    res.json({
      success: true,
      data: timeline,
      meta: { user_id: userId, days: daysNum, count: timeline.length },
    });

  } catch (err) {
    console.error('[AUDIT] Error fetching user timeline:', err);
    res.status(500).json({ error: 'Failed to fetch user timeline' });
  }
});


// ============================================================
// GET /api/audit/files — List archived log files
// ============================================================
router.get('/files', async (req, res) => {
  try {
    if (!fs.existsSync(ARCHIVE_DIR)) {
      return res.json({ success: true, data: [] });
    }

    const files = fs.readdirSync(ARCHIVE_DIR)
      .filter(f => f.startsWith('log'))
      .map(filename => {
        const filepath = path.join(ARCHIVE_DIR, filename);
        const stats = fs.statSync(filepath);
        return {
          filename,
          size: stats.size,
          size_mb: (stats.size / (1024 * 1024)).toFixed(2),
          created: stats.birthtime,
          modified: stats.mtime,
        };
      })
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));

    res.json({ success: true, data: files });

  } catch (err) {
    console.error('[AUDIT] Error listing files:', err);
    res.status(500).json({ error: 'Failed to list archive files' });
  }
});


// ============================================================
// GET /api/audit/files/:name — Download a specific archive file
// ============================================================
router.get('/files/:name', async (req, res) => {
  try {
    const filename = req.params.name;

    // Sanitize: only allow alphanumeric + dot + dash + underscore
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const filepath = path.join(ARCHIVE_DIR, filename);

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Log the download
    await req.auditLog('AUDIT_FILE_DOWNLOAD', { filename });

    res.download(filepath);

  } catch (err) {
    console.error('[AUDIT] Error downloading file:', err);
    res.status(500).json({ error: 'Failed to download file' });
  }
});


module.exports = router;
