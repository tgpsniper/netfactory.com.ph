// Can we reach privileged mode now, and what does this firmware actually accept there?
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const vsol = require('./src/utils/vsol-olt');

(async () => {
  const prisma = new PrismaClient();
  const d = await prisma.olt_devices.findUnique({ where: { id: 4 } });
  console.log(`record: ${d.host}:${d.ssh_port} user=${d.ssh_username} ssh_pw=${(d.ssh_password || '').length} enable_pw=${(d.enable_password || '').length}`);
  if (!d.enable_password) { console.log('no enable password stored — stopping'); await prisma.$disconnect(); process.exit(0); }

  const device = await vsol.getDeviceConfig(prisma, 4);
  try {
    const out = await vsol.sshShellExec(device, ['terminal length 0', 'list', 'exit', 'exit'], 30000);
    console.log(vsol.stripAnsi(out).slice(0, 6000));
  } catch (e) {
    console.log('ERROR: ' + e.message);
  }
  await prisma.$disconnect();
  process.exit(0);
})();
