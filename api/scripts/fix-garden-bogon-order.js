#!/usr/bin/env node
// ============================================================
// fix-garden-bogon-order.js — let the captive redirect survive the bogon drop
// ============================================================
// The captive redirect rewrites a restricted customer's port-80 destination to the
// portal's INTERNAL address, 10.0.98.4. The forward chain on every access router then
// runs, in this order:
//
//   [0] accept  connection-state=established,related
//   [1] drop    connection-state=invalid
//   [2] accept  src-address-list=MGMT-IP
//   [3] drop    dst-address-list=BOGONS        <-- BOGONS contains 10.0.0.0/8
//   [4] accept  src=nf-restricted dst=nf-portal    "nf-garden allow portal"
//
// So the packet the redirect just created is dropped one rule before the rule written
// to allow it. Measured on 2026-09-22 over 90 seconds on two routers: the redirect
// counter rose by 131 and 90, the BOGONS drop by 535 and 129, and "allow portal" by 1
// and 2. The redirect's own counter was pure 60-byte SYNs — connections opened and
// never completed — and the garden vhost's access log had not recorded a single
// customer request in four days of logs.
//
// This is why changing the redirect port from 80 to 8081 on 2026-09-21 did not make the
// garden work. That was a real bug, but the destination was already 10.0.98.4 and was
// being dropped as a bogon whatever port it named. The curl used to "verify" that fix
// ran from the server to itself and so never crossed a router.
//
// THE FIX: one accept for the portal, placed ABOVE the bogon drop. Added rather than
// reordering the existing rules, because place-before is atomic and the rollback is
// removing exactly the rule this script added.
//
// It does not weaken bogon filtering for anyone else. It is scoped to
// src-address-list=nf-restricted and dst-address-list=nf-portal, so with nobody
// restricted it matches nothing at all.
//
//   node scripts/fix-garden-bogon-order.js --dry-run
//   node scripts/fix-garden-bogon-order.js --devices 23,24
//   node scripts/fix-garden-bogon-order.js --devices all
//   node scripts/fix-garden-bogon-order.js --devices all --rollback
// ============================================================

const { PrismaClient } = require('@prisma/client');
const mikrotik = require('../src/utils/mikrotik');

const NEW_COMMENT      = 'nf-garden allow portal (pre-bogon)';
const EXISTING_COMMENT = 'nf-garden allow portal';

const DRY      = process.argv.includes('--dry-run');
const ROLLBACK = process.argv.includes('--rollback');
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? def : (process.argv[i + 1] || true);
}

const arr = x => Array.isArray(x) ? x : (x && x.data) || [];
const idOf = r => r['.id'] || r.id;
const dstList = r => String(r['dst-address-list'] || r.dstAddressList || '');
const srcList = r => String(r['src-address-list'] || r.srcAddressList || '');

const RULE = {
  chain: 'forward', action: 'accept',
  'src-address-list': 'nf-restricted',
  'dst-address-list': 'nf-portal',
  comment: NEW_COMMENT,
};

// The bogon drop is matched structurally, not by its comment: it is "Drop BOGONS" on
// these routers today, but the thing that matters is a forward drop keyed on a
// destination list named BOGONS, whatever anybody typed in the comment field.
const isBogonDrop = r =>
  r.chain === 'forward' && r.action === 'drop' && dstList(r) === 'BOGONS';

async function readForward(prisma, id) {
  return arr(await mikrotik.getFirewallFilter(prisma, id)).filter(r => r.chain === 'forward');
}

