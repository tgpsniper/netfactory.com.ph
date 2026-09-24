#!/usr/bin/env node
// ============================================================
// garden-reject — make the walled-garden cutoff fail fast
// ============================================================
// The cutoff rule is `action=drop`, so a restricted customer's HTTPS connection
// is swallowed and the browser sits spinning until it times out. That is the
// state the customer describes as "Connected, no internet": no error, no
// prompt, no reason given. It also slows the OS down in deciding the network is
// captive, because a black hole looks like a slow network rather than a blocked
// one.
//
// A TCP reset ends the connection immediately. The browser shows a refusal
// instead of a hang, and the OS reaches its captive-portal verdict sooner,
// which is the path that actually raises "Sign in to network".
//
// Inserted as a NEW rule directly above the existing drop rather than changing
// that rule's action, for two reasons: a reject needs a protocol-appropriate
// reject-with, so one rule cannot cover everything and the original drop stays
// as the catch-all; and leaving the known-good rule untouched means backing this
// out is a delete, not an edit that has to be remembered correctly.
//
// UDP WAS THE BIGGER HALF AND THIS SCRIPT ORIGINALLY MISSED IT.
//
// Only TCP was rejected at first, on the reasoning that tcp-reset means nothing
// to UDP — correct as far as it goes, but it left UDP in the black hole and UDP
// is where the traffic actually is. Measured on CLGNT-AC1 2026-09-24, six days
// after the TCP reject shipped: 258 packets rejected, 44,374 dropped. Chrome
// reaches YouTube and every other Google property over QUIC, which is UDP/443,
// so the browser sat through the full QUIC handshake timeout and reported
// ERR_CONNECTION_TIMED_OUT — the exact hang this script exists to remove, on
// the sites a customer is most likely to try first.
//
// UDP's equivalent is an ICMP port-unreachable. Chrome treats that as "QUIC is
// broken to this host", falls straight back to TCP, and meets the reset above.
// Two rules, both failing in well under a second.
//
//   node scripts/garden-reject.js                      # dry run, all routers
//   node scripts/garden-reject.js --apply --only CLGNT-AC1
//   node scripts/garden-reject.js --apply --off --only CLGNT-AC1   # remove
// ============================================================
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const mt = require('../src/utils/mikrotik');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const OFF   = process.argv.includes('--off');
const onlyIx = process.argv.indexOf('--only');
const ONLY = onlyIx > -1 ? process.argv[onlyIx + 1] : null;

// Disjoint on protocol, so the order between them does not matter — only that both
// sit above the drop. Everything that must stay reachable (portal, DNS, payment
// hosts, the payment window) is accepted higher up the chain and never reaches here.
const RULES = [
  { comment: 'nf-garden cutoff reset (tcp)', protocol: 'tcp', rejectWith: 'tcp-reset' },
  { comment: 'nf-garden cutoff reset (udp)', protocol: 'udp', rejectWith: 'icmp-port-unreachable' },
];
const DROP_MATCH = /^nf-garden cutoff \(out\)$/;
const SRC_LIST   = 'nf-restricted';

async function doDevice(dev) {
  const done = [];

  for (const spec of RULES) {
    // Re-read every pass: adding one of these shifts the drop's index by one, and
    // moving the next rule to a stale index would file it below the drop, where it
    // is dead and looks installed.
    const rules = await mt.execute(prisma, dev.id, '/ip/firewall/filter', 'print');
    const existing = rules.find(r => (r.comment || '') === spec.comment);
    const dropIdx  = rules.findIndex(r => DROP_MATCH.test(r.comment || ''));

    if (OFF) {
      if (!existing) { done.push(spec.protocol + ':absent'); continue; }
      if (!APPLY)    { done.push(spec.protocol + ':would-remove'); continue; }
      await mt.execute(prisma, dev.id, '/ip/firewall/filter', 'remove', { id: existing.id });
      done.push(spec.protocol + ':removed');
      continue;
    }

    if (existing) { done.push(spec.protocol + ':already'); continue; }
    // Without the cutoff rule this router is not running the garden at all; adding
    // a reject here would block traffic that nothing was blocking before.
    if (dropIdx === -1) return { status: 'no-cutoff-rule', note: 'garden not deployed here' };
    if (!APPLY) { done.push(spec.protocol + ':would-add above #' + dropIdx); continue; }

    const added = await mt.execute(prisma, dev.id, '/ip/firewall/filter', 'add', {
      data: {
        chain: 'forward',
        action: 'reject',
        'reject-with': spec.rejectWith,
        protocol: spec.protocol,
        'src-address-list': SRC_LIST,
        comment: spec.comment,
      }
    });

    // `add` appends to the end of the chain, which is below the drop and therefore
    // dead. It only does anything once moved above the drop.
    const newId = added && (added.id || added['.id']);
    await mt.execute(prisma, dev.id, '/ip/firewall/filter', 'exec', {
      command: 'move',
      data: { numbers: newId, destination: String(dropIdx) }
    });
    done.push(spec.protocol + ':added at #' + dropIdx);
  }

  return { status: done.join(', ') };
}

(async () => {
  const devices = await prisma.mikrotik_devices.findMany({
    where: { is_active: true }, orderBy: { id: 'asc' }
  });
  const targets = ONLY ? devices.filter(d => d.label === ONLY) : devices;
  if (!targets.length) { console.error('no device matched ' + ONLY); process.exit(1); }

  console.log((APPLY ? 'APPLY' : 'DRY RUN') + (OFF ? ' (remove)' : '') +
              ' — ' + targets.length + ' router(s)\n');

  let failed = 0;
  for (const d of targets) {
    try {
      const r = await doDevice(d);
      console.log('  ' + d.label.padEnd(11) + r.status + (r.note ? '  (' + r.note + ')' : ''));
    } catch (err) {
      failed++;
      console.log('  ' + d.label.padEnd(11) + 'FAILED  ' + err.message);
    }
  }
  console.log('\nfailed: ' + failed);
  await prisma.$disconnect();
  process.exit(0);
})();
