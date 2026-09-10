require('dotenv').config();
const { RouterOSAPI } = require('node-routeros');
const { PrismaClient } = require('@prisma/client');
(async () => {
  const prisma = new PrismaClient();
  const mt = await prisma.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  console.log('router:', mt.host + ':' + mt.port);
  const c = new RouterOSAPI({ host: mt.host, user: mt.username, password: mt.password, port: mt.port, timeout: 25 });
  await c.connect();

  const routes = await c.write('/ip/route/print');
  const rel = routes.filter(r => /^10\.100\./.test(r['dst-address'] || '') || (r['dst-address'] || '') === '0.0.0.0/0');
  console.log('\n=== routes matching 10.100.x or default ===');
  console.log(rel.length ? rel.map(r => `  ${r['dst-address']}  gw=${r.gateway}  active=${r.active}  iface=${r['immediate-gw'] || '-'}`).join('\n') : '  NONE');

  const addrs = await c.write('/ip/address/print');
  console.log('\n=== router interface addresses ===');
  addrs.forEach(a => console.log(`  ${a.address.padEnd(20)} ${a.interface}`));

  console.log('\n=== ping 10.100.105.2 from the router ===');
  const p = await c.write('/ping', ['=address=10.100.105.2', '=count=3']);
  const last = p[p.length - 1] || {};
  console.log(`  sent=${last.sent} received=${last.received} time=${last.time || '-'}`);

  console.log('\n=== existing dst-nat rules ===');
  const nat = await c.write('/ip/firewall/nat/print');
  nat.filter(n => n.action === 'dst-nat').forEach(n =>
    console.log(`  ${(n.comment||'-').padEnd(24)} ${n['dst-port']||'-'} -> ${n['to-addresses']}:${n['to-ports']||'-'}  src=${n['src-address']||'any'}  disabled=${n.disabled}`));

  c.close();
  await prisma.$disconnect();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
