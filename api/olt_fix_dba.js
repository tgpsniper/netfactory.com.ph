// FIX: the PON can only ever serve one subscriber as configured.
//
// Line profile "DHCP" takes its T-CONT from DBA profile "default1" — type 1 (FIXED)
// 1,024,000 Kbps. A GPON upstream is 1,244,160 Kbps total, so one ONU reserves 82% of the
// PON permanently, whether it is transmitting or not, and the second allocation cannot be
// granted: "Error: tcont 1 *unknown*". ONU 2 holds it; ONUs 1 and 3 are locked out.
//
// Rather than edit default1 in place — JC Pineda is live on it right now — build a new
// type 3 (assured plus maximum) DBA, a new line profile that uses it, and move only ONU 3
// onto it. ONU 2 keeps working untouched and can be migrated later in a quiet window.
//
//   assured 50,000 Kbps   guaranteed floor per subscriber
//   maximum 1,244,160     burst to line rate when the PON is idle
//
// Every other setting is copied verbatim from line profile DHCP so the VLAN 520 path is
// identical to the one already proven working on ONU 2.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const vsol = require('./src/utils/vsol-olt');

const show = (txt, from) => {
  const i = txt.indexOf(from);
  console.log(vsol.stripAnsi(i < 0 ? txt : txt.slice(i)).slice(0, 3000));
};

(async () => {
  const prisma = new PrismaClient();
  const device = await vsol.getDeviceConfig(prisma, 4);

  console.log('=== 1. create DBA profile "nf-shared" (type 3) ===');
  show(await vsol.sshShellExec(device, [
    'terminal length 0', 'configure terminal',
    'profile dba id 2 name nf-shared',
    'type 3 assured 50000 maximum 1244160',
    'commit', 'exit',
    'show profile dba',
    'end', 'exit', 'exit',
  ], 90000), 'profile dba id 2');

  console.log('\n=== 2. create line profile "DHCP-SHARED" using it ===');
  show(await vsol.sshShellExec(device, [
    'terminal length 0', 'configure terminal',
    'profile line id 3 name DHCP-SHARED',
    'tcont 1 name DHCP dba nf-shared',
    'gemport 1 tcont 1 gemport_name DHCP',
    'service ser_1 gemport 1 vlan 520',
    'service-port 1 gemport 1 uservlan 520 vlan 520',
    'commit', 'exit',
    'show profile line',
    'end', 'exit', 'exit',
  ], 90000), 'profile line id 3');

  console.log('\n=== 3. bind it to ONU 3 on PON 2 and save ===');
  show(await vsol.sshShellExec(device, [
    'terminal length 0', 'configure terminal',
    'interface gpon 0/2',
    'onu 3 profile line name DHCP-SHARED',
    'show onu 3 profile',
    'end', 'write', 'show history',
    'exit', 'exit',
  ], 90000), 'onu 3 profile line');

  await prisma.$disconnect();
  process.exit(0);
})();
