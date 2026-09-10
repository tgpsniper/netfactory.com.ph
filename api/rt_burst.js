require('dotenv').config();
process.on('uncaughtException', e => console.log('  (no queues)', e.errno || ''));
const { RouterOSAPI } = require('node-routeros');
const { PrismaClient } = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const m = await p.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const c = new RouterOSAPI({ host: m.host, user: m.username, password: m.password, port: m.port, timeout: 20 });
  await c.connect();
  const q = await c.write('/queue/simple/print', ['=detail=']);
  q.forEach(x => {
    console.log(`  ${x.name}`);
    console.log(`     target      ${x.target}`);
    console.log(`     max-limit   ${x['max-limit']}`);
    console.log(`     burst-limit ${x['burst-limit'] || '(none)'}`);
    console.log(`     burst-thres ${x['burst-threshold'] || '(none)'}`);
    console.log(`     burst-time  ${x['burst-time'] || '(none)'}`);
    console.log(`     dynamic=${x.dynamic}`);
  });
  c.close(); await p.$disconnect(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
