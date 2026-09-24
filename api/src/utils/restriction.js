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
const radiusGroups = require('./radius-groups');

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

// ── router selection, per subscriber ────────────────────────
// getRouterDeviceId above answers "which router is lowest-numbered and active", which
// was the same question as "which router carries this customer" only while there was
// one router. There are now 16, and not one registered subscriber device sits behind
// the one it returns — so every address-list write landed on a router that could not
// see the traffic it was supposed to restrict, and the walled garden never applied to
// anybody. It is kept only for the DHCP-server callers (device-release, nf-paying).
//
// The mapping that does hold is the one RADIUS already records for us. An accounting
// session carries both halves of the answer:
//
//   radacct.framedipaddress -> the address to put on nf-restricted
//   radacct.nasipaddress    -> nas.nasname -> nas.shortname -> mikrotik_devices.label
//
// Joined on shortname/label rather than address because the NAS-IP-Address a router
// sends is its internal MGMT address (192.168.9x.x) while mikrotik_devices.host is the
// public address its API answers on; those differ on every device here. Falling back
// to host covers a NAS row whose shortname was never lined up with a device label.
async function routerMap(prisma, radiusDb) {
  const [nasRows] = await radiusDb.query('SELECT nasname, shortname FROM nas');
  const devices = await prisma.mikrotik_devices.findMany({
    where: { is_active: true }, select: { id: true, label: true, host: true },
  });
  const norm = (v) => String(v || '').trim().toLowerCase();
  const byLabel = new Map(devices.map(d => [norm(d.label), d.id]));
  const byHost = new Map(devices.map(d => [String(d.host || '').trim(), d.id]));

  const map = new Map();           // NAS address -> mikrotik device id
  for (const n of nasRows) {
    const nasname = String(n.nasname || '').trim();
    if (!nasname) continue;
    const id = byLabel.has(norm(n.shortname)) ? byLabel.get(norm(n.shortname)) : byHost.get(nasname);
    if (id !== undefined) map.set(nasname, id);
  }
  // A router can also appear as its own NAS address with no matching nas row.
  for (const d of devices) {
    const h = String(d.host || '').trim();
    if (h && !map.has(h)) map.set(h, d.id);
  }
  return map;
}

// Which router is carrying this address right now. Used by the payment window, which
// has an address in hand and needs to punch a hole on the right box.
async function routerDeviceIdForIp(prisma, radiusDb, ip) {
  const [rows] = await radiusDb.query(
    `SELECT host(nasipaddress) AS nasip FROM radacct
      WHERE framedipaddress = ?::inet AND acctstoptime IS NULL
      ORDER BY radacctid DESC LIMIT 1`, [ip]);
  if (!rows.length) return null;
  const map = await routerMap(prisma, radiusDb);
  const id = map.get(rows[0].nasip);
  return id === undefined ? null : id;
}

