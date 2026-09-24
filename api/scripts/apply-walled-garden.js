#!/usr/bin/env node
// ============================================================
// apply-walled-garden.js — put the walled-garden rules on an access router
// ============================================================
// Why this exists as a script rather than the .rsc in the repo root: that file was
// written for CRM-DHCP (device 9) and depends on two cutoff rules that already existed
// there. No access concentrator has them, and not one subscriber is behind device 9 —
// so the .rsc cannot be pasted into the routers that actually carry customers.
//
// Ordering is the whole feature. The access routers accept customer traffic with
//     accept src-address-list=NAT out-interface=sfp-sfpplus2   ("Forward NAT pool")
// so every rule here MUST be inserted ABOVE that rule or a restricted customer keeps
// full internet. Equally, the accepts must sit above the drops, or the customer loses
// their connection AND the payment page — worse than not restricting them at all.
//
// Safe to run while nobody is restricted: every rule is scoped to src/dst-address-list
// nf-restricted, so an empty list means nothing changes for anybody.
//
//   node scripts/apply-walled-garden.js --devices 20 --dry-run
//   node scripts/apply-walled-garden.js --devices 20
//   node scripts/apply-walled-garden.js --devices all
//   node scripts/apply-walled-garden.js --devices 20 --rollback
// ============================================================

const { PrismaClient } = require('@prisma/client');
const mikrotik = require('../src/utils/mikrotik');

const PORTAL_PUBLIC   = process.env.WG_PORTAL_PUBLIC   || '36.50.30.102';
const PORTAL_INTERNAL = process.env.WG_PORTAL_INTERNAL || '10.0.98.4';
const REDIRECT_PORT   = process.env.WG_REDIRECT_PORT   || '80';
// Where garden-dns answers. Unprivileged on purpose — it runs as the service user, so
// it cannot bind 53, and the routers rewrite the port on the way in. Keep in step with
// GARDEN_DNS_ADDR / GARDEN_DNS_PORT in src/services/garden-dns.js.
const GARDEN_DNS_ADDR = process.env.WG_GARDEN_DNS_ADDR || '10.0.98.4';
const GARDEN_DNS_PORT = process.env.WG_GARDEN_DNS_PORT || '5354';

// The rule the customer-traffic accept lives on. Everything we add goes above it.
// Matched by comment where the router has one, otherwise structurally: the first forward
// accept scoped to src-address-list=NAT. Every access concentrator here releases
// customer traffic with that rule; only five of them label it. Matching on shape rather
// than on a comment somebody happened to type is what lets this run on all of them.
const ANCHOR_COMMENT = 'Forward NAT pool, new conn';
const srcList = (r) => r['src-address-list'] || r.srcAddressList || '';
const dstList = (r) => r['dst-address-list'] || r.dstAddressList || '';

// A SECOND anchor, higher up the chain. The routers drop anything destined for a bogon
// address early in forward, and BOGONS contains 10.0.0.0/8 — which is the portal's own
// internal address, the one the captive redirect rewrites the destination to. Insert the
// portal accepts above the NAT-pool anchor only, as this script used to, and they land
// BELOW that drop: the redirect fires, the packet is discarded one rule later, and the
// customer gets a blank page instead of the payment page. It cost four days and looked
// like a redirect-port bug twice over; measured 2026-09-22, when the garden vhost's
// access log turned out to hold nothing but the curl used to "verify" it.
//
// Matched structurally rather than by comment: what matters is a forward drop keyed on a
// destination list named BOGONS, not the text somebody typed beside it.
function findBogonDrop(filters) {
  return (filters || []).find(r =>
    r.chain === 'forward' && r.action === 'drop' && String(dstList(r)) === 'BOGONS') || null;
}
// The list holding customer source addresses is not named the same on every router.
// Thirteen release customer traffic with src-address-list=NAT; AC-MALAULI and
// AC-LEFTBANK use CLIENTS-POOL, which is the same rule doing the same job under a
// different name. Matching only on 'NAT' is why those two were written off as unable
// to take the garden: they have the anchor, it just is not spelled NAT. Nothing else
// in the chain is scoped to these lists, so there is no other accept to confuse it
// with.
const CUSTOMER_LISTS = ['NAT', 'CLIENTS-POOL'];
function findAnchor(filters) {
  const fwd = (filters || []).filter(r => r.chain === 'forward');
  return fwd.find(r => String(r.comment || '') === ANCHOR_COMMENT)
      || fwd.find(r => r.action === 'accept' && CUSTOMER_LISTS.includes(srcList(r)))
      || null;
}

