#!/usr/bin/env node
// ============================================================
// repair-account-bypass — close the account-number hole on OPEN restrictions
// ============================================================
// restrictSubscriber now moves a subscriber's account-number credential into
// plan-restricted alongside their MACs, and records it in the restriction snapshot so
// the restore puts it back. That only helps restrictions taken from now on. A cutoff
// that was already open when the fix shipped still has a snapshot containing MACs
// only, and its account credential is still sitting in a full-speed group.
//
// This backfills those: it appends the account entry to the existing snapshot AND
// moves the group. Both, or neither is safe — move the group without recording it and
// the restore has no idea it needs moving back, leaving a customer who has paid
// throttled on a credential nobody thinks to look at.
//
// Measured 2026-09-24: one open restriction qualified — its account credential was
// sitting in a full-speed group while its MAC was in plan-restricted. radacct had
// never recorded a single session under that username, so nothing live was
// interrupted by moving it. Run the dry run first; it names what it will touch.
//
//   node scripts/repair-account-bypass.js            # dry run
//   node scripts/repair-account-bypass.js --apply
// ============================================================
require('dotenv').config();
const radiusDb = require('../src/config/radius-db');
const APPLY = process.argv.includes('--apply');
const RESTRICTED = 'plan-restricted';

(async () => {
  // Open restrictions whose subscriber holds an account-number credential that the
  // cutoff never touched, and whose snapshot has no account entry yet.
  const [rows] = await radiusDb.query(
    `SELECT r.id, r.subscriber_id, r.devices, s.account_number,
            (SELECT g.groupname FROM radusergroup g WHERE g.username = s.account_number LIMIT 1) AS acct_group,
            (SELECT c.value FROM radcheck c
              WHERE c.username = s.account_number AND c.attribute = 'Auth-Type' LIMIT 1) AS prev_auth
       FROM subscriber_restrictions r JOIN subscribers s ON s.id = r.subscriber_id
      WHERE r.lifted_at IS NULL
        AND (EXISTS(SELECT 1 FROM radusergroup g WHERE g.username = s.account_number)
          OR EXISTS(SELECT 1 FROM radcheck c WHERE c.username = s.account_number))`);

  console.log((APPLY ? 'APPLY' : 'DRY RUN') + ' — ' + rows.length + ' open restriction(s) to repair\n');

  for (const r of rows) {
    const snap = typeof r.devices === 'string' ? JSON.parse(r.devices) : (r.devices || []);
    if (snap.some(d => d.kind === 'account')) { console.log(`  #${r.id} already covered`); continue; }
    if (r.acct_group === RESTRICTED) { console.log(`  #${r.id} already on ${RESTRICTED}`); continue; }

    const entry = { mac: r.account_number, kind: 'account',
                    prev_profile: r.acct_group || null, prev_auth: r.prev_auth || null };
    console.log(`  restriction #${r.id}  sub#${r.subscriber_id}`);
    console.log(`    snapshot entry to add: ${JSON.stringify(entry)}`);
    console.log(`    radusergroup ${r.account_number}: ${r.acct_group} -> ${RESTRICTED}`);
    if (!APPLY) continue;

    await radiusDb.transaction(async (conn) => {
      await conn.query(
        `UPDATE subscriber_restrictions SET devices = ?::jsonb WHERE id = ?`,
        [JSON.stringify(snap.concat([entry])), r.id]);
      const [g] = await conn.query(
        'SELECT 1 FROM radusergroup WHERE username = ? LIMIT 1', [r.account_number]);
      if (g.length) {
        await conn.query('UPDATE radusergroup SET groupname = ? WHERE username = ?',
          [RESTRICTED, r.account_number]);
      } else {
        await conn.query('INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)',
          [r.account_number, RESTRICTED]);
      }
    });
    console.log('    applied');
  }

  if (APPLY) {
    console.log('\n── after ──');
    const [after] = await radiusDb.query(
      `SELECT r.id, s.account_number,
              (SELECT g.groupname FROM radusergroup g WHERE g.username = s.account_number) AS acct_group,
              r.devices
         FROM subscriber_restrictions r JOIN subscribers s ON s.id = r.subscriber_id
        WHERE r.lifted_at IS NULL AND s.account_number IS NOT NULL`);
    after.forEach(a => console.log(`  #${a.id} ${a.account_number} acct_group=${a.acct_group || '(none)'}\n     ${JSON.stringify(a.devices)}`));
  }
  await radiusDb.disconnect();
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
