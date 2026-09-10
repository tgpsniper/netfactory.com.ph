// Bind the missing line profile to ONU 3 on PON 2 (the SG666, sn RTEGc65b4eb2).
//
// The line profile is what creates the T-CONT, the GEM port and the VLAN 520 service
// binding. ONU 2 has it and passes traffic; ONUs 1 and 3 have only a service profile,
// register fine, and have no data path at all. Only ONU 3 is touched here — whether
// ONU 1 should be in service is the operator's call.
//
// "write" is this platform's save. Without it the change is lost on the next reboot.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const vsol = require('./src/utils/vsol-olt');

(async () => {
  const prisma = new PrismaClient();
  const device = await vsol.getDeviceConfig(prisma, 4);

  console.log('=== applying ===');
  const apply = await vsol.sshShellExec(device, [
    'terminal length 0',
    'configure terminal',
    'interface gpon 0/2',
    'onu 3 profile line name DHCP',
    'end',
    'write',
    'show history',          // gives `write` time to finish before the session closes
    'exit', 'exit',
  ], 60000);
  console.log(vsol.stripAnsi(apply).split('\n').filter(l =>
    /config|onu 3|write|Building|\[OK\]|%|error|fail/i.test(l)).join('\n').slice(0, 1500));

  console.log('\n=== verifying (fresh session, re-reading the config) ===');
  const check = await vsol.sshShellExec(device, [
    'terminal length 0', 'show running-config', 'exit', 'exit',
  ], 60000);
  const txt = vsol.stripAnsi(check);
  const block = txt.split('\n');
  const start = block.findIndex(l => /^onu auto-learn$/.test(l.trim()));
  block.slice(Math.max(0, start - 1), start + 14).forEach(l => console.log('  ' + l.trim()));

  console.log('\nonu 3 line profile present:', /onu 3 profile line name DHCP/.test(txt));

  await prisma.$disconnect();
  process.exit(0);
})();
