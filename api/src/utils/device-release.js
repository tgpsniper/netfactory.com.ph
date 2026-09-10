// ============================================================
// DEVICE RELEASE — clean up everything a MAC leaves behind
// ============================================================
// Removing a device from the whitelist only stops it authenticating NEXT time. Four
// other things outlive it, and each has bitten us:
//
//   1. The DHCP lease. Session-Timeout is 86400, so a dead device's address stays
//      reserved for up to 24h. Worse, dhcp1 runs add-arp=true against an interface set
//      to arp=reply-only, so that address is unusable by anyone else until the lease
//      expires — the router will not answer ARP for a host it has no lease for.
//   2. The ARP entry. Normally removed with the lease, but a leftover or static one
//      keeps the address blackholed for the same reason.
//   3. The open accounting session. radacct rows with acctstoptime IS NULL are what the
//      UI reads to decide "Online". A device deleted mid-session shows as online for
//      ever — 70:28:F2:22:FA:56 sat like that from 11 Aug.
//   4. subscribers.mac_address. Cosmetic, but it feeds the "Register device" prefill,
//      so a stale value is an invitation to re-register hardware that is out of service.
//
// The address-list entry is a fifth: it is keyed on the lease address, so once the lease
// is gone the entry refers to an address that may be handed to somebody else.
//
// DB cleanup runs first and unconditionally. The router half is best effort: an
// unreachable router must not leave the database half-cleaned.
const mikrotik = require('./mikrotik');
const { getRouterDeviceId, ADDRESS_LIST } = require('./restriction');

// The DHCP server that authenticates by MAC. Only leases here are safe to reclaim from
// an unregistered MAC — hs-dhcp authenticates by username at the portal, so its clients
// legitimately hold leases without ever appearing in hotspot_mac_devices.
const MAB_DHCP_SERVER = process.env.MAB_DHCP_SERVER || 'dhcp1';

const upper = v => String(v || '').toUpperCase();
const macOf = l => upper(l['mac-address'] || l.macAddress);
const idOf = r => r['.id'] || r.id;

// Same reasoning as restriction.safely: the RouterOS client hangs rather than errors on
// some replies, and an admin deleting a device must not get a request that never returns.
async function withTimeout(fn, ms = 15000) {
  return Promise.race([
    fn(),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`router did not respond in ${ms}ms`)), ms)),
  ]);
}

// ── release one device ──────────────────────────────────────
// replacementMac: where subscribers.mac_address should point afterwards. Pass the new
// MAC on a swap so the display field follows the hardware; omit it on a plain delete and
// the field is cleared rather than left pointing at equipment no longer in service.
async function releaseDevice(prisma, radiusDb, mac, opts = {}) {
  const target = upper(mac);
  const { replacementMac = null, cause = 'Admin-Reset' } = opts;

  const out = {
    mac: target, sessionsClosed: 0, subscriberMacUpdated: 0,
    leasesFreed: [], addressListRemoved: [], arpRemoved: [],
    router: { ok: true },
  };

  // ── database side — must happen even if the router is unreachable ──
  const [sess] = await radiusDb.query(
    `UPDATE radacct
        SET acctstoptime = now(),
            acctsessiontime = coalesce(acctsessiontime,
              extract(epoch FROM (now() - acctstarttime))::bigint),
            acctterminatecause = ?
      WHERE username = ? AND acctstoptime IS NULL
      RETURNING radacctid`, [cause, target]);
  out.sessionsClosed = sess.length;

  const [subs] = await radiusDb.query(
    `UPDATE subscribers SET mac_address = ?
      WHERE upper(mac_address) = ? RETURNING id`, [replacementMac, target]);
  out.subscriberMacUpdated = subs.length;

  // ── router side — best effort ──
  try {
    const deviceId = await getRouterDeviceId(prisma);

    const leases = await withTimeout(() => mikrotik.getDHCPLeases(prisma, deviceId));
    const mine = (leases || []).filter(l => macOf(l) === target);
    const addresses = [];
    for (const l of mine) {
      if (!idOf(l)) continue;
      await withTimeout(() => mikrotik.execute(prisma, deviceId, '/ip/dhcp-server/lease',
        'remove', { id: idOf(l) }));
      out.leasesFreed.push(l.address || '(no address)');
      if (l.address) addresses.push(l.address);
    }

    // Entries here are keyed on the lease address. Left behind, they would restrict
    // whoever receives that address next.
    if (addresses.length) {
      const entries = await withTimeout(() => mikrotik.getAddressLists(prisma, deviceId));
      for (const e of (entries || [])) {
        if (e.list !== ADDRESS_LIST || !addresses.includes(e.address) || !idOf(e)) continue;
        await withTimeout(() => mikrotik.execute(prisma, deviceId, '/ip/firewall/address-list',
          'remove', { id: idOf(e) }));
        out.addressListRemoved.push(e.address);
      }
    }

    // Under arp=reply-only a stale entry is not cosmetic: it keeps the address dark.
    const arp = await withTimeout(() => mikrotik.getARPTable(prisma, deviceId));
    for (const a of (arp || [])) {
      if (macOf(a) !== target || !idOf(a)) continue;
      await withTimeout(() => mikrotik.execute(prisma, deviceId, '/ip/arp', 'remove', { id: idOf(a) }));
      out.arpRemoved.push(a.address);
    }
  } catch (err) {
    out.router = { ok: false, error: err.message };
    console.error(`[release] router cleanup for ${target} failed: ${err.message}`);
  }

  return out;
}

