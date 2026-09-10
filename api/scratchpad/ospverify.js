// Read-only check of the new OLT / PON / LCP resolution. Runs the exact queries
// and shaping added to /admin/subscribers/:id/network, keyed on the orphaned
// rows that already exist (nap_ports → sub 12, olt_onu_mappings → sub 27), so
// every join and alias is exercised without writing anything.
const { PrismaClient } = require('@prisma/client');
const { parseLcp, lcpSiblingRegex } = require('../src/utils/lcp');
const prisma = new PrismaClient();

(async () => {
  const PORT_SUB = 12, ONU_SUB = 27;
  const port = await prisma.$queryRaw`
    SELECT p.port_number, p.subscriber_label,
           n.id AS nap_id, n.name AS nap_name, n.type AS nap_type,
           n.total_ports, n.used_ports,
           n.latitude AS nap_lat, n.longitude AS nap_lng,
           n.olt AS nap_olt, n.pon AS nap_pon,
           n.access_core, n.nap_core, n.is_lcp_port, n.lcp_nap_id,
           n.closure_id, c.name AS closure_name
    FROM nap_ports p
    JOIN naps n ON n.id = p.nap_id
    LEFT JOIN closures c ON c.id = n.closure_id
    WHERE p.subscriber_id = ${PORT_SUB} LIMIT 1`;
  const p = port[0];

  const onu = await prisma.$queryRaw`
    SELECT m.pon_port, m.onu_id, m.serial_number, m.status,
           d.id AS olt_id, d.label AS olt_label, d.olt_model
    FROM olt_onu_mappings m
    JOIN olt_devices d ON d.id = m.olt_device_id
    WHERE m.subscriber_id = ${ONU_SUB}
    ORDER BY m.last_seen DESC NULLS LAST, m.id DESC LIMIT 1`;
  const o = onu[0] || null;

  const olt = o ? { id: Number(o.olt_id), name: o.olt_label, model: o.olt_model, source: 'onu' }
                : (p && p.nap_olt ? { id: null, name: p.nap_olt, model: null, source: 'nap' } : null);
  const pon = o ? { port: Number(o.pon_port), onuId: Number(o.onu_id),
                    label: `PON ${o.pon_port}/${o.onu_id}`, serial: o.serial_number,
                    status: o.status, source: 'onu' }
                : (p && p.nap_pon ? { port: null, onuId: null, label: p.nap_pon, serial: null, status: null, source: 'nap' } : null);

  let lcp = null;
  const parsed = p ? parseLcp(p.nap_name) : null;
  if (parsed) {
    const grp = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS nap_count, SUM(total_ports)::int AS total_ports,
             SUM(used_ports)::int AS used_ports, AVG(latitude) AS lat, AVG(longitude) AS lng
      FROM naps WHERE name ~* ${lcpSiblingRegex(parsed)}`;
    const g = grp[0] || {};
    lcp = { id: null, name: parsed.name, type: 'lcp', area: parsed.area, number: parsed.number,
            lat: g.lat != null ? Number(g.lat) : null, lng: g.lng != null ? Number(g.lng) : null,
            napCount: Number(g.nap_count || 0), totalPorts: Number(g.total_ports || 0),
            usedPorts: Number(g.used_ports || 0), source: 'derived' };
  }

  console.log(JSON.stringify({
    nap: p ? { id: Number(p.nap_id), name: p.nap_name, type: p.nap_type,
               portNumber: Number(p.port_number), totalPorts: Number(p.total_ports),
               usedPorts: Number(p.used_ports),
               lat: p.nap_lat != null ? Number(p.nap_lat) : null,
               lng: p.nap_lng != null ? Number(p.nap_lng) : null,
               accessCore: p.access_core, napCore: p.nap_core, isLcpPort: !!p.is_lcp_port } : null,
    olt, pon, lcp
  }, null, 1));
  await prisma.$disconnect();
})();