async function doDevice(prisma, dev) {
  const tag = `#${dev.id} ${String(dev.label).padEnd(12)} `;
  let fwd;
  try { fwd = await readForward(prisma, dev.id); }
  catch (e) { console.log(tag + 'UNREACHABLE — ' + e.message); return 'unreachable'; }

  const bogonAt = fwd.findIndex(isBogonDrop);
  const allowAt = fwd.findIndex(r => String(r.comment || '') === EXISTING_COMMENT);
  const mineAt  = fwd.findIndex(r => String(r.comment || '') === NEW_COMMENT);

  if (ROLLBACK) {
    if (mineAt === -1) { console.log(tag + 'no rule to roll back'); return 'skipped'; }
    if (DRY) { console.log(tag + `would REMOVE the rule at index ${mineAt}`); return 'would-change'; }
    await mikrotik.execute(prisma, dev.id, '/ip/firewall/filter', 'remove', { id: idOf(fwd[mineAt]) });
    const after = await readForward(prisma, dev.id);
    const gone = after.findIndex(r => String(r.comment || '') === NEW_COMMENT) === -1;
    console.log(tag + (gone ? 'removed  verified' : 'REMOVE DID NOT STICK'));
    return gone ? 'changed' : 'failed';
  }

  // A router with no garden rules is not half-fixed by this — it needs
  // apply-walled-garden.js first, and adding a lone accept would only hide that.
  if (allowAt === -1) { console.log(tag + 'no walled-garden rules installed — skipped'); return 'skipped'; }
  if (bogonAt === -1) { console.log(tag + 'no BOGONS drop in the forward chain — nothing to clear'); return 'ok'; }
  if (bogonAt > allowAt) {
    console.log(tag + `already fine: allow-portal at ${allowAt} sits above BOGONS drop at ${bogonAt}`);
    return 'ok';
  }
  if (mineAt !== -1 && mineAt < bogonAt) {
    console.log(tag + `already fixed: pre-bogon accept at ${mineAt}, BOGONS drop at ${bogonAt}`);
    return 'ok';
  }
  if (mineAt !== -1) {
    console.log(tag + `PROBLEM: the pre-bogon accept exists at ${mineAt} but is BELOW the BOGONS drop at ${bogonAt} — left alone, fix by hand`);
    return 'failed';
  }

  if (DRY) {
    console.log(tag + `would INSERT accept(nf-restricted -> nf-portal) above the BOGONS drop at index ${bogonAt}  (allow-portal currently at ${allowAt})`);
    return 'would-change';
  }

  await mikrotik.execute(prisma, dev.id, '/ip/firewall/filter', 'exec', {
    command: 'add', data: { ...RULE, 'place-before': idOf(fwd[bogonAt]) },
  });

  // Read the chain back. A rule that was added but landed in the wrong place is worse
  // than no rule, because the counters would look like it is working.
  const after = await readForward(prisma, dev.id);
  const newAt   = after.findIndex(r => String(r.comment || '') === NEW_COMMENT);
  const newBog  = after.findIndex(isBogonDrop);
  if (newAt !== -1 && newBog !== -1 && newAt < newBog) {
    console.log(tag + `inserted at ${newAt}, BOGONS drop now at ${newBog}  verified`);
    return 'changed';
  }
  console.log(tag + `INSERT DID NOT LAND ABOVE THE DROP (rule at ${newAt}, drop at ${newBog})`);
  return 'failed';
}

(async () => {
  const prisma = new PrismaClient();
  const want = String(arg('devices', 'all'));
  const where = { is_active: true };
  const devices = (await prisma.mikrotik_devices.findMany({ where, orderBy: { id: 'asc' } }))
    .filter(d => want === 'all' || want.split(',').map(s => s.trim()).includes(String(d.id)));

  console.log((DRY ? '[DRY RUN] ' : '') + (ROLLBACK ? 'ROLLBACK — ' : '') +
    `${devices.length} device(s)\n`);

  const tally = {};
  for (const d of devices) {
    const r = await doDevice(prisma, d);
    tally[r] = (tally[r] || 0) + 1;
    await mikrotik.disconnect(d.id).catch(() => {});
  }
  console.log('\n' + Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join('   '));
  if (DRY) console.log('DRY RUN — nothing was written');
  await prisma.$disconnect();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
