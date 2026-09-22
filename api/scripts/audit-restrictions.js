#!/usr/bin/env node
// ============================================================
// audit-restrictions — who SHOULD be restricted vs who IS
// ============================================================
// Read-only. Answers the only two questions that matter once auto-restrict is on:
// how many customers has it actually cut off, and is anyone past grace with a balance
// still enjoying full service. It reuses restriction.restrictionCandidates() rather
// than re-deriving "owes money", so this audit and the job can never disagree.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const radiusDb = require('../src/config/radius-db');
const restriction = require('../src/utils/restriction');
const prisma = new PrismaClient();

const peso = n => 'P' + Number(n).toFixed(2);

(async () => {
  const setting = async (k) => {
    const r = await prisma.system_settings.findUnique({ where: { key: k } });
    return r ? String(r.value) : '(unset)';
  };

  const { days, source } = await restriction.getGraceDays(prisma);
  const { mode, source: modeSrc } = await restriction.getRestrictionMode(prisma);
  const enabled = await restriction.isAutoRestrictEnabled(prisma);

  console.log('=== policy ===');
  console.log('  billing_auto_restrict_enabled : ' + (await setting('billing_auto_restrict_enabled')) +
              '   (effective: ' + (enabled ? 'ON' : 'OFF') + ')');
  console.log('  grace days                    : ' + days + '  [' + source + ']');
  console.log('  mode                          : ' + mode + '  [' + modeSrc + ']');
  console.log('  restrict hour (Manila)        : ' + (await setting('billing_restrict_hour')) + '  (default 9)');
  console.log('  max per run                   : ' + (await setting('billing_auto_restrict_max_per_run')) + '  (default 25)');

  // ── who IS restricted right now ──
  const [open] = await radiusDb.query(
    `SELECT r.id, r.subscriber_id, r.trigger_source, r.created_by, r.mode,
            r.restricted_at, r.no_auto_restore,
            s.account_number,
            trim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')) AS name
       FROM subscriber_restrictions r
       LEFT JOIN subscribers s ON s.id = r.subscriber_id
      WHERE r.lifted_at IS NULL
      ORDER BY r.restricted_at`);

  console.log('');
  console.log('=== currently restricted: ' + open.length + ' ===');
  open.forEach(r => console.log('  #' + r.subscriber_id + ' ' + (r.account_number || '?') +
    '  ' + (r.name || '').padEnd(28) + ' ' + String(r.trigger_source).padEnd(12) +
    ' ' + String(r.mode || '').padEnd(14) + ' since ' + new Date(r.restricted_at).toISOString().slice(0,16).replace('T',' ')));

  const byTrigger = {};
  open.forEach(r => { byTrigger[r.trigger_source] = (byTrigger[r.trigger_source] || 0) + 1; });
  console.log('  by trigger: ' + (Object.keys(byTrigger).length
    ? Object.entries(byTrigger).map(([k, v]) => k + '=' + v).join(', ') : 'none'));

  // ── who SHOULD be ──
  const cands = await restriction.restrictionCandidates(prisma, radiusDb, days);
  console.log('');
  console.log('=== past ' + days + ' days grace with a balance: ' + cands.length + ' ===');

  const restrictedIds = new Set(open.map(r => Number(r.subscriber_id)));
  const gap   = cands.filter(c => !restrictedIds.has(Number(c.id)));
  const noDev = gap.filter(c => Number(c.devices) === 0);
  const armed = gap.filter(c => Number(c.devices) > 0);

  console.log('  already restricted : ' + cands.filter(c => restrictedIds.has(Number(c.id))).length);
  console.log('  NOT restricted     : ' + gap.length +
              '   (' + armed.length + ' enforceable, ' + noDev.length + ' with no registered device)');

  if (armed.length) {
    console.log('');
    console.log('  --- past grace, has devices, still NOT restricted ---');
    armed.forEach(c => console.log('    #' + c.id + ' ' + c.account_number + '  ' +
      String(c.name || c.company_name || '').padEnd(28) +
      ' ' + String(c.days_past_due).padStart(4) + 'd  ' + peso(c.balance).padStart(11) +
      '  ' + c.devices + ' dev  status=' + c.subscriber_status));
  }
  if (noDev.length) {
    console.log('');
    console.log('  --- past grace but NOTHING to enforce against (no registered device) ---');
    noDev.forEach(c => console.log('    #' + c.id + ' ' + c.account_number + '  ' +
      String(c.name || c.company_name || '').padEnd(28) +
      ' ' + String(c.days_past_due).padStart(4) + 'd  ' + peso(c.balance).padStart(11) +
      '  status=' + c.subscriber_status));
  }

  // ── restricted but no longer qualifying ──
  const candIds = new Set(cands.map(c => Number(c.id)));
  const stale = open.filter(r => !candIds.has(Number(r.subscriber_id)));
  console.log('');
  console.log('=== restricted but NOT currently a candidate: ' + stale.length + ' ===');
  stale.forEach(r => console.log('  #' + r.subscriber_id + ' ' + (r.account_number || '?') + ' ' +
    (r.name || '') + '  trigger=' + r.trigger_source +
    (r.trigger_source === 'overdue-job' ? '  <- auto-restore should lift this' : '  (manual — auto-restore leaves it alone)')));

  // ── exempt accounts, which never appear as candidates at all ──
  // restriction_exempt is one of the columns that exist in the database but not in
  // schema.prisma, so it has to be read with raw SQL rather than through the client.
  const [ex] = await radiusDb.query(
    'SELECT count(*)::int AS n FROM subscribers WHERE restriction_exempt = true');
  const exempt = ex[0].n;
  console.log('');
  console.log('=== restriction_exempt subscribers (invisible to the job): ' + exempt + ' ===');

  const totalOwed = cands.reduce((s, c) => s + Number(c.balance), 0);
  console.log('');
  console.log('total owed by everyone past grace: ' + peso(totalOwed));

  await prisma.$disconnect();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
