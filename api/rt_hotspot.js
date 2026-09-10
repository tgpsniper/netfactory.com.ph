require('dotenv').config();
process.on('uncaughtException', e => console.log('  (empty)', e.errno || ''));
const { RouterOSAPI } = require('node-routeros');
const { PrismaClient } = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const m = await p.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const c = new RouterOSAPI({ host: m.host, user: m.username, password: m.password, port: m.port, timeout: 20 });
  await c.connect();
  const hs = await c.write('/ip/hotspot/print');
  console.log('  /ip hotspot servers:', hs.length ? hs.map(h=>`${h.name} iface=${h.interface}`).join(', ') : 'NONE');
  const q = await c.write('/queue/simple/print');
  console.log('  queues:', q.map(x=>x.name).join(' | ') || 'none');
  c.close(); await p.$disconnect(); process.exit(0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
