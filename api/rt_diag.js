require('dotenv').config();
const { RouterOSAPI } = require('node-routeros');
const { PrismaClient } = require('@prisma/client');
const P = (t, rows, f) => { console.log('\n=== ' + t + ' ==='); if (!rows || !rows.length) return console.log('  (none)'); rows.forEach(r => console.log('  ' + f(r))); };
(async () => {
  const p = new PrismaClient();
  const m = await p.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const c = new RouterOSAPI({ host: '36.50.30.110', user: m.username, password: m.password, port: 8728, timeout: 25 });
  await c.connect();

  P('RADIUS servers', await c.write('/radius/print'), r =>
    `service=${r.service}  address=${r.address}  authPort=${r['authentication-port']}  acctPort=${r['accounting-port']}  src=${r['src-address']}  disabled=${r.disabled}  secret=<len ${(r.secret||'').length}>`);

  try { P('RADIUS counters', await c.write('/radius/monitor', ['=numbers=0', '=once=']), r => JSON.stringify(r)); }
  catch (e) { console.log('\n=== RADIUS counters ===\n  unavailable:', e.message); }

  P('VLAN interfaces', await c.write('/interface/vlan/print'), r =>
    `${r.name}  vlan-id=${r['vlan-id']}  on=${r.interface}  running=${r.running}  disabled=${r.disabled}`);

  P('IP addresses', await c.write('/ip/address/print'), r =>
    `${(r.address||'').padEnd(20)} ${r.interface}  disabled=${r.disabled}`);

  const st = await c.write('/interface/print', ['=stats=']);
  P('interfaces with any RX', st.filter(r => Number(r['rx-byte'] || 0) > 0), r =>
    `${(r.name||'').padEnd(18)} type=${(r.type||'').padEnd(10)} running=${r.running}  rx=${r['rx-byte']}  tx=${r['tx-byte']}`);
  P('interfaces with ZERO rx', st.filter(r => !Number(r['rx-byte'] || 0)), r =>
    `${(r.name||'').padEnd(18)} type=${(r.type||'').padEnd(10)} running=${r.running}`);

  P('DHCP servers', await c.write('/ip/dhcp-server/print'), r =>
    `${r.name}  iface=${r.interface}  pool=${r['address-pool']}  use-radius=${r['use-radius']}  disabled=${r.disabled}  invalid=${r.invalid}`);
  P('DHCP leases', await c.write('/ip/dhcp-server/lease/print'), r =>
    `${r['mac-address']}  ${r.address}  status=${r.status}  server=${r.server}`);
  P('IP services', await c.write('/ip/service/print'), r =>
    `${(r.name||'').padEnd(10)} port=${r.port}  address=${r.address||'any'}  disabled=${r.disabled}`);

  c.close(); await p.$disconnect(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
