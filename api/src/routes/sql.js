// ============================================================
// SQL CONSOLE — Admin SQL execution endpoint
// ============================================================
// HIGH RISK: arbitrary query execution against production DB.
// Restricted to superadmin role. All queries audited.
// Read-only by default; explicit toggle to allow writes.
// ============================================================

const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');

const FORBIDDEN = /\b(pg_terminate_backend|pg_cancel_backend|pg_read_server_files|pg_read_binary_file|pg_ls_dir|pg_stat_file|copy\s+.*\s+from\s+program|copy\s+.*\s+to\s+program|create\s+role|drop\s+role|alter\s+role|create\s+user|drop\s+user|alter\s+user|create\s+extension|reset\s+role)\b/i;
// Always-blocked destructive statements (regardless of readOnly toggle).
// Use targeted Prisma model methods or a dedicated migration for these.
const DESTRUCTIVE = /(^|[\s;(])\s*(delete\s+from|update\s+\w+\s+set|drop\s+(table|index|view|schema|sequence|function|trigger|materialized|database)|truncate(\s+table)?)\b/i;
const WRITE_KEYWORDS = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|comment|merge|vacuum|cluster|reindex)\b/i;
const STATEMENT_TIMEOUT_MS = 30000;
const DEFAULT_LIMIT = 1000;

const requireSuperadmin = (req, res, next) => {
  if (!req.admin || req.admin.role !== 'superadmin') {
    return res.status(403).json({ error: 'SQL console requires superadmin role' });
  }
  next();
};

const serialize = obj => JSON.parse(JSON.stringify(obj, (_k, v) => {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  return v;
}));

// ── POST /execute ──────────────────────────────────────────
router.post('/execute', adminAuth(), requireSuperadmin, async (req, res) => {
  const { sql, readOnly = true } = req.body || {};
  if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'sql required' });
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) return res.status(400).json({ error: 'sql empty' });
  if (FORBIDDEN.test(trimmed)) return res.status(400).json({ error: 'Query contains a forbidden keyword (filesystem/role/extension ops are blocked)' });
  if (DESTRUCTIVE.test(trimmed)) return res.status(400).json({ error: 'DELETE / UPDATE / DROP / TRUNCATE are disabled in the SQL Console. Use a Prisma model method or a migration for these operations.' });

  const isSelect = /^\s*(select|with|explain|show)\b/i.test(trimmed);
  const containsWrite = WRITE_KEYWORDS.test(trimmed);
  if (readOnly && containsWrite && !isSelect) {
    return res.status(400).json({ error: 'Read-only mode is on. Toggle "Allow writes" to run this statement.' });
  }

  // Auto-LIMIT bare SELECTs to prevent runaway dumps
  let final = trimmed;
  if (isSelect && !/\blimit\s+\d+/i.test(trimmed)) {
    final = trimmed + ` LIMIT ${DEFAULT_LIMIT}`;
  }

  const start = Date.now();
  let rows = [], rowCount = 0, columns = [], errMsg = null, affected = null;

  try {
    await req.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      if (readOnly) await tx.$executeRawUnsafe(`SET TRANSACTION READ ONLY`);
      if (isSelect) {
        const result = await tx.$queryRawUnsafe(final);
        rows = Array.isArray(result) ? result : [];
        rowCount = rows.length;
        if (rows.length) columns = Object.keys(rows[0]);
      } else {
        affected = await tx.$executeRawUnsafe(final);
        rowCount = Number(affected) || 0;
      }
    }, { timeout: STATEMENT_TIMEOUT_MS + 5000 });
  } catch (e) {
    errMsg = e.message || String(e);
  }

  const duration = Date.now() - start;
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || null;

  // Audit (best-effort; never block response on failure)
  try {
    await req.prisma.$executeRawUnsafe(
      `INSERT INTO sql_audit (admin_id, admin_username, sql, read_only, duration_ms, row_count, error, ip) VALUES ($1::int, $2, $3, $4::boolean, $5::int, $6::int, $7, $8)`,
      req.admin.id, req.admin.username, sql, !!readOnly, duration, rowCount || 0, errMsg, ip
    );
  } catch (_) {}

  if (errMsg) return res.status(400).json({ error: errMsg, duration_ms: duration });

  res.json({
    rows: serialize(rows),
    columns,
    rowCount,
    affected,
    duration_ms: duration,
    truncated: isSelect && rowCount === DEFAULT_LIMIT && !/\blimit\s+\d+/i.test(trimmed),
    final_sql: final !== trimmed ? final : undefined,
  });
});

// ── GET /schema — list tables ──────────────────────────────
router.get('/schema', adminAuth(), requireSuperadmin, async (req, res) => {
  try {
    const tables = await req.prisma.$queryRawUnsafe(`
      SELECT table_name AS name,
             (SELECT reltuples::bigint FROM pg_class WHERE relname = table_name) AS approx_rows
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    res.json({ tables: serialize(tables) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /schema/:table — list columns ──────────────────────
router.get('/schema/:table', adminAuth(), requireSuperadmin, async (req, res) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(req.params.table)) return res.status(400).json({ error: 'invalid table name' });
  try {
    const cols = await req.prisma.$queryRawUnsafe(
      `SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS dflt
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      req.params.table
    );
    res.json({ columns: serialize(cols) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /audit — recent query history ──────────────────────
router.get('/audit', adminAuth(), requireSuperadmin, async (req, res) => {
  try {
    const rows = await req.prisma.$queryRawUnsafe(`
      SELECT id, admin_username, LEFT(sql, 500) AS sql, read_only, duration_ms, row_count, error, ip, created_at
      FROM sql_audit
      ORDER BY id DESC
      LIMIT 100
    `);
    res.json({ audit: serialize(rows) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
