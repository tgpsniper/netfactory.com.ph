require('dotenv').config();
process.on('uncaughtException', e => console.log('  (empty)', e.errno || ''));
const { RouterOSAPI } = require('node-routeros');
const { PrismaClient } = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const m = await p.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const c = new RouterOSAPI({ host: m.host, user: m.username, password: m.password, port: m.port, timeout: 20 });
  await c.connect();
  console.log('=== /radius incoming (CoA / Disconnect listener) ===');
  (await c.write('/radius/incoming/print')).forEach(r => console.log('  ', JSON.stringify(r)));
  c.close(); await p.$disconnect(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