// Every restricted device, the address it currently holds, and the router that
// authorised it. Driven off open accounting sessions because that is the same source
// /api/restricted uses to identify a caller — so the firewall and the payment page can
// never disagree about who is sitting on which address.
//
// LEFT JOIN, not JOIN: a restricted device with no open session cannot be placed on any
// router, and that is worth reporting rather than silently dropping. It means the
// cutoff does not bite until they reconnect.
async function desiredRestrictedByRouter(prisma, radiusDb) {
  const [rows] = await radiusDb.query(
    `WITH identities AS (
        -- Every RADIUS username belonging to a subscriber under an open restriction.
        -- The MAC is the usual one. The account number is the second identity the
        -- cutoff used to ignore completely, and a session dialled under it needs
        -- walling exactly as much — putting it in plan-restricted only throttles it.
        SELECT r.subscriber_id, d.mac AS username
          FROM subscriber_restrictions r
          JOIN hotspot_mac_devices d ON d.subscriber_id = r.subscriber_id
         WHERE r.lifted_at IS NULL
        UNION
        -- Gated on an OPEN SESSION, not on the credential existing. Most of these
        -- accounts never dial, and including a username with nothing to place would
        -- report every restricted subscriber as "no open session" — making a cutoff
        -- that is working look half-applied on the admin screen.
        SELECT r.subscriber_id, s.account_number AS username
          FROM subscriber_restrictions r
          JOIN subscribers s ON s.id = r.subscriber_id
         WHERE r.lifted_at IS NULL
           AND s.account_number IS NOT NULL
           AND EXISTS (SELECT 1 FROM radacct a
                        WHERE a.username = s.account_number
                          AND a.acctstoptime IS NULL
                          AND a.framedipaddress IS NOT NULL)
     )
     SELECT DISTINCT ON (i.username)
            i.username AS mac,
            i.subscriber_id,
            host(a.framedipaddress) AS ip,
            host(a.nasipaddress)    AS nasip
       FROM identities i
       LEFT JOIN radacct a ON a.username = i.username
                          AND a.acctstoptime IS NULL
                          AND a.framedipaddress IS NOT NULL
      ORDER BY i.username, a.radacctid DESC NULLS LAST`);

  const map = await routerMap(prisma, radiusDb);
  const byDevice = new Map();      // device id -> Set of addresses
  const placed = [];
  const unplaceable = [];

  for (const row of rows) {
    if (!row.ip) {
      unplaceable.push({ mac: row.mac, subscriberId: Number(row.subscriber_id), reason: 'no open session' });
      continue;
    }
    const deviceId = map.get(row.nasip);
    if (deviceId === undefined) {
      unplaceable.push({ mac: row.mac, subscriberId: Number(row.subscriber_id), ip: row.ip,
        nasip: row.nasip, reason: 'NAS not mapped to an active router' });
      continue;
    }
    if (!byDevice.has(deviceId)) byDevice.set(deviceId, new Set());
    byDevice.get(deviceId).add(row.ip);
    placed.push({ mac: row.mac, subscriberId: Number(row.subscriber_id), ip: row.ip, deviceId });
  }
  return { byDevice, placed, unplaceable };
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

// Re-apply the address list from the database, on every router. Idempotent.
//
// Every active router is reconciled, not only the ones with somebody to restrict:
// a device that moves between concentrators leaves its old entry behind, and an entry
// nobody clears keeps whoever inherits that address inside the garden. A router with
// nobody restricted on it therefore gets an empty want-set, which clears exactly that
// drift.
//
// Per-router failures are collected rather than thrown. One unreachable router must not
// stop the other fifteen from being brought into line.
// Set whenever a router could not be reconciled, cleared by a clean sweep. The sync job
// skips its work entirely when nobody is restricted, which is right for the normal case
// but would otherwise strand an entry: if the last restriction is lifted while a router
// is unreachable, that router keeps a paid-up customer inside the garden and no later
// run ever looks at it again. This flag is what makes the job come back.
let _needsSweep = false;
function needsSweep() { return _needsSweep; }

async function syncAddressList(prisma, radiusDb, opts = {}) {
  const { byDevice, placed, unplaceable } = await desiredRestrictedByRouter(prisma, radiusDb);
  const devices = await prisma.mikrotik_devices.findMany({
    where: { is_active: true }, select: { id: true, label: true }, orderBy: { id: 'asc' },
  });

  const added = [], removed = [], failed = [];
  // Bounded concurrency, not Promise.all over all sixteen. Opening every router at once
  // makes them time each other out — the RouterOS API connect is slow enough that a
  // burst of sixteen tripped the 10s connect timeout on a dozen boxes that are
  // individually fine. Four at a time finishes well inside the 5-minute schedule.
  const queue = devices.slice();
  const worker = async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      const want = [...(byDevice.get(d.id) || [])];
      const r = await safely(`reconcile ${ADDRESS_LIST} on #${d.id} ${d.label}`, () =>
        reconcileAddressList(prisma, d.id, want, opts.comment || 'billing restriction (synced)'));
      if (!r.ok) { failed.push({ deviceId: d.id, label: d.label, error: r.error }); continue; }
      for (const ip of r.result.added) added.push(`${ip}@${d.label}`);
      for (const ip of r.result.removed) removed.push(`${ip}@${d.label}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, devices.length) }, worker));

  _needsSweep = failed.length > 0;
  return { added, removed, failed, placed, unplaceable };
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
       -- LEFT, not JOIN: three subscribers carry no plan at all, and dropping them
       -- here would quietly exempt them from every cutoff.
       LEFT JOIN plans pl ON pl.id = s.plan_id
       JOIN invoices i ON i.subscriber_id = s.id
                      AND i.status IN ('pending','partial','overdue')
                      -- A prepaid top-up is a purchase, never a debt. An abandoned
                      -- checkout leaves a pending invoice dated today; counted here it
                      -- would age past grace and cut off a prepaid customer for
                      -- "non-payment" while they still hold weeks of paid service.
                      AND i.prepaid_days IS NULL
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
        -- A prepaid line is governed by its expiry date, never by arrears. The filter
        -- on i.prepaid_days above only keeps top-up invoices from reading as debt; it
        -- says nothing about the customer. Someone who moved onto a prepaid plan still
        -- owing an old postpaid balance would otherwise buy 30 days, come back online,
        -- and be cut off again at the next 9am sweep for the debt they did not pay —
        -- less than a day of the time they bought. The arrears are not forgiven by
        -- this: they stay on the invoice, in A/R and on the walled-garden page. They
        -- are simply not what disconnects a prepaid customer. Running out of days is.
        AND lower(coalesce(pl.billing_type, 'postpaid')) <> 'prepaid'
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

  // THE SECOND IDENTITY. A cutoff that only moves MACs is not a cutoff.
  //
  // Most of the fleet authenticates by MAC, but some subscribers also hold a
  // username/password credential keyed on their account number, and restricting only
  // ever touched hotspot_mac_devices. Measured 2026-09-24 on a restricted account: the
  // MAC sat in plan-restricted while that subscriber's `radusergroup <account-number>`
  // row stayed on their full-speed group with a working password, so dialling PPPoE
  // with the account number came up at full speed straight past the walled garden.
  // The account number is printed on the hold page the customer is looking at while
  // they do it.
  //
  // has_cred matters as much as the group row: a credential with no radusergroup row
  // authenticates into no group at all, which is unshaped rather than restricted, so
  // that case needs a row INSERTED rather than updated.
  const [acctRows] = await radiusDb.query(
    `SELECT s.account_number AS username,
            (SELECT g.groupname FROM radusergroup g
              WHERE g.username = s.account_number LIMIT 1) AS groupname,
            (SELECT c.value FROM radcheck c
              WHERE c.username = s.account_number AND c.attribute = 'Auth-Type' LIMIT 1) AS prev_auth,
            EXISTS(SELECT 1 FROM radcheck c WHERE c.username = s.account_number) AS has_cred
       FROM subscribers s WHERE s.id = ? LIMIT 1`, [sid]);
  const acct = acctRows[0] && acctRows[0].username &&
               (acctRows[0].groupname || acctRows[0].has_cred) ? acctRows[0] : null;

  if (!devices.length && !acct) {
    const err = new Error('Subscriber has no registered devices to restrict');
    err.status = 400;
    throw err;
  }

  // Snapshot BEFORE changing anything — this is the only record of what to restore to.
  //
  // `mac` holds the RADIUS username, which for an account entry is the account number
  // rather than a MAC. kind tells the two apart on the way back; entries written before
  // this existed have no kind and are MACs, which is what the restore assumes.
  const snapshot = devices.map(d => ({ mac: d.mac, prev_profile: d.profile || null }));
  if (acct) snapshot.push({
    mac: acct.username, kind: 'account',
    prev_profile: acct.groupname || null,
    // Null means "there was no Auth-Type row". Restoring that as Accept instead of
    // deleting it would leave the account authenticating with no password check at
    // all — a restriction that ends in an auth bypass.
    prev_auth: acct.prev_auth || null,
  });
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

    // Over the snapshot, not over devices: the account-number credential is in the
    // snapshot and is not a device, and it has to be moved too or the cutoff has a
    // front door standing open beside it.
    for (const d of snapshot) {
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
      // Only a real device has a row here. An account number would match nothing,
      // but being explicit keeps the intent readable.
      if (d.kind !== 'account') {
        await conn.query('UPDATE hotspot_mac_devices SET profile = ? WHERE mac = ?',
          [RESTRICTED_GROUP, d.mac]);
      }

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
  //
  // ok reflects THIS subscriber's routers only. Reconciling touches all sixteen, and a
  // box that is unreachable for unrelated reasons must not report a cutoff as failed
  // when the router actually carrying the customer took it cleanly.
  const router = await safely('apply address-list', async () => {
    const out = await syncAddressList(prisma, radiusDb, { comment: `restricted sub#${sid}` });
    const mine = new Set(out.placed.filter(p => p.subscriberId === sid).map(p => p.deviceId));
    const myFailures = out.failed.filter(f => mine.has(f.deviceId));
    if (myFailures.length) throw new Error(myFailures.map(f => `${f.label}: ${f.error}`).join('; '));
    // Not an error, but the cutoff is not live either: nothing to pin the rules to
    // until the device reconnects and RADIUS records an address for it.
    out.notApplied = out.unplaceable.filter(u => u.subscriberId === sid);
    return out;
  }, 45000);

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
  // The whole plan record, not just the group name: if that group turns out to be
  // empty we rebuild it from these speeds rather than restore into nothing.
  const [planRows] = await radiusDb.query(
    `SELECT p.id, p.radius_group, p.download_mbps, p.upload_mbps, p.speed_mbps,
            p.burst_download_mbps, p.burst_upload_mbps, p.burst_threshold_pct, p.burst_time_s
       FROM subscribers s
       JOIN plans p ON p.id = s.plan_id WHERE s.id = ? LIMIT 1`, [sid]);
  const plan = planRows[0] || null;
  const planGroup = plan ? plan.radius_group : null;

  // Every group that belongs to some plan, used only to tell two cases apart below.
  const [planGroupRows] = await radiusDb.query(
    `SELECT DISTINCT radius_group FROM plans WHERE radius_group IS NOT NULL`);
  const planGroups = new Set(planGroupRows.map(r => r.radius_group));

  // prev_profile is the right answer while nothing else moved, and the WRONG answer
  // when the subscriber's plan changed during the cutoff — which is exactly what the
  // walled garden's prepaid option will do. Someone cut off on fiber-200 who then buys
  // the 50 Mbps prepaid tier would otherwise come back at 200 Mbps, having paid for a
  // quarter of it, with the arrears still outstanding.
  //
  // Override ONLY when prev_profile is recognisably some other PLAN's group. A profile
  // matching no plan is a hand-made group somebody set deliberately, and a restore has
  // no business overwriting that.
  const chooseTarget = (prev) => {
    if (!prev) return planGroup;
    if (planGroup && prev !== planGroup && planGroups.has(prev)) return planGroup;
    return prev;
  };

  // Rebuild the plan's group before anybody is restored into it. Deactivating a plan
  // used to delete its radgroupreply rows out from under the subscribers still on it,
  // and a group with no attributes answers Access-Accept with no rate limit — the
  // customer comes back unshaped and with no interim accounting, so the sync jobs
  // cannot see the session either. No-op when the group is already there.
  const healed = plan ? await radiusGroups.ensureGroupForPlan(radiusDb, plan) : null;
  if (healed && healed.created) {
    console.warn(`[restriction] sub#${sid}: rebuilt missing RADIUS group ` +
                 `${planGroup} -> ${healed.rateLimit} before restoring`);
  }
  const unshaped = [];

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
      const isAccount = d.kind === 'account';

      // Put the account credential's Auth-Type back to EXACTLY what it was, which for
      // an account number is normally no row at all. The MAC path above sets Reject
      // back to Accept because MAB authorises on the username alone and Accept is its
      // resting state. An account authenticates against Cleartext-Password, so
      // Auth-Type := Accept there means "let this in WITHOUT checking the password" —
      // lifting a restriction would hand out an auth bypass. Delete, do not flip.
      if (isAccount && open.mode === 'full') {
        if (d.prev_auth) {
          await conn.query(
            `UPDATE radcheck SET value = ? WHERE username = ? AND attribute = 'Auth-Type'`,
            [d.prev_auth, d.mac]);
        } else {
          await conn.query(
            `DELETE FROM radcheck WHERE username = ? AND attribute = 'Auth-Type'`, [d.mac]);
        }
      }

      let target = chooseTarget(d.prev_profile);

      // Never restore anybody into a group that replies with nothing. ensureGroupForPlan
      // above has already rebuilt the current plan's group if it was missing, so this
      // catches the remaining case: a stale prev_profile naming a group that has since
      // been emptied. Prefer the plan over the ghost.
      if (target && !(await radiusGroups.groupHasAttributes(conn, target))) {
        if (planGroup && target !== planGroup &&
            await radiusGroups.groupHasAttributes(conn, planGroup)) {
          console.warn(`[restriction] sub#${sid}: ${target} has no attributes — ` +
                       `restoring ${d.mac} to ${planGroup} instead`);
          target = planGroup;
        } else {
          // Both empty. Unshaped is the lesser evil against leaving somebody who has
          // paid throttled with no way out, but it is not silent: it is warned and
          // reported back to the caller.
          console.warn(`[restriction] sub#${sid}: no usable RADIUS group for ${d.mac} ` +
                       `(${target} is empty) — restoring UNSHAPED`);
          unshaped.push({ username: d.mac, group: target });
          target = null;
        }
      }

      if (!target) {
        // Nothing sane to restore to. Drop the group row so the device authenticates
        // unrestricted rather than staying throttled with no way out.
        await conn.query('DELETE FROM radusergroup WHERE username = ?', [d.mac]);
        if (!isAccount) {
          await conn.query('UPDATE hotspot_mac_devices SET profile = NULL WHERE mac = ?', [d.mac]);
        }
        restored.push({ mac: d.mac, profile: null, kind: d.kind });
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
      if (!isAccount) {
        await conn.query('UPDATE hotspot_mac_devices SET profile = ? WHERE mac = ?', [target, d.mac]);
      }
      restored.push({ mac: d.mac, profile: target, kind: d.kind });
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

  // Clearing runs across every router for the same reason restricting does — and here
  // a missed router is the worse failure of the two: it leaves a paid-up customer
  // walled in. Any failure is surfaced, not just this subscriber's, so the reconcile
  // job knows there is drift left to repair.
  // Unlike restricting, a failure here is not thrown. The restriction is already lifted
  // in the database and the customer's RADIUS group is back; refusing to report that
  // because an unrelated router was unreachable helps nobody. What a failure does do is
  // arm needsSweep, so the reconcile job keeps coming back until every router is clear —
  // a stale entry left behind is a customer who paid and is still walled in.
  const router = await safely('clear address-list', () =>
    syncAddressList(prisma, radiusDb, { comment: 'billing restriction' }), 45000);

  return { wasRestricted: true, restored, router, restrictionId: open.id,
           // Non-empty means somebody came back with no rate limit on them. The caller
           // can surface it; silence here is how five subscribers sat on deleted groups.
           unshaped: unshaped.length ? unshaped : undefined,
           rebuiltGroup: healed && healed.created ? planGroup : undefined };
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

  // Prepaid subscribers are excluded from restrictionCandidates by design — their
  // cutoff is expiry, not arrears. Absence from that list must not read as "settled".
  // Without this, a cutoff applied by the overdue job while the customer was postpaid
  // would be lifted on the very next tick the moment they were moved onto a prepaid
  // plan, handing back service nobody paid for — and nothing would catch it, because
  // expiryCandidates deliberately skips `expires_at IS NULL` (never topped up). On a
  // prepaid line only live paid time lifts a cutoff, and buying it goes through
  // prepaid.grant(), which restores on its own.
  const [noTime] = await radiusDb.query(
    `SELECT s.id FROM subscribers s
       JOIN plans p ON p.id = s.plan_id
                   AND lower(coalesce(p.billing_type,'')) = 'prepaid'
      WHERE s.expires_at IS NULL OR s.expires_at <= now()`);
  const prepaidOutOfTime = new Set(noTime.map(r => Number(r.id)));

  const lifted = [];
  for (const r of open) {
    const sid = Number(r.subscriber_id);
    if (stillOwing.has(sid)) continue;         // still past grace with a balance
    if (prepaidOutOfTime.has(sid)) continue;   // prepaid line with no days left
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

    // Prepaid carries no debt, so "no overdue invoice" does not mean "paid up" — an
    // expired prepaid account has simply run out. Without this guard, settling any
    // unrelated invoice (an installation fee, an old postpaid balance from before the
    // plan was switched) would hand back service nobody bought. Topping up goes
    // through prepaid.grant(), which restores on its own.
    const sub = await prisma.subscribers.findUnique({
      where: { id: sid }, include: { plan: true },
    });
    if (sub && String(sub.plan && sub.plan.billing_type || '').toLowerCase() === 'prepaid') {
      const exp = sub.expires_at ? new Date(sub.expires_at).getTime() : 0;
      if (exp <= Date.now()) return { restored: false, reason: 'prepaid service expired' };
    }

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
      // Passed through so a payment-triggered restore that came back with no rate
      // limit on it lands in the audit log. Dropping these here would put the silence
      // straight back: this is the path a paying customer actually takes.
      unshaped: out.unshaped,
      rebuiltGroup: out.rebuiltGroup,
    };
  } catch (err) {
    console.error(`[restore-on-payment] subscriber ${sid}: ${err.message}`);
    return { restored: false, error: err.message };
  }
}

