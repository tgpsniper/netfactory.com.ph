// ============================================================
// NETFACTORY & DATA SOLUTION — RADIUS API Routes
// ============================================================
// Mount: app.use('/api/admin/radius', radiusRoutes)
// All routes require admin authentication
// ============================================================

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const radiusDb = require('../config/radius-db');
const restriction = require('../utils/restriction');
const mikrotik = require('../utils/mikrotik');
const deviceRelease = require('../utils/device-release');

// ── Auth middleware (reuse existing adminAuth) ──────────────
function adminAuth() {
  return async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: 'No token provided' });
      
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, req.config.jwt.secret);
      if (decoded.type !== 'admin') return res.status(403).json({ error: 'Admin access required' });
      
      req.adminUser = decoded;
      req.admin = decoded;  // For audit logger middleware compatibility
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

// Apply auth to all routes
router.use(adminAuth());


// ─────────────────────────────────────────────────────────────
// RADIUS SERVICE STATUS
// ─────────────────────────────────────────────────────────────

// GET /api/admin/radius/status
// Returns: connection status, plan groups, subscriber counts
router.get('/status', async (req, res) => {
  try {
    const [[dbTest]] = await radiusDb.query("SELECT 1 AS ok");
    const dbStatus = { connected: dbTest && dbTest.ok === 1 };
    
    if (!dbStatus.connected) {
      return res.json({
        connected: false,
        error: dbStatus.error,
        freeradius: 'unknown',
      });
    }

    // Get counts
    const [users] = await radiusDb.query(
      'SELECT COUNT(DISTINCT username) AS total FROM radcheck'
    );
    const [enabled] = await radiusDb.query(
      'SELECT COUNT(*) AS total FROM subscriber_radius WHERE enabled = true'
    );
    const [disabled] = await radiusDb.query(
      'SELECT COUNT(*) AS total FROM subscriber_radius WHERE enabled = false'
    );
    const [activeSessions] = await radiusDb.query(
      'SELECT COUNT(*) AS total FROM radacct WHERE acctstoptime IS NULL'
    );
    const [groups] = await radiusDb.query(
      `SELECT groupname, 
              MAX(CASE WHEN attribute='Mikrotik-Rate-Limit' THEN value END) AS rate_limit
       FROM radgroupreply GROUP BY groupname ORDER BY groupname`
    );
    const [authToday] = await radiusDb.query(
      `SELECT 
        SUM(CASE WHEN reply='Access-Accept' THEN 1 ELSE 0 END) AS accepts,
        SUM(CASE WHEN reply='Access-Reject' THEN 1 ELSE 0 END) AS rejects
       FROM radpostauth WHERE authdate >= CURRENT_DATE`
    );

    res.json({
      connected: true,
      database: dbStatus,
      stats: {
        totalRadiusUsers: users[0].total,
        enabledUsers: enabled[0].total,
        disabledUsers: disabled[0].total,
        activeSessions: activeSessions[0].total,
        authToday: {
          accepts: authToday[0]?.accepts || 0,
          rejects: authToday[0]?.rejects || 0,
        },
      },
      planGroups: groups,
    });
  } catch (err) {
    console.error('RADIUS status error:', err);
    res.status(500).json({ error: 'Failed to get RADIUS status', details: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// SUBSCRIBER PROVISIONING
// ─────────────────────────────────────────────────────────────

// POST /api/admin/radius/provision
// Body: { subscriberId, username, password, planGroup, staticIp?, macBinding? }
// Creates RADIUS credentials for a CRM subscriber
router.post('/provision', async (req, res) => {
  try {
    const { subscriberId, username, password, planGroup, staticIp, macBinding } = req.body;

    if (!subscriberId || !username || !password || !planGroup) {
      return res.status(400).json({ 
        error: 'Required: subscriberId, username, password, planGroup' 
      });
    }

    // Validate plan group exists
    const [groupExists] = await radiusDb.query(
      'SELECT COUNT(*) AS cnt FROM radgroupreply WHERE groupname = ?',
      [planGroup]
    );
    if (groupExists[0].cnt === 0) {
      return res.status(400).json({ error: `Plan group '${planGroup}' does not exist` });
    }

    // Check username not already taken
    const [existing] = await radiusDb.query(
      'SELECT id FROM subscriber_radius WHERE radius_username = ?',
      [username]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: `Username '${username}' already exists in RADIUS` });
    }

    // Check subscriber not already provisioned
    const [existingSub] = await radiusDb.query(
      'SELECT id FROM subscriber_radius WHERE subscriber_id = ?',
      [subscriberId]
    );
    if (existingSub.length > 0) {
      return res.status(409).json({ error: 'Subscriber already has RADIUS credentials' });
    }

    await radiusDb.transaction(async (conn) => {
      // 1. Insert into radcheck (Cleartext-Password for PAP/CHAP)
      await conn.query(
        "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)",
        [username, password]
      );

      // 2. Assign to plan group
      await conn.query(
        'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)',
        [username, planGroup]
      );

      // 3. Add static IP if provided
      if (staticIp) {
        await conn.query(
          "INSERT INTO radreply (username, attribute, op, value) VALUES (?, 'Framed-IP-Address', ':=', ?)",
          [username, staticIp]
        );
      }

      // 4. Add MAC binding if provided
      if (macBinding) {
        await conn.query(
          "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Calling-Station-Id', '==', ?)",
          [username, macBinding.toUpperCase()]
        );
      }

      // 5. Insert bridge record
      await conn.query(
        `INSERT INTO subscriber_radius 
         (subscriber_id, radius_username, radius_group, radius_password, enabled, static_ip, mac_binding)
         VALUES (?, ?, ?, ?, true, ?, ?)`,
        [subscriberId, username, planGroup, password, staticIp || null, macBinding || null]
      );
    });

    res.json({
      success: true,
      message: `RADIUS provisioned: ${username} → ${planGroup}`,
      data: { subscriberId, username, planGroup, staticIp, macBinding },
    });

  } catch (err) {
    console.error('RADIUS provision error:', err);
    res.status(500).json({ error: 'Failed to provision RADIUS', details: err.message });
  }
});


// GET /api/admin/radius/subscriber/:subscriberId
// Returns RADIUS info for a CRM subscriber
router.get('/subscriber/:subscriberId', async (req, res) => {
  try {
    const { subscriberId } = req.params;

    // Get bridge record
    const [bridge] = await radiusDb.query(
      'SELECT * FROM subscriber_radius WHERE subscriber_id = ?',
      [subscriberId]
    );

    if (bridge.length === 0) {
      return res.json({ provisioned: false });
    }

    const sr = bridge[0];

    // Get active session
    const [sessions] = await radiusDb.query(
      `SELECT acctsessionid, nasipaddress, framedipaddress, acctstarttime,
              acctinputoctets, acctoutputoctets, acctsessiontime
       FROM radacct 
       WHERE username = ? AND acctstoptime IS NULL
       ORDER BY acctstarttime DESC`,
      [sr.radius_username]
    );

    // Get radcheck attributes
    const [checks] = await radiusDb.query(
      'SELECT attribute, op, value FROM radcheck WHERE username = ?',
      [sr.radius_username]
    );

    // Get radreply attributes
    const [replies] = await radiusDb.query(
      'SELECT attribute, op, value FROM radreply WHERE username = ?',
      [sr.radius_username]
    );

    // Get group info with rate limit
    const [groupInfo] = await radiusDb.query(
      `SELECT attribute, value FROM radgroupreply WHERE groupname = ?`,
      [sr.radius_group]
    );

    // Recent auth attempts (last 10)
    const [authLog] = await radiusDb.query(
      'SELECT reply, authdate FROM radpostauth WHERE username = ? ORDER BY id DESC LIMIT 10',
      [sr.radius_username]
    );

    res.json({
      provisioned: true,
      radius: {
        username: sr.radius_username,
        password: sr.radius_password,
        group: sr.radius_group,
        enabled: sr.enabled === true,
        staticIp: sr.static_ip,
        macBinding: sr.mac_binding,
        disabledReason: sr.suspended_reason,
        lastAuthAt: sr.last_auth_at,
        createdAt: sr.created_at,
      },
      session: sessions.length > 0 ? {
        active: true,
        sessionId: sessions[0].acctsessionid,
        nasIp: sessions[0].nasipaddress,
        framedIp: sessions[0].framedipaddress,
        startTime: sessions[0].acctstarttime,
        uploadBytes: sessions[0].acctinputoctets,
        downloadBytes: sessions[0].acctoutputoctets,
        sessionTime: sessions[0].acctsessiontime,
      } : { active: false },
      attributes: { check: checks, reply: replies },
      groupAttributes: groupInfo,
      recentAuth: authLog,
    });

  } catch (err) {
    console.error('RADIUS subscriber lookup error:', err);
    res.status(500).json({ error: 'Failed to get RADIUS info', details: err.message });
  }
});


// PUT /api/admin/radius/subscriber/:subscriberId/plan
// Body: { planGroup }
// Changes subscriber's RADIUS plan (updates radusergroup + bridge)
router.put('/subscriber/:subscriberId/plan', async (req, res) => {
  try {
    const { subscriberId } = req.params;
    const { planGroup } = req.body;

    if (!planGroup) return res.status(400).json({ error: 'planGroup required' });

    // Validate plan group
    const [groupExists] = await radiusDb.query(
      'SELECT COUNT(*) AS cnt FROM radgroupreply WHERE groupname = ?',
      [planGroup]
    );
    if (groupExists[0].cnt === 0) {
      return res.status(400).json({ error: `Plan group '${planGroup}' does not exist` });
    }

    // Get bridge record
    const [bridge] = await radiusDb.query(
      'SELECT * FROM subscriber_radius WHERE subscriber_id = ?',
      [subscriberId]
    );
    if (bridge.length === 0) {
      return res.status(404).json({ error: 'Subscriber not provisioned in RADIUS' });
    }

    const sr = bridge[0];
    const oldGroup = sr.radius_group;

    await radiusDb.transaction(async (conn) => {
      // Update radusergroup
      await conn.query(
        'UPDATE radusergroup SET groupname = ? WHERE username = ?',
        [planGroup, sr.radius_username]
      );

      // Update bridge
      await conn.query(
        'UPDATE subscriber_radius SET radius_group = ? WHERE subscriber_id = ?',
        [planGroup, subscriberId]
      );
    });

    res.json({
      success: true,
      message: `Plan changed: ${oldGroup} → ${planGroup}`,
      data: { subscriberId, username: sr.radius_username, oldGroup, newGroup: planGroup },
      coaRequired: true,
      coaHint: 'Send CoA disconnect to apply new rate limit immediately',
    });

  } catch (err) {
    console.error('RADIUS plan change error:', err);
    res.status(500).json({ error: 'Failed to change plan', details: err.message });
  }
});


// PUT /api/admin/radius/subscriber/:subscriberId/suspend
// Body: { reason? }
// Suspends subscriber — moves to plan-suspended group
router.put('/subscriber/:subscriberId/suspend', async (req, res) => {
  try {
    const { subscriberId } = req.params;
    const { reason } = req.body;

    const [bridge] = await radiusDb.query(
      'SELECT * FROM subscriber_radius WHERE subscriber_id = ?',
      [subscriberId]
    );
    if (bridge.length === 0) {
      return res.status(404).json({ error: 'Subscriber not provisioned in RADIUS' });
    }

    const sr = bridge[0];
    if (!sr.enabled) {
      return res.json({ success: true, message: 'Already suspended' });
    }

    const previousGroup = sr.radius_group;

    await radiusDb.transaction(async (conn) => {
      // Move to suspended group
      await conn.query(
        'UPDATE radusergroup SET groupname = ? WHERE username = ?',
        ['plan-suspended', sr.radius_username]
      );

      // Update bridge
      await conn.query(
        `UPDATE subscriber_radius 
         SET enabled = false, radius_group = 'plan-suspended', 
             suspended_reason = ?
         WHERE subscriber_id = ?`,
        [reason || `Suspended. Previous plan: ${previousGroup}`, subscriberId]
      );
    });

    res.json({
      success: true,
      message: `Suspended: ${sr.radius_username}`,
      data: { subscriberId, username: sr.radius_username, previousGroup },
      coaRequired: true,
    });

  } catch (err) {
    console.error('RADIUS suspend error:', err);
    res.status(500).json({ error: 'Failed to suspend', details: err.message });
  }
});


// PUT /api/admin/radius/subscriber/:subscriberId/reactivate
// Body: { planGroup? } — optional, defaults to plan stored in suspended_reason
router.put('/subscriber/:subscriberId/reactivate', async (req, res) => {
  try {
    const { subscriberId } = req.params;
    let { planGroup } = req.body;

    const [bridge] = await radiusDb.query(
      'SELECT * FROM subscriber_radius WHERE subscriber_id = ?',
      [subscriberId]
    );
    if (bridge.length === 0) {
      return res.status(404).json({ error: 'Subscriber not provisioned in RADIUS' });
    }

    const sr = bridge[0];
    if (sr.enabled) {
      return res.json({ success: true, message: 'Already active' });
    }

    // Try to recover previous plan from suspended_reason
    if (!planGroup && sr.suspended_reason) {
      const match = sr.suspended_reason.match(/Previous plan: (plan-\w+)/);
      if (match) planGroup = match[1];
    }
    if (!planGroup) planGroup = sr.radius_group || 'radsys'; // fallback

    await radiusDb.transaction(async (conn) => {
      await conn.query(
        'UPDATE radusergroup SET groupname = ? WHERE username = ?',
        [planGroup, sr.radius_username]
      );

      await conn.query(
        `UPDATE subscriber_radius 
         SET enabled = true, radius_group = ?, suspended_reason = NULL
         WHERE subscriber_id = ?`,
        [planGroup, subscriberId]
      );
    });

    res.json({
      success: true,
      message: `Reactivated: ${sr.radius_username} → ${planGroup}`,
      data: { subscriberId, username: sr.radius_username, planGroup },
    });

  } catch (err) {
    console.error('RADIUS reactivate error:', err);
    res.status(500).json({ error: 'Failed to reactivate', details: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// BILLING RESTRICTION (MAC-authenticated subscribers)
//
// The suspend/reactivate endpoints above drive subscriber_radius.radius_username —
// the PPPoE model. This network authenticates devices by MAC, and subscriber_radius
// has no rows, so those two 404 for every subscriber here. These endpoints operate on
// the subscriber's registered MACs instead. See utils/restriction.js for why
// enforcement is applied in two layers.
// ─────────────────────────────────────────────────────────────

// GET — current restriction state (also used to decide which button to show)
router.get('/subscriber/:subscriberId/restriction', async (req, res) => {
  try {
    const open = await restriction.getRestriction(radiusDb, req.params.subscriberId);
    res.json({ restricted: !!open, restriction: open || null });
  } catch (err) {
    console.error('Restriction status error:', err);
    res.status(500).json({ error: 'Failed to read restriction state: ' + err.message });
  }
});

// POST — restrict this subscriber's devices
router.post('/subscriber/:subscriberId/restrict', async (req, res) => {
  try {
    const sid = Number(req.params.subscriberId);
    if (!Number.isInteger(sid)) return res.status(400).json({ error: 'Invalid subscriber id' });
    const by = req.adminUser?.username || String(req.adminUser?.id || 'admin');
    const reason = (req.body?.reason || '').toString().slice(0, 500) || null;

    const out = await restriction.restrictSubscriber(req.prisma, radiusDb, sid, {
      reason, by, trigger: 'manual',
    });

    if (out.alreadyRestricted) {
      return res.json({ success: true, alreadyRestricted: true, message: 'Already restricted',
        restriction: out.restriction });
    }

    if (req.auditLog) {
      req.auditLog('SUBSCRIBER_RESTRICT', {
        subscriberId: sid, reason, macs: out.macs, mode: out.mode,
        routerApplied: out.router.ok, routerError: out.router.error || null,
      }).catch(() => {});
    }

    const what = out.mode === 'full' ? 'Cut off' : 'Restricted';
    // Report the router half honestly rather than implying full enforcement.
    res.json({
      success: true,
      mode: out.mode,
      message: out.router.ok
        ? `${what} ${out.macs.length} device(s)`
        : `${what} ${out.macs.length} device(s) in RADIUS, but the router was not updated — the customer stays online until their lease renews`,
      devices: out.devices,
      routerApplied: out.router.ok,
      routerError: out.router.error || null,
      routerChanges: out.router.result || null,
    });
  } catch (err) {
    console.error('Restrict error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST — lift the restriction and put every device back on its previous plan
router.post('/subscriber/:subscriberId/unrestrict', async (req, res) => {
  try {
    const sid = Number(req.params.subscriberId);
    if (!Number.isInteger(sid)) return res.status(400).json({ error: 'Invalid subscriber id' });
    const by = req.adminUser?.username || String(req.adminUser?.id || 'admin');

    const out = await restriction.unrestrictSubscriber(req.prisma, radiusDb, sid, { by });
    if (!out.wasRestricted) {
      return res.json({ success: true, wasRestricted: false, message: 'Not restricted' });
    }

    if (req.auditLog) {
      req.auditLog('SUBSCRIBER_UNRESTRICT', {
        subscriberId: sid, restored: out.restored,
        routerApplied: out.router.ok, routerError: out.router.error || null,
      }).catch(() => {});
    }

    res.json({
      success: true,
      message: `Restored ${out.restored.length} device(s)`,
      restored: out.restored,
      routerApplied: out.router.ok,
      routerError: out.router.error || null,
    });
  } catch (err) {
    console.error('Unrestrict error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET — who is past due + grace right now, under the current setting.
// Read-only preview. Lets an admin see exactly who an automatic policy would catch
// before any automation is switched on, and shows which grace value is in force.
router.get('/restrictions/candidates', async (req, res) => {
  try {
    const grace = await restriction.getGraceDays(req.prisma);
    // ?graceDays= overrides for what-if comparisons without saving the setting.
    const override = req.query.graceDays !== undefined ? Number(req.query.graceDays) : null;
    const useDays = (override !== null && Number.isInteger(override) && override >= 0 && override <= 180)
      ? override : grace.days;

    const mode = await restriction.getRestrictionMode(req.prisma);
    const candidates = await restriction.restrictionCandidates(req.prisma, radiusDb, useDays);
    res.json({
      graceDays: useDays,
      graceSource: override !== null && useDays === override ? 'query override' : grace.source,
      configuredGraceDays: grace.days,
      mode: mode.mode,
      modeSource: mode.source,
      count: candidates.length,
      candidates,
    });
  } catch (err) {
    console.error('Restriction candidates error:', err);
    res.status(500).json({ error: 'Failed to list candidates: ' + err.message });
  }
});

// POST — run the automatic restriction pass on demand.
// Always a dry run unless ?apply=true is passed AND the feature is enabled in
// settings, so hitting this endpoint out of curiosity cannot cut anybody off.
router.post('/restrictions/run', async (req, res) => {
  try {
    const wantApply = String(req.query.apply || '') === 'true';
    const enabled = await restriction.isAutoRestrictEnabled(req.prisma);
    const dryRun = !(wantApply && enabled);

    const out = await restriction.runAutoRestrict(req.prisma, radiusDb, { dryRun });

    if (!dryRun && req.auditLog) {
      req.auditLog('BILLING_AUTO_RESTRICT_RUN', {
        restricted: out.restricted, graceDays: out.graceDays, mode: out.mode,
        manual: true, by: req.adminUser?.username || 'admin',
      }).catch(() => {});
    }

    res.json({
      ...out,
      autoRestrictEnabled: enabled,
      note: dryRun
        ? (wantApply && !enabled
            ? 'Dry run: billing_auto_restrict_enabled is false. Turn it on in Settings first.'
            : 'Dry run. Pass ?apply=true to actually restrict.')
        : 'Applied.',
    });
  } catch (err) {
    console.error('Auto-restrict run error:', err);
    res.status(500).json({ error: 'Run failed: ' + err.message });
  }
});

// POST — lift automatic restrictions for anyone who has since paid.
// Safe by nature: it only ever restores access, and only for restrictions the
// automation itself created.
router.post('/restrictions/restore-paid', async (req, res) => {
  try {
    const out = await restriction.runAutoRestore(req.prisma, radiusDb);
    if (out.lifted.length && req.auditLog) {
      req.auditLog('BILLING_AUTO_RESTORE_RUN', { lifted: out.lifted, manual: true }).catch(() => {});
    }
    res.json({ success: true, ...out });
  } catch (err) {
    console.error('Auto-restore run error:', err);
    res.status(500).json({ error: 'Restore failed: ' + err.message });
  }
});

// POST — re-apply the address-list from the database.
// Restriction is keyed to the address a device currently holds, so if a lease moves
// the router can drift out of step with the database. This repairs it, and is the
// hook the nightly overdue job will call.
router.post('/restrictions/sync', async (req, res) => {
  try {
    const changes = await restriction.syncAddressList(req.prisma, radiusDb);
    res.json({ success: true, ...changes });
  } catch (err) {
    console.error('Restriction sync error:', err);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});


// PUT /api/admin/radius/subscriber/:subscriberId/password
// Body: { password }
router.put('/subscriber/:subscriberId/password', async (req, res) => {
  try {
    const { subscriberId } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const [bridge] = await radiusDb.query(
      'SELECT * FROM subscriber_radius WHERE subscriber_id = ?',
      [subscriberId]
    );
    if (bridge.length === 0) {
      return res.status(404).json({ error: 'Subscriber not provisioned in RADIUS' });
    }

    const sr = bridge[0];

    await radiusDb.transaction(async (conn) => {
      await conn.query(
        "UPDATE radcheck SET value = ? WHERE username = ? AND attribute = 'Cleartext-Password'",
        [password, sr.radius_username]
      );

      await conn.query(
        'UPDATE subscriber_radius SET radius_password = ? WHERE subscriber_id = ?',
        [password, subscriberId]
      );
    });

    res.json({
      success: true,
      message: `Password updated for ${sr.radius_username}`,
    });

  } catch (err) {
    console.error('RADIUS password change error:', err);
    res.status(500).json({ error: 'Failed to change password', details: err.message });
  }
});


// DELETE /api/admin/radius/subscriber/:subscriberId
// Removes all RADIUS credentials for a subscriber
router.delete('/subscriber/:subscriberId', async (req, res) => {
  try {
    const { subscriberId } = req.params;

    const [bridge] = await radiusDb.query(
      'SELECT * FROM subscriber_radius WHERE subscriber_id = ?',
      [subscriberId]
    );
    if (bridge.length === 0) {
      return res.status(404).json({ error: 'Subscriber not provisioned in RADIUS' });
    }

    const sr = bridge[0];

    await radiusDb.transaction(async (conn) => {
      await conn.query('DELETE FROM radcheck WHERE username = ?', [sr.radius_username]);
      await conn.query('DELETE FROM radreply WHERE username = ?', [sr.radius_username]);
      await conn.query('DELETE FROM radusergroup WHERE username = ?', [sr.radius_username]);
      await conn.query('DELETE FROM subscriber_radius WHERE subscriber_id = ?', [subscriberId]);
      // Note: radacct and radpostauth records are preserved for history
    });

    res.json({
      success: true,
      message: `RADIUS credentials removed for ${sr.radius_username}`,
      data: { subscriberId, username: sr.radius_username },
    });

  } catch (err) {
    console.error('RADIUS deprovision error:', err);
    res.status(500).json({ error: 'Failed to remove RADIUS credentials', details: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// SESSION MANAGEMENT
// ─────────────────────────────────────────────────────────────

// GET /api/admin/radius/sessions
// Query: ?page=1&limit=20&nasip=x.x.x.x
// Returns all active sessions
router.get('/sessions', async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1');
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const offset = (page - 1) * limit;
    const nasip = req.query.nasip;

    let where = 'WHERE acctstoptime IS NULL';
    const params = [];

    if (nasip) {
      where += ' AND nasipaddress = ?';
      params.push(nasip);
    }

    const [total] = await radiusDb.query(
      `SELECT COUNT(*) AS cnt FROM radacct ${where}`, params
    );

    const [sessions] = await radiusDb.query(
      `SELECT username, acctsessionid, nasipaddress, nasportid,
              framedipaddress, acctstarttime, acctupdatetime,
              acctinputoctets, acctoutputoctets, acctsessiontime,
              calledstationid, callingstationid
       FROM radacct ${where}
       ORDER BY acctstarttime DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Get unique NAS IPs for filter dropdown
    const [nasDevices] = await radiusDb.query(
      'SELECT DISTINCT nasipaddress FROM radacct WHERE acctstoptime IS NULL ORDER BY nasipaddress'
    );

    res.json({
      sessions,
      nasDevices: nasDevices.map(n => n.nasipaddress),
      pagination: {
        page,
        limit,
        total: total[0].cnt,
        pages: Math.ceil(total[0].cnt / limit),
      },
    });

  } catch (err) {
    console.error('RADIUS sessions error:', err);
    res.status(500).json({ error: 'Failed to get sessions', details: err.message });
  }
});


// GET /api/admin/radius/sessions/stats
// Returns aggregate session statistics
router.get('/sessions/stats', async (req, res) => {
  try {
    const [active] = await radiusDb.query(
      'SELECT COUNT(*) AS total FROM radacct WHERE acctstoptime IS NULL'
    );

    const [byNas] = await radiusDb.query(
      `SELECT nasipaddress, COUNT(*) AS sessions 
       FROM radacct WHERE acctstoptime IS NULL 
       GROUP BY nasipaddress ORDER BY sessions DESC`
    );

    const [todayTraffic] = await radiusDb.query(
      `SELECT 
        COALESCE(SUM(acctinputoctets), 0) AS total_upload,
        COALESCE(SUM(acctoutputoctets), 0) AS total_download
       FROM radacct WHERE acctstarttime >= CURRENT_DATE`
    );

    const [topUsers] = await radiusDb.query(
      `SELECT username, 
              COALESCE(acctinputoctets, 0) + COALESCE(acctoutputoctets, 0) AS total_bytes,
              acctsessiontime, framedipaddress, nasipaddress
       FROM radacct WHERE acctstoptime IS NULL
       ORDER BY total_bytes DESC LIMIT 10`
    );

    res.json({
      activeSessions: active[0].total,
      sessionsByNas: byNas,
      todayTraffic: {
        uploadBytes: todayTraffic[0].total_upload,
        downloadBytes: todayTraffic[0].total_download,
      },
      topUsers,
    });

  } catch (err) {
    console.error('RADIUS session stats error:', err);
    res.status(500).json({ error: 'Failed to get session stats', details: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// COA / DISCONNECT
// ─────────────────────────────────────────────────────────────

// POST /api/admin/radius/coa/disconnect
// Body: { username } or { sessionId, nasIp }
// Sends CoA Disconnect-Request to kick a user's session
router.post('/coa/disconnect', async (req, res) => {
  try {
    const { username, sessionId, nasIp } = req.body;

    if (!username && !(sessionId && nasIp)) {
      return res.status(400).json({ error: 'Provide username, or sessionId + nasIp' });
    }

    let targetNasIp, targetSessionId, targetUsername;

    if (username) {
      // Look up active session
      const [session] = await radiusDb.query(
        `SELECT acctsessionid, nasipaddress, username 
         FROM radacct WHERE username = ? AND acctstoptime IS NULL 
         ORDER BY acctstarttime DESC LIMIT 1`,
        [username]
      );
      if (session.length === 0) {
        return res.json({ success: false, message: 'No active session found for user' });
      }
      targetNasIp = session[0].nasipaddress;
      targetSessionId = session[0].acctsessionid;
      targetUsername = session[0].username;
    } else {
      targetNasIp = nasIp;
      targetSessionId = sessionId;
    }

    // Read NAS secret from credentials file or env
    const nasSecret = process.env.NAS_RADIUS_SECRET || '';
    
    if (!nasSecret) {
      return res.status(500).json({ 
        error: 'NAS_RADIUS_SECRET not configured — cannot send CoA' 
      });
    }

    // Build radclient command for Disconnect-Request
    const attrs = [
      `User-Name="${targetUsername || ''}"`,
      `Acct-Session-Id="${targetSessionId}"`,
    ].join(',');

    const cmd = `echo "${attrs}" | radclient -x ${targetNasIp}:3799 disconnect "${nasSecret}" 2>&1`;

    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 10000 });
      const success = stdout.includes('Disconnect-ACK');
      
      res.json({
        success,
        message: success ? 'Disconnect-ACK received — session terminated' : 'Disconnect failed',
        details: { nasIp: targetNasIp, sessionId: targetSessionId, output: stdout.trim() },
      });
    } catch (execErr) {
      res.json({
        success: false,
        message: 'CoA command failed',
        details: { error: execErr.message, nasIp: targetNasIp },
      });
    }

  } catch (err) {
    console.error('RADIUS CoA error:', err);
    res.status(500).json({ error: 'Failed to send CoA', details: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// AUTH LOG
// ─────────────────────────────────────────────────────────────

// GET /api/admin/radius/authlog
// Query: ?username=x&page=1&limit=50
router.get('/authlog', async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1');
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const offset = (page - 1) * limit;
    const username = req.query.username;

    let where = '';
    const params = [];

    if (username) {
      where = 'WHERE username = ?';
      params.push(username);
    }

    const [total] = await radiusDb.query(
      `SELECT COUNT(*) AS cnt FROM radpostauth ${where}`, params
    );

    const [logs] = await radiusDb.query(
      `SELECT username, reply, authdate 
       FROM radpostauth ${where}
       ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      logs,
      pagination: {
        page, limit,
        total: total[0].cnt,
        pages: Math.ceil(total[0].cnt / limit),
      },
    });

  } catch (err) {
    console.error('RADIUS authlog error:', err);
    res.status(500).json({ error: 'Failed to get auth log', details: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// PLAN GROUPS MANAGEMENT
// ─────────────────────────────────────────────────────────────

// GET /api/admin/radius/plans
// Returns all plan groups with their attributes
router.get('/plans', async (req, res) => {
  try {
    const [groups] = await radiusDb.query(
      `SELECT groupname, attribute, op, value 
       FROM radgroupreply ORDER BY groupname, attribute`
    );

    // Group by plan
    const plans = {};
    groups.forEach(row => {
      if (!plans[row.groupname]) plans[row.groupname] = {};
      plans[row.groupname][row.attribute] = row.value;
    });

    // Count subscribers per group
    const [counts] = await radiusDb.query(
      `SELECT radius_group, COUNT(*) AS subscribers 
       FROM subscriber_radius GROUP BY radius_group`
    );

    const countMap = {};
    counts.forEach(row => { countMap[row.radius_group] = row.subscribers; });

    const result = Object.entries(plans).map(([name, attrs]) => ({
      groupname: name,
      rateLimit: attrs['Mikrotik-Rate-Limit'] || 'N/A',
      sessionTimeout: attrs['Session-Timeout'] || '0',
      idleTimeout: attrs['Idle-Timeout'] || '0',
      acctInterval: attrs['Acct-Interim-Interval'] || '300',
      subscribers: countMap[name] || 0,
    }));

    res.json({ plans: result });

  } catch (err) {
    console.error('RADIUS plans error:', err);
    res.status(500).json({ error: 'Failed to get plans', details: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// BULK OPERATIONS
// ─────────────────────────────────────────────────────────────

// POST /api/admin/radius/bulk/provision
// Body: { subscribers: [{ subscriberId, username, password, planGroup }] }
router.post('/bulk/provision', async (req, res) => {
  try {
    const { subscribers } = req.body;
    if (!Array.isArray(subscribers) || subscribers.length === 0) {
      return res.status(400).json({ error: 'subscribers array required' });
    }

    if (subscribers.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 subscribers per batch' });
    }

    const results = { success: 0, failed: 0, errors: [] };

    for (const sub of subscribers) {
      try {
        const { subscriberId, username, password, planGroup } = sub;
        
        if (!subscriberId || !username || !password || !planGroup) {
          results.failed++;
          results.errors.push({ subscriberId, error: 'Missing required fields' });
          continue;
        }

        await radiusDb.transaction(async (conn) => {
          await conn.query(
            "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)",
            [username, password]
          );
          await conn.query(
            'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)',
            [username, planGroup]
          );
          await conn.query(
            `INSERT INTO subscriber_radius 
             (subscriber_id, radius_username, radius_group, radius_password, enabled)
             VALUES (?, ?, ?, ?, 1)`,
            [subscriberId, username, planGroup, password]
          );
        });

        results.success++;
      } catch (err) {
        results.failed++;
        results.errors.push({ subscriberId: sub.subscriberId, error: err.message });
      }
    }

    res.json({
      success: true,
      message: `Provisioned ${results.success}/${subscribers.length}`,
      results,
    });

  } catch (err) {
    console.error('RADIUS bulk provision error:', err);
    res.status(500).json({ error: 'Bulk provision failed', details: err.message });
  }
});


// GET /api/admin/radius/dashboard
// Aggregate dashboard data for RADIUS overview page
router.get('/dashboard', async (req, res) => {
  try {
    const [totals] = await radiusDb.query(`
      SELECT 
        (SELECT COUNT(*) FROM subscriber_radius) AS total_provisioned,
        (SELECT COUNT(*) FROM subscriber_radius WHERE enabled = true) AS enabled,
        (SELECT COUNT(*) FROM subscriber_radius WHERE enabled = false) AS disabled,
        (SELECT COUNT(*) FROM radacct WHERE acctstoptime IS NULL) AS active_sessions
    `);

    const [authStats] = await radiusDb.query(`
      SELECT 
        SUM(CASE WHEN reply='Access-Accept' THEN 1 ELSE 0 END) AS accepts,
        SUM(CASE WHEN reply='Access-Reject' THEN 1 ELSE 0 END) AS rejects
      FROM radpostauth WHERE authdate >= CURRENT_DATE
    `);

    const [planDistribution] = await radiusDb.query(`
      SELECT radius_group AS plan_group, COUNT(*) AS count
      FROM subscriber_radius WHERE enabled = true
      GROUP BY radius_group ORDER BY count DESC
    `);

    const [hourlyAuth] = await radiusDb.query(`
      SELECT EXTRACT(HOUR FROM authdate) AS hour, reply, COUNT(*) AS count
      FROM radpostauth 
      WHERE authdate >= CURRENT_DATE
      GROUP BY EXTRACT(HOUR FROM authdate), reply
      ORDER BY hour
    `);

    const [recentFailed] = await radiusDb.query(`
      SELECT p.username, p.authdate, p.reply,
        CASE
          WHEN rc.username IS NOT NULL THEN 'Wrong password'
          ELSE 'Unknown username'
        END AS reason
      FROM radpostauth p
      LEFT JOIN (SELECT DISTINCT username FROM radcheck) rc ON rc.username = p.username
      WHERE p.reply = 'Access-Reject'
      ORDER BY p.id DESC LIMIT 100
    `);

    res.json({
      totals: totals[0],
      authToday: {
        accepts: authStats[0]?.accepts || 0,
        rejects: authStats[0]?.rejects || 0,
      },
      planDistribution,
      hourlyAuth,
      recentFailed,
    });

  } catch (err) {
    console.error('RADIUS dashboard error:', err);
    res.status(500).json({ error: 'Dashboard query failed', details: err.message });
  }
});


// GET /api/admin/radius/plans - Plan groups from radgroupreply
router.get('/plans', async (req, res) => {
  try {
    const [groups] = await radiusDb.query(
      `SELECT g.groupname,
        MAX(CASE WHEN g.attribute = 'Mikrotik-Rate-Limit' THEN g.value END) AS rate_limit,
        MAX(CASE WHEN g.attribute = 'Session-Timeout' THEN g.value END) AS session_timeout,
        MAX(CASE WHEN g.attribute = 'Idle-Timeout' THEN g.value END) AS idle_timeout,
        MAX(CASE WHEN g.attribute = 'Acct-Interim-Interval' THEN g.value END) AS acct_interval,
        COUNT(DISTINCT u.username) AS subscriber_count
      FROM radgroupreply g
      LEFT JOIN radusergroup u ON u.groupname = g.groupname
      GROUP BY g.groupname
      ORDER BY g.groupname`
    );
    res.json({ success: true, plans: groups });
  } catch (err) {
    console.error('Plans error:', err);
    res.status(500).json({ error: 'Failed to load plan groups' });
  }
});



// ─────────────────────────────────────────────────────────────
// NAS DEVICE MANAGEMENT
// ─────────────────────────────────────────────────────────────

// GET /api/admin/radius/nas - List all NAS devices
router.get('/nas', async (req, res) => {
  try {
    const [devices] = await radiusDb.query(
      'SELECT id, nasname, shortname, type, secret, description, ports, server, community, mikrotik_user, mikrotik_pass FROM nas ORDER BY shortname'
    );
    res.json({ devices });
  } catch (err) {
    console.error('NAS list error:', err);
    res.status(500).json({ error: 'Failed to load NAS devices' });
  }
});

// POST /api/admin/radius/nas - Add NAS device
router.post('/nas', async (req, res) => {
  try {
    const { nasname, shortname, secret, description, type, mikrotik_user, mikrotik_pass } = req.body;
    if (!nasname || !shortname || !secret) {
      return res.status(400).json({ error: 'Required: nasname (IP), shortname (label), secret' });
    }
    const [existing] = await radiusDb.query('SELECT id FROM nas WHERE nasname = ?', [nasname]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'NAS with IP ' + nasname + ' already exists' });
    }
    const [result] = await radiusDb.query(
      'INSERT INTO nas (nasname, shortname, type, secret, description, mikrotik_user, mikrotik_pass) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [nasname.trim(), shortname.trim(), type || 'other', secret, description || '', mikrotik_user || '', mikrotik_pass || '']
    );
    if (req.auditLog) req.auditLog('NAS_DEVICE_ADD', { nasname: nasname.trim(), shortname: shortname.trim(), description: description || '' }).catch(() => {});
    res.status(201).json({ success: true, message: 'NAS device added', id: result.insertId });
  } catch (err) {
    console.error('NAS add error:', err);
    res.status(500).json({ error: 'Failed to add NAS device' });
  }
});

// PUT /api/admin/radius/nas/:id - Update NAS device
router.put('/nas/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { nasname, shortname, secret, description, type, mikrotik_user, mikrotik_pass } = req.body;
    const fields = [];
    const values = [];
    if (nasname !== undefined) { fields.push('nasname = ?'); values.push(nasname.trim()); }
    if (shortname !== undefined) { fields.push('shortname = ?'); values.push(shortname.trim()); }
    if (secret !== undefined) { fields.push('secret = ?'); values.push(secret); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description); }
    if (type !== undefined) { fields.push('type = ?'); values.push(type); }
    if (mikrotik_user !== undefined) { fields.push('mikrotik_user = ?'); values.push(mikrotik_user); }
    if (mikrotik_pass !== undefined) { fields.push('mikrotik_pass = ?'); values.push(mikrotik_pass); }
    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(id);
    await radiusDb.query('UPDATE nas SET ' + fields.join(', ') + ' WHERE id = ?', values);
    if (req.auditLog) req.auditLog('NAS_DEVICE_UPDATE', { nasId: id, fields: Object.keys(req.body).filter(k => req.body[k] !== undefined) }).catch(() => {});
    res.json({ success: true, message: 'NAS device updated' });
  } catch (err) {
    console.error('NAS update error:', err);
    res.status(500).json({ error: 'Failed to update NAS device' });
  }
});

// DELETE /api/admin/radius/nas/:id - Remove NAS device
router.delete('/nas/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [device] = await radiusDb.query('SELECT shortname FROM nas WHERE id = ?', [id]);
    if (device.length === 0) return res.status(404).json({ error: 'NAS device not found' });
    await radiusDb.query('DELETE FROM nas WHERE id = ?', [id]);
    if (req.auditLog) req.auditLog('NAS_DEVICE_DELETE', { nasId: id, shortname: device[0].shortname }).catch(() => {});
    res.json({ success: true, message: 'NAS device "' + device[0].shortname + '" removed' });
  } catch (err) {
    console.error('NAS delete error:', err);
    res.status(500).json({ error: 'Failed to remove NAS device' });
  }
});

// POST /api/admin/radius/nas/generate-config/:id - Generate MikroTik config
router.post('/nas/generate-config/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [device] = await radiusDb.query('SELECT * FROM nas WHERE id = ?', [id]);
    if (device.length === 0) return res.status(404).json({ error: 'NAS device not found' });
    const d = device[0];
    const radiusPublicIp = process.env.RADIUS_PUBLIC_IP || '44.220.47.35';
    const iface = req.body.interface || 'ether1';
    const serviceName = req.body.serviceName || 'NF-Internet';

    const config = [
      '# MikroTik RADIUS Config for ' + d.shortname + ' (' + d.nasname + ')',
      '# Generated: ' + new Date().toISOString(),
      '',
      '# ─── RADIUS Server ───',
      '/radius',
      'add address=' + radiusPublicIp + ' secret=' + d.secret + ' \\',
      '    service=ppp timeout=3000ms authentication-port=1812 accounting-port=1813',
      '',
      '# ─── Enable CoA (Change of Authorization) ───',
      '/radius incoming',
      'set accept=yes port=3799',
      '',
      '# ─── PPPoE Server Profile ───',
      '/ppp profile',
      'add name="radius-pppoe" use-mpls=default use-compression=default \\',
      '    use-encryption=default only-one=yes \\',
      '    rate-limit="" \\',
      '    change-tcp-mss=yes',
      '',
      '# ─── PPPoE Server ───',
      '/interface pppoe-server server',
      'add service-name="' + serviceName + '" interface=' + iface + ' \\',
      '    default-profile=radius-pppoe \\',
      '    authentication=pap,chap,mschap2 \\',
      '    one-session-per-host=yes \\',
      '    max-mtu=1480 max-mru=1480 keepalive-timeout=30',
      '',
      '# ─── PPP AAA ───',
      '/ppp aaa',
      'set use-radius=yes accounting=yes interim-update=5m \\',
      '    use-circuit-id-in-nas-port-id=yes',
    ].join('\n');

    res.json({ config, device: d.shortname });
  } catch (err) {
    console.error('Config gen error:', err);
    res.status(500).json({ error: 'Failed to generate config' });
  }
});



// ─────────────────────────────────────────────────────────────
// SESSION HISTORY (radacct)
// ─────────────────────────────────────────────────────────────

// GET /api/admin/radius/sessions-history
router.get('/sessions-history', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const offset = (page - 1) * limit;
    const username = req.query.username || '';

    let where = '';
    const params = [];
    if (username) {
      where = 'WHERE username LIKE ?';
      params.push('%' + username + '%');
    }

    const [[{ total }]] = await radiusDb.query(
      'SELECT COUNT(*) AS total FROM radacct ' + where, params
    );

    const [sessions] = await radiusDb.query(
      'SELECT radacctid, username, nasipaddress, nasportid, acctstarttime, acctstoptime, ' +
      'acctinputoctets, acctoutputoctets, framedipaddress, callingstationid, ' +
      'acctterminatecause, acctsessiontime, acctuniqueid ' +
      'FROM radacct ' + where + ' ORDER BY acctstarttime DESC LIMIT ? OFFSET ?',
      [...params, limit, offset]
    );

    res.json({
      sessions: sessions.map(s => ({
        id: s.radacctid,
        username: s.username,
        nasIp: s.nasipaddress,
        nasPort: s.nasportid,
        startTime: s.acctstarttime,
        stopTime: s.acctstoptime,
        inputBytes: Number(s.acctinputoctets || 0),
        outputBytes: Number(s.acctoutputoctets || 0),
        framedIp: s.framedipaddress,
        callingStation: s.callingstationid,
        terminateCause: s.acctterminatecause,
        sessionTime: s.acctsessiontime,
        sessionId: s.acctuniqueid,
      })),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('Session history error:', err);
    res.status(500).json({ error: 'Failed to load session history' });
  }
});


// ─────────────────────────────────────────────────────────────
// RADIUS SERVER LOGS (via SSH)
// ─────────────────────────────────────────────────────────────

const { Client: SSHClient } = require('ssh2');
const fs = require('fs');
const path = require('path');

async function sshExec(cmd, timeout = 15000) {
  try {
    const { execSync } = require('child_process');
    return execSync(cmd, { timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    // On non-zero exit, capture both stdout and stderr (e.g. radclient returns exit 1 on Access-Reject)
    const output = ((e.stdout || '') + '\n' + (e.stderr || '')).trim();
    return output || e.message || 'Command failed';
  }
}


// POST /api/admin/radius/server-logs
router.post('/server-logs', async (req, res) => {
  try {
    const { action, lines } = req.body;
    const numLines = parseInt(lines) || 50;
    let command = '';
    let description = '';

    switch (action) {
      case 'recent':
        command = 'sudo cat /var/log/freeradius/radius.log /var/log/freeradius/radius.log.1 2>/dev/null | tail -' + numLines;
        description = 'Recent ' + numLines + ' log lines';
        break;
      case 'rejects':
        command = 'sudo cat /var/log/freeradius/radius.log /var/log/freeradius/radius.log.1 2>/dev/null | grep -i "Login incorrect\|reject\|Error" | tail -' + numLines;
        description = 'Recent rejects/errors';
        break;
      case 'accepts':
        command = 'sudo cat /var/log/freeradius/radius.log /var/log/freeradius/radius.log.1 2>/dev/null | grep -i "Login OK\|Access-Accept" | tail -' + numLines;
        description = 'Recent accepts';
        break;
      case 'status':
        command = 'sudo systemctl status freeradius --no-pager 2>&1; echo "---"; echo "Uptime:"; uptime; echo "---"; echo "RADIUS Connections:"; sudo ss -tulnp | grep -E "1812|1813|3799" 2>/dev/null || echo "None"';
        description = 'RADIUS server status';
        break;
      case 'restart':
        command = 'sudo systemctl restart freeradius && echo "FreeRADIUS restarted successfully" || echo "Restart failed"';
        description = 'Restart FreeRADIUS';
        break;
      case 'test-auth':
        const testUser = req.body.testUser || 'nf-test-user';
        const testPass = req.body.testPass || 'nftestpass2026';
        command = 'echo "User-Name=' + testUser + ',User-Password=' + testPass + '" | radclient -x 127.0.0.1 auth ' + (process.env.RADIUS_SECRET || '') + ' 2>&1';
        description = 'Test auth for ' + testUser;
        break;
      default:
        return res.status(400).json({ error: 'Invalid action. Use: recent, rejects, accepts, status, restart, test-auth' });
    }

    const output = await sshExec(command, action === 'restart' ? 15000 : 10000);
    res.json({ success: true, description, output, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Server logs error:', err);
    res.status(500).json({ error: 'SSH connection failed: ' + err.message });
  }
});


// GET /api/admin/radius/recent-accounts - Last N created RADIUS accounts
router.get('/recent-accounts', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const [accounts] = await radiusDb.query(
      "SELECT r.username, r.value AS password, g.groupname FROM radcheck r " +
      "LEFT JOIN radusergroup g ON r.username = g.username " +
      "WHERE r.attribute = 'Cleartext-Password' ORDER BY r.id DESC LIMIT ?", [limit]
    );
    // Enrich with CRM subscriber names
    const usernames = accounts.map(a => a.username);
    if (usernames.length > 0 && req.prisma) {
      try {
        const subs = await req.prisma.subscribers.findMany({
          where: { account_number: { in: usernames } },
          select: { account_number: true, first_name: true, last_name: true }
        });
        const nameMap = {};
        subs.forEach(s => { nameMap[s.account_number] = (s.first_name || "") + " " + (s.last_name || ""); });
        accounts.forEach(a => { a.customerName = nameMap[a.username] || null; });
      } catch(e) { console.error("Name lookup:", e.message); }
    }
    res.json({ accounts });
  } catch (err) {
    console.error('Recent accounts error:', err);
    res.status(500).json({ error: 'Failed to load accounts' });
  }
});


// ─────────────────────────────────────────────────────────────
// RADIUS FIREWALL MANAGEMENT (via SSH + UFW)
// ─────────────────────────────────────────────────────────────

// Helper: add UFW rules for a source
async function ufwAddRules(source, label) {
  const comment = label || source;
  const fromClause = source === '0.0.0.0/0' ? '' : 'from ' + source + ' ';
  const cmds = [
    "sudo ufw allow " + fromClause + "to any port 1812 proto udp comment 'RADIUS " + comment + "'",
    "sudo ufw allow " + fromClause + "to any port 1813 proto udp comment 'RADIUS " + comment + "'",
    "sudo ufw allow " + fromClause + "to any port 3799 proto udp comment 'RADIUS CoA " + comment + "'"
  ].join(' && ');
  return await sshExec(cmds, 10000);
}

// Helper: remove UFW rules for a source
async function ufwRemoveRules(source) {
  const grepSource = source === '0.0.0.0/0' ? 'Anywhere' : source;
  const output = String(await sshExec("sudo ufw status numbered | grep -E '1812|1813|3799' | grep '" + grepSource + "'", 8000));
  const nums = [];
  output.split('\n').forEach(l => { const m = l.match(/\[\s*(\d+)\]/); if (m) nums.push(parseInt(m[1])); });
  nums.sort((a, b) => b - a);
  for (const n of nums) { await sshExec('echo "y" | sudo ufw delete ' + n, 8000); }
  return nums.length;
}

// GET /api/admin/radius/firewall - List firewall rules from database
router.get('/firewall', async (req, res) => {
  try {
    const [rules] = await radiusDb.query('SELECT id, source, label, enabled, created_at FROM radius_firewall_rules ORDER BY id');
    res.json({ rules });
  } catch (err) {
    console.error('Firewall list error:', err);
    res.status(500).json({ error: 'Failed to list firewall rules: ' + err.message });
  }
});

// POST /api/admin/radius/firewall - Add firewall rule
router.post('/firewall', async (req, res) => {
  try {
    const { source, label } = req.body;
    if (!source) return res.status(400).json({ error: 'Required: source (IP or CIDR)' });
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
    if (!ipRegex.test(source)) return res.status(400).json({ error: 'Invalid IP/CIDR format' });

    // Add to database
    await radiusDb.query('INSERT INTO radius_firewall_rules (source, label, enabled) VALUES (?, ?, true) ON CONFLICT (source) DO UPDATE SET label = ?, enabled = true', [source, label || source, label || source]);
    // Add to UFW
    await ufwAddRules(source, label || source);
    // Audit log
    if (req.auditLog) req.auditLog('FIREWALL_RULE_ADD', { source, label: label || source, ports: '1812,1813,3799' }).catch(() => {});
    res.json({ success: true, message: 'Firewall rules added for ' + source });
  } catch (err) {
    console.error('Firewall add error:', err);
    res.status(500).json({ error: 'Failed to add firewall rule: ' + err.message });
  }
});

// PUT /api/admin/radius/firewall/:id/toggle - Enable/disable a firewall rule
router.put('/firewall/:id/toggle', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [rows] = await radiusDb.query('SELECT source, label, enabled FROM radius_firewall_rules WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Rule not found' });

    const rule = rows[0];
    const newEnabled = !rule.enabled;

    if (newEnabled) {
      await ufwAddRules(rule.source, rule.label);
    } else {
      await ufwRemoveRules(rule.source);
    }

    await radiusDb.query('UPDATE radius_firewall_rules SET enabled = ? WHERE id = ?', [newEnabled, id]);
    // Audit log
    if (req.auditLog) req.auditLog('FIREWALL_RULE_TOGGLE', { source: rule.source, label: rule.label, status: newEnabled ? 'ENABLED' : 'DISABLED' }).catch(() => {});
    res.json({ success: true, enabled: newEnabled, message: (newEnabled ? 'Enabled' : 'Disabled') + ' firewall rules for ' + rule.source });
  } catch (err) {
    console.error('Firewall toggle error:', err);
    res.status(500).json({ error: 'Failed to toggle firewall rule: ' + err.message });
  }
});

// DELETE /api/admin/radius/firewall - Remove firewall rules by source IP
router.delete('/firewall', async (req, res) => {
  try {
    const { source } = req.body;
    if (!source) return res.status(400).json({ error: 'Required: source (IP or CIDR)' });

    // Remove from UFW
    await ufwRemoveRules(source);
    // Remove from database
    await radiusDb.query('DELETE FROM radius_firewall_rules WHERE source = ?', [source]);
    // Audit log
    if (req.auditLog) req.auditLog('FIREWALL_RULE_DELETE', { source }).catch(() => {});
    res.json({ success: true, message: 'Removed firewall rules for ' + source });
  } catch (err) {
    console.error('Firewall delete error:', err);
    res.status(500).json({ error: 'Failed to delete firewall rule: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// RADIUS LOG MANAGEMENT
// ─────────────────────────────────────────────────────────────

// GET /api/admin/radius/log-stats - Get log record counts
router.get('/log-stats', async (req, res) => {
  try {
    const [stats] = await radiusDb.query(`
      SELECT
        (SELECT COUNT(*) FROM radpostauth) AS auth_total,
        (SELECT COUNT(*) FROM radpostauth WHERE authdate < NOW() - INTERVAL '30 days') AS auth_older_30d,
        (SELECT COUNT(*) FROM radpostauth WHERE authdate < NOW() - INTERVAL '90 days') AS auth_older_90d,
        (SELECT COUNT(*) FROM radacct) AS sessions_total,
        (SELECT COUNT(*) FROM radacct WHERE acctstarttime < NOW() - INTERVAL '30 days' AND acctstoptime IS NOT NULL) AS sessions_older_30d,
        (SELECT COUNT(*) FROM radacct WHERE acctstarttime < NOW() - INTERVAL '90 days' AND acctstoptime IS NOT NULL) AS sessions_older_90d,
        (SELECT MIN(authdate) FROM radpostauth) AS auth_oldest,
        (SELECT MIN(acctstarttime) FROM radacct) AS sessions_oldest
    `);
    res.json(stats[0]);
  } catch (err) {
    console.error('Log stats error:', err);
    res.status(500).json({ error: 'Failed to get log stats: ' + err.message });
  }
});

// DELETE /api/admin/radius/purge-logs - Purge old log records
router.delete('/purge-logs', async (req, res) => {
  try {
    const { target, days } = req.body;
    if (!target || !days) return res.status(400).json({ error: 'Required: target (auth|sessions|all), days (number)' });
    const d = parseInt(days);
    if (isNaN(d) || d < 1) return res.status(400).json({ error: 'Days must be a positive number' });

    let authDeleted = 0, sessionDeleted = 0;

    if (target === 'auth' || target === 'all') {
      const [result] = await radiusDb.query(
        "DELETE FROM radpostauth WHERE authdate < NOW() - INTERVAL '" + d + " days' RETURNING id"
      );
      authDeleted = result.length;
    }

    if (target === 'sessions' || target === 'all') {
      const [result] = await radiusDb.query(
        "DELETE FROM radacct WHERE acctstarttime < NOW() - INTERVAL '" + d + " days' AND acctstoptime IS NOT NULL RETURNING radacctid"
      );
      sessionDeleted = result.length;
    }

    if (req.auditLog) req.auditLog('RADIUS_LOGS_PURGE', { target, days: d, authDeleted, sessionDeleted }).catch(() => {});
    res.json({ success: true, authDeleted, sessionDeleted, message: 'Purged ' + (authDeleted + sessionDeleted) + ' records older than ' + d + ' days' });
  } catch (err) {
    console.error('Purge logs error:', err);
    res.status(500).json({ error: 'Failed to purge logs: ' + err.message });
  }
});

// ============================================================
// PREPAID HOTSPOT VOUCHERS
//   auth data lives in radcheck/radusergroup; metadata in hotspot_vouchers
// ============================================================

// GET /api/admin/radius/vouchers/profiles — available voucher plans
router.get('/vouchers/profiles', async (req, res) => {
  try {
    const [rows] = await radiusDb.query(
      `SELECT groupname AS profile,
         MAX(CASE WHEN attribute='Mikrotik-Rate-Limit' THEN value END) AS rate_limit,
         MAX(CASE WHEN attribute='Session-Timeout' THEN value END) AS session_timeout
       FROM radgroupreply WHERE groupname LIKE 'voucher-%'
       GROUP BY groupname ORDER BY groupname`);
    res.json({ profiles: rows });
  } catch (err) {
    console.error('Voucher profiles error:', err);
    res.status(500).json({ error: 'Failed to load voucher profiles' });
  }
});

// GET /api/admin/radius/vouchers — list vouchers with usage status
router.get('/vouchers', async (req, res) => {
  try {
    const { status, profile } = req.query;
    const lim = Math.min(parseInt(req.query.limit) || 500, 2000);
    const params = [];
    let where = "WHERE 1=1";
    if (profile) { params.push(profile); where += " AND v.profile = ?"; }
    const [rows] = await radiusDb.query(
      `SELECT v.code, v.profile, v.price, v.batch_id, v.created_at, v.created_by,
         COALESCE(s.sessions,0) AS sessions, s.first_used,
         COALESCE(s.online,false) AS online
       FROM hotspot_vouchers v
       LEFT JOIN LATERAL (
         SELECT count(*) AS sessions, min(acctstarttime) AS first_used,
                bool_or(acctstoptime IS NULL) AS online
         FROM radacct a WHERE a.username = v.code
       ) s ON true
       ${where}
       ORDER BY v.created_at DESC LIMIT ${lim}`, params);
    let vouchers = rows.map(r => ({ ...r, status: r.online ? 'online' : (Number(r.sessions) > 0 ? 'used' : 'unused') }));
    if (status) vouchers = vouchers.filter(v => v.status === status);
    res.json({ vouchers, count: vouchers.length });
  } catch (err) {
    console.error('Voucher list error:', err);
    res.status(500).json({ error: 'Failed to list vouchers: ' + err.message });
  }
});

// POST /api/admin/radius/vouchers/generate — create a batch
router.post('/vouchers/generate', async (req, res) => {
  try {
    const profile = String(req.body.profile || '');
    const count = parseInt(req.body.count);
    const length = Math.min(Math.max(parseInt(req.body.length) || 8, 4), 16);
    const price = (req.body.price === '' || req.body.price == null) ? null : Number(req.body.price);
    if (!profile || !count || count < 1) return res.status(400).json({ error: 'Required: profile, count (>=1)' });
    if (count > 500) return res.status(400).json({ error: 'Max 500 vouchers per batch' });
    const [pf] = await radiusDb.query("SELECT 1 FROM radgroupreply WHERE groupname = ? LIMIT 1", [profile]);
    if (pf.length === 0) return res.status(400).json({ error: 'Unknown profile: ' + profile });

    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no 0/O/1/I
    const gen = () => { const b = crypto.randomBytes(length); let s = ''; for (let i = 0; i < length; i++) s += A[b[i] % A.length]; return s; };
    const batchId = 'B' + Date.now();
    const createdBy = req.adminUser?.username || String(req.adminUser?.id || 'admin');
    const codes = [];
    await radiusDb.transaction(async (conn) => {
      for (let i = 0; i < count; i++) {
        let code = '', exists = true, tries = 0;
        while (exists && tries < 12) { code = gen(); const [e] = await conn.query("SELECT 1 FROM radcheck WHERE username = ? LIMIT 1", [code]); exists = e.length > 0; tries++; }
        await conn.query("INSERT INTO radcheck (username,attribute,op,value) VALUES (?, 'Cleartext-Password', ':=', ?)", [code, code]);
        await conn.query("INSERT INTO radcheck (username,attribute,op,value) VALUES (?, 'Simultaneous-Use', ':=', '1')", [code]);
        await conn.query("INSERT INTO radusergroup (username,groupname,priority) VALUES (?, ?, 1)", [code, profile]);
        await conn.query("INSERT INTO hotspot_vouchers (code,profile,batch_id,price,created_by) VALUES (?, ?, ?, ?, ?)", [code, profile, batchId, price, createdBy]);
        codes.push(code);
      }
    });
    if (req.auditLog) req.auditLog('VOUCHER_GENERATE', { profile, count: codes.length, batchId }).catch(() => {});
    res.status(201).json({ success: true, batchId, profile, count: codes.length, codes });
  } catch (err) {
    console.error('Voucher generate error:', err);
    res.status(500).json({ error: 'Failed to generate vouchers: ' + err.message });
  }
});

// DELETE /api/admin/radius/vouchers/batch/:batchId — delete UNUSED vouchers in a batch
router.delete('/vouchers/batch/:batchId', async (req, res) => {
  try {
    const batchId = req.params.batchId;
    const [rows] = await radiusDb.query(
      `SELECT v.code FROM hotspot_vouchers v
       WHERE v.batch_id = ? AND NOT EXISTS (SELECT 1 FROM radacct a WHERE a.username = v.code)`, [batchId]);
    const codes = rows.map(r => r.code);
    if (codes.length) {
      await radiusDb.transaction(async (conn) => {
        for (const code of codes) {
          await conn.query("DELETE FROM radcheck WHERE username = ?", [code]);
          await conn.query("DELETE FROM radusergroup WHERE username = ?", [code]);
          await conn.query("DELETE FROM hotspot_vouchers WHERE code = ?", [code]);
        }
      });
    }
    if (req.auditLog) req.auditLog('VOUCHER_BATCH_DELETE', { batchId, deleted: codes.length }).catch(() => {});
    res.json({ success: true, deleted: codes.length, message: 'Deleted ' + codes.length + ' unused voucher(s) from batch' });
  } catch (err) {
    console.error('Voucher batch delete error:', err);
    res.status(500).json({ error: 'Failed to delete batch' });
  }
});

// DELETE /api/admin/radius/vouchers/:code — delete a single voucher
router.delete('/vouchers/:code', async (req, res) => {
  try {
    const code = req.params.code;
    await radiusDb.transaction(async (conn) => {
      await conn.query("DELETE FROM radcheck WHERE username = ?", [code]);
      await conn.query("DELETE FROM radusergroup WHERE username = ?", [code]);
      await conn.query("DELETE FROM hotspot_vouchers WHERE code = ?", [code]);
    });
    if (req.auditLog) req.auditLog('VOUCHER_DELETE', { code }).catch(() => {});
    res.json({ success: true, message: 'Voucher ' + code + ' deleted' });
  } catch (err) {
    console.error('Voucher delete error:', err);
    res.status(500).json({ error: 'Failed to delete voucher' });
  }
});

// ─────────────────────────────────────────────────────────────
// HOTSPOT MAC LOGIN (MAB — MAC Authentication Bypass)
// A registered device authenticates by its MAC alone (username=MAC,
// password=MAC) — the hotspot must have login-by=mac (hs-prof does).
// ─────────────────────────────────────────────────────────────

// Normalize any MAC form (aabb.ccdd.eeff, AA-BB-.., aabbccddeeff) to AA:BB:CC:DD:EE:FF
function normMac(raw) {
  const hex = String(raw || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

// Validate/normalise an IPv4 address (for RADIUS Framed-IP-Address / static DHCP lease)
function normIp(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  if (m.slice(1, 5).some(o => Number(o) > 255)) return null;
  return s;
}

// GET /api/admin/radius/mac-devices — list registered devices + live status
router.get('/mac-devices', async (req, res) => {
  try {
    const [rows] = await radiusDb.query(
      `SELECT d.mac, d.label, d.profile, d.enabled, d.created_at, d.created_by, d.notes,
         COALESCE(s.sessions,0) AS sessions, s.last_seen,
         COALESCE(s.online,false) AS online, ip.static_ip
       FROM hotspot_mac_devices d
       LEFT JOIN LATERAL (
         SELECT count(*) AS sessions, max(acctstarttime) AS last_seen,
                bool_or(acctstoptime IS NULL) AS online
         FROM radacct a WHERE a.username = d.mac
       ) s ON true
       LEFT JOIN LATERAL (
         SELECT value AS static_ip FROM radreply
         WHERE username = d.mac AND attribute = 'Framed-IP-Address' LIMIT 1
       ) ip ON true
       ORDER BY d.created_at DESC`);
    const devices = rows.map(r => ({
      ...r,
      status: !r.enabled ? 'disabled' : (r.online ? 'online' : (Number(r.sessions) > 0 ? 'seen' : 'idle')),
    }));
    res.json({ devices, count: devices.length });
  } catch (err) {
    console.error('MAC devices list error:', err);
    res.status(500).json({ error: 'Failed to list MAC devices: ' + err.message });
  }
});

// POST /api/admin/radius/mac-devices — register a device by MAC
router.post('/mac-devices', async (req, res) => {
  try {
    const mac = normMac(req.body.mac);
    if (!mac) return res.status(400).json({ error: 'Invalid MAC address (need 12 hex digits)' });
    const label = (req.body.label || '').toString().slice(0, 120) || null;
    const profile = req.body.profile ? String(req.body.profile) : null;
    const staticIp = req.body.staticIp ? normIp(req.body.staticIp) : null;
    if (req.body.staticIp && !staticIp) return res.status(400).json({ error: 'Invalid static IP address' });

    if (profile) {
      const [pf] = await radiusDb.query("SELECT 1 FROM radgroupreply WHERE groupname = ? LIMIT 1", [profile]);
      if (pf.length === 0) return res.status(400).json({ error: 'Unknown profile: ' + profile });
    }
    const [dupe] = await radiusDb.query("SELECT 1 FROM hotspot_mac_devices WHERE mac = ? LIMIT 1", [mac]);
    if (dupe.length) return res.status(409).json({ error: 'MAC already registered: ' + mac });
    const [clash] = await radiusDb.query("SELECT 1 FROM radcheck WHERE username = ? LIMIT 1", [mac]);
    if (clash.length) return res.status(409).json({ error: 'A RADIUS account already exists for ' + mac });

    const createdBy = req.adminUser?.username || String(req.adminUser?.id || 'admin');
    await radiusDb.transaction(async (conn) => {
      // MAB: authorize on the MAC (User-Name) alone. Do NOT use Cleartext-Password —
      // the DHCP server sends whatever /ip/dhcp-server/config radius-password holds
      // (a free-form string, "empty" by default), so PAP can never match the MAC.
      // No Simultaneous-Use: the DHCP server re-authenticates the same MAC on every lease
      // renewal while accounting is still open, which reads as a duplicate login and gets
      // rejected — and with interim-update=0s a lost Acct-Stop locks the device out for good.
      await conn.query("INSERT INTO radcheck (username,attribute,op,value) VALUES (?, 'Auth-Type', ':=', 'Accept')", [mac]);
      if (profile) await conn.query("INSERT INTO radusergroup (username,groupname,priority) VALUES (?, ?, 1)", [mac, profile]);
      if (staticIp) await conn.query("INSERT INTO radreply (username,attribute,op,value) VALUES (?, 'Framed-IP-Address', ':=', ?)", [mac, staticIp]);
      await conn.query("INSERT INTO hotspot_mac_devices (mac,label,profile,created_by) VALUES (?, ?, ?, ?)", [mac, label, profile, createdBy]);
    });
    if (req.auditLog) req.auditLog('MAC_DEVICE_REGISTER', { mac, profile, staticIp }).catch(() => {});
    res.status(201).json({ success: true, mac, label, profile, staticIp, message: 'Device registered for MAC login: ' + mac });
  } catch (err) {
    console.error('MAC device register error:', err);
    res.status(500).json({ error: 'Failed to register device: ' + err.message });
  }
});

// PUT /api/admin/radius/mac-devices/:mac/profile — move a device to another plan
//
// Until now the only way to change a registered device's plan was to delete it and
// register it again, which threw away the label, the created_by/created_at trail and
// the audit history for what is really a one-field edit.
//
// The plan lives in two places that must agree: hotspot_mac_devices.profile (what the
// CRM shows) and radusergroup.groupname (what RADIUS actually answers with). They are
// written in one transaction so a failure cannot leave the CRM claiming one plan while
// subscribers are served another.
router.put('/mac-devices/:mac/profile', async (req, res) => {
  try {
    const mac = normMac(req.params.mac);
    if (!mac) return res.status(400).json({ error: 'Invalid MAC' });
    const profile = req.body.profile ? String(req.body.profile) : null;

    const [d] = await radiusDb.query("SELECT mac, profile, enabled, subscriber_id FROM hotspot_mac_devices WHERE mac = ?", [mac]);
    if (!d.length) return res.status(404).json({ error: 'Device not found: ' + mac });
    const from = d[0].profile || null;
    if (from === profile) return res.json({ success: true, mac, profile, unchanged: true });

    if (profile) {
      const [pf] = await radiusDb.query("SELECT 1 FROM radgroupreply WHERE groupname = ? LIMIT 1", [profile]);
      if (pf.length === 0) return res.status(400).json({ error: 'Unknown profile: ' + profile });
    }

    await radiusDb.transaction(async (conn) => {
      await conn.query("UPDATE hotspot_mac_devices SET profile = ? WHERE mac = ?", [profile, mac]);
      // A disabled device deliberately has no RADIUS rows; leave it that way so the
      // toggle handler stays the single place that re-arms authorization.
      if (d[0].enabled) {
        await conn.query("DELETE FROM radusergroup WHERE username = ?", [mac]);
        if (profile) await conn.query("INSERT INTO radusergroup (username,groupname,priority) VALUES (?, ?, 1)", [mac, profile]);
      }
    });

    if (req.auditLog) req.auditLog('MAC_DEVICE_PROFILE_CHANGE', { mac, from, to: profile }).catch(() => {});

    // The router builds its queue once, at authentication, so a live session keeps the
    // old rate until it authenticates again. Say so rather than let the UI imply the
    // change is already in force.
    const [live] = await radiusDb.query("SELECT 1 FROM radacct WHERE upper(username) = upper(?) AND acctstoptime IS NULL LIMIT 1", [mac]);
    res.json({
      success: true, mac, from, profile,
      appliesNow: live.length === 0,
      message: live.length
        ? 'Plan changed. The device is online and keeps its current speed until it reconnects.'
        : 'Plan changed.',
    });
  } catch (err) {
    console.error('MAC device profile change error:', err);
    res.status(500).json({ error: 'Failed to change plan: ' + err.message });
  }
});

// PUT /api/admin/radius/mac-devices/:mac/toggle — enable/disable MAC login
router.put('/mac-devices/:mac/toggle', async (req, res) => {
  try {
    const mac = normMac(req.params.mac);
    if (!mac) return res.status(400).json({ error: 'Invalid MAC' });
    const [d] = await radiusDb.query("SELECT mac, profile, enabled FROM hotspot_mac_devices WHERE mac = ?", [mac]);
    if (!d.length) return res.status(404).json({ error: 'Device not found: ' + mac });
    const nowEnabled = !d[0].enabled;
    await radiusDb.transaction(async (conn) => {
      if (nowEnabled) {
        // re-arm the RADIUS authorization (MAB — username only, no Simultaneous-Use;
        // see the register handler for why)
        await conn.query("INSERT INTO radcheck (username,attribute,op,value) VALUES (?, 'Auth-Type', ':=', 'Accept')", [mac]);
        if (d[0].profile) await conn.query("INSERT INTO radusergroup (username,groupname,priority) VALUES (?, ?, 1)", [mac, d[0].profile]);
      } else {
        // disable = remove RADIUS creds so auth fails, keep the record
        await conn.query("DELETE FROM radcheck WHERE username = ?", [mac]);
        await conn.query("DELETE FROM radusergroup WHERE username = ?", [mac]);
      }
      await conn.query("UPDATE hotspot_mac_devices SET enabled = ? WHERE mac = ?", [nowEnabled, mac]);
    });
    // The display MAC prefers an enabled device, so disabling one can change which device
    // the header should be naming.
    const [owner] = await radiusDb.query('SELECT subscriber_id FROM hotspot_mac_devices WHERE mac = ?', [mac]);
    if (owner[0] && owner[0].subscriber_id) await deviceRelease.syncSubscriberMac(radiusDb, owner[0].subscriber_id);
    if (req.auditLog) req.auditLog('MAC_DEVICE_TOGGLE', { mac, enabled: nowEnabled }).catch(() => {});
    res.json({ success: true, mac, enabled: nowEnabled });
  } catch (err) {
    console.error('MAC device toggle error:', err);
    res.status(500).json({ error: 'Failed to toggle device' });
  }
});

// DELETE /api/admin/radius/mac-devices/:mac — remove a registered device
router.delete('/mac-devices/:mac', async (req, res) => {
  try {
    const mac = normMac(req.params.mac);
    if (!mac) return res.status(400).json({ error: 'Invalid MAC' });
    // What the device WAS, captured before the delete — otherwise the audit entry says
    // only "a MAC was removed" and there is no way to put it back.
    const [was] = await radiusDb.query(
      'SELECT subscriber_id, profile, label, enabled FROM hotspot_mac_devices WHERE mac = ?', [mac]);

    await radiusDb.transaction(async (conn) => {
      await conn.query("DELETE FROM radcheck WHERE username = ?", [mac]);
      await conn.query("DELETE FROM radusergroup WHERE username = ?", [mac]);
      await conn.query("DELETE FROM radreply WHERE username = ?", [mac]);
      await conn.query("DELETE FROM hotspot_mac_devices WHERE mac = ?", [mac]);
    });

    // Dropping the whitelist row only stops the NEXT authentication. Without this the
    // device keeps its address for up to 24h, that address stays unusable by anyone else
    // under arp=reply-only, and its accounting session never closes so the UI reports it
    // online for ever.
    const released = await deviceRelease.releaseDevice(req.prisma, radiusDb, mac);

    // releaseDevice clears the display MAC when it pointed at the deleted device. If the
    // subscriber still has another registered device, show that one rather than nothing.
    const displayMac = was[0]
      ? await deviceRelease.syncSubscriberMac(radiusDb, was[0].subscriber_id) : null;

    if (req.auditLog) {
      req.auditLog('MAC_DEVICE_DELETE', {
        mac,
        was: was[0] || null,
        released: {
          leases: released.leasesFreed, arp: released.arpRemoved,
          addressList: released.addressListRemoved, sessionsClosed: released.sessionsClosed,
          subscriberMacCleared: released.subscriberMacUpdated,
        },
        displayMac,
        routerApplied: released.router.ok, routerError: released.router.error || null,
      }).catch(() => {});
    }
    res.json({
      success: true, displayMac,
      message: 'Device ' + mac + ' removed' +
        (released.leasesFreed.length ? ' and lease ' + released.leasesFreed.join(', ') + ' released' : ''),
      released,
    });
  } catch (err) {
    console.error('MAC device delete error:', err);
    res.status(500).json({ error: 'Failed to remove device' });
  }
});

// ─────────────────────────────────────────────────────────────
// SUBSCRIBER-LINKED HOTSPOT ACCESS
// Everything a subscriber can have on the hotspot, tied to their id:
//   • MAC login (auto-auth by device)
//   • Hotspot login (username/password at the captive portal)
//   • Prepaid vouchers issued under the subscriber
// MAC toggle/delete reuse /mac-devices/:mac/*, voucher delete reuses /vouchers/:code.
// ─────────────────────────────────────────────────────────────

// GET aggregator — all hotspot access for one subscriber + profiles for the forms
router.get('/subscriber/:subscriberId/hotspot', async (req, res) => {
  try {
    const sid = req.params.subscriberId;
    const [macs] = await radiusDb.query(
      // The lease address comes from the newest accounting session: for an online
      // device that is the open session's live address, for an offline one it is the
      // address it last held, which is still what you need to find it on the router.
      // host() strips the /32 the inet column carries.
      `SELECT d.mac, d.label, d.profile, d.enabled, d.created_at,
         COALESCE(s.online,false) AS online, COALESCE(s.sessions,0) AS sessions,
         s.ip, s.last_start, s.last_stop
       FROM hotspot_mac_devices d
       LEFT JOIN LATERAL (SELECT bool_or(a.acctstoptime IS NULL) AS online, count(*) AS sessions,
                            (array_agg(host(a.framedipaddress) ORDER BY a.acctstarttime DESC)
                               FILTER (WHERE a.framedipaddress IS NOT NULL))[1] AS ip,
                            max(a.acctstarttime) AS last_start,
                            max(a.acctstoptime)  AS last_stop
                          FROM radacct a WHERE a.username = d.mac) s ON true
       WHERE d.subscriber_id = ? ORDER BY d.created_at DESC`, [sid]);
    const macDevices = macs.map(m => ({ ...m, status: !m.enabled ? 'disabled' : (m.online ? 'online' : (Number(m.sessions) > 0 ? 'seen' : 'idle')) }));

    const [logins] = await radiusDb.query(
      `SELECT h.username, h.profile, h.enabled, h.created_at,
         COALESCE(s.online,false) AS online
       FROM subscriber_hotspot h
       LEFT JOIN LATERAL (SELECT bool_or(acctstoptime IS NULL) AS online
                          FROM radacct a WHERE a.username = h.username) s ON true
       WHERE h.subscriber_id = ? ORDER BY h.created_at DESC LIMIT 1`, [sid]);
    const hotspotLogin = logins[0] || null;

    const [vch] = await radiusDb.query(
      `SELECT v.code, v.profile, v.price, v.created_at,
         COALESCE(s.sessions,0) AS sessions, COALESCE(s.online,false) AS online
       FROM hotspot_vouchers v
       LEFT JOIN LATERAL (SELECT count(*) AS sessions, bool_or(acctstoptime IS NULL) AS online
                          FROM radacct a WHERE a.username = v.code) s ON true
       WHERE v.subscriber_id = ? ORDER BY v.created_at DESC`, [sid]);
    const vouchers = vch.map(v => ({ ...v, status: v.online ? 'online' : (Number(v.sessions) > 0 ? 'used' : 'unused') }));

    // Every plan group, not just voucher-%. The old filter meant the MAC-login and
    // hotspot-login forms could only offer voucher rates, so registering a device for a
    // Fiber 300 subscriber silently capped them at the cheapest voucher speed.
    const [profiles] = await radiusDb.query(
      `SELECT groupname AS profile,
         MAX(CASE WHEN attribute='Mikrotik-Rate-Limit' THEN value END) AS rate_limit,
         MAX(CASE WHEN attribute='Session-Timeout' THEN value END) AS session_timeout
       FROM radgroupreply GROUP BY groupname ORDER BY groupname`);

    // Vouchers really are prepaid products, so that form keeps the voucher-only list.
    const voucherProfiles = profiles.filter(p => /^voucher-/.test(p.profile));

    // Pre-select the group the subscriber actually pays for. Some plans have a
    // radius_group with no matching radgroupreply rows; fall back to no selection
    // rather than pointing the form at a group that isn't in the list.
    const [planRows] = await radiusDb.query(
      `SELECT p.radius_group FROM subscribers s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.id = ? LIMIT 1`, [sid]);
    const planGroup = planRows[0] ? planRows[0].radius_group : null;
    const defaultProfile = profiles.some(p => p.profile === planGroup) ? planGroup : null;

    // Restriction state rides along so the panel can render Restrict vs Restore
    // without a second round trip.
    const openRestriction = await restriction.getRestriction(radiusDb, sid);

    res.json({ macDevices, hotspotLogin, vouchers, profiles, voucherProfiles, defaultProfile,
      restricted: !!openRestriction, restriction: openRestriction || null });
  } catch (err) {
    console.error('Subscriber hotspot get error:', err);
    res.status(500).json({ error: 'Failed to load hotspot access: ' + err.message });
  }
});

// POST — register a MAC login for this subscriber
router.post('/subscriber/:subscriberId/hotspot/mac', async (req, res) => {
  try {
    const sid = parseInt(req.params.subscriberId);
    const mac = normMac(req.body.mac);
    if (!mac) return res.status(400).json({ error: 'Invalid MAC address (need 12 hex digits)' });
    const label = (req.body.label || '').toString().slice(0, 120) || null;
    let profile = req.body.profile ? String(req.body.profile) : null;

    // A restricted subscriber who registers another device must not get an unrestricted
    // one — otherwise the restriction is bypassed by adding a second router.
    const openR = await restriction.getRestriction(radiusDb, sid);
    if (openR) profile = restriction.RESTRICTED_GROUP;
    if (profile) { const [pf] = await radiusDb.query("SELECT 1 FROM radgroupreply WHERE groupname = ? LIMIT 1", [profile]); if (!pf.length) return res.status(400).json({ error: 'Unknown profile: ' + profile }); }
    const [dupe] = await radiusDb.query("SELECT 1 FROM hotspot_mac_devices WHERE mac = ? LIMIT 1", [mac]); if (dupe.length) return res.status(409).json({ error: 'MAC already registered: ' + mac });
    const [clash] = await radiusDb.query("SELECT 1 FROM radcheck WHERE username = ? LIMIT 1", [mac]); if (clash.length) return res.status(409).json({ error: 'A RADIUS account already exists for ' + mac });
    const createdBy = req.adminUser?.username || String(req.adminUser?.id || 'admin');
    // Under a full cutoff the new device must be refused too, or the customer gets
    // back online simply by plugging in a different router.
    const authType = (openR && openR.mode === 'full') ? 'Reject' : 'Accept';
    await radiusDb.transaction(async (conn) => {
      // MAB: authorize on the MAC (User-Name) alone, no Simultaneous-Use — see the
      // /mac-devices register handler
      await conn.query("INSERT INTO radcheck (username,attribute,op,value) VALUES (?, 'Auth-Type', ':=', ?)", [mac, authType]);
      if (profile) await conn.query("INSERT INTO radusergroup (username,groupname,priority) VALUES (?, ?, 1)", [mac, profile]);
      await conn.query("INSERT INTO hotspot_mac_devices (mac,label,profile,created_by,subscriber_id) VALUES (?, ?, ?, ?, ?)", [mac, label, profile, createdBy, sid]);
    });
    // Fill in the panel's MAC ADDRESS field. Without this the registration succeeds in
    // full — RADIUS accepts the device — while the subscriber's header still reads "—",
    // which reads as a failure and has been reported as one.
    const displayMac = await deviceRelease.syncSubscriberMac(radiusDb, sid);
    if (req.auditLog) req.auditLog('MAC_DEVICE_REGISTER', { mac, profile, subscriberId: sid }).catch(() => {});
    res.status(201).json({ success: true, mac, displayMac });
  } catch (err) {
    console.error('Subscriber MAC register error:', err);
    res.status(500).json({ error: 'Failed to register device: ' + err.message });
  }
});

// POST — swap a device's MAC in place (ONU died, router replaced, board swapped)
//
// A replacement is deliberately NOT delete-then-add. Deleting drops the radcheck and
// radusergroup rows, and if the subscriber is under an open restriction the snapshot in
// subscriber_restrictions then names a MAC that no longer exists — so lifting the
// restriction would silently leave the replacement stranded on plan-restricted. Both of
// this week's outages came from exactly that pattern, with nothing in the audit trail
// saying what had been removed.
//
// Renaming the RADIUS username in place keeps everything that describes the SERVICE
// (enabled flag, plan group, Auth-Type — Accept or Reject under a live cutoff, the
// device row's id and created_at) and changes only the identity of the hardware.
// Accounting history stays under the old MAC, which is correct: those sessions really
// were the old unit.
router.post('/subscriber/:subscriberId/hotspot/mac/:oldMac/replace', async (req, res) => {
  try {
    const sid = parseInt(req.params.subscriberId);
    if (!Number.isInteger(sid)) return res.status(400).json({ error: 'Invalid subscriber id' });
    const oldMac = normMac(req.params.oldMac);
    const newMac = normMac(req.body.mac || req.body.newMac);
    if (!oldMac || !newMac) return res.status(400).json({ error: 'Invalid MAC address (need 12 hex digits)' });
    if (oldMac === newMac) return res.status(400).json({ error: 'The replacement MAC is the same as the old one' });
    const reason = (req.body.reason || '').toString().slice(0, 200).trim() || null;

    // Scoped to the subscriber on purpose: this endpoint must never be able to move a
    // device between accounts, only change the hardware on one.
    const [own] = await radiusDb.query(
      'SELECT mac, label, profile, enabled FROM hotspot_mac_devices WHERE mac = ? AND subscriber_id = ?',
      [oldMac, sid]);
    if (!own.length) return res.status(404).json({ error: oldMac + ' is not registered to this subscriber' });
    const old = own[0];

    const [dupe] = await radiusDb.query(
      'SELECT subscriber_id FROM hotspot_mac_devices WHERE mac = ? LIMIT 1', [newMac]);
    if (dupe.length) {
      return res.status(409).json({ error: 'Already registered' +
        (dupe[0].subscriber_id ? ' to subscriber #' + dupe[0].subscriber_id : '') + ': ' + newMac });
    }
    const [clash] = await radiusDb.query('SELECT 1 FROM radcheck WHERE username = ? LIMIT 1', [newMac]);
    if (clash.length) return res.status(409).json({ error: 'A RADIUS account already exists for ' + newMac });

    const by = req.adminUser?.username || String(req.adminUser?.id || 'admin');
    const openR = await restriction.getRestriction(radiusDb, sid);
    const label = req.body.label !== undefined
      ? (String(req.body.label).slice(0, 120).trim() || null)
      : old.label;
    const note = 'Replaced ' + oldMac + ' on ' + new Date().toISOString().slice(0, 10) +
      ' by ' + by + (reason ? ' — ' + reason : '');

    await radiusDb.transaction(async (conn) => {
      await conn.query('UPDATE radcheck SET username = ? WHERE username = ?', [newMac, oldMac]);
      await conn.query('UPDATE radusergroup SET username = ? WHERE username = ?', [newMac, oldMac]);
      await conn.query('UPDATE radreply SET username = ? WHERE username = ?', [newMac, oldMac]);
      await conn.query(
        `UPDATE hotspot_mac_devices
            SET mac = ?, label = ?,
                notes = ltrim(coalesce(notes || E'\n', '') || ?, E'\n')
          WHERE mac = ?`,
        [newMac, label, note, oldMac]);

      // Keep an open restriction pointing at hardware that exists. Without this the
      // snapshot still names the dead MAC and Restore access would put the customer's
      // old unit back on its plan while leaving the new one cut off.
      if (openR) {
        await conn.query(
          `UPDATE subscriber_restrictions
              SET devices = (SELECT jsonb_agg(
                     CASE WHEN e->>'mac' = ? THEN jsonb_set(e, '{mac}', to_jsonb(?::text)) ELSE e END)
                   FROM jsonb_array_elements(devices) e)
            WHERE id = ?`,
          [oldMac, newMac, openR.id]);
      }
    });

    // Retire the old hardware completely: free its lease and ARP entry, close its
    // accounting session, and point the subscriber's display MAC at the replacement so
    // the Register device prefill cannot re-offer equipment that is out of service.
    const released = await deviceRelease.releaseDevice(req.prisma, radiusDb, oldMac,
      { replacementMac: newMac });
    const router_ = { ...released.router, leaseFreed: released.leasesFreed[0] || null, addressList: null };

    // The list was keyed on the old lease; re-derive it from the new device's address.
    if (openR && router_.ok) {
      try {
        router_.addressList = await restriction.syncAddressList(req.prisma, radiusDb);
      } catch (e) {
        router_.ok = false;
        router_.error = e.message;
        console.error('[mac-replace] address-list resync failed:', e.message);
      }
    }

    // releaseDevice already repointed the display MAC via replacementMac; this makes it
    // authoritative for subscribers whose column was never populated in the first place.
    await deviceRelease.syncSubscriberMac(radiusDb, sid);

    if (req.auditLog) {
      req.auditLog('MAC_DEVICE_REPLACE', {
        subscriberId: sid, oldMac, newMac, reason,
        profile: old.profile, enabled: old.enabled,
        restrictedAtTime: !!openR, restrictionId: openR ? openR.id : null,
        released: {
          leases: released.leasesFreed, arp: released.arpRemoved,
          addressList: released.addressListRemoved,
          sessionsClosed: released.sessionsClosed,
          subscriberMacUpdated: released.subscriberMacUpdated,
        },
        leaseFreed: router_.leaseFreed, routerApplied: router_.ok,
        routerError: router_.error || null,
      }).catch(() => {});
    }

    res.json({
      success: true, oldMac, newMac, profile: old.profile, enabled: old.enabled,
      restricted: !!openR, released,
      message: openR
        ? 'Swapped to ' + newMac + ' — the subscriber is still restricted, so the new device stays cut off until access is restored'
        : (router_.ok
            ? 'Swapped to ' + newMac + '. The new device can connect immediately.'
            : 'Swapped to ' + newMac + ' in RADIUS, but the router was not reachable — the old lease may linger until it expires'),
      routerApplied: router_.ok,
      routerError: router_.error || null,
      leaseFreed: router_.leaseFreed,
    });
  } catch (err) {
    console.error('MAC replace error:', err);
    res.status(500).json({ error: 'Failed to replace device: ' + err.message });
  }
});

// GET — devices knocking at the door: MACs that RADIUS refused because they are not
// registered to anybody. Every refusal is already recorded in radpostauth; nothing here
// is new data, it just stops the information being invisible.
//
// This exists because the alternative is transcribing a MAC off a CPE's status page, and
// that page routinely shows a different MAC to the one actually requesting DHCP — an ONU
// can hold several WAN connections, and only one of them is asking. Three separate
// call-outs this week were spent discovering that by hand.
//
// Read-only, and it deliberately does not auto-register anything: a device that gets
// service merely by plugging in is a device anybody can plug in.
router.get('/devices/unknown', async (req, res) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 720);
    const [rows] = await radiusDb.query(
      `SELECT upper(p.username) AS mac,
              count(*) AS attempts,
              count(*) FILTER (WHERE p.reply = 'Access-Reject') AS rejects,
              min(p.authdate) AS first_seen,
              max(p.authdate) AS last_seen,
              bool_or(p.reply = 'Access-Accept') AS ever_accepted
         FROM radpostauth p
        WHERE p.authdate > now() - (? || ' hours')::interval
          -- MAC-shaped only: portal logins and voucher codes also land in this table
          AND p.username ~* '^([0-9a-f]{2}:){5}[0-9a-f]{2}$'
          AND upper(p.username) NOT IN (SELECT upper(mac) FROM hotspot_mac_devices)
          AND upper(p.username) NOT IN (SELECT upper(username) FROM radcheck)
        GROUP BY 1
        HAVING count(*) FILTER (WHERE p.reply = 'Access-Reject') > 0
        ORDER BY max(p.authdate) DESC
        LIMIT 100`, [String(hours)]);

    // A prefix already in service here is weak evidence the device is your own CPE
    // rather than a stranger's. Weak, but it is the only signal available offline.
    const [known] = await radiusDb.query(
      `SELECT DISTINCT substring(upper(mac) from 1 for 8) AS oui FROM hotspot_mac_devices`);
    const knownOuis = new Set(known.map(k => k.oui));

    res.json({
      windowHours: hours,
      devices: rows.map(r => ({
        mac: r.mac,
        attempts: Number(r.attempts),
        rejects: Number(r.rejects),
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        everAccepted: r.ever_accepted,
        familiarVendor: knownOuis.has(r.mac.slice(0, 8)),
      })),
    });
  } catch (err) {
    console.error('Unknown device scan error:', err);
    res.status(500).json({ error: 'Failed to list unknown devices: ' + err.message });
  }
});

// GET/POST — find and clear residue left by devices that are no longer registered:
// accounting sessions still open, leases still held on the MAC-authenticated server, and
// subscriber display MACs pointing at nothing. GET reports; POST with {confirm:true}
// applies. Deliberately two steps — this deletes router state.
router.get('/devices/orphans', async (req, res) => {
  try {
    res.json(await deviceRelease.releaseOrphans(req.prisma, radiusDb, { dryRun: true }));
  } catch (err) {
    console.error('Orphan scan error:', err);
    res.status(500).json({ error: 'Failed to scan for orphaned device state: ' + err.message });
  }
});

router.post('/devices/orphans/release', async (req, res) => {
  try {
    if (req.body.confirm !== true) {
      return res.status(400).json({ error: 'Send {"confirm": true} to apply. GET /devices/orphans first to see what would change.' });
    }
    const out = await deviceRelease.releaseOrphans(req.prisma, radiusDb, { dryRun: false });
    if (req.auditLog) {
      req.auditLog('DEVICE_ORPHANS_RELEASED', {
        sessions: out.staleSessions, leases: out.staleLeases,
        subscriberMacs: out.staleSubscriberMacs,
      }).catch(() => {});
    }
    res.json(out);
  } catch (err) {
    console.error('Orphan release error:', err);
    res.status(500).json({ error: 'Failed to release orphaned device state: ' + err.message });
  }
});

// POST — create a hotspot username/password login for this subscriber
router.post('/subscriber/:subscriberId/hotspot/login', async (req, res) => {
  try {
    const sid = parseInt(req.params.subscriberId);
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const profile = req.body.profile ? String(req.body.profile) : null;
    if (!username) return res.status(400).json({ error: 'Username is required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
    if (profile) { const [pf] = await radiusDb.query("SELECT 1 FROM radgroupreply WHERE groupname = ? LIMIT 1", [profile]); if (!pf.length) return res.status(400).json({ error: 'Unknown profile: ' + profile }); }
    const [clash] = await radiusDb.query("SELECT 1 FROM radcheck WHERE username = ? LIMIT 1", [username]); if (clash.length) return res.status(409).json({ error: 'Username already exists: ' + username });
    const createdBy = req.adminUser?.username || String(req.adminUser?.id || 'admin');
    await radiusDb.transaction(async (conn) => {
      await conn.query("INSERT INTO radcheck (username,attribute,op,value) VALUES (?, 'Cleartext-Password', ':=', ?)", [username, password]);
      if (profile) await conn.query("INSERT INTO radusergroup (username,groupname,priority) VALUES (?, ?, 1)", [username, profile]);
      await conn.query("INSERT INTO subscriber_hotspot (subscriber_id,username,profile,created_by) VALUES (?, ?, ?, ?)", [sid, username, profile, createdBy]);
    });
    if (req.auditLog) req.auditLog('HOTSPOT_LOGIN_CREATE', { username, subscriberId: sid }).catch(() => {});
    res.status(201).json({ success: true, username });
  } catch (err) {
    console.error('Subscriber hotspot login error:', err);
    res.status(500).json({ error: 'Failed to create hotspot login: ' + err.message });
  }
});

// DELETE — remove a subscriber's hotspot login
router.delete('/subscriber/:subscriberId/hotspot/login/:username', async (req, res) => {
  try {
    const username = req.params.username;
    await radiusDb.transaction(async (conn) => {
      await conn.query("DELETE FROM radcheck WHERE username = ?", [username]);
      await conn.query("DELETE FROM radusergroup WHERE username = ?", [username]);
      await conn.query("DELETE FROM subscriber_hotspot WHERE username = ?", [username]);
    });
    if (req.auditLog) req.auditLog('HOTSPOT_LOGIN_DELETE', { username }).catch(() => {});
    res.json({ success: true, message: 'Hotspot login ' + username + ' removed' });
  } catch (err) {
    console.error('Subscriber hotspot login delete error:', err);
    res.status(500).json({ error: 'Failed to remove hotspot login' });
  }
});

// POST — generate prepaid vouchers under this subscriber
router.post('/subscriber/:subscriberId/hotspot/vouchers', async (req, res) => {
  try {
    const sid = parseInt(req.params.subscriberId);
    const profile = String(req.body.profile || '');
    const count = parseInt(req.body.count);
    const price = (req.body.price === '' || req.body.price == null) ? null : Number(req.body.price);
    if (!profile || !count || count < 1) return res.status(400).json({ error: 'Required: profile, count (>=1)' });
    if (count > 200) return res.status(400).json({ error: 'Max 200 vouchers per batch' });
    const [pf] = await radiusDb.query("SELECT 1 FROM radgroupreply WHERE groupname = ? LIMIT 1", [profile]); if (!pf.length) return res.status(400).json({ error: 'Unknown profile: ' + profile });
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const gen = () => { const b = crypto.randomBytes(8); let s = ''; for (let i = 0; i < 8; i++) s += A[b[i] % A.length]; return s; };
    const batchId = 'B' + Date.now();
    const createdBy = req.adminUser?.username || String(req.adminUser?.id || 'admin');
    const codes = [];
    await radiusDb.transaction(async (conn) => {
      for (let i = 0; i < count; i++) {
        let code = '', exists = true, tries = 0;
        while (exists && tries < 12) { code = gen(); const [e] = await conn.query("SELECT 1 FROM radcheck WHERE username = ? LIMIT 1", [code]); exists = e.length > 0; tries++; }
        await conn.query("INSERT INTO radcheck (username,attribute,op,value) VALUES (?, 'Cleartext-Password', ':=', ?)", [code, code]);
        await conn.query("INSERT INTO radcheck (username,attribute,op,value) VALUES (?, 'Simultaneous-Use', ':=', '1')", [code]);
        await conn.query("INSERT INTO radusergroup (username,groupname,priority) VALUES (?, ?, 1)", [code, profile]);
        await conn.query("INSERT INTO hotspot_vouchers (code,profile,batch_id,price,created_by,subscriber_id) VALUES (?, ?, ?, ?, ?, ?)", [code, profile, batchId, price, createdBy, sid]);
        codes.push(code);
      }
    });
    if (req.auditLog) req.auditLog('VOUCHER_GENERATE', { profile, count: codes.length, batchId, subscriberId: sid }).catch(() => {});
    res.status(201).json({ success: true, batchId, profile, count: codes.length, codes });
  } catch (err) {
    console.error('Subscriber voucher generate error:', err);
    res.status(500).json({ error: 'Failed to generate vouchers: ' + err.message });
  }
});

// GET connection type for a subscriber (+ what's actually provisioned)
router.get('/subscriber/:subscriberId/connection-type', async (req, res) => {
  try {
    const sid = parseInt(req.params.subscriberId);
    const [rows]   = await radiusDb.query("SELECT connection_type FROM subscribers WHERE id = ?", [sid]);
    const [pppoe]  = await radiusDb.query("SELECT 1 FROM subscriber_radius WHERE subscriber_id = ? LIMIT 1", [sid]);
    const [hs]     = await radiusDb.query("SELECT 1 FROM subscriber_hotspot WHERE subscriber_id = ? LIMIT 1", [sid]);
    const type = (rows[0] && rows[0].connection_type) || (hs.length && !pppoe.length ? 'hotspot' : 'pppoe');
    res.json({ connection_type: type, hasPppoe: pppoe.length > 0, hasHotspot: hs.length > 0 });
  } catch (err) {
    console.error('Connection type get error:', err);
    res.status(500).json({ error: 'Failed to read connection type' });
  }
});

// PUT connection type — clean switch: remove the OLD type's access, set the new type.
// PPPoE→Hotspot removes the PPPoE credential; Hotspot→PPPoE removes the hotspot login + MAC
// devices (access creds). Vouchers are financial records and are preserved either way.
router.put('/subscriber/:subscriberId/connection-type', async (req, res) => {
  try {
    const sid = parseInt(req.params.subscriberId);
    const type = String(req.body.type || '').toLowerCase();
    if (!['pppoe', 'hotspot'].includes(type)) return res.status(400).json({ error: "type must be 'pppoe' or 'hotspot'" });

    // Captured before the transaction destroys them. This switch has twice taken a
    // customer offline with an audit entry that recorded only the new type, leaving no
    // record of which MACs and profiles were deleted or how to restore them.
    const [doomed] = await radiusDb.query(
      type === 'pppoe'
        ? 'SELECT mac, profile, label FROM hotspot_mac_devices WHERE subscriber_id = ?'
        : 'SELECT null::text AS mac, null::text AS profile, null::text AS label WHERE false',
      type === 'pppoe' ? [sid] : []);

    await radiusDb.transaction(async (conn) => {
      if (type === 'hotspot') {
        // switching TO hotspot → remove the PPPoE credential
        const [sr] = await conn.query("SELECT radius_username FROM subscriber_radius WHERE subscriber_id = ?", [sid]);
        for (const r of sr) {
          await conn.query("DELETE FROM radcheck    WHERE username = ?", [r.radius_username]);
          await conn.query("DELETE FROM radusergroup WHERE username = ?", [r.radius_username]);
          await conn.query("DELETE FROM radreply     WHERE username = ?", [r.radius_username]);
        }
        await conn.query("DELETE FROM subscriber_radius WHERE subscriber_id = ?", [sid]);
      } else {
        // switching TO pppoe → remove hotspot login(s) + MAC devices (access creds)
        const [sh] = await conn.query("SELECT username FROM subscriber_hotspot WHERE subscriber_id = ?", [sid]);
        for (const h of sh) {
          await conn.query("DELETE FROM radcheck    WHERE username = ?", [h.username]);
          await conn.query("DELETE FROM radusergroup WHERE username = ?", [h.username]);
        }
        await conn.query("DELETE FROM subscriber_hotspot WHERE subscriber_id = ?", [sid]);
        const [macs] = await conn.query("SELECT mac FROM hotspot_mac_devices WHERE subscriber_id = ?", [sid]);
        for (const m of macs) {
          await conn.query("DELETE FROM radcheck    WHERE username = ?", [m.mac]);
          await conn.query("DELETE FROM radusergroup WHERE username = ?", [m.mac]);
        }
        await conn.query("DELETE FROM hotspot_mac_devices WHERE subscriber_id = ?", [sid]);
      }
      await conn.query("UPDATE subscribers SET connection_type = ? WHERE id = ?", [type, sid]);
    });
    // Same reasoning as a delete: the whitelist row is gone, but the lease, ARP entry and
    // open session are not, and they would keep the address dark and the device "online".
    const released = [];
    for (const m of doomed) {
      released.push(await deviceRelease.releaseDevice(req.prisma, radiusDb, m.mac));
    }
    // Switching to PPPoE leaves no MAC devices at all, so the display MAC must clear.
    await deviceRelease.syncSubscriberMac(radiusDb, sid);

    if (req.auditLog) {
      req.auditLog('CONNECTION_TYPE_SWITCH', {
        subscriberId: sid, type,
        deletedDevices: doomed.map(m => ({ mac: m.mac, profile: m.profile, label: m.label })),
        released: released.map(r => ({ mac: r.mac, leases: r.leasesFreed, sessionsClosed: r.sessionsClosed })),
      }).catch(() => {});
    }
    res.json({ success: true, connection_type: type, deletedDevices: doomed, released });
  } catch (err) {
    console.error('Connection type switch error:', err);
    res.status(500).json({ error: 'Failed to switch connection type: ' + err.message });
  }
});

module.exports = router;
