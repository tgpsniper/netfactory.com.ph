// ============================================================
// restriction.js — billing restriction for MAC-authenticated subscribers
// ============================================================
// Why this exists: radius.js already had suspend/reactivate, but they drive
// subscriber_radius.radius_username, which is the PPPoE model. This network
// authenticates by MAC (hotspot_mac_devices -> radusergroup keyed by the MAC),
// and subscriber_radius is empty, so those endpoints 404 on every subscriber here.
//
// Enforcement is deliberately two-layered, because neither layer alone is enough:
//
//   1. RADIUS group -> plan-restricted.  Durable: survives renewals, reboots, and a
//      device moving to a different address. But it only takes effect at the NEXT
//      DHCP renewal, and today's leases run 24h (Session-Timeout 86400 overrides the
//      server's 30m), so on its own it could take ~12h to bite.
//
//   2. Firewall address-list nf-restricted.  Immediate: the walled-garden rules on
//      the router match this list, so the customer is limited within seconds. But
//      it is keyed to the address they currently hold, so it needs re-syncing if
//      that address ever changes.
//
// Layer 1 makes it stick, layer 2 makes it prompt. Restoring reverses both.
//
// NOT used here: deleting the DHCP lease. VLAN520-DHCP is arp=reply-only and dhcp1
// has add-arp=true, so removing a lease drops the ARP entry and instantly blackholes
// the customer — no portal, no payment page, and with a 24h lease they may not
// re-DHCP for hours. That is a disconnection, not a restriction.
// ============================================================

const mikrotik = require('./mikrotik');

const RESTRICTED_GROUP = 'plan-restricted';
const ADDRESS_LIST = 'nf-restricted';

// ── enforcement mode ────────────────────────────────────────
//   full          — no internet at all. RADIUS refuses the device outright, so once
//                   its lease lapses it cannot get an address again, and the firewall
//                   rejects the address it currently holds. The customer cannot reach
//                   the payment portal either; that is the point of "full".
//   walled-garden — throttled to plan-restricted, portal and DNS still reachable.
//
// Which one is live is a setting, not a code path chosen at build time, because this
// is collections policy and it changes.
const MODE_KEY = 'billing_restriction_mode';
const MODE_DEFAULT = 'full';
const MODES = ['full', 'walled-garden'];

async function getRestrictionMode(prisma) {
  try {
    const row = await prisma.system_settings.findUnique({ where: { key: MODE_KEY } });
    const raw = row ? String(row.value || '').trim().toLowerCase() : '';
    if (!raw) return { mode: MODE_DEFAULT, source: 'default (not set)' };
    if (!MODES.includes(raw)) {
      console.warn(`[restriction] ${MODE_KEY} = ${JSON.stringify(row.value)} is not one of ${MODES.join(' | ')}; using ${MODE_DEFAULT}`);
      return { mode: MODE_DEFAULT, source: `default (invalid value ${JSON.stringify(row.value)})` };
    }
    return { mode: raw, source: 'settings' };
  } catch (err) {
    console.error('[restriction] could not read ' + MODE_KEY + ': ' + err.message);
    return { mode: MODE_DEFAULT, source: 'default (settings unreadable)' };
  }
}

// ── router selection ────────────────────────────────────────
// One active router today. Resolved at call time rather than hardcoded so adding a
// second device does not silently keep enforcing on the first.
async function getRouterDeviceId(prisma) {
  if (process.env.RESTRICT_ROUTER_ID) return Number(process.env.RESTRICT_ROUTER_ID);
  const rows = await prisma.mikrotik_devices.findMany({
    where: { is_active: true }, select: { id: true }, orderBy: { id: 'asc' }, take: 2,
  });
  if (!rows.length) throw new Error('No active MikroTik device configured');
  if (rows.length > 1) {
    console.warn('[restriction] multiple active routers; using id=' + rows[0].id +
      '. Set RESTRICT_ROUTER_ID to choose explicitly.');
  }
  return rows[0].id;
}

