// Read-only external reachability probe: ask a router on a DIFFERENT public
// range to open a TCP session back to this box, since nothing inside the LAN
// can test inbound NAT (no hairpin here).
const { PrismaClient } = require('@prisma/client');
const mt = require('../src/utils/mikrotik');
const prisma = new PrismaClient();

const TARGET = '36.50.30.102';
const PORTS = [80];
const VANTAGE = Number(process.argv[2] || 11); // 11 = SMN-AC3 163.61.86.42

(async () => {
  for (const port of PORTS) {
    let verdict;
    try {
      const r = await mt.execute(prisma, VANTAGE, '/tool', 'exec', {
        command: 'fetch',
        data: {
          url: `http://${TARGET}:${port}/`,
          mode: 'http',
          'check-certificate': 'no',
          'keep-result': 'no',
          'http-method': 'head',
        },
      });
      verdict = `REACHABLE   ${JSON.stringify(r).slice(0, 200)}`;
    } catch (e) {
      const m = String((e && e.message) || e);
      verdict = `${/closed|refused|timeout|timed out|unreachable/i.test(m) ? 'BLOCKED  ' : 'ERROR    '} ${m.slice(0, 200)}`;
    }
    console.log(`${TARGET}:${String(port).padEnd(5)} ${verdict}`);
  }
  await mt.disconnectAll().catch(() => {});
  await prisma.$disconnect();
  process.exit(0);
})();