const TAG = 'nf-garden';

const ADDRESS_LISTS = [
  { list: 'nf-portal', address: PORTAL_PUBLIC,   comment: 'nf-garden portal (public)' },
  { list: 'nf-portal', address: PORTAL_INTERNAL, comment: 'nf-garden portal (internal)' },
  // FQDN entries: RouterOS resolves and refreshes these itself, the only workable
  // approach against CDN-backed hosts whose addresses rotate.
  { list: 'nf-garden', address: 'checkout.xendit.co', comment: 'nf-garden payment host' },
  { list: 'nf-garden', address: 'api.xendit.co',      comment: 'nf-garden payment host' },
];

// Order matters and is the order below. Accepts first, drops last.
// aboveBogons: these name the portal by address list, and the portal's internal address
// is inside 10.0.0.0/8, so they are dead below the bogon drop. Everything else here is
// keyed on the customer rather than the destination and is unaffected by it.
const FILTER_RULES = [
  { chain:'forward', action:'accept', 'src-address-list':'nf-restricted', 'dst-address-list':'nf-portal',
    comment:'nf-garden allow portal', aboveBogons: true },
  { chain:'forward', action:'accept', 'dst-address-list':'nf-restricted', 'src-address-list':'nf-portal',
    comment:'nf-garden allow portal (return)', aboveBogons: true },
  { chain:'forward', action:'accept', 'src-address-list':'nf-restricted', protocol:'udp', 'dst-port':'53',
    comment:'nf-garden allow DNS' },
  { chain:'forward', action:'accept', 'src-address-list':'nf-restricted', protocol:'tcp', 'dst-port':'53',
    comment:'nf-garden allow DNS tcp' },
  { chain:'forward', action:'accept', 'src-address-list':'nf-restricted', 'dst-address-list':'nf-garden',
    comment:'nf-garden allow payment hosts' },
  { chain:'forward', action:'accept', 'dst-address-list':'nf-restricted', 'src-address-list':'nf-garden',
    comment:'nf-garden allow payment hosts (return)' },
  // The timed payment window. A checkout cannot complete inside a domain allow-list —
  // 3-D Secure lands on the cardholder's own bank — so /api/restricted/pay parks the
  // address in nf-paying for 20 minutes. These MUST be above the drops.
  { chain:'forward', action:'accept', 'src-address-list':'nf-paying',
    comment:'nf-garden payment window' },
  { chain:'forward', action:'accept', 'dst-address-list':'nf-paying',
    comment:'nf-garden payment window (return)' },
  { chain:'forward', action:'drop', 'src-address-list':'nf-restricted',
    comment:'nf-garden cutoff (out)' },
  { chain:'forward', action:'drop', 'dst-address-list':'nf-restricted',
    comment:'nf-garden cutoff (in)' },
];

// srcnat accept = "do not NAT this". Without it the customer reaches the portal as the
// router's NAT pool address, and /api/restricted identifies callers by matching the
// source address against radacct — so every restricted customer would look like the
// same stranger and the page could not tell them what they owe.
// Scoped to nf-restricted so it changes nothing for anybody who is not cut off.
const SRCNAT_RULE = { chain:'srcnat', action:'accept', 'src-address-list':'nf-restricted',
  'dst-address-list':'nf-portal', comment:'nf-garden preserve source to portal' };