// ── router helpers ──────────────────────────────────────────
// Every router call is best-effort: the RADIUS side is the source of truth, and a
// router that is unreachable must not roll back a restriction that is already
// recorded. Callers get { ok, error } so the API can report partial success honestly
// instead of claiming the customer was restricted when only half of it happened.
// A hard timeout matters as much as the try/catch here: the RouterOS API library
// has a habit of hanging rather than erroring on odd replies (a zero-row print
// returns "!empty", which it does not understand), and an admin clicking Restrict
// must not get a request that never returns.
async function safely(label, fn, ms = 15000) {
  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`router did not respond in ${ms}ms`)), ms)),
    ]);
    return { ok: true, result };
  } catch (err) {
    console.error(`[restriction] ${label} failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// MAC -> current leased IP, for the MACs we care about.
async function leaseIpsForMacs(prisma, deviceId, macs) {
  const want = new Set(macs.map(m => String(m).toUpperCase()));
  const leases = await mikrotik.getDHCPLeases(prisma, deviceId);
  const out = {};
  for (const l of leases || []) {
    const mac = String(l['mac-address'] || l.macAddress || '').toUpperCase();
    const addr = l.address;
    if (want.has(mac) && addr) out[mac] = addr;
  }
  return out;
}

async function addressListEntries(prisma, deviceId) {
  const all = await mikrotik.getAddressLists(prisma, deviceId);
  return (all || []).filter(e => e.list === ADDRESS_LIST);
}

// Make the router's nf-restricted list exactly match `wantIps`.
// Written as a reconcile rather than add/remove calls so it is safe to re-run — the
// future nightly job can call this to repair drift after addresses change.
async function reconcileAddressList(prisma, deviceId, wantIps, comment) {
  const existing = await addressListEntries(prisma, deviceId);
  const have = new Map(existing.map(e => [e.address, e]));
  const want = new Set(wantIps);

  const added = [];
  const removed = [];

  for (const ip of want) {
    if (!have.has(ip)) {
      await mikrotik.execute(prisma, deviceId, '/ip/firewall/address-list', 'add', {
        data: { list: ADDRESS_LIST, address: ip, comment: comment || 'billing restriction' },
      });
      added.push(ip);
    }
  }
  for (const [ip, entry] of have) {
    if (!want.has(ip)) {
      const id = entry['.id'] || entry.id;
      if (id) {
        await mikrotik.execute(prisma, deviceId, '/ip/firewall/address-list', 'remove', { id });
        removed.push(ip);
      }
    }
  }
  return { added, removed };
}

// Every IP that SHOULD be on the list right now = the current lease address of every
// MAC belonging to a subscriber with an open restriction.
async function desiredRestrictedIps(prisma, radiusDb, deviceId) {
  const [rows] = await radiusDb.query(
    `SELECT d.mac
       FROM subscriber_restrictions r
       JOIN hotspot_mac_devices d ON d.subscriber_id = r.subscriber_id
      WHERE r.lifted_at IS NULL`);
  const macs = rows.map(r => r.mac);
  if (!macs.length) return { macs: [], ips: [] };
  const byMac = await leaseIpsForMacs(prisma, deviceId, macs);
  return { macs, ips: Object.values(byMac) };
}

// Re-apply the address list from the database. Idempotent.
async function syncAddressList(prisma, radiusDb) {
  const deviceId = await getRouterDeviceId(prisma);
  const { ips } = await desiredRestrictedIps(prisma, radiusDb, deviceId);
  return reconcileAddressList(prisma, deviceId, ips, 'billing restriction (synced)');
}

// ── grace period ────────────────────────────────────────────
// Lives in system_settings so collections policy can change without a deploy.
// Validated here rather than at the write endpoint: PUT /admin/settings is a generic
// key/value upsert with no per-key rules, so a typo would otherwise be stored happily
// and the first anyone would know is customers being cut off on day 0.
const GRACE_KEY = 'billing_grace_period_days';
const GRACE_DEFAULT = 7;
const GRACE_MAX = 180;

async function getGraceDays(prisma) {
  let raw = null;
  try {
    const row = await prisma.system_settings.findUnique({ where: { key: GRACE_KEY } });
    raw = row ? row.value : null;
  } catch (err) {
    console.error('[restriction] could not read ' + GRACE_KEY + ': ' + err.message);
    return { days: GRACE_DEFAULT, source: 'default (settings unreadable)' };
  }

  if (raw === null || String(raw).trim() === '') {
    return { days: GRACE_DEFAULT, source: 'default (not set)' };
  }
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > GRACE_MAX) {
    console.warn(`[restriction] ${GRACE_KEY} = ${JSON.stringify(raw)} is not a whole number of days between 0 and ${GRACE_MAX}; using ${GRACE_DEFAULT}`);
    return { days: GRACE_DEFAULT, source: `default (invalid value ${JSON.stringify(raw)})` };
  }
  return { days: n, source: 'settings' };
}

// Everyone whose oldest unpaid invoice is past due + grace. Read-only: it decides
// nothing, it only answers "who would be restricted under the current policy".
// This is the exact query the nightly job will consume.
async function restrictionCandidates(prisma, radiusDb, graceDays) {
  const [rows] = await radiusDb.query(
    `SELECT s.id,
            s.account_number,
            trim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')) AS name,
            s.company_name,
            s.status AS subscriber_status,
            count(DISTINCT i.id)                      AS unpaid_invoices,
            min(i.due_date)                           AS oldest_due,
            (CURRENT_DATE - min(i.due_date))          AS days_past_due,
            sum(i.amount + coalesce(i.overdue_fee,0)) - coalesce(sum(p.paid),0) AS balance,
            -- Scalar subquery, NOT a join: joining hotspot_mac_devices here would
            -- duplicate every invoice row once per device and multiply the balance.
            (SELECT count(*) FROM hotspot_mac_devices hd
              WHERE hd.subscriber_id = s.id)          AS devices,
            (r.id IS NOT NULL)                        AS already_restricted,
            s.restriction_exempt
       FROM subscribers s
       JOIN invoices i ON i.subscriber_id = s.id
                      AND i.status IN ('pending','partial','overdue')
       LEFT JOIN LATERAL (
              -- 'success' is what the rest of the app writes (webhooks.js, accounting.js,
              -- admin.js all filter on it). The others are accepted defensively: an
              -- unrecognised status here reads as "never paid", which would cut off a
              -- customer who has settled — the failure mode has to be the harmless one.
              SELECT sum(amount) AS paid FROM payments
               WHERE invoice_id = i.id
                 AND lower(status) IN ('success','paid','completed','confirmed')
            ) p ON true
       LEFT JOIN subscriber_restrictions r ON r.subscriber_id = s.id AND r.lifted_at IS NULL
      -- Exempt accounts never appear as candidates at all, so no automated path can
      -- reach them. Restricting one by hand from their panel still works.
      WHERE s.restriction_exempt = false
      GROUP BY s.id, r.id
      -- Filter in HAVING, not WHERE: the trigger is the OLDEST unpaid invoice passing
      -- grace, but the balance shown must be everything they owe. Filtering invoices
      -- in WHERE would report only the past-grace slice and understate the debt.
     HAVING min(i.due_date) < (CURRENT_DATE - ?::int)
        -- A fully-credited invoice can still sit in 'pending'; do not chase a zero balance.
        AND sum(i.amount + coalesce(i.overdue_fee,0)) - coalesce(sum(p.paid),0) > 0
      ORDER BY days_past_due DESC`, [graceDays]);
  return rows;
}

// ── state ───────────────────────────────────────────────────
async function getRestriction(radiusDb, subscriberId) {
  const [rows] = await radiusDb.query(
    `SELECT * FROM subscriber_restrictions
      WHERE subscriber_id = ? AND lifted_at IS NULL
      ORDER BY id DESC LIMIT 1`, [subscriberId]);
  return rows[0] || null;
}

// ── restrict ────────────────────────────────────────────────
async function restrictSubscriber(prisma, radiusDb, subscriberId, opts = {}) {
  const sid = Number(subscriberId);
  const { reason = null, by = 'system', trigger = 'manual' } = opts;

  const open = await getRestriction(radiusDb, sid);
  if (open) return { alreadyRestricted: true, restriction: open };

  const [devices] = await radiusDb.query(
    `SELECT mac, profile FROM hotspot_mac_devices WHERE subscriber_id = ? ORDER BY mac`, [sid]);
  if (!devices.length) {
    const err = new Error('Subscriber has no registered devices to restrict');
    err.status = 400;
    throw err;
  }

  // Snapshot BEFORE changing anything — this is the only record of what to restore to.
  const snapshot = devices.map(d => ({ mac: d.mac, prev_profile: d.profile || null }));
  const macs = devices.map(d => d.mac);

  // Recorded per-restriction, so lifting always reverses what was actually applied
  // even if the policy setting changed while the customer was cut off.
  const { mode } = opts.mode ? { mode: opts.mode } : await getRestrictionMode(prisma);

  await radiusDb.transaction(async (conn) => {
    await conn.query(
      `INSERT INTO subscriber_restrictions
         (subscriber_id, reason, trigger_source, created_by, devices, mode)
       VALUES (?, ?, ?, ?, ?::jsonb, ?)`,
      [sid, reason, trigger, by, JSON.stringify(snapshot), mode]);

    for (const d of devices) {
      // A device with no group row yet still needs one, or it would authenticate
      // with no rate limit at all while nominally restricted.
      const [existing] = await conn.query(
        'SELECT 1 FROM radusergroup WHERE username = ? LIMIT 1', [d.mac]);
      if (existing.length) {
        await conn.query('UPDATE radusergroup SET groupname = ? WHERE username = ?',
          [RESTRICTED_GROUP, d.mac]);
      } else {
        await conn.query(
          'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)',
          [d.mac, RESTRICTED_GROUP]);
      }
      await conn.query('UPDATE hotspot_mac_devices SET profile = ? WHERE mac = ?',
        [RESTRICTED_GROUP, d.mac]);

      if (mode === 'full') {
        // Refuse the device at RADIUS. MAB authorises on User-Name alone via
        // Auth-Type := Accept, so flipping that value to Reject is the whole switch:
        // the DHCP server stops handing this MAC an address entirely.
        const [upd] = await conn.query(
          `UPDATE radcheck SET value = 'Reject'
            WHERE username = ? AND attribute = 'Auth-Type' RETURNING id`, [d.mac]);
        if (!upd.length) {
          // No Auth-Type row to flip (shouldn't happen for a registered device, but a
          // missing row would otherwise mean "restricted" silently did nothing).
          await conn.query(
            "INSERT INTO radcheck (username,attribute,op,value) VALUES (?, 'Auth-Type', ':=', 'Reject')",
            [d.mac]);
        }
      }
    }
  });

  // Router side — immediate effect. Failure here leaves the restriction recorded and
  // durable; it just will not bite until the next renewal, and the caller is told.
  const router = await safely('apply address-list', async () => {
    const deviceId = await getRouterDeviceId(prisma);
    const { ips } = await desiredRestrictedIps(prisma, radiusDb, deviceId);
    return reconcileAddressList(prisma, deviceId, ips, `restricted sub#${sid}`);
  });

  return { alreadyRestricted: false, devices: snapshot, macs, mode, router };
}

