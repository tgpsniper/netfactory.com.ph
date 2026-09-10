const express = require('express');
const { execSync } = require('child_process');
const os = require('os');
const adminAuth = require('../middleware/adminAuth');
const router = express.Router();

// ── Apply admin auth to all routes ──────────────────────────
// Mounted at /api/admin/system. Without this /status served hostname,
// OS/kernel/Node versions, CPU model and memory figures to anyone.
router.use(adminAuth());

// Helper: run shell command safely
function run(cmd, fallback = '') {
  try { return execSync(cmd, { timeout: 5000, encoding: 'utf8' }).trim(); }
  catch { return fallback; }
}

// ============================================
// GET /api/admin/system/status - Full system stats
// ============================================
router.get('/status', async (req, res) => {
  try {
    // === CPU ===
    const cpuCount = os.cpus().length;
    const cpuModel = os.cpus()[0]?.model || 'Unknown';
    const cpuSpeed = os.cpus()[0]?.speed || 0;
    
    // CPU usage % (1-second sample)
    const cpuUsageRaw = run("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'", "0");
    const cpuUsage = parseFloat(cpuUsageRaw) || 0;

    // Load averages
    const loadAvg = os.loadavg();

    // === RAM ===
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    // More accurate from /proc/meminfo (accounts for buffers/cache)
    const memInfo = run("free -b | grep Mem | awk '{print $2,$3,$4,$6,$7}'", "");
    let memDetails = { total: totalMem, used: usedMem, free: freeMem, buffCache: 0, available: freeMem };
    if (memInfo) {
      const parts = memInfo.split(/\s+/).map(Number);
      memDetails = {
        total: parts[0] || totalMem,
        used: parts[1] || usedMem,
        free: parts[2] || freeMem,
        buffCache: parts[3] || 0,
        available: parts[4] || freeMem,
      };
    }

    // Swap
    const swapInfo = run("free -b | grep Swap | awk '{print $2,$3,$4}'", "0 0 0");
    const swapParts = swapInfo.split(/\s+/).map(Number);
    const swap = { total: swapParts[0] || 0, used: swapParts[1] || 0, free: swapParts[2] || 0 };

    // === Disk ===
    const diskRaw = run("df -B1 / | tail -1 | awk '{print $2,$3,$4,$5}'", "");
    const diskParts = diskRaw.split(/\s+/);
    const disk = {
      total: parseInt(diskParts[0]) || 0,
      used: parseInt(diskParts[1]) || 0,
      available: parseInt(diskParts[2]) || 0,
      usePct: parseInt(diskParts[3]) || 0,
    };

    // === Uptime ===
    const uptimeSecs = os.uptime();
    const uptimeDays = Math.floor(uptimeSecs / 86400);
    const uptimeHours = Math.floor((uptimeSecs % 86400) / 3600);
    const uptimeMins = Math.floor((uptimeSecs % 3600) / 60);

    // === OS Info ===
    const hostname = os.hostname();
    const platform = os.platform();
    const osRelease = run("lsb_release -ds 2>/dev/null || cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'\"' -f2", "Linux");
    const kernelVersion = os.release();
    const nodeVersion = process.version;

    // === PM2 Processes ===
    let pm2Processes = [];
    try {
      const pm2Raw = run("pm2 jlist", "[]");
      const pm2List = JSON.parse(pm2Raw);
      pm2Processes = pm2List.map(p => ({
        name: p.name,
        pid: p.pid,
        status: p.pm2_env?.status || 'unknown',
        cpu: p.monit?.cpu || 0,
        memory: p.monit?.memory || 0,
        uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
        restarts: p.pm2_env?.restart_time || 0,
        version: p.pm2_env?.version || '-',
      }));
    } catch {}

    // === PostgreSQL ===
    let postgres = { size: 'N/A', version: 'N/A', connections: 0, maxConnections: 0, tables: 0 };
    try {
      postgres.size = run("sudo -u postgres psql -d ispdb -t -c \"SELECT pg_size_pretty(pg_database_size('ispdb'));\"", "N/A").trim();
      postgres.version = run("sudo -u postgres psql -t -c 'SHOW server_version;'", "N/A").trim();
      postgres.connections = parseInt(run("sudo -u postgres psql -t -c \"SELECT count(*) FROM pg_stat_activity WHERE datname='ispdb';\"", "0")) || 0;
      postgres.maxConnections = parseInt(run("sudo -u postgres psql -t -c 'SHOW max_connections;'", "100")) || 100;
      postgres.tables = parseInt(run("sudo -u postgres psql -d ispdb -t -c \"SELECT count(*) FROM information_schema.tables WHERE table_schema='public';\"", "0")) || 0;
    } catch {}

    // === Network (basic) ===
    const networkInterfaces = Object.entries(os.networkInterfaces())
      .filter(([name]) => !name.startsWith('lo'))
      .map(([name, addrs]) => ({
        name,
        ipv4: addrs.find(a => a.family === 'IPv4')?.address || null,
      }))
      .filter(n => n.ipv4);

    // === Nginx ===
    let nginx = { status: 'unknown', version: 'N/A' };
    try {
      nginx.status = run("systemctl is-active nginx", "inactive");
      nginx.version = run("nginx -v 2>&1 | awk -F/ '{print $2}'", "N/A");
    } catch {}

    // === Subscriber counts (from DB) ===
    let subscriberStats = {};
    try {
      const [total, active, prospective, pending] = await Promise.all([
        req.prisma.subscribers.count(),
        req.prisma.subscribers.count({ where: { status: 'active' } }),
        req.prisma.subscribers.count({ where: { status: 'prospective' } }),
        req.prisma.subscribers.count({ where: { status: 'pending' } }),
      ]);
      subscriberStats = { total, active, prospective, pending };
    } catch {}

    // === Open tickets ===
    let ticketStats = {};
    try {
      const [open, inProgress, total] = await Promise.all([
        req.prisma.tickets.count({ where: { status: 'open' } }),
        req.prisma.tickets.count({ where: { status: 'in_progress' } }),
        req.prisma.tickets.count(),
      ]);
      ticketStats = { open, inProgress, total };
    } catch {}

    res.json({
      timestamp: new Date().toISOString(),
      system: {
        hostname,
        platform,
        os: osRelease,
        kernel: kernelVersion,
        nodeVersion,
        uptime: { seconds: uptimeSecs, days: uptimeDays, hours: uptimeHours, minutes: uptimeMins, formatted: `${uptimeDays}d ${uptimeHours}h ${uptimeMins}m` },
      },
      cpu: {
        model: cpuModel,
        cores: cpuCount,
        speed: cpuSpeed,
        usage: cpuUsage,
        loadAvg: { '1m': loadAvg[0], '5m': loadAvg[1], '15m': loadAvg[2] },
      },
      memory: {
        total: memDetails.total,
        used: memDetails.used,
        free: memDetails.free,
        available: memDetails.available,
        buffCache: memDetails.buffCache,
        usePct: Math.round((memDetails.used / memDetails.total) * 100),
        swap,
      },
      disk: {
        total: disk.total,
        used: disk.used,
        available: disk.available,
        usePct: disk.usePct,
      },
      pm2: pm2Processes,
      postgres,
      nginx,
      network: networkInterfaces,
      crm: { subscribers: subscriberStats, tickets: ticketStats },
    });
  } catch (err) {
    console.error('System status error:', err);
    res.status(500).json({ error: 'Failed to fetch system status' });
  }
});

module.exports = router;