// Catches the plain-HTTP probe phones and laptops fire to detect a captive portal, which
// is what makes "Sign in to network" appear instead of a wall of timeouts. HTTPS is
// deliberately NOT intercepted: that means a certificate error on every site the
// customer opens, which reads as the ISP attacking them.
//
// TARGET IS THE INTERNAL ADDRESS, NOT THE PUBLIC ONE. This was originally
// 36.50.30.102:8081 and added disabled, because the edge does not forward 8081 from the
// public address — so the rule would have sent customers to a port nothing answers. The
// access routers reach 10.0.98.4 directly (that is why nf-portal carries both addresses,
// and the "allow portal" accept has matched traffic), so going internally sidesteps the
// edge entirely and the rule can ship enabled.
//
// AND THE PORT IS 80, NOT 8081. Nothing upstream forwards 8081 to this host. Probed from
// SMN-AC2 and STMS-AC1 on 2026-09-22: port 80 connects in under 300ms, port 8081 times
// out after a full 10 seconds without establishing. The garden was therefore moved onto
// port 80 on 2026-09-15 — sites-available/walled-garden-80, a regex server_name so it
// catches whatever Host a redirected request carries, and conf.d/nf-garden-clients.conf
// splitting the two audiences by SOURCE address so scanners still get 444.
//
// This said the opposite for a day. On 2026-09-21 all fifteen routers were changed from
// :80 to :8081 on the strength of one test — curl -H 'Host: 1.1.1.1' http://10.0.98.4:80
// run ON THIS SERVER — which returned a closed connection and was read as "port 80 is the
// catchall and does not answer". But walled-garden-80 answers by source address, and
// 10.0.98.0/24 is one of the ranges it deliberately EXCLUDES: the server asking itself is
// guaranteed to be treated as a scanner and get 444. The test could not have returned
// anything else, from a port that was working correctly. Probe from a router, or from a
// customer address, or the answer means nothing.
//
// ORDER WITHIN THIS LIST IS THE CONTRACT. They are appended in sequence, so the array
// order is the order on the router. Two placements matter and neither is obvious:
//
//   The captive redirect stays ABOVE the payer bypass. A customer mid-checkout is on
//   nf-paying AND still on nf-restricted — openPaymentWindow adds to the one list and
//   never removes from the other — so if the bypass came first, their port 80 would
//   stop being redirected the instant they pressed Pay. They are sitting on
//   http://1.1.1.1/restricted/ at that moment; 1.1.1.1 would resolve to the real
//   Cloudflare resolver and the page polling for their payment would die under them.
//
//   The payer bypass stays ABOVE the DNS redirects, which is the whole reason it
//   exists. See its own comment below.
const DSTNAT_RULES = [
  { chain:'dstnat', action:'dst-nat', 'src-address-list':'nf-restricted',
    protocol:'tcp', 'dst-port':'80', 'dst-address-list':'!nf-portal',
    'to-addresses':PORTAL_INTERNAL, 'to-ports':REDIRECT_PORT,
    comment:'nf-garden captive redirect' },

  // THE ONE RULE THAT KEEPS THE GARDEN FROM BECOMING A TRAP.
  //
  // garden-dns answers 10.0.98.4 for every A query except xendit.co and our own domain.
  // That is correct for someone staring at the hold page and wrong for someone holding a
  // card, because 3-D Secure does not redirect to Xendit — it redirects to the
  // CARDHOLDER'S OWN BANK, whose domain is in no allow-list here and never could be.
  // Hijack that and the card fails on the last screen, after the customer believes they
  // have paid, with no way to tell them why.
  //
  // openPaymentWindow (src/routes/restricted.js) parks the address in nf-paying for 20
  // minutes but leaves it on nf-restricted, so a DNS redirect scoped to nf-restricted
  // alone matches a payer too. accept in dstnat means "stop NAT processing for this
  // packet", so this rule hands payers straight through to real DNS for the window.
  { chain:'dstnat', action:'accept', 'src-address-list':'nf-paying',
    comment:'nf-garden payer DNS bypass',
    // If the DNS rules somehow landed first — a half-finished earlier run — appending
    // would put this BELOW them and quietly undo the protection above. Anchor to them.
    placeBefore: ['nf-garden dns redirect', 'nf-garden dns redirect (tcp)'] },

  // Force the OS captive probe to resolve to us. Without this, DNS leaves untouched
  // (the 'allow DNS' filter accept has passed 116k packets), the probe resolves to the
  // real Apple/Google address, and whether the portal pops depends on the phone having
  // decided to re-probe at all. Measured on CLGNT-AC1 2026-09-24: 100.66.48.27 probed
  // and got the portal automatically, 100.66.48.13 never probed once in a day.
  //
  // This does NOT make https:// show the portal. Nothing can, short of forging
  // certificates. It makes the probe dependable, and the probe is what raises the
  // "Sign in to network" sheet.
  { chain:'dstnat', action:'dst-nat', 'src-address-list':'nf-restricted',
    protocol:'udp', 'dst-port':'53',
    'to-addresses':GARDEN_DNS_ADDR, 'to-ports':GARDEN_DNS_PORT,
    comment:'nf-garden dns redirect' },
  { chain:'dstnat', action:'dst-nat', 'src-address-list':'nf-restricted',
    protocol:'tcp', 'dst-port':'53',
    'to-addresses':GARDEN_DNS_ADDR, 'to-ports':GARDEN_DNS_PORT,
    comment:'nf-garden dns redirect (tcp)' },
];

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? def : (process.argv[i + 1] || true);
}
const DRY = process.argv.includes('--dry-run');
const ROLLBACK = process.argv.includes('--rollback');

