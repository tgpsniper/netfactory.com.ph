#!/usr/bin/env node
// ============================================================
// smoke.js — the checks that would have caught this week
// ============================================================
// Not a test suite. A short list of assertions about things that have actually
// broken here, meant to run in seconds before every restart. Each one exists
// because something shipped without it.
//
//   node scripts/smoke.js            # run everything
//   node scripts/smoke.js --quick    # skip checks that need the ACS or the API
//
// Exit 0 = safe to restart. Exit 1 = do not.
//
// Deliberately dependency-free: this repo has nodemon and nothing else in
// devDependencies, and a test runner that has to be installed before it can
// tell you the build is broken is a test runner that will not get run.
require('dotenv').config();

const QUICK = process.argv.includes('--quick');
const API = process.env.SMOKE_API || 'http://127.0.0.1:' + (process.env.PORT || 3001);
const NBI = process.env.SMOKE_NBI || 'http://127.0.0.1:7557';

let passed = 0, failed = 0, skipped = 0, warned = 0;
const failures = [];
const warnings = [];

function ok(name)            { passed++; console.log('  ✓ ' + name); }
function bad(name, detail)   { failed++; failures.push({ name, detail });
                               console.log('  ✗ ' + name + '\n      ' + detail); }
function skip(name, why)     { skipped++; console.log('  – ' + name + '  (' + why + ')'); }
// Warnings are real problems that are not this deploy's fault. A pre-existing
// data fault must stay visible, but blocking every future release on it only
// teaches people to pass --force, and then the blocking checks stop working too.
function warn(name, detail)  { warned++; warnings.push({ name, detail });
                               console.log('  ! ' + name + '\n      ' + detail); }

async function check(name, fn, severity = 'fail') {
  try {
    const r = await fn();
    if (r === 'skip') return;
    ok(name);
  } catch (err) {
    (severity === 'warn' ? warn : bad)(name, err.message);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Small fetch wrapper: Node 18+ has global fetch, and a timeout so a hung
// service fails the run instead of hanging the deploy that called it.
async function get(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, text, json };
  } finally { clearTimeout(t); }
}

