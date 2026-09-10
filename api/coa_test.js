// Push a rate-limit change to a LIVE subscriber session via RADIUS CoA.
//
// MikroTik builds the simple queue once, from the Access-Accept, at the moment a
// device authenticates. Nothing re-reads RADIUS afterwards, so a plan or burst
// change does not reach anyone already online — they keep their old queue until
// the lease renews, up to 12 hours later. CoA (RFC 5176) is the mechanism for
// pushing the change now.
//
// Requires on the router:   /radius incoming set accept=yes port=3799
//
// Usage:
//   node coa_test.js                      # CoA only — never interrupts anyone
//   node coa_test.js --mac AA:BB:...      # target one device
//   node coa_test.js --disconnect         # fall back to Disconnect-Message
//
// --disconnect drops the session so the device re-authenticates and rebuilds its
// queue from scratch. It works where CoA does not, but the subscriber loses
// connectivity for a few seconds, so it is never the default.
require('dotenv').config();
process.on('uncaughtException', e => {
  if (e && e.errno === 'UNKNOWNREPLY') return;      // node-routeros throws on empty result sets
  console.error('unexpected:', e.message); process.exit(1);
});
const { execFile } = require('child_process');
const { RouterOSAPI } = require('node-routeros');
const { PrismaClient } = require('@prisma/client');
const radiusDb = require('./src/config/radius-db');

const argv = process.argv.slice(2);
const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const WANT_DISCONNECT = argv.includes('--disconnect');
const ONLY_MAC = (arg('--mac') || '').toUpperCase() || null;

const radclient = (host, type, secret, attrs) => new Promise(resolve => {
  const child = execFile('radclient', ['-x', '-t', '4', '-r', '1', `${host}:3799`, type, secret],
    { timeout: 15000 },
    (err, stdout, stderr) => resolve({ err, out: (stdout || '') + (stderr || '') }));
  child.stdin.end(attrs.join(',') + '\n');
});

const queues = async c => {
  const rows = await c.write('/queue/simple/print', ['=detail=']);
  const m = {};
  rows.forEach(q => { m[q.target] = {
    max: q['max-limit'], burst: q['burst-limit'],
    thres: q['burst-threshold'], time: q['burst-time'] }; });
  return m;
};
const fmt = q => q ? `max=${q.max} burst=${q.burst} thres=${q.thres} time=${q.time}` : '(no queue)';

(async () => {
  const prisma = new PrismaClient();

  // Live sessions, and the rate limit each one *should* now have.
  const [sessions] = await radiusDb.query(`
    SELECT a.username, host(a.framedipaddress) AS ip, host(a.nasipaddress) AS nas,
           a.acctsessionid, g.value AS rate
      FROM radacct a
      JOIN radusergroup ug ON upper(ug.username) = upper(a.username)
      JOIN radgroupreply g ON g.groupname = ug.groupname AND g.attribute = 'Mikrotik-Rate-Limit'
     WHERE a.acctstoptime IS NULL`);

  const targets = sessions.filter(s => !ONLY_MAC || s.username.toUpperCase() === ONLY_MAC);
  if (!targets.length) { console.log('No live sessions to act on.'); process.exit(0); }

  // The NAS address RADIUS saw is the one that will answer CoA.
  const nasHost = targets[0].nas;
  const [nasRows] = await radiusDb.query('SELECT secret FROM nas WHERE nasname = ?', [nasHost]);
  const secret = nasRows.length ? nasRows[0].secret : null;
  if (!secret) { console.log(`No shared secret in the nas table for ${nasHost}.`); process.exit(1); }

  const dev = await prisma.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const c = new RouterOSAPI({ host: dev.host, user: dev.username, password: dev.password, port: dev.port, timeout: 20 });
  await c.connect();

  console.log(`CoA target: ${nasHost}:3799   sessions: ${targets.length}\n`);
  const before = await queues(c);

  for (const s of targets) {
    const target = s.ip + '/32';
    console.log(`── ${s.username}  ${s.ip}`);
    console.log(`   should be : ${s.rate}`);
    console.log(`   queue now : ${fmt(before[target])}`);

    const r = await radclient(nasHost, 'coa', secret, [
      `User-Name=${s.username}`,
      `Acct-Session-Id=${s.acctsessionid}`,
      `Framed-IP-Address=${s.ip}`,
      `Mikrotik-Rate-Limit="${s.rate}"`,
    ]);
    const ack  = /Received CoA-ACK/i.test(r.out);
    const nak  = /Received CoA-NAK/i.test(r.out);
    const none = /no response|timed out/i.test(r.out) || (!ack && !nak);
    console.log(`   CoA       : ${ack ? 'ACK' : nak ? 'NAK (router understood but refused)'
                                   : none ? 'no response — is /radius incoming accept=yes?' : '?'}`);

    if (!ack && WANT_DISCONNECT) {
      const d = await radclient(nasHost, 'disconnect', secret, [
        `User-Name=${s.username}`,
        `Acct-Session-Id=${s.acctsessionid}`,
        `Framed-IP-Address=${s.ip}`,
      ]);
      console.log(`   Disconnect: ${/Received Disconnect-ACK/i.test(d.out) ? 'ACK — device will re-authenticate'
                                   : /Disconnect-NAK/i.test(d.out) ? 'NAK' : 'no response'}`);
    }
  }

  // Give the router a moment to rebuild queues before re-reading.
  await new Promise(r => setTimeout(r, 4000));
  const after = await queues(c);
  console.log('\n── queues after ──');
  for (const s of targets) {
    const t = s.ip + '/32';
    const changed = JSON.stringify(before[t]) !== JSON.stringify(after[t]);
    console.log(`  ${s.username}  ${fmt(after[t])}   ${changed ? '<< CHANGED' : '(unchanged)'}`);
  }

  c.close(); await prisma.$disconnect(); process.exit(0);
})();