async function raw(prisma, deviceId, path, cmd, data) {
  return mikrotik.execute(prisma, deviceId, path, 'exec', { command: cmd, data });
}
const idOf = (r) => r['.id'] || r.id;

async function applyDevice(prisma, dev) {
  const label = `#${dev.id} ${dev.label}`;
  const out = { device: label, added: [], skipped: [], removed: [], errors: [] };

  const filters = await mikrotik.getFirewallFilter(prisma, dev.id);
  const nats = await mikrotik.getFirewallNAT(prisma, dev.id);
  const lists = await mikrotik.getAddressLists(prisma, dev.id);

  if (ROLLBACK) {
    for (const [path, rows] of [['/ip/firewall/filter', filters], ['/ip/firewall/nat', nats]]) {
      for (const r of rows || []) {
        if (!String(r.comment || '').startsWith(TAG)) continue;
        if (DRY) { out.removed.push(`${path} ${r.comment}`); continue; }
        await mikrotik.execute(prisma, dev.id, path, 'remove', { id: idOf(r) });
        out.removed.push(`${path} ${r.comment}`);
      }
    }
    for (const e of lists || []) {
      if (!['nf-portal', 'nf-garden'].includes(e.list)) continue;
      if (DRY) { out.removed.push(`address-list ${e.list} ${e.address}`); continue; }
      await mikrotik.execute(prisma, dev.id, '/ip/firewall/address-list', 'remove', { id: idOf(e) });
      out.removed.push(`address-list ${e.list} ${e.address}`);
    }
    return out;
  }

  // ── anchor ──
  const anchor = findAnchor(filters);
  if (!anchor) {
    out.errors.push('no forward accept for src-address-list=NAT — refusing to guess placement');
    return out;
  }
  const anchorId = idOf(anchor);
  out.anchor = String(anchor.comment || '') || `(uncommented ${anchor.action} srcL=NAT)`;

  // ── address lists ──
  for (const a of ADDRESS_LISTS) {
    const have = (lists || []).some(e => e.list === a.list && e.address === a.address);
    if (have) { out.skipped.push(`address-list ${a.list} ${a.address}`); continue; }
    if (DRY) { out.added.push(`address-list ${a.list} ${a.address}`); continue; }
    await raw(prisma, dev.id, '/ip/firewall/address-list', 'add', a);
    out.added.push(`address-list ${a.list} ${a.address}`);
  }

  // ── filter rules, each inserted directly above its anchor so they land in order ──
  // The portal accepts go above the bogon drop where there is one; everything else goes
  // above the NAT-pool accept, which is what releases customer traffic.
  const bogonDrop = findBogonDrop(filters);
  const bogonId = bogonDrop ? idOf(bogonDrop) : null;
  if (bogonDrop) out.bogonAnchor = true;
  for (const r of FILTER_RULES) {
    if ((filters || []).some(f => String(f.comment || '') === r.comment)) {
      out.skipped.push(`filter ${r.comment}`); continue;
    }
    const { aboveBogons, ...rule } = r;
    const before = (aboveBogons && bogonId) ? bogonId : anchorId;
    if (DRY) {
      out.added.push(`filter ${r.comment}` + ((aboveBogons && bogonId) ? '  [above the BOGONS drop]' : ''));
      continue;
    }
    await raw(prisma, dev.id, '/ip/firewall/filter', 'add', { ...rule, 'place-before': before });
    out.added.push(`filter ${r.comment}`);
  }

  // ── NAT ──
  const firstSrcnat = (nats || []).find(r => r.chain === 'srcnat');
  if ((nats || []).some(n => String(n.comment || '') === SRCNAT_RULE.comment)) {
    out.skipped.push(`nat ${SRCNAT_RULE.comment}`);
  } else if (DRY) {
    out.added.push(`nat ${SRCNAT_RULE.comment}`);
  } else {
    const d = { ...SRCNAT_RULE };
    if (firstSrcnat) d['place-before'] = idOf(firstSrcnat);
    await raw(prisma, dev.id, '/ip/firewall/nat', 'add', d);
    out.added.push(`nat ${SRCNAT_RULE.comment}`);
  }

  // Appended in array order, so the list's order becomes the router's order. Re-read
  // after each add: a rule placed this pass is the anchor the next one may need.
  let natsNow = nats || [];
  for (const rule of DSTNAT_RULES) {
    if (natsNow.some(n => String(n.comment || '') === rule.comment)) {
      out.skipped.push(`nat ${rule.comment}`); continue;
    }
    const { placeBefore, ...data } = rule;
    // Only ever used to move a rule UP. Appending is the default and is correct as long
    // as the rules above it already exist, which is the normal path.
    if (placeBefore) {
      const target = natsNow.find(n => placeBefore.includes(String(n.comment || '')));
      if (target) data['place-before'] = idOf(target);
    }
    if (DRY) {
      out.added.push(`nat ${rule.comment}` + (data['place-before'] ? '  [above the dns redirect]' : ''));
      continue;
    }
    await raw(prisma, dev.id, '/ip/firewall/nat', 'add', data);
    out.added.push(`nat ${rule.comment}`);
    natsNow = await mikrotik.getFirewallNAT(prisma, dev.id);
  }
  return out;
}

