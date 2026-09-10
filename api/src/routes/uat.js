// ============================================================
// NETFACTORY — UAT / Data Management API Routes
// ============================================================
// Mount: app.use('/api/admin/uat', uatRoutes)
// All routes require admin authentication
// ============================================================

const express = require('express');
const router = express.Router();

// ── Auth middleware ──────────────────────────────────────────
function adminAuth() {
  return async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: 'No token provided' });
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, req.config.jwt.secret);
      if (decoded.type !== 'admin') return res.status(403).json({ error: 'Admin access required' });
      req.adminUser = decoded;
      req.admin = decoded;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

router.use(adminAuth());

// Helper: get row count for a table
async function tableCount(prisma, table) {
  try {
    const r = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS cnt FROM "${table}"`);
    return r[0]?.cnt || 0;
  } catch { return 0; }
}

// Helper: truncate tables with CASCADE
async function truncateTables(prisma, tables) {
  const results = {};
  for (const t of tables) {
    try {
      const before = await tableCount(prisma, t);
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${t}" CASCADE`);
      results[t] = before;
    } catch (err) {
      results[t] = 'error: ' + err.message;
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────
// GET /api/admin/uat/stats — Record counts for all affected tables
// ─────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const p = req.prisma;

    // Customer data tables
    const customer = {};
    for (const t of [
      'subscribers', 'subscriber_auth', 'subscriber_notification_prefs',
      'subscriber_radius', 'subscriber_credits', 'invoices', 'payments',
      'tickets', 'ticket_updates', 'notifications', 'usage_data', 'surveys', 'onu_inventory',
      'radcheck', 'radreply', 'radusergroup', 'radacct', 'radpostauth',
      'accounts_receivable', 'ar_payments', 'audit_log', 'audit_logs',
      'accounting_audit_log', 'deposit_items', 'deposits', 'expenses',
      'fund_transactions', 'fund_transfers', 'journal_entries',
      'journal_entry_lines', 'accounts_payable', 'ap_payments'
    ]) {
      customer[t] = await tableCount(p, t);
    }

    // GIS tables
    const gis = {};
    for (const t of [
      'foc_routes', 'foc_strands', 'closures', 'closure_connections',
      'closure_splices', 'naps', 'nap_ports', 'nap_attachments',
      'network_nodes', 'network_elements', 'network_links', 'fiber_routes'
    ]) {
      gis[t] = await tableCount(p, t);
    }

    // Plans tables
    const plans = {};
    for (const t of ['plans', 'plan_features', 'plan_notes', 'radgroupreply', 'radgroupcheck']) {
      plans[t] = await tableCount(p, t);
    }

    // Sum totals
    const sumObj = (o) => Object.values(o).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);

    res.json({
      customer,
      customerTotal: sumObj(customer),
      gis,
      gisTotal: sumObj(gis),
      plans,
      plansTotal: sumObj(plans),
    });
  } catch (err) {
    console.error('UAT stats error:', err);
    res.status(500).json({ error: 'Failed to get stats: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/admin/uat/customer-data — UAT Mode: clear all customer data
// ─────────────────────────────────────────────────────────────
router.delete('/customer-data', async (req, res) => {
  try {
    const { confirmation } = req.body;
    if (confirmation !== 'CONFIRM') return res.status(400).json({ error: 'Type CONFIRM to proceed' });

    // Log BEFORE deletion
    if (req.auditLog) await req.auditLog('UAT_CLEAR_CUSTOMER_DATA', { action: 'initiated' }).catch(() => {});

    const WEB_INQUIRY_ACCOUNT = '00000000';
    const p = req.prisma;

    // Get web inquiry subscriber ID to preserve its linked records
    const webInqRows = await p.$queryRawUnsafe("SELECT id FROM subscribers WHERE account_number = $1", WEB_INQUIRY_ACCOUNT);
    const webInqId = webInqRows.length > 0 ? webInqRows[0].id : null;

    // Tables that can be fully truncated (no subscriber FK link)
    const fullTruncate = [
      'radcheck', 'radreply', 'radusergroup', 'radacct', 'radpostauth',
      'ar_payments', 'deposit_items', 'ap_payments', 'journal_entry_lines',
      'accounts_receivable', 'accounts_payable', 'deposits', 'expenses',
      'fund_transactions', 'fund_transfers', 'journal_entries',
      'accounting_audit_log', 'audit_log', 'audit_logs', 'notifications',
    ];
    const results = await truncateTables(p, fullTruncate);

    // Tables with subscriber_id FK — delete all except web inquiry account's records
    // Order: children first to respect FK constraints
    const subLinked = [
      'ticket_updates', 'subscriber_auth', 'subscriber_notification_prefs',
      'subscriber_credits', 'subscriber_radius', 'usage_data',
      'payments', 'invoices', 'tickets', 'surveys', 'onu_inventory',
    ];
    for (const t of subLinked) {
      try {
        let q;
        if (t === 'ticket_updates') {
          // ticket_updates links via ticket_id, not subscriber_id
          if (webInqId) {
            q = await p.$executeRawUnsafe("DELETE FROM ticket_updates WHERE ticket_id IN (SELECT id FROM tickets WHERE subscriber_id != $1)", webInqId);
          } else {
            q = await p.$executeRawUnsafe("DELETE FROM ticket_updates");
          }
        } else if (t === 'payments') {
          if (webInqId) {
            q = await p.$executeRawUnsafe("DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE subscriber_id != $1)", webInqId);
          } else {
            q = await p.$executeRawUnsafe("DELETE FROM payments");
          }
        } else {
          if (webInqId) {
            q = await p.$executeRawUnsafe(`DELETE FROM "${t}" WHERE subscriber_id != $1`, webInqId);
          } else {
            q = await p.$executeRawUnsafe(`DELETE FROM "${t}"`);
          }
        }
        results[t] = 'cleared';
      } catch (err) {
        results[t] = 'error: ' + err.message;
      }
    }

    // Delete subscribers except web inquiry account
    try {
      const delSub = await p.$queryRawUnsafe("DELETE FROM subscribers WHERE account_number != $1 RETURNING id", WEB_INQUIRY_ACCOUNT);
      results['subscribers'] = delSub.length;
    } catch (err) {
      results['subscribers'] = 'error: ' + err.message;
    }

    // Ensure web inquiry account exists — recreate if missing
    const webCheck = await p.$queryRawUnsafe("SELECT id FROM subscribers WHERE account_number = $1", WEB_INQUIRY_ACCOUNT);
    if (webCheck.length === 0) {
      await p.$executeRawUnsafe(
        "INSERT INTO subscribers (account_number, first_name, last_name, phone, address, status) VALUES ($1, $2, $3, $4, $5, $6)",
        WEB_INQUIRY_ACCOUNT, 'Web', 'Inquiry', '0000000000', 'System Account', 'active'
      );
      results['_webInquiryRecreated'] = true;
    }

    // Reset sequences
    try {
      const maxId = await p.$queryRawUnsafe("SELECT COALESCE(MAX(id), 0) + 1 AS next FROM subscribers");
      await p.$executeRawUnsafe("SELECT setval(pg_get_serial_sequence('subscribers', 'id'), $1, false)", maxId[0].next);
      await p.$executeRawUnsafe("SELECT setval(pg_get_serial_sequence('invoices', 'id'), 1, false)");
      await p.$executeRawUnsafe("SELECT setval(pg_get_serial_sequence('tickets', 'id'), 1, false)");
    } catch {}

    const total = Object.values(results).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
    const tableCount = fullTruncate.length + subLinked.length + 1;
    res.json({ success: true, message: 'Cleared ' + total + ' customer records across ' + tableCount + ' tables', results });
  } catch (err) {
    console.error('UAT clear customer data error:', err);
    res.status(500).json({ error: 'Failed to clear customer data: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/admin/uat/gis-data — Clear all GIS/network infrastructure
// ─────────────────────────────────────────────────────────────
router.delete('/gis-data', async (req, res) => {
  try {
    const { confirmation } = req.body;
    if (confirmation !== 'CONFIRM') return res.status(400).json({ error: 'Type CONFIRM to proceed' });

    if (req.auditLog) await req.auditLog('UAT_CLEAR_GIS_DATA', { action: 'initiated' }).catch(() => {});

    // Order matters: children first
    const tables = [
      'closure_splices', 'closure_connections', 'nap_attachments', 'nap_ports',
      'naps', 'closures', 'foc_strands', 'foc_routes',
      'fiber_routes', 'network_nodes', 'network_elements', 'network_links',
    ];

    const results = await truncateTables(req.prisma, tables);
    const total = Object.values(results).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
    res.json({ success: true, message: 'Cleared ' + total + ' GIS records across ' + tables.length + ' tables', results });
  } catch (err) {
    console.error('UAT clear GIS data error:', err);
    res.status(500).json({ error: 'Failed to clear GIS data: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/admin/uat/plans — Clear all plans and RADIUS group mappings
// ─────────────────────────────────────────────────────────────
router.delete('/plans', async (req, res) => {
  try {
    const { confirmation } = req.body;
    if (confirmation !== 'CONFIRM') return res.status(400).json({ error: 'Type CONFIRM to proceed' });

    if (req.auditLog) await req.auditLog('UAT_CLEAR_PLANS', { action: 'initiated' }).catch(() => {});

    const tables = ['plan_features', 'plan_notes', 'radgroupreply', 'radgroupcheck', 'plans'];
    const results = await truncateTables(req.prisma, tables);
    const total = Object.values(results).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
    res.json({ success: true, message: 'Cleared ' + total + ' plan records across ' + tables.length + ' tables', results });
  } catch (err) {
    console.error('UAT clear plans error:', err);
    res.status(500).json({ error: 'Failed to clear plans: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/admin/uat/cleanup — Run system cleanup script
// ─────────────────────────────────────────────────────────────
router.post('/cleanup', async (req, res) => {
  try {
    const adminUser = await req.prisma.admin_users.findUnique({ where: { id: req.admin.id } });
    if (!adminUser || adminUser.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only Super Administrators can run system cleanup' });
    }

    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    if (req.auditLog) await req.auditLog('UAT_SYSTEM_CLEANUP', { action: 'initiated' }).catch(() => {});

    const { stdout, stderr } = await execAsync('/home/ashraf/scripts/cleanup.sh', { timeout: 60000 });

    // Extract total freed from output
    const freedMatch = stdout.match(/Total freed:\s*\x1b\[0;36m([\d.]+[BKMG]+)/);
    const freed = freedMatch ? freedMatch[1] : 'unknown';

    // Count removed items
    const removedCount = (stdout.match(/\[CLEAN\]/g) || []).length;

    res.json({
      success: true,
      message: 'System cleanup complete — ' + removedCount + ' items removed, ' + freed + ' freed',
      removed: removedCount,
      freed: freed,
      output: stdout.replace(/\x1b\[[0-9;]*m/g, '') // strip ANSI colors
    });
  } catch (err) {
    console.error('Cleanup error:', err);
    res.status(500).json({ error: 'Cleanup failed: ' + err.message });
  }
});

module.exports = router;
