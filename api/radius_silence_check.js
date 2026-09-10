// Alert when RADIUS goes quiet.
//
// On 2026-08-15 the core router was replaced. Every subscriber session closed at
// 00:59:52 with NAS-Reboot and nothing re-authenticated for the next three hours.
// Nobody noticed — it surfaced only because someone asked an unrelated question
// about the OLT. Every layer looked "up": FreeRADIUS was active, the database was
// healthy, the CRM rendered fine. The only visible symptom was an absence, and
// nothing here was watching for one.
//
// Silence is the signal. This checks two things that should never both be true on
// a live network: no open accounting sessions, and no authentication attempt for
// longer than a subscriber would plausibly stay quiet.
//
// Exit 0 = healthy, 1 = alert, 2 = check itself failed (treat as alert).
// Designed for cron: prints a short human-readable block, nothing when healthy
// unless --verbose is passed.
require('dotenv').config();
const radiusDb = require('./src/config/radius-db');

const QUIET_MINUTES = Number(process.env.RADIUS_SILENCE_MINUTES || 15);
const VERBOSE = process.argv.includes('--verbose');

const ago = ts => {
  if (!ts) return 'never';
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m ago`;
};

(async () => {
  const one = async sql => { const [rows] = await radiusDb.query(sql); return rows[0]; };

  const live = await one(
    `SELECT count(*)::int AS n FROM radacct WHERE acctstoptime IS NULL`);
  const lastAuth = await one(
    `SELECT username, reply, authdate FROM radpostauth ORDER BY authdate DESC LIMIT 1`);
  const lastClose = await one(
    `SELECT username, acctstoptime, acctterminatecause FROM radacct
      WHERE acctstoptime IS NOT NULL ORDER BY acctstoptime DESC LIMIT 1`);
  const recent = await one(
    `SELECT count(*)::int AS n FROM radpostauth
      WHERE authdate > now() - interval '${QUIET_MINUTES} minutes'`);

  const liveCount   = live?.n ?? 0;
  const recentAuths = recent?.n ?? 0;
  const silent      = liveCount === 0 && recentAuths === 0;

  if (!silent) {
    if (VERBOSE) {
      console.log(`RADIUS OK — ${liveCount} live session(s), ` +
                  `${recentAuths} auth(s) in the last ${QUIET_MINUTES}m ` +
                  `(last: ${lastAuth?.username || '-'} ${ago(lastAuth?.authdate)})`);
    }
    process.exit(0);
  }

  console.log('=== RADIUS SILENCE ALERT ===');
  console.log(`  live sessions            ${liveCount}`);
  console.log(`  auth attempts last ${String(QUIET_MINUTES).padStart(3)}m   ${recentAuths}`);
  console.log(`  last authentication      ${lastAuth ? `${lastAuth.username} ${lastAuth.reply} (${ago(lastAuth.authdate)})` : 'never'}`);
  console.log(`  last session closed      ${lastClose ? `${lastClose.username} (${ago(lastClose.acctstoptime)})` : 'never'}`);

  // A mass close with this cause means the NAS restarted — the single most useful
  // hint for whoever gets paged, because it points at the router, not at RADIUS.
  if (lastClose?.acctterminatecause === 'NAS-Reboot') {
    console.log(`  terminate cause          NAS-Reboot  <-- the router restarted; check it first`);
  }

  console.log('');
  console.log('  No subscriber has authenticated and none are online.');
  console.log('  FreeRADIUS being "active" does not mean it is being asked.');
  process.exit(1);
})().catch(err => {
  console.log('=== RADIUS SILENCE CHECK FAILED ===');
  console.log('  ' + err.message);
  process.exit(2);
});
