// Cross-layer audit: OLT <-> RADIUS <-> router.
//
// Today proved the three layers can each look healthy while the service is dead. An ONU
// reports Online with no line profile and never sends a packet; a MAC sits whitelisted in
// RADIUS having never been seen; a lease lingers for a device that left. Nothing in the
// CRM joins these up, so each one had to be found by hand.
require('dotenv').config();
const { RouterOSAPI } = require('node-routeros');
const { PrismaClient } = require('@prisma/client');
const vsol = require('./src/utils/vsol-olt');
const radiusDb = require('./src/config/radius-db');

const up = v => String(v || '').toUpperCase();

(async () => {
  const prisma = new PrismaClient();

  // ── OLT: which ONUs exist, and does each have a data path? ──
  const device = await vsol.getDeviceConfig(prisma, 4);
  const cfg = vsol.stripAnsi(await vsol.sshShellExec(device,
    ['terminal length 0', 'show running-config', 'exit', 'exit'], 60000));

  const onus = [];
  let pon = null;
  for (const raw of cfg.split('\n')) {
    const l = raw.trim();
    let m;
    if ((m = l.match(/^interface gpon (\d+\/\d+)$/))) { pon = m[1]; continue; }
    if ((m = l.match(/^onu add (\d+) profile (\S+) sn (\S+)/)) && pon) {
      onus.push({ pon, id: +m[1], sn: m[3], line: null, srv: null });
    }
    if ((m = l.match(/^onu (\d+) profile (line|srv) name (\S+)/)) && pon) {
      const o = onus.find(x => x.pon === pon && x.id === +m[1]);
      if (o) o[m[2]] = m[3];
    }
  }

  // Live state for the PONs that actually hold ONUs.
  const ponsWithOnus = [...new Set(onus.map(o => o.pon))];
  for (const p of ponsWithOnus) {
    const out = vsol.stripAnsi(await vsol.sshShellExec(device, [
      'terminal length 0', 'configure terminal', `interface gpon ${p}`,
      'show onu state', 'end', 'exit', 'exit',
    ], 60000));
    // Output is one field per line: "1/1/2:3" then admin, omcc, phase, channel.
    const rows = out.split('\n').map(x => x.trim());
    rows.forEach((r, i) => {
      const m = r.match(/^\d+\/\d+\/(\d+):(\d+)$/);
      if (!m) return;
      const o = onus.find(x => x.pon.endsWith('/' + m[1]) && x.id === +m[2]);
      if (o) o.phase = rows[i + 3] || '?';
    });
  }

  // ── RADIUS + router ──
  const [devs] = await radiusDb.query(
    `SELECT d.mac, d.subscriber_id, s.account_number,
            trim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')) AS name,
            (SELECT count(*) FROM radpostauth p WHERE upper(p.username) = upper(d.mac)) AS auths,
            (SELECT framedipaddress FROM radacct a
              WHERE upper(a.username) = upper(d.mac) AND a.acctstoptime IS NULL LIMIT 1) AS live_ip
       FROM hotspot_mac_devices d
       LEFT JOIN subscribers s ON s.id = d.subscriber_id
      ORDER BY d.mac`);

  const mt = await prisma.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const c = new RouterOSAPI({ host: mt.host, user: mt.username, password: mt.password, port: mt.port, timeout: 25 });
  await c.connect();
  const leases = await c.write('/ip/dhcp-server/lease/print');
  const pings = {};
  for (const d of devs) {
    const L = leases.find(x => up(x['mac-address']) === up(d.mac));
    if (!L) continue;
    const p = await c.write('/ping', [`=address=${L.address}`, '=count=3']);
    const last = p[p.length - 1] || {};
    pings[up(d.mac)] = { ip: L.address, rx: Number(last.received || 0), seen: L['last-seen'] };
  }
  c.close();

  // ── report ──
  console.log('\n════ OLT: ONUs and whether they have a data path ════');
  console.log('  PON    ONU  SERIAL          PHASE      LINE PROFILE   VERDICT');
  onus.forEach(o => {
    const verdict = !o.line ? 'NO DATA PATH — cannot ever get an IP'
      : (o.phase === 'working' ? 'ok' : 'line profile ok, ONU not working');
    console.log(`  ${o.pon.padEnd(6)} ${String(o.id).padEnd(4)} ${o.sn.padEnd(15)} ${String(o.phase || '?').padEnd(10)} ${String(o.line || 'N/A').padEnd(14)} ${verdict}`);
  });

  console.log('\n════ Subscribers: registered device vs reality ════');
  devs.forEach(d => {
    const k = up(d.mac), p = pings[k];
    let verdict;
    if (Number(d.auths) === 0) verdict = 'NEVER SEEN — no auth attempt ever reached RADIUS';
    else if (!d.live_ip && !p) verdict = 'NO IP — authenticated before, nothing now';
    else if (p && p.rx === 0) verdict = `HAS IP ${p.ip} BUT UNREACHABLE — ping 0/3, last-seen ${p.seen}`;
    else verdict = `ok — ${p ? p.ip : d.live_ip}, ping ${p ? p.rx : '?'}/3`;
    console.log(`  ${d.mac}  ${String(d.account_number || '-').padEnd(12)} ${String(d.name || '').padEnd(16)} ${verdict}`);
  });

  const unregistered = leases.filter(l => !devs.some(d => up(d.mac) === up(l['mac-address'])));
  console.log('\n════ Leases held by devices nobody registered ════');
  console.log(unregistered.length ? unregistered.map(l =>
    `  ${up(l['mac-address'])}  ${l.address}  server=${l.server}  last-seen=${l['last-seen']}`).join('\n') : '  none');

  await prisma.$disconnect();
  process.exit(0);
})();