// Only one applying sweep at a time. There are now three ways to start one — the daily
// job, POST /restrictions/run?apply=true, and switching the setting on — and each
// restriction is a router write, so two overlapping sweeps would queue tens of API
// calls against the same boxes and add the same address twice. The unique index on
// subscriber_restrictions already stops a double cut-off in the database; this stops
// the wasted router traffic in front of it. Dry runs are never blocked: they write
// nothing, and a preview must always be able to answer.
let _sweepRunning = false;

// dryRun reports what it would do without touching anything — this is what runs while
// the feature is switched off, so the behaviour can be watched in the logs for a few
// days before it is trusted with real customers.
async function runAutoRestrict(prisma, radiusDb, opts = {}) {
  const dryRun = opts.dryRun !== undefined ? opts.dryRun : !(await isAutoRestrictEnabled(prisma));

  if (!dryRun && _sweepRunning) {
    console.warn('[auto-restrict] a sweep is already running — this one is skipped');
    // Same shape as a real result so every caller's .length checks stay valid.
    return { dryRun: false, graceDays: null, mode: null, cap: null, capped: false,
             eligible: [], restricted: [], skippedNoDevices: [],
             skipped: 'a sweep is already running' };
  }
  if (!dryRun) _sweepRunning = true;
  try {
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
  } finally {
    if (!dryRun) _sweepRunning = false;
  }
}