(async () => {
  console.log('\nsmoke: ' + new Date().toISOString() + (QUICK ? '  [quick]' : ''));

  // ── 1. Syntax and wiring ──────────────────────────────────
  // Every route module must at least parse and load. A typo here takes the
  // whole API down on restart, and pm2 will keep restarting it into the same
  // error — the failure mode behind a good share of those 136 restarts.
  console.log('\n modules');
  await check('utils/genieacs loads', async () => { require('../src/utils/genieacs'); });
  await check('utils/inbox loads',    async () => { require('../src/utils/inbox'); });
  await check('utils/restriction loads', async () => { require('../src/utils/restriction'); });
  await check('jobs register without throwing', async () => {
    const jobs = require('../src/jobs');
    assert(jobs, 'jobs/index did not export');
  });

  // ── 2. readParam shapes ───────────────────────────────────
  // THE 2026-09-19 REGRESSION. GenieACS stores a parameter's existence apart
  // from its value: after a GetParameterNames a discovered-but-unread node is
  // {"_object":false,"_writable":false} with no _value. readParam returned that
  // node, so manufacturer became an object, the UI printed "[object Object]",
  // and (d.manufacturer||"").toLowerCase() threw — an object is truthy, so the
  // || "" guard never fired and the whole device list died.
  console.log('\n genieacs parameter shapes');
  const acs = require('../src/utils/genieacs');
  const mkDev = v => ({
    _id: 'smoke-test', _deviceId: { _SerialNumber: 'S', _OUI: 'O', _ProductClass: 'P' },
    InternetGatewayDevice: { DeviceInfo: { Manufacturer: v } },
  });
  await check('discovered-but-unread parameter reads as null, not an object', async () => {
    const m = acs.extractIdentity(mkDev({ _object: false, _writable: false })).manufacturer;
    assert(m === null, 'expected null, got ' + JSON.stringify(m));
  });
  await check('normal parameter still reads its value', async () => {
    const m = acs.extractIdentity(mkDev({ _value: 'ZTE', _type: 'xsd:string' })).manufacturer;
    assert(m === 'ZTE', 'expected "ZTE", got ' + JSON.stringify(m));
  });
  await check('absent parameter reads as null', async () => {
    const m = acs.extractIdentity(mkDev(undefined)).manufacturer;
    assert(m === null || m === undefined, 'got ' + JSON.stringify(m));
  });

  // ── 3. Real devices, real shapes ──────────────────────────
  // The unit checks above use a hand-made device. This one asks the live ACS,
  // because the shapes that break things are the ones real firmware produces.
  console.log('\n live ACS');
  if (QUICK) { skip('every device field the UI renders is a scalar', '--quick'); }
  else {
    await check('every device field the UI renders is a scalar', async () => {
      let list;
      try { const r = await get(NBI + '/devices/?query=' + encodeURIComponent('{}')); list = r.json; }
      catch (e) { skip('live ACS device shapes', 'NBI unreachable'); return 'skip'; }
      assert(Array.isArray(list), 'NBI did not return an array');
      const offenders = [];
      for (const d of list) {
        const id = acs.extractIdentity(d);
        // These are rendered directly into the TR-069 Manager table and are
        // string-handled (.toLowerCase, .includes) by its search filter.
        for (const f of ['manufacturer', 'serial_number', 'software_version', 'hardware_version']) {
          if (id[f] !== null && id[f] !== undefined && typeof id[f] === 'object') {
            offenders.push(d._id + '.' + f);
          }
        }
        const w = acs.extractWifi(d);
        if (w && w.ssid && typeof w.ssid === 'object') offenders.push(d._id + '.ssid');
      }
      assert(offenders.length === 0,
        offenders.length + ' object-valued field(s), e.g. ' + offenders.slice(0, 3).join(', '));
    });

    await check('device metrics are numbers or null, never NaN', async () => {
      let list;
      try { const r = await get(NBI + '/devices/?query=' + encodeURIComponent('{}')); list = r.json; }
      catch (e) { return 'skip'; }
      if (!Array.isArray(list)) return 'skip';
      const bad = [];
      for (const d of list) {
        const m = acs.extractMetrics(d) || {};
        for (const k of Object.keys(m)) {
          const v = m[k];
          if (typeof v === 'object' && v !== null) bad.push(d._id + '.' + k + ' (object)');
          else if (typeof v === 'number' && Number.isNaN(v)) bad.push(d._id + '.' + k + ' (NaN)');
        }
      }
      assert(bad.length === 0, bad.length + ' bad metric(s), e.g. ' + bad.slice(0, 3).join(', '));
    });
  }

  // ── 4. Database ───────────────────────────────────────────
  // Not just "can we connect" — the objects schema.prisma does not describe and
  // a `prisma db push` would silently drop. If these ever vanish, balances stop
  // computing and new subscribers stop getting account numbers, with no error.
  console.log('\n database');
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  await check('database reachable', async () => {
    await prisma.$queryRaw`SELECT 1`;
  });
  await check('account-number trigger still exists', async () => {
    const r = await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM information_schema.triggers
       WHERE trigger_schema = 'public' AND trigger_name = 'trg_subscriber_account_number'`;
    assert(r[0].n > 0, 'trg_subscriber_account_number is GONE — did something run prisma db push?');
  });
  await check('4 generated columns still exist', async () => {
    const r = await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND is_generated = 'ALWAYS'`;
    assert(r[0].n >= 4, 'expected >= 4 generated columns, found ' + r[0].n);
  });
  await check('no subscriber points at a missing plan', async () => {
    // plan_id has an index but no foreign key, so it can dangle. A dangling one
    // is silently unbillable every month — generate-invoices.js calls this out.
    const r = await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM subscribers s
       WHERE s.plan_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM plans p WHERE p.id = s.plan_id)`;
    assert(r[0].n === 0, r[0].n + ' subscriber(s) reference a plan that does not exist ' +
      '— active, but can never be invoiced');
  }, 'warn');

  // ── 5. The API is actually serving ────────────────────────
  console.log('\n api');
  if (QUICK) { skip('API responds', '--quick'); }
  else {
    await check('API responds', async () => {
      let r;
      try { r = await get(API + '/api/health'); }
      catch (e) { throw new Error('no response from ' + API + ' — ' + e.message); }
      assert(r.status < 500, 'got HTTP ' + r.status);
    });
    await check('protected routes reject anonymous callers', async () => {
      // A broken auth middleware that fails open is the worst silent failure
      // available here: everything keeps working and everyone can see everything.
      const r = await get(API + '/api/admin/subscribers');
      assert(r.status === 401 || r.status === 403,
        'expected 401/403 without a token, got ' + r.status);
    });
    await check('portal rejects identity-field edits', async () => {
      // Added 2026-09-18. Names and account numbers are staff-only; this asserts
      // the endpoint is at least not open to anonymous writes.
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      try {
        const res = await fetch(API + '/api/portal/account', {
          method: 'PUT', signal: ctl.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ firstName: 'smoke', lastName: 'test' }),
        });
        assert(res.status === 401 || res.status === 403,
          'expected 401/403 unauthenticated, got ' + res.status);
      } finally { clearTimeout(t); }
    });
  }

  await prisma.$disconnect();

  // ── Result ────────────────────────────────────────────────
  console.log('\n  ' + passed + ' passed, ' + failed + ' failed' +
              (warned ? ', ' + warned + ' warning' + (warned > 1 ? 's' : '') : '') +
              (skipped ? ', ' + skipped + ' skipped' : ''));
  if (warned) {
    console.log('\n  WARNINGS (not blocking, but real):');
    warnings.forEach(w => console.log('    - ' + w.name + ': ' + w.detail));
  }
  if (failed) {
    console.log('\n  DO NOT DEPLOY:');
    failures.forEach(f => console.log('    - ' + f.name + ': ' + f.detail));
    console.log('');
    process.exit(1);
  }
  console.log('  safe to restart\n');
  process.exit(0);
})().catch(err => {
  // A crash in the checks is itself a failure — never let it read as a pass.
  console.error('\n  smoke run crashed: ' + (err && err.stack || err));
  process.exit(1);
});
