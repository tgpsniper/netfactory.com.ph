require('dotenv').config();
const { RouterOSAPI } = require('node-routeros');
const { PrismaClient } = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const m = await p.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const c = new RouterOSAPI({ host: '36.50.30.110', user: m.username, password: m.password, port: 8728, timeout: 20 });
  try {
    await c.connect();
    const id = await c.write('/system/identity/print');
    console.log('CONNECTED — identity:', id[0] && id[0].name);
    c.close();
  } catch (e) { console.log('FAILED:', e.message); }
  await p.$disconnect(); process.exit(0);
})();