// ── keep subscribers.mac_address honest ─────────────────────
// The column is display-only — the subscriber panel header shows it and the register form
// prefills from it — but nothing on the registration path ever wrote it. Registering a
// device filled hotspot_mac_devices, radcheck and radusergroup correctly and left this
// field NULL, so the header read "MAC ADDRESS —" for every subscriber, including ones that
// were authenticated and online at that moment. It looked like registration had failed
// when it had not.
//
// Derived rather than assigned at each call site: recomputing from the device table is
// idempotent, gives the same answer whatever order register/toggle/replace/delete happen
// in, and repairs rows that earlier code left stale. Preference is the first enabled
// device, oldest first — a subscriber's original router stays the one on display when a
// second is added, and only falls back to a disabled device if that is all there is.
async function syncSubscriberMac(radiusDb, subscriberId) {
  const sid = Number(subscriberId);
  if (!Number.isInteger(sid)) return null;
  const [rows] = await radiusDb.query(
    `UPDATE subscribers s
        SET mac_address = (SELECT d.mac FROM hotspot_mac_devices d
                            WHERE d.subscriber_id = s.id
                            ORDER BY d.enabled DESC, d.created_at, d.id
                            LIMIT 1)
      WHERE s.id = ?
      RETURNING mac_address`, [sid]);
  return rows.length ? rows[0].mac_address : null;
}

// ── sweep ───────────────────────────────────────────────────
// Finds residue that no longer belongs to any registered device: sessions still open,
// leases still held on the MAC-authenticated server, and subscriber display MACs that
// point at nothing. Defaults to a dry run — this deletes router state, so the caller has
// to ask for it explicitly.
async function releaseOrphans(prisma, radiusDb, opts = {}) {
  const { dryRun = true } = opts;

  const [registered] = await radiusDb.query('SELECT upper(mac) AS mac FROM hotspot_mac_devices');
  const known = new Set(registered.map(r => r.mac));

  const [openSessions] = await radiusDb.query(
    `SELECT username, framedipaddress, acctstarttime FROM radacct WHERE acctstoptime IS NULL`);
  const staleSessions = openSessions.filter(s => !known.has(upper(s.username)));

  const [staleSubs] = await radiusDb.query(
    `SELECT id, account_number, mac_address FROM subscribers
      WHERE mac_address IS NOT NULL AND mac_address <> ''
        AND upper(mac_address) NOT IN (SELECT upper(mac) FROM hotspot_mac_devices)`);

  let staleLeases = [];
  let routerError = null;
  try {
    const deviceId = await getRouterDeviceId(prisma);
    const leases = await withTimeout(() => mikrotik.getDHCPLeases(prisma, deviceId));
    // Scoped to the MAB server on purpose: a portal user on hs-dhcp holds a legitimate
    // lease without ever being a registered MAC, and must not be swept up here.
    staleLeases = (leases || [])
      .filter(l => l.server === MAB_DHCP_SERVER && !known.has(macOf(l)))
      .map(l => ({ address: l.address, mac: macOf(l), id: idOf(l) }));
  } catch (err) {
    routerError = err.message;
    console.error(`[release] orphan sweep could not read leases: ${err.message}`);
  }

  const found = {
    dryRun,
    staleSessions: staleSessions.map(s => ({ mac: s.username, ip: s.framedipaddress, since: s.acctstarttime })),
    staleLeases: staleLeases.map(l => ({ mac: l.mac, address: l.address })),
    staleSubscriberMacs: staleSubs.map(s => ({ subscriberId: s.id, account: s.account_number, mac: s.mac_address })),
    routerError,
  };
  if (dryRun) return found;

  const released = [];
  for (const mac of new Set([
    ...staleSessions.map(s => upper(s.username)),
    ...staleLeases.map(l => l.mac),
    ...staleSubs.map(s => upper(s.mac_address)),
  ])) {
    released.push(await releaseDevice(prisma, radiusDb, mac, { cause: 'Session-Timeout' }));
  }
  return { ...found, released };
}

module.exports = { releaseDevice, releaseOrphans, syncSubscriberMac, MAB_DHCP_SERVER };
