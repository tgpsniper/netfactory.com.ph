require('dotenv').config();
const { RouterOSAPI } = require('node-routeros');
const { PrismaClient } = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const m = await p.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const c = new RouterOSAPI({ host: '36.50.30.110', user: m.username, password: m.password, port: 8728, timeout: 25 });
  await c.connect();

  console.log('=== lease detail ===');
  (await c.write('/ip/dhcp-server/lease/print', ['=detail='])).forEach(r =>
    console.log(JSON.stringify(r, null, 1)));

  console.log('\n=== pools ===');
  (await c.write('/ip/pool/print')).forEach(r => console.log(`  ${r.name}  ranges=${r.ranges}`));

  console.log('\n=== ARP on VLAN520-DHCP ===');
  (await c.write('/ip/arp/print')).filter(r => r.interface === 'VLAN520-DHCP')
    .forEach(r => console.log(`  ${r['mac-address']}  ${r.address}  status=${r.status}  dynamic=${r.dynamic}`));

  console.log('\n=== ping the leased client ===');
  const pg = await c.write('/ping', ['=address=10.3.254.253', '=count=3']);
  const last = pg[pg.length - 1] || {};
  console.log(`  sent=${last.sent} received=${last.received} avg=${last['avg-rtt'] || '-'}`);

  console.log('\n=== recent dhcp/radius log entries ===');
  (await c.write('/log/print')).filter(r => /dhcp|radius/i.test((r.topics||'') + (r.message||'')))
    .slice(-15).forEach(r => console.log(`  ${r.time}  [${r.topics}]  ${r.message}`));

  c.close(); await p.$disconnect(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