// ── restore ─────────────────────────────────────────────────
async function unrestrictSubscriber(prisma, radiusDb, subscriberId, opts = {}) {
  const sid = Number(subscriberId);
  const { by = 'system' } = opts;

  const open = await getRestriction(radiusDb, sid);
  if (!open) return { wasRestricted: false };

  // devices is jsonb; pg returns it already parsed, but tolerate a string.
  const snapshot = typeof open.devices === 'string' ? JSON.parse(open.devices) : (open.devices || []);

  // Fall back to the subscriber's current plan group for any device whose snapshot
  // has no previous profile — better than leaving it on plan-restricted forever.
  const [planRows] = await radiusDb.query(
    `SELECT p.radius_group FROM subscribers s
       JOIN plans p ON p.id = s.plan_id WHERE s.id = ? LIMIT 1`, [sid]);
  const planGroup = planRows[0] ? planRows[0].radius_group : null;

  const restored = [];
  await radiusDb.transaction(async (conn) => {
    // Reverse the RADIUS refusal first, and do it for every device on the account
    // rather than only the snapshot — a device added during a full cutoff was also
    // set to Reject by the register endpoint, and leaving one behind means the
    // customer is "restored" but still cannot get an address on that device.
    if (open.mode === 'full') {
      await conn.query(
        `UPDATE radcheck SET value = 'Accept'
          WHERE attribute = 'Auth-Type' AND value = 'Reject'
            AND username IN (SELECT mac FROM hotspot_mac_devices WHERE subscriber_id = ?)`,
        [sid]);
    }

    for (const d of snapshot) {
      const target = d.prev_profile || planGroup;
      if (!target) {
        // Nothing sane to restore to. Drop the group row so the device authenticates
        // unrestricted rather than staying throttled with no way out.
        await conn.query('DELETE FROM radusergroup WHERE username = ?', [d.mac]);
        await conn.query('UPDATE hotspot_mac_devices SET profile = NULL WHERE mac = ?', [d.mac]);
        restored.push({ mac: d.mac, profile: null });
        continue;
      }
      const [existing] = await conn.query(
        'SELECT 1 FROM radusergroup WHERE username = ? LIMIT 1', [d.mac]);
      if (existing.length) {
        await conn.query('UPDATE radusergroup SET groupname = ? WHERE username = ?', [target, d.mac]);
      } else {
        await conn.query(
          'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)', [d.mac, target]);
      }
      await conn.query('UPDATE hotspot_mac_devices SET profile = ? WHERE mac = ?', [target, d.mac]);
      restored.push({ mac: d.mac, profile: target });
    }

    // Devices registered DURING the restriction were forced onto plan-restricted by
    // the register endpoint, so they are not in the snapshot. Sweep them onto the
    // subscriber's plan group — otherwise they stay throttled forever.
    const known = new Set(snapshot.map(d => String(d.mac).toUpperCase()));
    const [strays] = await conn.query(
      `SELECT mac FROM hotspot_mac_devices
        WHERE subscriber_id = ? AND profile = ?`, [sid, RESTRICTED_GROUP]);
    for (const s of strays) {
      if (known.has(String(s.mac).toUpperCase())) continue;
      if (planGroup) {
        await conn.query('UPDATE radusergroup SET groupname = ? WHERE username = ?', [planGroup, s.mac]);
        await conn.query('UPDATE hotspot_mac_devices SET profile = ? WHERE mac = ?', [planGroup, s.mac]);
      } else {
        await conn.query('DELETE FROM radusergroup WHERE username = ?', [s.mac]);
        await conn.query('UPDATE hotspot_mac_devices SET profile = NULL WHERE mac = ?', [s.mac]);
      }
      restored.push({ mac: s.mac, profile: planGroup || null, addedDuringRestriction: true });
    }

    await conn.query(
      'UPDATE subscriber_restrictions SET lifted_at = now(), lifted_by = ? WHERE id = ?',
      [by, open.id]);
  });

  const router = await safely('clear address-list', async () => {
    const deviceId = await getRouterDeviceId(prisma);
    const { ips } = await desiredRestrictedIps(prisma, radiusDb, deviceId);
    return reconcileAddressList(prisma, deviceId, ips, 'billing restriction');
  });

  return { wasRestricted: true, restored, router, restrictionId: open.id };
}

