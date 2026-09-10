require('dotenv').config();
process.on('uncaughtException', e => { console.log('  (library threw on empty result:', e.errno || e.message, ')'); });
const { RouterOSAPI } = require('node-routeros');
const { PrismaClient } = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const m = await p.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const c = new RouterOSAPI({ host: '36.50.30.110', user: m.username, password: m.password, port: 8728, timeout: 25 });
  await c.connect();
  const k = (await c.write('/radius/monitor', ['=numbers=0','=once=']))[0] || {};
  console.log(`  radius counters: requests=${k.requests} accepts=${k.accepts} rejects=${k.rejects} timeouts=${k.timeouts} bad-replies=${k['bad-replies']} rtt=${k['last-request-rtt']}`);
  const a = await c.write('/ip/arp/print');
  const v = a.filter(r => r.interface === 'VLAN520-DHCP');
  console.log('  arp on VLAN520:', v.length ? v.map(r=>`${r['mac-address']}=${r.address}`).join(' | ') : 'none');
  const st = await c.write('/interface/print', ['=stats=']);
  const vl = st.find(r => r.name === 'VLAN520-DHCP');
  console.log(`  VLAN520 rx=${vl && vl['rx-byte']} tx=${vl && vl['tx-byte']} running=${vl && vl.running}`);
  c.close(); await p.$disconnect(); process.exit(0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
