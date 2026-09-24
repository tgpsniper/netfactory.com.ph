#!/usr/bin/env node
// ============================================================
// garden-dns-toggle — turn the walled-garden DNS redirect off (or back on)
// ============================================================
// The two dstnat rules added by apply-walled-garden.js rewrite a restricted
// customer's DNS from port 53 to 10.0.98.4:5354, where garden-dns answers every
// name with the portal address. That only works if the rewritten packet actually
// reaches 10.0.98.4. On CLGNT-AC1 it does not.
//
// Measured 2026-09-24 on nf-crm, with the redirect live:
//
//   dstnat 'nf-garden dns redirect'          2,710 packets and climbing
//   garden-dns                               5 queries, all of them local tests
//   tcpdump -e -i eno3 'udp port 5354'       every frame tagged vlan 97, between
//                                            two MikroTik MACs, neither one ours
//   tcpdump -e 'ether dst <eno3 mac> and udp port 5354'    0 packets in 20 s
//
// The destination MAC is not this host's. Those frames are transit on a VLAN the
// server has no interface on; the capture only sees them because tcpdump puts the
// NIC in promiscuous mode. The kernel never delivers them, so garden-dns never
// answers, so the query goes unanswered and the client retries forever — a CPE's
// own ntp1.tummy.com lookup was repeating every three seconds.
//
// The access concentrator is doing its job: it routes 10.0.98.0/24 to the
// VLAN97-MGMT gateway, which forwards tcp/80 to the portal (nginx logs the real
// client IP) but not udp/5354. That gateway is not in mikrotik_devices, so nothing
// here can read or change its rules — opening a port needs its administrator.
//
// The cost of leaving it on is worse than having no redirect: before it, DNS was
// accepted to the customer's real resolver and names resolved. With it, a
// restricted line has no working DNS at all, which also kills the OS captive-portal
// probes that raise 'Sign in to network'.
//
// Disable rather than delete: the rules keep their place in the chain, and the
// order that took care to get right (captive redirect above the payer bypass above
// these) survives. Re-enabling is one flag once 5354 is reachable.
//
// Worth knowing before you bother: the captive portal does not need the hijack. The
// OS probes (captive.apple.com, connectivitycheck.gstatic.com) are plain HTTP, so
// ordinary DNS resolves them to their real address and the tcp/80 captive redirect
// takes it from there — the flow a restricted customer completed through to payment
// on 2026-09-22, with no DNS redirect in place. The hijack only adds a landing page
// for HTTPS-only attempts, which is cosmetic.
//
//   node scripts/garden-dns-toggle.js                       # dry run, show state
//   node scripts/garden-dns-toggle.js --off --apply         # disable the redirect
//   node scripts/garden-dns-toggle.js --on  --apply         # put it back
//   node scripts/garden-dns-toggle.js --off --apply --devices 20
// ============================================================
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const mikrotik = require('../src/utils/mikrotik');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const OFF   = process.argv.includes('--off');
const ON    = process.argv.includes('--on');
const argOf = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? null : process.argv[i + 1];
};

const COMMENTS = ['nf-garden dns redirect', 'nf-garden dns redirect (tcp)'];
const idOf = (r) => r['.id'] || r.id;

async function doDevice(dev) {
  const rules = await mikrotik.getFirewallNAT(prisma, dev.id);
  const mine = rules.filter(r => COMMENTS.includes(String(r.comment || '')));
  console.log(`── #${dev.id} ${dev.host}`);
  if (!mine.length) { console.log('   (no dns redirect rules on this device)'); return; }

  for (const r of mine) {
    const disabled = r.disabled === true || r.disabled === 'true';
    const state = disabled ? 'disabled' : 'enabled';
    const want  = OFF ? 'disabled' : 'enabled';
    if (state === want) {
      console.log(`   = ${r.comment} already ${state} (${r.packets} pkts)`);
      continue;
    }
    if (!APPLY) {
      console.log(`   ~ ${r.comment} ${state} -> ${want} (${r.packets} pkts) [dry run]`);
      continue;
    }
    await mikrotik.execute(prisma, dev.id, '/ip/firewall/nat',
      OFF ? 'disable' : 'enable', { id: idOf(r) });
    console.log(`   ${OFF ? '-' : '+'} ${r.comment} ${state} -> ${want}`);
  }
}

(async () => {
  if (APPLY && !OFF && !ON) { console.error('need --off or --on with --apply'); process.exit(2); }
  if (OFF && ON) { console.error('--off and --on are mutually exclusive'); process.exit(2); }

  const which = argOf('devices');
  const where = which && which !== 'all'
    ? { id: { in: which.split(',').map(s => Number(s.trim())).filter(Boolean) } }
    : { is_active: true };
  const devices = await prisma.mikrotik_devices.findMany({ where, orderBy: { id: 'asc' } });

  console.log(`${APPLY ? (OFF ? 'DISABLE' : 'ENABLE') : 'DRY RUN'} dns redirect on ${devices.length} device(s)\n`);
  for (const dev of devices) {
    try { await doDevice(dev); }
    catch (err) { console.log(`── #${dev.id} ${dev.host}\n   ! ${err.message}`); }
  }
  await mikrotik.disconnectAll();
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('FAILED: ' + err.message);
  try { await mikrotik.disconnectAll(); } catch {}
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
