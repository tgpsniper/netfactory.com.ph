// ============================================================
// restriction-sync — keep the router's nf-restricted list in step with the database
// ============================================================
// Restriction is enforced against the address a device currently holds. Once a
// restricted device renews it picks up plan-restricted's 5-minute lease, and if its
// address ever changes the address-list entry is left pointing at nothing — the
// customer quietly escapes the walled garden and nobody finds out.
//
// This is a reconcile, not billing automation: it decides nothing about who should be
// restricted, it only makes the router match the decisions already recorded.
//
// Cheap by design — when nobody is restricted (the normal case) it does not touch the
// router at all.
// ============================================================

const radiusDb = require('../config/radius-db');
const restriction = require('../utils/restriction');

const SCHEDULE = '*/5 * * * *';

async function run(prisma) {
  const [open] = await radiusDb.query(
    'SELECT count(*)::int AS n FROM subscriber_restrictions WHERE lifted_at IS NULL');
  // needsSweep overrides the cheap exit: a router that could not be reached while the
  // last restriction was lifted still holds that address, and skipping here would leave
  // a customer who has paid locked inside the walled garden indefinitely.
  const nobodyRestricted = !open[0] || open[0].n === 0;
  if (nobodyRestricted && !restriction.needsSweep()) return;

  const changes = await restriction.syncAddressList(prisma, radiusDb);
  if (changes.added.length || changes.removed.length) {
    console.log(`[restriction-sync] drift corrected — added ${JSON.stringify(changes.added)}, removed ${JSON.stringify(changes.removed)}`);
  }
  if (changes.failed.length) {
    console.warn('[restriction-sync] could not reach ' +
      changes.failed.map(f => `#${f.deviceId} ${f.label}`).join(', ') + ' — will retry');
  }
  // A restricted device with no open session cannot be pinned to any router, so the
  // cutoff is recorded but not yet in force. Say so rather than looking successful.
  if (changes.unplaceable.length) {
    console.warn('[restriction-sync] not enforced (no address to bind to): ' +
      changes.unplaceable.map(u => `${u.mac} (${u.reason})`).join(', '));
  }
}

module.exports = { name: 'restriction-sync', schedule: SCHEDULE, run };
