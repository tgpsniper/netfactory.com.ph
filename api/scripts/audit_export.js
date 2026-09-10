const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const LOG_DIR = '/var/log/j2network/audit';
const MAX_FILE_SIZE = 1 * 1024 * 1024 * 1024;
const MARKER_FILE = path.join(LOG_DIR, '.last_export_id');
const DB_URL = process.env.DATABASE_URL || 'postgresql://DBUSER:DBPASS@localhost:5432/DBNAME';

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  console.log('[AUDIT EXPORT] Connected to database');

  let lastId = 0;
  if (fs.existsSync(MARKER_FILE)) {
    lastId = parseInt(fs.readFileSync(MARKER_FILE, 'utf8').trim()) || 0;
  }
  console.log('[AUDIT EXPORT] Last exported ID:', lastId);

  const res = await client.query('SELECT * FROM audit_logs WHERE id > $1 ORDER BY id ASC', [lastId]);
  if (res.rows.length === 0) {
    console.log('[AUDIT EXPORT] No new logs to export');
    await client.end();
    return;
  }

  console.log('[AUDIT EXPORT] Exporting ' + res.rows.length + ' new rows');
  const portal = res.rows.filter(r => r.log_source === 'portal');
  const crm = res.rows.filter(r => r.log_source === 'crm');
  if (portal.length > 0) writeRows(portal, 'portal');
  if (crm.length > 0) writeRows(crm, 'crm');

  const maxId = res.rows[res.rows.length - 1].id;
  fs.writeFileSync(MARKER_FILE, String(maxId));
  console.log('[AUDIT EXPORT] Marker updated to ID ' + maxId);
  await client.end();
  console.log('[AUDIT EXPORT] Done');
}

function writeRows(rows, source) {
  const prefix = source === 'portal' ? 'logportal' : 'logcrm';
  const now = new Date();
  const yymm = String(now.getFullYear()).slice(2) + String(now.getMonth() + 1).padStart(2, '0');

  let fileNum = 1;
  let filePath;
  const existing = fs.readdirSync(LOG_DIR).filter(f => f.startsWith(prefix + yymm) && f.endsWith('.csv')).sort();

  if (existing.length > 0) {
    const last = existing[existing.length - 1];
    const seq = last.replace(prefix + yymm, '').replace('.csv', '');
    fileNum = parseInt(seq) || 1;
    filePath = path.join(LOG_DIR, last);
    const stat = fs.statSync(filePath);
    if (stat.size >= MAX_FILE_SIZE) { fileNum++; filePath = null; }
  }

  if (!filePath) {
    filePath = path.join(LOG_DIR, prefix + yymm + String(fileNum).padStart(4, '0') + '.csv');
  }

  const isNew = !fs.existsSync(filePath) || fs.statSync(filePath).size === 0;
  if (isNew) {
    fs.writeFileSync(filePath, 'id,log_source,user_id,username,action,details,public_ip,local_ip,user_agent,created_at\n');
  }

  const csvLines = rows.map(r => {
    const details = r.details ? JSON.stringify(r.details).replace(/"/g, '""') : '';
    const ua = (r.user_agent || '').replace(/"/g, '""');
    return r.id + ',' + r.log_source + ',' + (r.user_id || '') + ',' + (r.username || '') + ',"' + r.action + '","' + details + '",' + (r.public_ip || '') + ',' + (r.local_ip || '') + ',"' + ua + '",' + r.created_at.toISOString();
  }).join('\n') + '\n';

  fs.appendFileSync(filePath, csvLines);
  console.log('[AUDIT EXPORT] Wrote ' + rows.length + ' ' + source + ' rows to ' + path.basename(filePath));
}

main().catch(err => { console.error('[AUDIT EXPORT] FATAL:', err.message); process.exit(1); });
