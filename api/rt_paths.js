require('dotenv').config();
const { RouterOSAPI } = require('node-routeros');
const { PrismaClient } = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const m = await p.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const c = new RouterOSAPI({ host: '36.50.30.110', user: m.username, password: m.password, port: 8728, timeout: 20 });
  await c.connect();
  console.log('=== bridge ports ===');
  (await c.write('/interface/bridge/port/print')).forEach(r =>
    console.log(`  bridge=${r.bridge}  iface=${r.interface}  pvid=${r.pvid}  disabled=${r.disabled}`));
  console.log('\n=== routes ===');
  (await c.write('/ip/route/print')).forEach(r =>
    console.log(`  ${(r['dst-address']||'').padEnd(20)} gw=${(r.gateway||'-').padEnd(18)} active=${r.active}`));
  c.close(); await p.$disconnect(); process.exit(0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
