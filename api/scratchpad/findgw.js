// Which managed router owns 10.0.98.1 / the 36.50.30.102 NAT? Read-only sweep.
const { PrismaClient } = require('@prisma/client');
const mt = require('../src/utils/mikrotik');
const prisma = new PrismaClient();
(async () => {
  const devs = await prisma.mikrotik_devices.findMany({ where: { is_active: true }, orderBy: { id: 'asc' } });
  for (const d of devs) {
    try {
      const addrs = await mt.execute(prisma, d.id, '/ip/address');
      const list = (addrs || []).map(a => a.address).filter(Boolean);
      const hit = list.some(a => a.startsWith('10.0.98.1/') || a.startsWith('36.50.30.102/'));
      console.log(`${String(d.id).padStart(2)} ${d.label.padEnd(10)} ${d.host.padEnd(14)} ${hit ? '*** MATCH ***' : ''} ${list.join(' ')}`);
    } catch (e) {
      console.log(`${String(d.id).padStart(2)} ${d.label.padEnd(10)} ${d.host.padEnd(14)} ERR ${String(e.message).slice(0,60)}`);
    }
  }
  await mt.disconnectAll().catch(() => {});
  await prisma.$disconnect();
  process.exit(0);
})();
