require('dotenv').config();
const { RouterOSAPI } = require('node-routeros');
const { PrismaClient } = require('@prisma/client');
(async () => {
  const prisma = new PrismaClient();
  const mt = await prisma.mikrotik_devices.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' } });
  const c = new RouterOSAPI({ host: mt.host, user: mt.username, password: mt.password, port: mt.port, timeout: 25 });
  await c.connect();

  console.log('=== does the router have any route back toward this server? ===');
  const routes = await c.write('/ip/route/print');
  const back = routes.filter(r => /^10\.0\.98\./.test(r['dst-address']||'') || /36\.50\.30\.10[0-9]/.test(r['dst-address']||''));
  console.log(back.length ? back.map(r=>`  ${r['dst-address']} gw=${r.gateway}`).join('\n') : '  none (only the default route covers it)');

  console.log('\n=== WireGuard on the router ===');
  try {
    const wg = await c.write('/interface/wireguard/print');
    console.log(wg.length ? wg.map(w=>`  ${w.name}  listen=${w['listen-port']}  running=${w.running}  pubkey=${(w['public-key']||'').slice(0,12)}...`).join('\n') : '  no wireguard interfaces');
    const peers = await c.write('/interface/wireguard/peers/print');
    console.log('  peers:', peers.length);
    peers.forEach(p=>console.log(`    iface=${p.interface} allowed=${p['allowed-address']} ep=${p['endpoint-address']||'-'}`));
  } catch (e) { console.log('  wireguard unavailable:', e.message); }

  console.log('\n=== what is SmartOLT-VPN ? ===');
  const ifaces = await c.write('/interface/print');
  ifaces.filter(i=>/vpn|wg|ovpn|gre|eoip|ipip/i.test(i.name+i.type))
        .forEach(i=>console.log(`  ${i.name.padEnd(18)} type=${i.type} running=${i.running}`));

  c.close(); await prisma.$disconnect(); process.exit(0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