// The check that matters: every nf-garden accept above both drops, and both drops above
// the rule that would otherwise let a restricted customer straight out.
async function verifyDevice(prisma, dev) {
  const filters = await mikrotik.getFirewallFilter(prisma, dev.id);
  const fwd = (filters || []).filter(r => r.chain === 'forward');
  const anchorRule = findAnchor(filters);
  const anchorAt = anchorRule ? fwd.findIndex(r => idOf(r) === idOf(anchorRule)) : -1;
  const accepts = fwd.map((r, i) => ({ r, i }))
    .filter(x => String(x.r.comment || '').startsWith(TAG) && x.r.action === 'accept').map(x => x.i);
  const drops = fwd.map((r, i) => ({ r, i }))
    .filter(x => String(x.r.comment || '').startsWith(TAG) && x.r.action === 'drop').map(x => x.i);

  const problems = [];
  if (!accepts.length || !drops.length) problems.push('rules missing');
  if (accepts.length && drops.length && Math.max(...accepts) > Math.min(...drops))
    problems.push('an accept sits BELOW a drop — restricted customers could not reach the payment page');
  if (drops.length && anchorAt !== -1 && Math.max(...drops) > anchorAt)
    problems.push('a drop sits BELOW the NAT-pool accept — restriction would not bite');

  // dstnat order, which the filter chain says nothing about. Both of these are silent
  // failures: the rules are all present and the router reports no error either way.
  const nats = await mikrotik.getFirewallNAT(prisma, dev.id);
  const dst = (nats || []).filter(r => r.chain === 'dstnat');
  const at = (c) => dst.findIndex(r => String(r.comment || '') === c);
  const bypassAt  = at('nf-garden payer DNS bypass');
  const dnsAt     = [at('nf-garden dns redirect'), at('nf-garden dns redirect (tcp)')].filter(i => i !== -1);
  const captiveAt = at('nf-garden captive redirect');
  if (bypassAt !== -1 && dnsAt.length && bypassAt > Math.min(...dnsAt))
    problems.push('the payer DNS bypass sits BELOW a dns redirect — a customer mid-checkout would have their bank\'s domain hijacked and the card would fail');
  if (bypassAt !== -1 && captiveAt !== -1 && bypassAt < captiveAt)
    problems.push('the payer DNS bypass sits ABOVE the captive redirect — the hold page would stop being served the moment they press Pay');

  return { device: `#${dev.id} ${dev.label}`, accepts: accepts.length, drops: drops.length,
    anchorAt, ok: problems.length === 0, problems,
    dstnat: dst.filter(r => String(r.comment || '').startsWith(TAG))
              .map((r, i) => `${i} ${r.action.padEnd(7)} ${r.comment}`),
    order: fwd.map((r, i) => `${i}${i === anchorAt ? '*' : ' '} ${r.action.padEnd(6)} ${r.comment || '(no comment)'}`) };
}