// ── run the moment the switch is thrown ─────────────────────
// Turning the feature on used to change nothing until the next daily pass, which is
// up to 24 hours away — on 2026-09-22 the setting read true while the last pass had
// already run as a dry run, so ten accounts that were 28 days past due were still
// enjoying full service and the dashboard said restriction was ON. An operator who
// throws this switch means "now".
//
// Split in two on purpose. The preview is one indexed query and is awaited, so the
// caller can answer the HTTP request with the real number of accounts about to be
// cut off. The enforcement is a router write per subscriber — up to the per-run cap,
// several seconds each — and runs detached, because holding a settings save open for
// a minute behind nginx would time out and leave the operator unsure whether the
// setting even stuck.
//
// The outcome therefore has to be recorded where it can be found later: the log, and
// an audit_log row written here rather than through req.auditLog, which belongs to a
// request that has already been answered.
async function sweepOnEnable(prisma, radiusDb, opts = {}) {
  const by = opts.by || 'admin';
  const preview = await runAutoRestrict(prisma, radiusDb, { dryRun: true });

  console.log('[auto-restrict] switched on by ' + by + ' — ' + preview.eligible.length +
    ' account(s) past ' + preview.graceDays + ' days grace, enforcing now (' + preview.mode + ')');

  // Deliberately not awaited. dryRun is left unset so runAutoRestrict re-reads the
  // setting: if the upsert that triggered this somehow did not land, this becomes a
  // dry run instead of cutting anybody off on a setting that was never saved.
  setImmediate(() => {
    runAutoRestrict(prisma, radiusDb)
      .then(async (out) => {
        if (out.skipped) {
          console.warn('[auto-restrict] on-enable sweep skipped: ' + out.skipped);
          return;
        }
        if (out.dryRun) {
          console.warn('[auto-restrict] on-enable sweep ran as a DRY RUN — the setting did not stick');
          return;
        }
        console.log('[auto-restrict] on-enable sweep ' +
          (out.mode === 'full' ? 'cut off ' : 'restricted ') + out.restricted.length + ' subscriber(s)' +
          (out.capped ? ' (CAP HIT — ' + out.eligible.length + ' qualify, limit ' + out.cap + ')' : ''));
        out.restricted.forEach(r => console.log('    #' + r.subscriberId + ' ' + r.account +
          ' — ' + r.daysPastDue + 'd past due, balance ' + r.balance +
          (r.routerApplied ? '' : ' (ROUTER NOT UPDATED)')));
        if (out.skippedNoDevices.length) {
          console.warn('[auto-restrict] ' + out.skippedNoDevices.length +
            ' subscriber(s) past grace have no registered device, so nothing could be enforced: ' +
            out.skippedNoDevices.join(', '));
        }
        try {
          await prisma.audit_log.create({ data: {
            user_type: 'system', user_id: 0,
            action: 'BILLING_AUTO_RESTRICT_ON_ENABLE',
            entity_type: 'subscriber_restrictions',
            details: { by, graceDays: out.graceDays, mode: out.mode,
                       restricted: out.restricted, capped: out.capped,
                       skippedNoDevices: out.skippedNoDevices },
            ip_address: '127.0.0.1',
          }});
        } catch (e) {
          console.error('[auto-restrict] could not write audit row: ' + e.message);
        }
      })
      // Detached work has no request to fail, so an unhandled rejection here would be
      // an invisible crash. Catch it and say so.
      .catch(err => console.error('[auto-restrict] on-enable sweep failed: ' + err.message));
  });

  return {
    triggered: true,
    graceDays: preview.graceDays,
    mode: preview.mode,
    eligible: preview.eligible.length,
    cap: preview.cap,
    capped: preview.capped,
    skippedNoDevices: preview.skippedNoDevices.length,
    accounts: preview.eligible.map(e => e.account),
  };
}

module.exports = {
  RESTRICTED_GROUP,
  ADDRESS_LIST,
  needsSweep,
  isAutoRestrictEnabled,
  runAutoRestrict,
  sweepOnEnable,
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
  routerMap,
  routerDeviceIdForIp,
  desiredRestrictedByRouter,
  getRestriction,
  restrictSubscriber,
  unrestrictSubscriber,
  syncAddressList,
  reconcileAddressList,
  leaseIpsForMacs,
};
