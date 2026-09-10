require('dotenv').config();
process.on('uncaughtException', e => { if (e && e.errno==='UNKNOWNREPLY') { console.log('  (no leases)'); process.exit(0);} });
const { RouterOSAPI } = require('node-routeros');
const { PrismaClient } = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const m = await p.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const c = new RouterOSAPI({ host: m.host, user: m.username, password: m.password, port: m.port, timeout: 20 });
  await c.connect();
  const l = await c.write('/ip/dhcp-server/lease/print');
  l.forEach(x => console.log(`  ${x['mac-address']}  ${x.address}  status=${x.status} radius=${x.radius} last-seen=${x['last-seen']||'-'}`));
  c.close(); await p.$disconnect(); process.exit(0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