// ── automation ──────────────────────────────────────────────
// Two passes, deliberately asymmetric:
//
//   restore  — always safe, always allowed to run. Only ever gives access back.
//   restrict — gated behind an explicit setting, capped per run, and only touches
//              subscribers who are past grace AND still owe money.
//
// Both are driven off restrictionCandidates(), so "who should be restricted" is
// defined in exactly one place and the two passes can never disagree.

async function readNumberSetting(prisma, key, def, min, max) {
  try {
    const row = await prisma.system_settings.findUnique({ where: { key } });
    const n = Number(String(row ? row.value : '').trim());
    if (!Number.isInteger(n) || n < min || n > max) return def;
    return n;
  } catch (_) { return def; }
}

async function isAutoRestrictEnabled(prisma) {
  try {
    const row = await prisma.system_settings.findUnique({ where: { key: 'billing_auto_restrict_enabled' } });
    return String(row ? row.value : '').trim().toLowerCase() === 'true';
  } catch (_) { return false; }
}

// Lift restrictions the automation itself created, once the subscriber no longer
// qualifies. Manual restrictions are left alone on purpose: an admin who cut someone
// off for abuse must not have that quietly undone by a payment.
async function runAutoRestore(prisma, radiusDb) {
  // Cheap guard first: with nothing restricted there is nothing to reconcile, and this
  // runs often enough that the aggregate below should not be paid for needlessly.
  // trigger_source is the whole point of this filter and it was missing: without it
  // this pass lifted MANUAL restrictions too, seconds after an admin applied one,
  // because "not currently eligible for automatic restriction" is not the same thing
  // as "settled". A subscriber inside the grace window still owing money is not a
  // candidate, so a manual cutoff was undone on the very next tick — the button
  // appeared to do nothing. Only restrictions this automation created may be lifted
  // by it; a manual one is lifted by a human, or by restoreIfSettled on payment.
  const [open] = await radiusDb.query(
    `SELECT subscriber_id FROM subscriber_restrictions
      WHERE lifted_at IS NULL AND no_auto_restore = false
        AND trigger_source = 'overdue-job'`);
  if (!open.length) return { lifted: [] };

  const { days } = await getGraceDays(prisma);
  const candidates = await restrictionCandidates(prisma, radiusDb, days);
  const stillOwing = new Set(candidates.map(c => Number(c.id)));

  const lifted = [];
  for (const r of open) {
    const sid = Number(r.subscriber_id);
    if (stillOwing.has(sid)) continue;         // still past grace with a balance
    try {
      const out = await unrestrictSubscriber(prisma, radiusDb, sid, { by: 'auto (account settled)' });
      if (out.wasRestricted) lifted.push({ subscriberId: sid, devices: out.restored.length });
    } catch (err) {
      console.error(`[auto-restore] subscriber ${sid} failed: ${err.message}`);
    }
  }
  return { lifted };
}

