#!/usr/bin/env node
// ============================================================
// scope-payment-window.js — limit the nf-paying window to HTTPS
// ============================================================
// When a restricted customer starts a payment their address is parked in
// nf-paying for PAYMENT_WINDOW_MIN (20) minutes, because a checkout cannot be
// completed inside a domain allow-list: 3-D Secure lands on the cardholder's own
// bank and each wallet bounces through its own CDNs.
//
// That window was meant to be HTTPS only — restricted.js says as much: "one
// firewall rule allows out on 443". CRM-DHCP, the hand-built original, does
// scope it that way. The 15 access routers that actually carry subscribers do
// not: their rules carry no protocol and no port, so the window hands out FULL
// unrestricted internet, every port and protocol, for 20 minutes. /pay allows 6
// attempts per 15 minutes, so the window can be re-opened more or less
// continuously by anyone who notices. That is a hole in collections, not a
// feature.
//
// This brings the access routers in line with CRM-DHCP:
//     out    : protocol=tcp dst-port=443   src-address-list=nf-paying
//     return : protocol=tcp src-port=443   dst-address-list=nf-paying
//
// Payment traffic is HTTPS end to end, so checkout is unaffected. DNS is already
// permitted by its own rule and does not ride this one.
//
//   node scripts/scope-payment-window.js                      # dry run, all
//   node scripts/scope-payment-window.js --apply --only MCB-AC1
//   node scripts/scope-payment-window.js --apply --revert --only MCB-AC1
//
// Re-runnable: rules already scoped are skipped, so a partial run can be redone.
const { PrismaClient } = require('@prisma/client');
const mikrotik = require('../src/utils/mikrotik');
const prisma = new PrismaClient();

const args   = process.argv.slice(2);
const APPLY  = args.includes('--apply');
const REVERT = args.includes('--revert');
const ONLY   = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1] : null; })();

// comment fragment -> the fields that rule should carry
const WANT = [
  { match: /payment window( out)?$/,      set: { protocol: 'tcp', dstPort: '443' }, key: 'dstPort' },
  { match: /payment window( \(return\)| return)$/, set: { protocol: 'tcp', srcPort: '443' }, key: 'srcPort' },
];
const CLEAR = { protocol: '', dstPort: '', srcPort: '' };

(async () => {
  const where = { is_active: true };
  if (ONLY) where.label = ONLY;
  const devices = await prisma.mikrotik_devices.findMany({
    where, select: { id: true, label: true }, orderBy: { id: 'asc' } });
  if (!devices.length) throw new Error(ONLY ? `no active router labelled ${ONLY}` : 'no active routers');

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — payment window ${REVERT ? 'UNSCOPED (revert)' : 'scoped to tcp/443'}` +
              ` across ${devices.length} router(s)\n`);
  let changed = 0, skipped = 0, failed = 0;

  for (const d of devices) {
    try {
      const filters = await mikrotik.execute(prisma, d.id, '/ip/firewall/filter', 'print', {});
      const rules = (filters || []).filter(r => /nf-garden payment window/.test(String(r.comment || '')));
      if (!rules.length) { console.log(`${d.label.padEnd(11)} no payment-window rules — SKIP`); skipped++; continue; }

      for (const r of rules) {
        const spec = WANT.find(w => w.match.test(String(r.comment).trim()));
        if (!spec) { console.log(`${d.label.padEnd(11)} unrecognised: ${r.comment} — SKIP`); skipped++; continue; }
        const already = REVERT ? !r.protocol : (r.protocol === 'tcp' && String(r[spec.key]) === '443');
        if (already) { console.log(`${d.label.padEnd(11)} ${r.comment} already correct — SKIP`); skipped++; continue; }

        console.log(`${d.label.padEnd(11)} ${r.comment}: protocol=${r.protocol || '(any)'} ` +
                    `dst=${r.dstPort || '-'} src=${r.srcPort || '-'}  =>  ` +
                    (REVERT ? 'any/any' : `tcp ${spec.key === 'dstPort' ? 'dst' : 'src'}=443`));
        if (APPLY) {
          await mikrotik.execute(prisma, d.id, '/ip/firewall/filter', 'set',
            { id: r.id, data: REVERT ? CLEAR : spec.set });
          const after = (await mikrotik.execute(prisma, d.id, '/ip/firewall/filter', 'print', {}))
            .find(x => x.id === r.id);
          console.log(`${''.padEnd(11)}   -> protocol=${after.protocol || '(any)'} ` +
                      `dst=${after.dstPort || '-'} src=${after.srcPort || '-'}`);
        }
        changed++;
      }
    } catch (e) { console.log(`${d.label.padEnd(11)} ERROR ${e.message}`); failed++; }
  }

  console.log(`\n${APPLY ? 'changed' : 'would change'}: ${changed}   skipped: ${skipped}   failed: ${failed}`);
  if (!APPLY) console.log('re-run with --apply to make these changes');
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
