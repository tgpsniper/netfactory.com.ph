#!/usr/bin/env node
// ============================================================
// garden-redirect.js — turn the walled-garden captive redirect on/off
// ============================================================
// The redirect rule ("nf-garden captive redirect") was provisioned on every
// access router pointing at 36.50.30.102:8081 and left disabled, because
// nothing upstream forwards 8081 to this host. Probed from an access router
// and from the server itself, 80 and 443 connect while 3001 and 8081 time out.
//
// nginx now answers the captive-probe hostnames on port 80
// (sites-available/walled-garden-80 + conf.d/nf-garden-clients.conf), so this
// retargets the rule to 10.0.98.4:80 and enables it.
//
// 10.0.98.4 rather than the public address: it is already in each router's
// nf-portal list, so the "preserve source to portal" srcnat rule still matches
// and nginx sees the customer's real 100.66.x.x. That source is what the geo
// gate checks. Sending this via the public IP risks the edge masquerading the
// source, which would fail the gate and return 444 instead of the portal.
//
//   node scripts/garden-redirect.js                 # dry run, all routers
//   node scripts/garden-redirect.js --apply --only CLGNT-AC1
//   node scripts/garden-redirect.js --apply         # roll out everywhere
//   node scripts/garden-redirect.js --apply --off   # revert: disable again
//
// Re-runnable: it reads each rule first and skips any already in the wanted
// state, so a partial rollout can simply be run again.
const { PrismaClient } = require('@prisma/client');
const mikrotik = require('../src/utils/mikrotik');
const prisma = new PrismaClient();

const args  = process.argv.slice(2);
const APPLY = args.includes('--apply');
const OFF   = args.includes('--off');
const ONLY  = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1] : null; })();

const TARGET_ADDR = '10.0.98.4';
const TARGET_PORT = '80';

(async () => {
  const where = { is_active: true };
  if (ONLY) where.label = ONLY;
  const devices = await prisma.mikrotik_devices.findMany({
    where, select: { id: true, label: true }, orderBy: { id: 'asc' },
  });
  if (!devices.length) throw new Error(ONLY ? `no active router labelled ${ONLY}` : 'no active routers');

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — captive redirect ${OFF ? 'OFF' : 'ON'} ` +
              `(${TARGET_ADDR}:${TARGET_PORT}) across ${devices.length} router(s)\n`);

  let changed = 0, skipped = 0, failed = 0;
  for (const d of devices) {
    try {
      const nat  = await mikrotik.execute(prisma, d.id, '/ip/firewall/nat', 'print', {});
      const rule = (nat || []).find(r => /nf-garden captive redirect/.test(String(r.comment || '')));
      if (!rule) { console.log(`${d.label.padEnd(11)} no rule found — SKIP`); skipped++; continue; }

      const nowOn   = rule.disabled !== true;
      const nowDest = `${rule.toAddresses}:${rule.toPorts}`;
      const wantDest = `${TARGET_ADDR}:${TARGET_PORT}`;
      if (nowOn === !OFF && (OFF || nowDest === wantDest)) {
        console.log(`${d.label.padEnd(11)} already ${OFF ? 'disabled' : 'enabled -> ' + nowDest} — SKIP`);
        skipped++; continue;
      }

      console.log(`${d.label.padEnd(11)} ${nowDest} disabled=${rule.disabled} ` +
                  `=> ${wantDest} disabled=${!!OFF}`);
      if (APPLY) {
        if (!OFF) {
          await mikrotik.execute(prisma, d.id, '/ip/firewall/nat', 'set',
            { id: rule.id, data: { toAddresses: TARGET_ADDR, toPorts: TARGET_PORT } });
        }
        await mikrotik.execute(prisma, d.id, '/ip/firewall/nat', OFF ? 'disable' : 'enable',
          { id: rule.id });
        const after = (await mikrotik.execute(prisma, d.id, '/ip/firewall/nat', 'print', {}))
          .find(r => r.id === rule.id);
        console.log(`${''.padEnd(11)}   -> now ${after.toAddresses}:${after.toPorts} ` +
                    `disabled=${after.disabled === true}`);
      }
      changed++;
    } catch (e) {
      console.log(`${d.label.padEnd(11)} ERROR ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${APPLY ? 'changed' : 'would change'}: ${changed}   skipped: ${skipped}   failed: ${failed}`);
  if (!APPLY) console.log('re-run with --apply to make these changes');
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
