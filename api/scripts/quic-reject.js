// ============================================================
// quic-reject.js — make QUIC fail fast inside the walled garden
// ============================================================
// The cutoff rejects TCP but silently drops everything else. Safari and Chrome try
// HTTP/3 over UDP 443 before TCP, so a dropped QUIC packet leaves the browser waiting
// on a flow that will never answer instead of falling back to TCP, where the captive
// redirect would have caught it. Measured on a restricted line: 35 DNS queries and 12
// silent drops in 45 seconds, and not one TCP connection attempted.
//
// Rejecting UDP 443 with an ICMP port-unreachable makes the browser give up on HTTP/3
// immediately and retry over TCP. DNS keeps its own accept higher up the chain, so
// only QUIC is affected.
//
//   node scripts/quic-reject.js --devices 20 --dry-run
//   node scripts/quic-reject.js --devices 20
//   node scripts/quic-reject.js --devices 20 --rollback
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const mikrotik = require('../src/utils/mikrotik');

const COMMENT = 'nf-garden cutoff reset (quic)';
const RULE = {
  chain: 'forward', action: 'reject', 'reject-with': 'icmp-port-unreachable',
  'src-address-list': 'nf-restricted', protocol: 'udp', 'dst-port': '443',
  comment: COMMENT,
};

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const DRY = has('--dry-run'), ROLLBACK = has('--rollback');
const idOf = r => r['.id'] || r.id;

async function one(prisma, dev) {
  const label = `#${dev.id} ${dev.label}`;
  const rules = await mikrotik.execute(prisma, dev.id, '/ip/firewall/filter', 'print', {});
  const fwd = (rules || []).filter(r => r.chain === 'forward');

  const existing = fwd.find(r => (r.comment || '') === COMMENT);
  if (ROLLBACK) {
    if (!existing) return console.log(`  ${label}: nothing to roll back`);
    if (DRY) return console.log(`  ${label}: would REMOVE ${idOf(existing)}`);
    await mikrotik.execute(prisma, dev.id, '/ip/firewall/filter', 'remove', { id: idOf(existing) });
    return console.log(`  ${label}: removed`);
  }
  if (existing) return console.log(`  ${label}: already present — skipped`);

  // Anchor on the first cutoff DROP, so the new reject lands after the TCP reject and
  // before anything silent. Matched structurally, not by index: rule numbers shift.
  const anchor = fwd.find(r => r.action === 'drop' && (r.comment || '').startsWith('nf-garden cutoff'));
  if (!anchor) return console.log(`  ${label}: !! no 'nf-garden cutoff' drop found — refusing to guess placement`);

  if (DRY) return console.log(`  ${label}: would INSERT before ${idOf(anchor)} (${anchor.comment})`);
  await mikrotik.execute(prisma, dev.id, '/ip/firewall/filter', 'add',
    { ...RULE, 'place-before': idOf(anchor) });

  // Read the chain back — an add that silently lands at the bottom is worse than none.
  const after = (await mikrotik.execute(prisma, dev.id, '/ip/firewall/filter', 'print', {}))
    .filter(r => r.chain === 'forward');
  const iNew = after.findIndex(r => (r.comment || '') === COMMENT);
  const iDrop = after.findIndex(r => r.action === 'drop' && (r.comment || '').startsWith('nf-garden cutoff'));
  const iTcp = after.findIndex(r => (r.comment || '') === 'nf-garden cutoff reset (tcp)');
  console.log(`  ${label}: inserted at [${iNew}]  (tcp reject [${iTcp}], first drop [${iDrop}]) ` +
    (iNew >= 0 && iNew < iDrop ? '-> OK, above the drop' : '-> !! WRONG PLACE, roll back'));
}

(async () => {
  const prisma = new PrismaClient();
  const only = (val('--devices') || '').split(',').filter(Boolean).map(Number);
  const devs = await prisma.mikrotik_devices.findMany({
    where: { is_active: true, ...(only.length ? { id: { in: only } } : {}) }, orderBy: { id: 'asc' },
  });
  console.log((ROLLBACK ? 'ROLLBACK' : DRY ? 'DRY RUN' : 'APPLY') + ` on ${devs.length} router(s)\n`);
  for (const d of devs) {
    try { await one(prisma, d); }
    catch (e) { console.log(`  #${d.id} ${d.label}: ERROR ${e.message}`); }
  }
  await prisma.$disconnect();
})();