// ── restore on payment ──────────────────────────────────────
// Called straight from the payment endpoints so service resumes on the spot rather than
// waiting for the next reconcile tick. Policy, set by the operator: paying restores
// access, whoever applied the cutoff. A restriction applied for something billing cannot
// see — abuse, equipment recovery, a disputed account — must be marked no_auto_restore
// when it is created, and then it holds until a human lifts it.
//
// Never throws. A payment must be recorded even if the router is unreachable; the
// reconcile job picks up anything missed here.
async function restoreIfSettled(prisma, radiusDb, subscriberId, opts = {}) {
  const sid = Number(subscriberId);
  try {
    const open = await getRestriction(radiusDb, sid);
    if (!open) return { restored: false, reason: 'not restricted' };
    if (open.no_auto_restore) return { restored: false, reason: 'held for manual review' };

    // Reuse the eligibility query rather than re-deriving "settled" here — one
    // definition of who owes money, so payment and cutoff can never disagree.
    const { days } = await getGraceDays(prisma);
    const candidates = await restrictionCandidates(prisma, radiusDb, days);
    if (candidates.some(c => Number(c.id) === sid)) {
      return { restored: false, reason: 'still past grace with a balance' };
    }

    const out = await unrestrictSubscriber(prisma, radiusDb, sid,
      { by: opts.by || 'auto (payment received)' });
    return {
      restored: !!out.wasRestricted,
      devices: out.restored ? out.restored.length : 0,
      routerApplied: out.router ? out.router.ok : null,
      restrictionId: open.id,
    };
  } catch (err) {
    console.error(`[restore-on-payment] subscriber ${sid}: ${err.message}`);
    return { restored: false, error: err.message };
  }
}

