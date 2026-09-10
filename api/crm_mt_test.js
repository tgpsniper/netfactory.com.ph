require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const mt = require('./src/utils/mikrotik');
(async () => {
  const prisma = new PrismaClient();
  const dev = await prisma.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  console.log('device', dev.id, dev.label, dev.host + ':' + dev.port);
  const t = async (name, fn) => {
    const t0 = Date.now();
    try { const r = await fn(); console.log(`  ${name.padEnd(18)} OK  ${Date.now()-t0}ms  rows=${Array.isArray(r)?r.length:'n/a'}`); return r; }
    catch (e) { console.log(`  ${name.padEnd(18)} FAIL ${Date.now()-t0}ms  ${e.message}`); }
  };
  await t('identity',   () => mt.getSystemIdentity(prisma, dev.id));
  await t('resources',  () => mt.getSystemResources(prisma, dev.id));
  await t('interfaces', () => mt.getInterfaces(prisma, dev.id));
  await t('ip addresses',() => mt.getIPAddresses(prisma, dev.id));
  await t('routes',     () => mt.getRoutes(prisma, dev.id));
  await t('arp',        () => mt.getARPTable(prisma, dev.id));
  await t('dhcp leases',() => mt.getDHCPLeases(prisma, dev.id));
  await mt.disconnectAll();
  await prisma.$disconnect(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