(async () => {
  const prisma = new PrismaClient();
  const which = String(arg('devices', ''));
  if (!which) { console.error('need --devices <id,id|all>'); process.exit(2); }

  let devices = await prisma.mikrotik_devices.findMany({
    where: { is_active: true }, select: { id: true, label: true }, orderBy: { id: 'asc' } });
  if (which !== 'all') {
    const want = new Set(which.split(',').map(x => Number(x.trim())));
    devices = devices.filter(d => want.has(d.id));
  }
  console.log(`${DRY ? 'DRY RUN — ' : ''}${ROLLBACK ? 'ROLLBACK' : 'apply'} on ${devices.length} device(s)\n`);

  for (const dev of devices) {
    try {
      const out = await applyDevice(prisma, dev);
      console.log(`── ${out.device}${out.anchor ? '   [anchor: ' + out.anchor + ']' : ''}`);
      out.added.forEach(x => console.log('   + ' + x));
      out.skipped.forEach(x => console.log('   = ' + x + ' (already present)'));
      out.removed.forEach(x => console.log('   - ' + x));
      out.errors.forEach(x => console.log('   ! ' + x));
      if (!ROLLBACK && !DRY && !out.errors.length) {
        const v = await verifyDevice(prisma, dev);
        console.log(`   verify: ${v.ok ? 'OK' : 'PROBLEM'} — ${v.accepts} accepts, ${v.drops} drops, anchor at ${v.anchorAt}`);
        v.dstnat.forEach(l => console.log('      dstnat ' + l));
        v.problems.forEach(p => console.log('   !! ' + p));
        if (!v.ok) v.order.forEach(l => console.log('      ' + l));
      }
    } catch (err) {
      console.log(`── #${dev.id} ${dev.label}\n   ! FAILED: ${err.message}`);
    }
  }
  await prisma.$disconnect();
  process.exit(0);
})();
