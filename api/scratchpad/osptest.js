// Exercise the extended /admin/subscribers/:id/network and /admin/map/subscriber-ports
// endpoints over real HTTP with a short-lived admin token.
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3001) + '/api';
(async () => {
  const admin = await p.admin_users.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const tok = jwt.sign({ id: admin.id, type: 'admin' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const h = { Authorization: 'Bearer ' + tok };
  for (const id of process.argv.slice(2)) {
    const r = await fetch(BASE + '/admin/subscribers/' + id + '/network', { headers: h });
    const d = await r.json();
    console.log('--- subscriber ' + id + ' (' + r.status + ') ---');
    console.log(JSON.stringify({ nap: d.nap, olt: d.olt, pon: d.pon, lcp: d.lcp }, null, 1));
  }
  const r2 = await fetch(BASE + '/admin/map/subscriber-ports', { headers: h });
  const d2 = await r2.json();
  console.log('--- subscriber-ports (' + r2.status + ') ---');
  console.log(JSON.stringify(d2.mappings, null, 1));
  await p.$disconnect();
})();
