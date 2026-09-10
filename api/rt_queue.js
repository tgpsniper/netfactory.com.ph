require('dotenv').config();
const { RouterOSAPI } = require('node-routeros');
const { PrismaClient } = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const m = await p.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const c = new RouterOSAPI({ host: m.host, user: m.username, password: m.password, port: m.port, timeout: 20 });
  await c.connect();
  console.log('=== simple queues (rate limit from RADIUS) ===');
  (await c.write('/queue/simple/print')).forEach(r =>
    console.log(`  name=${r.name}  target=${r.target}  max-limit=${r['max-limit']}  dynamic=${r.dynamic}`));
  console.log('=== lease ===');
  (await c.write('/ip/dhcp-server/lease/print')).forEach(r =>
    console.log(`  ${r['mac-address']}  ${r.address}  status=${r.status}  radius=${r.radius}  host=${r['host-name']||'-'}`));
  c.close(); await p.$disconnect(); process.exit(0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
