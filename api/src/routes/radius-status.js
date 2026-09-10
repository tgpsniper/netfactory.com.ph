const express = require('express');
const { execSync } = require('child_process');
const os = require('os');
const adminAuth = require('../middleware/adminAuth');
const router = express.Router();

// ── Apply admin auth to all routes ──────────────────────────
// Mounted at /api/admin/radius-status. Without this the endpoint served
// hostname, kernel, CPU/RAM/disk, every interface IP and the full NAS list
// (including the RADIUS NAS address) to unauthenticated callers.
router.use(adminAuth());

// RADIUS is now LOCAL — no SSH needed
function ssh(cmd, fallback = '') {
  try {
    const { execSync } = require('child_process');
    return execSync(cmd, { timeout: 10000, encoding: 'utf8' }).trim();
  } catch (e) { return fallback; }
}

// Helper: run local command
function run(cmd, fallback = '') {
  try { return execSync(cmd, { timeout: 5000, encoding: 'utf8' }).trim(); }
  catch { return fallback; }
}

// ============================================
// GET /api/admin/radius-status/status
// ============================================
router.get('/status', async (req, res) => {
  try {
    // === System stats (local commands — RADIUS runs on this box) ===
    // CPU
    const cpuCount = parseInt(ssh('nproc', '0')) || 0;
    const cpuModel = ssh("cat /proc/cpuinfo | grep 'model name' | head -1 | cut -d: -f2", 'Unknown').trim();
    const cpuUsageRaw = ssh("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'", "0");
    const cpuUsage = parseFloat(cpuUsageRaw) || 0;
    const loadAvgRaw = ssh("cat /proc/loadavg | awk '{print $1,$2,$3}'", "0 0 0").split(/\s+/).map(Number);

    // RAM
    const memRaw = ssh("free -b | grep Mem | awk '{print $2,$3,$4,$6,$7}'", "0 0 0 0 0");
    const memParts = memRaw.split(/\s+/).map(Number);
    const memory = {
      total: memParts[0] || 0, used: memParts[1] || 0, free: memParts[2] || 0,
      buffCache: memParts[3] || 0, available: memParts[4] || 0,
      usePct: memParts[0] > 0 ? Math.round((memParts[1] / memParts[0]) * 100) : 0,
    };

    // Swap
    const swapRaw = ssh("free -b | grep Swap | awk '{print $2,$3,$4}'", "0 0 0");
    const swapParts = swapRaw.split(/\s+/).map(Number);
    const swap = { total: swapParts[0] || 0, used: swapParts[1] || 0, free: swapParts[2] || 0 };

    // Disk
    const diskRaw = ssh("df -B1 / | tail -1 | awk '{print $2,$3,$4,$5}'", "0 0 0 0");
    const diskParts = diskRaw.split(/\s+/);
    const disk = {
      total: parseInt(diskParts[0]) || 0, used: parseInt(diskParts[1]) || 0,
      available: parseInt(diskParts[2]) || 0, usePct: parseInt(diskParts[3]) || 0,
    };

    // Uptime
    const uptimeSecs = parseInt(ssh("cat /proc/uptime | awk '{print int($1)}'", "0")) || 0;
    const uptimeDays = Math.floor(uptimeSecs / 86400);
    const uptimeHours = Math.floor((uptimeSecs % 86400) / 3600);
    const uptimeMins = Math.floor((uptimeSecs % 3600) / 60);

    // OS
    const hostname = ssh('hostname', 'unknown');
    const osRelease = ssh("lsb_release -ds 2>/dev/null || cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'\"' -f2", 'Linux');
    const kernelVersion = ssh('uname -r', '');

    // Network
    const netRaw = ssh("ip -4 -o addr show | grep -v '127.0.0.1' | awk '{print $2,$4}' | sed 's/\\/.*//'", "");
    const network = netRaw ? netRaw.split('\n').map(line => {
      const [name, ipv4] = line.trim().split(/\s+/);
      return { name, ipv4 };
    }).filter(n => n.ipv4) : [];

    // === FreeRADIUS Service ===
    const freeradiusStatus = ssh('systemctl is-active freeradius', 'inactive');
    const freeradiusVersion = ssh("freeradius -v 2>/dev/null | grep -oiE 'Version [0-9.]+' | head -1 | awk '{print $2}'", 'N/A');
    const freeradiusUptime = ssh("systemctl show freeradius --property=ActiveEnterTimestamp | cut -d= -f2", '');

    // Real health check (replaces the old hardcoded flags): FreeRADIUS is
    // "connected" only if the service is active AND actually listening on 1812.
    const freeradiusListening = ssh("ss -lnuH 'sport = :1812' 2>/dev/null | head -1", '') !== '';
    const radiusConnected = (freeradiusStatus === 'active') && freeradiusListening;
    // Host reachable = we could actually read local system info (derived, not hardcoded).
    const hostReachable = cpuCount > 0 || hostname !== 'unknown';

    // === MariaDB Service ===
    const mariadbStatus = ssh('systemctl is-active postgresql', 'inactive');
    const mariadbVersion = ssh("psql --version 2>/dev/null | awk '{print $3}'", 'N/A');

    // === RADIUS DB stats via MySQL (from CRM's existing radius-db connection) ===
    let radiusDb = {};
    try {
      const pool = require('../config/radius-db');

      // Active sessions
      const [sessRows] = await pool.query("SELECT COUNT(*) as cnt FROM radacct WHERE acctstoptime IS NULL");
      radiusDb.activeSessions = sessRows[0]?.cnt || 0;

      // Total sessions today
      const [todayRows] = await pool.query("SELECT COUNT(*) as cnt FROM radacct WHERE acctstarttime::date = CURRENT_DATE");
      radiusDb.sessionsToday = todayRows[0]?.cnt || 0;

      // NAS devices
      const [nasRows] = await pool.query("SELECT COUNT(*) as cnt FROM nas");
      radiusDb.nasDevices = nasRows[0]?.cnt || 0;

      // NAS list
      const [nasList] = await pool.query("SELECT nasname, shortname, type, description FROM nas ORDER BY shortname LIMIT 50");
      radiusDb.nasList = nasList || [];

      // Total registered users (radcheck)
      const [userRows] = await pool.query("SELECT COUNT(DISTINCT username) as cnt FROM radcheck");
      radiusDb.totalUsers = userRows[0]?.cnt || 0;

      // Auth log stats (last 24 hours) - postauth table
      let authAccepts = 0, authRejects = 0;
      try {
        const [acceptRows] = await pool.query("SELECT COUNT(*) as cnt FROM radpostauth WHERE reply = 'Access-Accept' AND authdate >= NOW() - INTERVAL '1 day'");
        authAccepts = acceptRows[0]?.cnt || 0;
        const [rejectRows] = await pool.query("SELECT COUNT(*) as cnt FROM radpostauth WHERE reply = 'Access-Reject' AND authdate >= NOW() - INTERVAL '1 day'");
        authRejects = rejectRows[0]?.cnt || 0;
      } catch {}
      radiusDb.authAccepts24h = authAccepts;
      radiusDb.authRejects24h = authRejects;

      // Bandwidth usage today (radacct)
      let bandwidthIn = 0, bandwidthOut = 0;
      try {
        const [bwRows] = await pool.query("SELECT COALESCE(SUM(acctinputoctets),0) as total_in, COALESCE(SUM(acctoutputoctets),0) as total_out FROM radacct WHERE acctstarttime::date = CURRENT_DATE");
        bandwidthIn = bwRows[0]?.total_in || 0;
        bandwidthOut = bwRows[0]?.total_out || 0;
      } catch {}
      radiusDb.bandwidthInToday = bandwidthIn;
      radiusDb.bandwidthOutToday = bandwidthOut;

      // Database size
      const [dbSize] = await pool.query("SELECT ROUND(pg_database_size(current_database()) / 1024.0 / 1024.0, 1) AS size_mb");
      radiusDb.dbSizeMB = parseFloat(dbSize[0]?.size_mb) || 0;

      // Table row counts
      const [radacctCount] = await pool.query("SELECT COUNT(*) as cnt FROM radacct");
      const [postauthCount] = await pool.query("SELECT COUNT(*) as cnt FROM radpostauth");
      radiusDb.radacctRows = radacctCount[0]?.cnt || 0;
      radiusDb.postauthRows = postauthCount[0]?.cnt || 0;

      // Top 5 active sessions by duration
      let topSessions = [];
      try {
        const [topRows] = await pool.query(`
          SELECT username, nasipaddress, framedipaddress,
                 ROUND(EXTRACT(EPOCH FROM (NOW() - acctstarttime))/60)::int as duration_min,
                 acctstarttime
          FROM radacct 
          WHERE acctstoptime IS NULL 
          ORDER BY acctstarttime ASC 
          LIMIT 10
        `);
        topSessions = topRows || [];
      } catch {}
      radiusDb.topSessions = topSessions;

    } catch (err) {
      radiusDb.error = 'Could not query RADIUS database: ' + err.message;
    }

    // === MariaDB stats via SSH ===
    const mariaConnections = parseInt(ssh("sudo -u postgres psql -t -c \"SELECT count(*) FROM pg_stat_activity WHERE datname='ispdb';\" 2>/dev/null | tr -d ' '", "0")) || 0;
    const mariaMaxConn = parseInt(ssh("sudo -u postgres psql -t -c \"SHOW max_connections;\" 2>/dev/null | tr -d ' '", "200")) || 200;

    res.json({
      timestamp: new Date().toISOString(),
      connected: radiusConnected,
      sshConnected: hostReachable,
      system: {
        hostname, os: osRelease, kernel: kernelVersion,
        uptime: { seconds: uptimeSecs, days: uptimeDays, hours: uptimeHours, minutes: uptimeMins, formatted: `${uptimeDays}d ${uptimeHours}h ${uptimeMins}m` },
      },
      cpu: {
        model: cpuModel, cores: cpuCount, usage: cpuUsage,
        loadAvg: { '1m': loadAvgRaw[0] || 0, '5m': loadAvgRaw[1] || 0, '15m': loadAvgRaw[2] || 0 },
      },
      memory,
      disk,
      swap,
      network,
      services: {
        freeradius: { status: freeradiusStatus, version: freeradiusVersion, uptime: freeradiusUptime },
        mariadb: { status: mariadbStatus, version: mariadbVersion, connections: mariaConnections, maxConnections: mariaMaxConn },
      },
      radius: radiusDb,
    });
  } catch (err) {
    console.error('RADIUS status error:', err);
    res.status(500).json({ error: 'Failed to fetch RADIUS status' });
  }
});

module.exports = router;
