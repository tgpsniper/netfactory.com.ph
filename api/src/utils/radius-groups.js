// ============================================================
// radius-groups — the rate-limit string, and making sure a plan's group exists
// ============================================================
// buildRateLimit lived in routes/admin.js and was reachable only from there, which
// was fine while the plan editor was the only thing that wrote a group. It is not
// any more: unrestrictSubscriber has to be able to put a customer back on their plan
// speed, and it cannot do that by guessing at the format. One definition, two callers.
//
// WHY A GROUP CAN BE MISSING AT ALL
//
// syncPlanToRadius deletes a plan's radgroupreply rows when the plan is deactivated.
// That is right for a plan nobody is on and wrong for one that still carries
// customers: on 2026-09-24, five subscribers were on four deactivated plans, and
// `sulit-stream-1200` — the plan of the one subscriber among them with live RADIUS
// rows — had zero attributes. Restoring her would have sent her device back to a
// group that sends no Mikrotik-Rate-Limit, no Session-Timeout and no
// Acct-Interim-Interval: an unshaped line that the accounting jobs cannot see either.
// An Access-Accept with no reply attributes is still an Access-Accept.

// Build the Mikrotik-Rate-Limit value for a plan, including burst when the plan
// defines it. Threshold is stored as a percentage rather than an absolute rate
// so it stays valid when the plan speed changes — an absolute threshold silently
// becomes nonsense the moment someone edits the speed.
function buildRateLimit(downloadMbps, uploadMbps, burst) {
  const dl = downloadMbps || 0;
  const ul = uploadMbps || downloadMbps || 0;
  const rate = dl + 'M/' + ul + 'M';

  const bDl = Number(burst?.burst_download_mbps) || 0;
  const bUl = Number(burst?.burst_upload_mbps) || bDl;
  // Burst is only meaningful above the sustained rate.
  if (!bDl || bDl <= dl) return rate;

  const pct  = Math.min(Math.max(Number(burst?.burst_threshold_pct) || 80, 1), 99);
  const time = Math.max(Number(burst?.burst_time_s) || 16, 1);
  const tDl  = Math.max(Math.round(dl * pct / 100), 1);
  const tUl  = Math.max(Math.round(ul * pct / 100), 1);

  return `${rate} ${bDl}M/${bUl}M ${tDl}M/${tUl}M ${time}/${time}`;
}

// A group is only real if it actually replies with something. A groupname that
// appears in radusergroup but nowhere in radgroupreply is the failure mode above:
// it looks provisioned from the subscriber's side and shapes nothing.
async function groupHasAttributes(radiusDb, groupname) {
  if (!groupname) return false;
  const [rows] = await radiusDb.query(
    'SELECT 1 FROM radgroupreply WHERE groupname = ? LIMIT 1', [groupname]);
  return rows.length > 0;
}

// Create a plan's group from the plan record if it is missing. Deliberately a no-op
// when the group already has attributes — this repairs absence, it does not reconcile
// drift. Editing a plan is what reconciles drift, and it is the only thing that should,
// or a restore would quietly overwrite a rate somebody set by hand.
//
// Speed precedence matches syncPlanToRadius's call sites exactly (download_mbps first,
// speed_mbps as the fallback); two different answers to "how fast is this plan" is how
// a customer ends up on a speed that matches no screen in the CRM.
async function ensureGroupForPlan(radiusDb, plan, conn) {
  const db = conn || radiusDb;
  const group = plan && plan.radius_group;
  if (!group) return { ok: false, reason: 'plan has no radius_group' };

  const [rows] = await db.query(
    'SELECT 1 FROM radgroupreply WHERE groupname = ? LIMIT 1', [group]);
  if (rows.length) return { ok: true, created: false };

  const dl = Number(plan.download_mbps) || Number(plan.speed_mbps) || 0;
  const ul = Number(plan.upload_mbps)   || dl;
  if (!dl) return { ok: false, reason: `plan ${group} has no speed to build a rate limit from` };

  const rateLimit = buildRateLimit(dl, ul, plan);
  await db.query(
    "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Mikrotik-Rate-Limit', ':=', ?)",
    [group, rateLimit]);
  await db.query(
    "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Session-Timeout', ':=', '86400')",
    [group]);
  await db.query(
    "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Acct-Interim-Interval', ':=', '300')",
    [group]);
  return { ok: true, created: true, rateLimit };
}

module.exports = { buildRateLimit, groupHasAttributes, ensureGroupForPlan };
