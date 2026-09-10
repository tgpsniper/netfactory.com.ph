// ============================================================
// PM2 Ecosystem — J2 Health Monitor
// ============================================================
// Deploy: pm2 start monitor.config.js
// Check:  pm2 logs j2-monitor --lines 50
// Stop:   pm2 stop j2-monitor
// ============================================================

module.exports = {
  apps: [{
    name: 'j2-monitor',
    script: './j2-monitor.js',
    cwd: '/home/ubuntu/Node.js_API/j2-api',
    cron_restart: '*/3 * * * *',     // Every 3 minutes
    autorestart: false,               // Don't restart on exit — cron handles it
    watch: false,
    max_memory_restart: '100M',
    env: {
      NODE_ENV: 'production',
    },
    // Logging
    error_file: '/home/ubuntu/.pm2/logs/j2-monitor-error.log',
    out_file: '/home/ubuntu/.pm2/logs/j2-monitor-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    // Keep logs reasonable
    max_size: '10M',
    retain: 5,
  }]
};
