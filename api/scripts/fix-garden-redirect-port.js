// Repoint the nf-garden captive redirect from :80 to :8081.
// Port 80 is the catchall vhost: for an unknown Host header it closes the
// connection without answering, so every redirected customer saw a browser
// timeout instead of the payment page. 8081 is the vhost that returns the 302.
//
//   node scripts/fix-garden-redirect-port.js --devices 20            # one router
//   node scripts/fix-garden-redirect-port.js --devices all
//   node scripts/fix-garden-redirect-port.js --devices all --dry-run
//   node scripts/fix-garden-redirect-port.js --devices all --revert   # back to 80
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const mikrotik = require('../src/utils/mikrotik');
const prisma = new PrismaClient();

const COMMENT = 'nf-garden captive redirect';
const DRY     = process.argv.includes('--dry-run');
const REVERT  = process.argv.includes('--revert');
const WANT    = REVERT ? '80' : '8081';
const FROM    = REVERT ? '8081' : '80';

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const arr   = x => Array.isArray(x) ? x : (x && Array.isArray(x.data) ? x.data : []);
const idOf  = r => r['.id'] || r.id;
const portOf= r => String(r.toPorts || r['to-ports'] || '');

(async () => {
  const sel = String(argOf('devices', ''));
  if (!sel) { console.error('need --devices <id[,id]|all>'); process.exit(2); }
  const all = await prisma.mikrotik_devices.findMany({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const devs = sel === 'all' ? all : all.filter(d => sel.split(',').map(Number).includes(d.id));
  if (!devs.length) { console.error('no matching active devices'); process.exit(2); }

  let changed = 0, already = 0, missing = 0, failed = 0;
  for (const d of devs) {
    const tag = `#${d.id} ${d.label}`.padEnd(20);
    try {
      const nat = arr(await mikrotik.getFirewallNAT(prisma, d.id));
      const rule = nat.find(r => String(r.comment || '') === COMMENT);
      if (!rule) { console.log(tag + 'no redirect rule — skipped'); missing++; continue; }

      const now = portOf(rule);
      if (now === WANT) { console.log(tag + `already :${WANT}`); already++; continue; }
      // Only touch the rule we came for, and only if it looks the way we expect.
      if (now !== FROM) { console.log(tag + `to-ports is :${now}, expected :${FROM} — left alone`); missing++; continue; }
      if (DRY) { console.log(tag + `would set :${FROM} -> :${WANT}`); changed++; continue; }

      await mikrotik.execute(prisma, d.id, '/ip/firewall/nat', 'set',
        { id: idOf(rule), data: { 'to-ports': WANT } });

      // Read it back. A write that reports success and changes nothing is the
      // failure mode worth guarding against here.
      const after = arr(await mikrotik.getFirewallNAT(prisma, d.id))
        .find(r => String(r.comment || '') === COMMENT);
      const got = portOf(after);
      if (got === WANT) { console.log(tag + `:${FROM} -> :${WANT}  verified`); changed++; }
      else { console.log(tag + `SET DID NOT STICK — still :${got}`); failed++; }
    } catch (e) {
      console.log(tag + 'FAILED — ' + e.message.slice(0, 60)); failed++;
    }
  }
  console.log(`\n  changed ${changed}, already correct ${already}, skipped ${missing}, failed ${failed}`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
