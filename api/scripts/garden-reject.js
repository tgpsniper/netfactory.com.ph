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
// that rule's action, for two reasons: reject-with=tcp-reset is meaningful only
// for TCP, so UDP and everything else must still meet the original drop; and
// leaving the known-good rule untouched means backing this out is a delete of
// one rule, not an edit that has to be remembered correctly.
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

const COMMENT    = 'nf-garden cutoff reset (tcp)';
const DROP_MATCH = /^nf-garden cutoff \(out\)$/;
const SRC_LIST   = 'nf-restricted';

async function doDevice(dev) {
  const rules = await mt.execute(prisma, dev.id, '/ip/firewall/filter', 'print');

  const existing = rules.find(r => (r.comment || '') === COMMENT);
  const dropIdx  = rules.findIndex(r => DROP_MATCH.test(r.comment || ''));

  if (OFF) {
    if (!existing) return { status: 'absent' };
    if (!APPLY) return { status: 'would-remove' };
    await mt.execute(prisma, dev.id, '/ip/firewall/filter', 'remove', { id: existing.id });
    return { status: 'removed' };
  }

  if (existing) return { status: 'already' };
  // Without the cutoff rule this router is not running the garden at all; adding
  // a reject here would block traffic that nothing was blocking before.
  if (dropIdx === -1) return { status: 'no-cutoff-rule', note: 'garden not deployed here' };

  if (!APPLY) return { status: 'would-add', note: 'above rule #' + dropIdx };

  const added = await mt.execute(prisma, dev.id, '/ip/firewall/filter', 'add', {
    data: {
      chain: 'forward',
      action: 'reject',
      'reject-with': 'tcp-reset',
      protocol: 'tcp',
      'src-address-list': SRC_LIST,
      comment: COMMENT,
    }
  });

  // `add` appends to the end of the chain, which is below the drop and therefore
  // dead. It only does anything once moved above the drop.
  const newId = added && (added.id || added['.id']);
  await mt.execute(prisma, dev.id, '/ip/firewall/filter', 'exec', {
    command: 'move',
    data: { numbers: newId, destination: String(dropIdx) }
  });

  return { status: 'added', note: 'moved to #' + dropIdx };
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
