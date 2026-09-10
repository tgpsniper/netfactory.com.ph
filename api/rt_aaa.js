require('dotenv').config();
const { RouterOSAPI } = require('node-routeros');
const { PrismaClient } = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const m = await p.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const c = new RouterOSAPI({ host: '36.50.30.110', user: m.username, password: m.password, port: 8728, timeout: 25 });
  await c.connect();
  console.log('=== /user aaa (does router login use RADIUS?) ===');
  (await c.write('/user/aaa/print')).forEach(r => console.log(' ', JSON.stringify(r)));
  c.close(); await p.$disconnect(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