// dryRun reports what it would do without touching anything — this is what runs while
// the feature is switched off, so the behaviour can be watched in the logs for a few
// days before it is trusted with real customers.
async function runAutoRestrict(prisma, radiusDb, opts = {}) {
  const dryRun = opts.dryRun !== undefined ? opts.dryRun : !(await isAutoRestrictEnabled(prisma));
  const { days } = await getGraceDays(prisma);
  const { mode } = await getRestrictionMode(prisma);
  const cap = await readNumberSetting(prisma, 'billing_auto_restrict_max_per_run', 25, 1, 10000);

  const candidates = await restrictionCandidates(prisma, radiusDb, days);
  const eligible = candidates.filter(c =>
    !c.already_restricted &&           // nothing to do
    Number(c.devices) > 0);            // no registered device = nothing to restrict

  const skippedNoDevices = candidates.filter(c => !c.already_restricted && Number(c.devices) === 0)
    .map(c => Number(c.id));

  const capped = eligible.length > cap;
  const batch = eligible.slice(0, cap);

  const restricted = [];
  if (!dryRun) {
    for (const c of batch) {
      try {
        const out = await restrictSubscriber(prisma, radiusDb, Number(c.id), {
          reason: `Automatic: ${c.days_past_due} days past due, balance ${c.balance}`,
          by: 'auto (overdue job)', trigger: 'overdue-job',
        });
        if (!out.alreadyRestricted) {
          restricted.push({ subscriberId: Number(c.id), account: c.account_number,
            daysPastDue: Number(c.days_past_due), balance: c.balance, mode: out.mode,
            routerApplied: out.router.ok });
        }
      } catch (err) {
        console.error(`[auto-restrict] subscriber ${c.id} failed: ${err.message}`);
      }
    }
  }

  return {
    dryRun, graceDays: days, mode, cap, capped,
    eligible: eligible.map(c => ({ subscriberId: Number(c.id), account: c.account_number,
      name: c.name || c.company_name, daysPastDue: Number(c.days_past_due),
      balance: c.balance, devices: Number(c.devices) })),
    restricted,
    // Surfaced rather than silently ignored: a subscriber past grace with no
    // registered device is invisible to enforcement and someone should know.
    skippedNoDevices,
  };
}

module.exports = {
  RESTRICTED_GROUP,
  ADDRESS_LIST,
  isAutoRestrictEnabled,
  runAutoRestrict,
  runAutoRestore,
  restoreIfSettled,
  GRACE_KEY,
  GRACE_DEFAULT,
  MODE_KEY,
  MODE_DEFAULT,
  MODES,
  getRestrictionMode,
  getGraceDays,
  restrictionCandidates,
  getRouterDeviceId,
  getRestriction,
  restrictSubscriber,
  unrestrictSubscriber,
  syncAddressList,
  reconcileAddressList,
  leaseIpsForMacs,
};
