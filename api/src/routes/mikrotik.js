// ============================================================
// NETFACTORY & DATA SOLUTION — MikroTik REST API Routes
// ============================================================
// Mount: app.use('/api/admin/mikrotik', mikrotikRoutes)
// All routes require admin authentication
// ============================================================

const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const mikrotik = require('../utils/mikrotik');

// ── Apply admin auth to all routes ──────────────────────────
router.use(adminAuth());

// ── Param middleware: validate and attach deviceId ───────────
function requireDevice(req, res, next) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid device ID. Must be a positive integer.' });
  }
  req.deviceId = id;
  next();
}

// ============================================================
// DEVICE CRUD
// ============================================================

// GET /devices — List all MikroTik devices (passwords masked)
router.get('/devices', async (req, res) => {
  try {
    const devices = await req.prisma.mikrotik_devices.findMany({
      orderBy: { id: 'asc' },
    });
    const masked = devices.map(d => ({
      ...d,
      password: '••••••••',
    }));
    res.json(masked);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices — Create a new device
router.post('/devices', async (req, res) => {
  try {
    const { label, host, port, username, password, use_tls, notes } = req.body;
    if (!label || !host || !username || !password) {
      return res.status(400).json({ error: 'label, host, username, and password are required.' });
    }
    const device = await req.prisma.mikrotik_devices.create({
      data: {
        label,
        host,
        port:     port ? parseInt(port, 10) : 8728,
        username,
        password,
        use_tls:  use_tls === true || use_tls === 'true',
        notes:    notes || null,
      },
    });
    res.status(201).json({ ...device, password: '••••••••' });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /devices/:id — Update a device
router.put('/devices/:id', requireDevice, async (req, res) => {
  try {
    const { label, host, port, username, password, use_tls, notes, is_active } = req.body;
    const data = {};
    if (label !== undefined)    data.label = label;
    if (host !== undefined)     data.host = host;
    if (port !== undefined)     data.port = parseInt(port, 10);
    if (username !== undefined)  data.username = username;
    if (use_tls !== undefined)  data.use_tls = use_tls === true || use_tls === 'true';
    if (notes !== undefined)    data.notes = notes;
    if (is_active !== undefined) data.is_active = is_active === true || is_active === 'true';

    // Skip password update if placeholder is sent
    if (password !== undefined && password !== '••••••••') {
      data.password = password;
    }

    data.updated_at = new Date();

    const device = await req.prisma.mikrotik_devices.update({
      where: { id: req.deviceId },
      data,
    });
    res.json({ ...device, password: '••••••••' });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /devices/:id — Delete a device and disconnect
router.delete('/devices/:id', requireDevice, async (req, res) => {
  try {
    await mikrotik.disconnect(req.deviceId);
    await req.prisma.mikrotik_devices.delete({
      where: { id: req.deviceId },
    });
    res.json({ success: true, message: `Device ${req.deviceId} deleted.` });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices/:id/test — Test connection, fetch identity + resources
router.post('/devices/:id/test', requireDevice, async (req, res) => {
  try {
    const api = await mikrotik.connect(req.prisma, req.deviceId);

    const identityResult = await mikrotik.getSystemIdentity(req.prisma, req.deviceId);
    const resourcesResult = await mikrotik.getSystemResources(req.prisma, req.deviceId);

    const identity = Array.isArray(identityResult) && identityResult.length > 0
      ? identityResult[0].name
      : (identityResult?.name || 'unknown');

    const version = Array.isArray(resourcesResult) && resourcesResult.length > 0
      ? resourcesResult[0].version
      : (resourcesResult?.version || 'unknown');

    const uptime = Array.isArray(resourcesResult) && resourcesResult.length > 0
      ? resourcesResult[0].uptime
      : (resourcesResult?.uptime || 'unknown');

    // Update last_seen, last_identity, last_version in DB
    await req.prisma.mikrotik_devices.update({
      where: { id: req.deviceId },
      data: {
        last_seen:     new Date(),
        last_identity: identity,
        last_version:  version,
        updated_at:    new Date(),
      },
    });

    // Disconnect after test
    await mikrotik.disconnect(req.deviceId);

    res.json({
      success: true,
      identity,
      version,
      uptime,
    });
  } catch (err) {
    // Ensure disconnect on error
    try { await mikrotik.disconnect(req.deviceId); } catch (_) {}
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SYSTEM ROUTES
// ============================================================

// GET /devices/:id/system/identity
router.get('/devices/:id/system/identity', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.getSystemIdentity(req.prisma, req.deviceId);
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/system/resources
router.get('/devices/:id/system/resources', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.getSystemResources(req.prisma, req.deviceId);
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/system/health
router.get('/devices/:id/system/health', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.getSystemHealth(req.prisma, req.deviceId);
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/system/clock
router.get('/devices/:id/system/clock', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/system/clock');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/system/packages
router.get('/devices/:id/system/packages', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/system/package');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/system/routerboard
router.get('/devices/:id/system/routerboard', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/system/routerboard');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices/:id/system/reboot
router.post('/devices/:id/system/reboot', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/system', 'exec', { command: 'reboot' });
    res.json({ success: true, result });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// INTERFACE ROUTES
// ============================================================

// GET /devices/:id/interfaces
router.get('/devices/:id/interfaces', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.getInterfaces(req.prisma, req.deviceId);
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/interfaces/:iface/traffic
router.get('/devices/:id/interfaces/:iface/traffic', requireDevice, async (req, res) => {
  try {
    const iface = req.params.iface;
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/interface', 'exec', {
      command: 'monitor-traffic',
      data: { interface: iface, once: '' },
    });
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices/:id/interfaces/:iface/enable
router.post('/devices/:id/interfaces/:iface/enable', requireDevice, async (req, res) => {
  try {
    const iface = req.params.iface;
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/interface', 'enable', { id: iface });
    res.json({ success: true, result });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices/:id/interfaces/:iface/disable
router.post('/devices/:id/interfaces/:iface/disable', requireDevice, async (req, res) => {
  try {
    const iface = req.params.iface;
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/interface', 'disable', { id: iface });
    res.json({ success: true, result });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PPPoE ROUTES
// ============================================================

// GET /devices/:id/pppoe/active
router.get('/devices/:id/pppoe/active', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.getActivePPPoE(req.prisma, req.deviceId);
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/pppoe/secrets
router.get('/devices/:id/pppoe/secrets', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ppp/secret');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/pppoe/profiles
router.get('/devices/:id/pppoe/profiles', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ppp/profile');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/pppoe/servers
router.get('/devices/:id/pppoe/servers', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/interface/pppoe-server/server');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// QUEUE ROUTES
// ============================================================

// GET /devices/:id/queues/simple
router.get('/devices/:id/queues/simple', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.getSimpleQueues(req.prisma, req.deviceId);
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices/:id/queues/simple — Add a simple queue
router.post('/devices/:id/queues/simple', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/queue/simple', 'add', req.body);
    res.status(201).json({ success: true, result });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /devices/:id/queues/simple/:ruleId — Update a simple queue
router.put('/devices/:id/queues/simple/:ruleId', requireDevice, async (req, res) => {
  try {
    const ruleId = req.params.ruleId;
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/queue/simple', 'set', {
      id: ruleId,
      data: req.body,
    });
    res.json({ success: true, result });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /devices/:id/queues/simple/:ruleId — Remove a simple queue
router.delete('/devices/:id/queues/simple/:ruleId', requireDevice, async (req, res) => {
  try {
    const ruleId = req.params.ruleId;
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/queue/simple', 'remove', { id: ruleId });
    res.json({ success: true, result });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/queues/tree
router.get('/devices/:id/queues/tree', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/queue/tree');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/queues/types
router.get('/devices/:id/queues/types', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/queue/type');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// FIREWALL ROUTES
// ============================================================

// ── Filter rules ────────────────────────────────────────────

// GET /devices/:id/firewall/filter
router.get('/devices/:id/firewall/filter', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.getFirewallFilter(req.prisma, req.deviceId);
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices/:id/firewall/filter — Add filter rule
router.post('/devices/:id/firewall/filter', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/firewall/filter', 'add', req.body);
    res.status(201).json({ success: true, result });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /devices/:id/firewall/filter/:ruleId — Update filter rule
router.put('/devices/:id/firewall/filter/:ruleId', requireDevice, async (req, res) => {
  try {
    const ruleId = req.params.ruleId;
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/firewall/filter', 'set', {
      id: ruleId,
      data: req.body,
    });
    res.json({ success: true, result });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /devices/:id/firewall/filter/:ruleId — Remove filter rule
router.delete('/devices/:id/firewall/filter/:ruleId', requireDevice, async (req, res) => {
  try {
    const ruleId = req.params.ruleId;
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/firewall/filter', 'remove', { id: ruleId });
    res.json({ success: true, result });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── NAT rules ───────────────────────────────────────────────

// GET /devices/:id/firewall/nat
router.get('/devices/:id/firewall/nat', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.getFirewallNAT(req.prisma, req.deviceId);
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices/:id/firewall/nat — Add NAT rule
router.post('/devices/:id/firewall/nat', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/firewall/nat', 'add', req.body);
    res.status(201).json({ success: true, result });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /devices/:id/firewall/nat/:ruleId — Update NAT rule
router.put('/devices/:id/firewall/nat/:ruleId', requireDevice, async (req, res) => {
  try {
    const ruleId = req.params.ruleId;
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/firewall/nat', 'set', {
      id: ruleId,
      data: req.body,
    });
    res.json({ success: true, result });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /devices/:id/firewall/nat/:ruleId — Remove NAT rule
router.delete('/devices/:id/firewall/nat/:ruleId', requireDevice, async (req, res) => {
  try {
    const ruleId = req.params.ruleId;
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/firewall/nat', 'remove', { id: ruleId });
    res.json({ success: true, result });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Mangle ──────────────────────────────────────────────────

// GET /devices/:id/firewall/mangle
router.get('/devices/:id/firewall/mangle', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/firewall/mangle');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Address Lists ───────────────────────────────────────────

// GET /devices/:id/firewall/address-lists
router.get('/devices/:id/firewall/address-lists', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.getAddressLists(req.prisma, req.deviceId);
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices/:id/firewall/address-lists — Add to address list
router.post('/devices/:id/firewall/address-lists', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/firewall/address-list', 'add', req.body);
    res.status(201).json({ success: true, result });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /devices/:id/firewall/address-lists/:ruleId — Remove from address list
router.delete('/devices/:id/firewall/address-lists/:ruleId', requireDevice, async (req, res) => {
  try {
    const ruleId = req.params.ruleId;
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/firewall/address-list', 'remove', { id: ruleId });
    res.json({ success: true, result });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connections ─────────────────────────────────────────────

// GET /devices/:id/firewall/connections
router.get('/devices/:id/firewall/connections', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/firewall/connection');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// IP ROUTES
// ============================================================

// GET /devices/:id/ip/addresses
router.get('/devices/:id/ip/addresses', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.getIPAddresses(req.prisma, req.deviceId);
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/ip/routes
router.get('/devices/:id/ip/routes', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.getRoutes(req.prisma, req.deviceId);
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/ip/dns
router.get('/devices/:id/ip/dns', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/dns');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/ip/dns/cache
router.get('/devices/:id/ip/dns/cache', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/dns/cache');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/ip/dhcp/servers
router.get('/devices/:id/ip/dhcp/servers', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/dhcp-server');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/ip/dhcp/leases
router.get('/devices/:id/ip/dhcp/leases', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.getDHCPLeases(req.prisma, req.deviceId);
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/ip/arp
router.get('/devices/:id/ip/arp', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.getARPTable(req.prisma, req.deviceId);
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/ip/pools
router.get('/devices/:id/ip/pools', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/pool');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HOTSPOT ROUTES
// ============================================================

// GET /devices/:id/hotspot/active
router.get('/devices/:id/hotspot/active', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/hotspot/active');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/hotspot/users
router.get('/devices/:id/hotspot/users', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/hotspot/user');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/hotspot/profiles
router.get('/devices/:id/hotspot/profiles', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/hotspot/user/profile');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/hotspot/hosts
router.get('/devices/:id/hotspot/hosts', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ip/hotspot/host');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// WIRELESS ROUTES
// ============================================================

// GET /devices/:id/wireless/interfaces
router.get('/devices/:id/wireless/interfaces', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/interface/wireless');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/wireless/registration
router.get('/devices/:id/wireless/registration', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/interface/wireless/registration-table');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:id/wireless/access-list
router.get('/devices/:id/wireless/access-list', requireDevice, async (req, res) => {
  try {
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/interface/wireless/access-list');
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// LOG ROUTES
// ============================================================

// GET /devices/:id/logs — Fetch system logs (optional ?limit=N)
router.get('/devices/:id/logs', requireDevice, async (req, res) => {
  try {
    let result = await mikrotik.getLogs(req.prisma, req.deviceId);
    const limit = parseInt(req.query.limit, 10);
    if (limit > 0 && Array.isArray(result)) {
      result = result.slice(-limit);
    }
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// TOOLS ROUTES
// ============================================================

// POST /devices/:id/tools/ping
router.post('/devices/:id/tools/ping', requireDevice, async (req, res) => {
  try {
    const { address, count } = req.body;
    if (!address) {
      return res.status(400).json({ error: 'address is required.' });
    }
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/ping', 'exec', {
      command: 'ping',
      data: { address, count: String(count || '4') },
    });
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices/:id/tools/traceroute
router.post('/devices/:id/tools/traceroute', requireDevice, async (req, res) => {
  try {
    const { address, count } = req.body;
    if (!address) {
      return res.status(400).json({ error: 'address is required.' });
    }
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/tool/traceroute', 'exec', {
      command: 'traceroute',
      data: { address, count: String(count || '1') },
    });
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices/:id/tools/torch
router.post('/devices/:id/tools/torch', requireDevice, async (req, res) => {
  try {
    const { interface: iface, duration } = req.body;
    if (!iface) {
      return res.status(400).json({ error: 'interface is required.' });
    }
    const result = await mikrotik.execute(req.prisma, req.deviceId, '/tool/torch', 'exec', {
      command: 'torch',
      data: { interface: iface, duration: String(duration || '5') },
    });
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices/:id/tools/bandwidth-test
router.post('/devices/:id/tools/bandwidth-test', requireDevice, async (req, res) => {
  try {
    const { address, protocol, direction, duration, user, password } = req.body;
    if (!address) {
      return res.status(400).json({ error: 'address is required.' });
    }
    const data = { address };
    if (protocol)  data.protocol = protocol;
    if (direction) data.direction = direction;
    if (duration)  data.duration = String(duration);
    if (user)      data.user = user;
    if (password)  data.password = password;

    const result = await mikrotik.execute(req.prisma, req.deviceId, '/tool/bandwidth-test', 'exec', {
      command: 'bandwidth-test',
      data,
    });
    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SUBSCRIBER-SPECIFIC ROUTES
// ============================================================

// GET /subscriber/:id/mikrotik-info
// Lookup subscriber's RADIUS username, find active PPPoE session, return status + queue
router.get('/subscriber/:id/mikrotik-info', async (req, res) => {
  try {
    const subscriberId = parseInt(req.params.id, 10);
    if (isNaN(subscriberId) || subscriberId <= 0) {
      return res.status(400).json({ error: 'Invalid subscriber ID.' });
    }

    // Find subscriber and their RADIUS account
    const subscriber = await req.prisma.subscribers.findUnique({
      where: { id: subscriberId },
      include: { subscriber_radius: true },
    });
    if (!subscriber) {
      return res.status(404).json({ error: 'Subscriber not found.' });
    }

    const radiusAccounts = subscriber.subscriber_radius;
    if (!radiusAccounts || radiusAccounts.length === 0) {
      return res.json({
        subscriber_id: subscriberId,
        radius_username: null,
        pppoe_active: false,
        message: 'No RADIUS account linked to this subscriber.',
      });
    }

    const radiusUsername = radiusAccounts[0].radius_username;

    // Find active MikroTik devices to search for PPPoE sessions
    const devices = await req.prisma.mikrotik_devices.findMany({
      where: { is_active: true },
    });

    let pppoeSession = null;
    let matchedDeviceId = null;

    for (const device of devices) {
      try {
        const sessions = await mikrotik.getActivePPPoE(req.prisma, device.id);
        if (Array.isArray(sessions)) {
          const match = sessions.find(s => s.name === radiusUsername);
          if (match) {
            pppoeSession = match;
            matchedDeviceId = device.id;
            break;
          }
        }
      } catch (_) {
        // Device unreachable, continue to next
      }
    }

    const result = {
      subscriber_id: subscriberId,
      radius_username: radiusUsername,
      pppoe_active: !!pppoeSession,
    };

    if (pppoeSession) {
      result.device_id = matchedDeviceId;
      result.session = {
        name:     pppoeSession.name,
        address:  pppoeSession.address,
        uptime:   pppoeSession.uptime,
        service:  pppoeSession.service,
        callerId: pppoeSession['caller-id'] || pppoeSession.callerId,
      };

      // Try to find a matching simple queue for this subscriber
      try {
        const queues = await mikrotik.getSimpleQueues(req.prisma, matchedDeviceId);
        if (Array.isArray(queues)) {
          const queueMatch = queues.find(q =>
            q.target === (pppoeSession.address + '/32') ||
            q.target === pppoeSession.address ||
            q.name === radiusUsername
          );
          if (queueMatch) {
            result.queue = {
              name:      queueMatch.name,
              target:    queueMatch.target,
              maxLimit:  queueMatch['max-limit'] || queueMatch.maxLimit,
              disabled:  queueMatch.disabled,
            };
          }
        }
      } catch (_) {
        // Queue lookup failed, non-critical
      }
    }

    res.json(result);
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /subscriber/:id/disconnect — Disconnect subscriber's PPPoE session
router.post('/subscriber/:id/disconnect', async (req, res) => {
  try {
    const subscriberId = parseInt(req.params.id, 10);
    if (isNaN(subscriberId) || subscriberId <= 0) {
      return res.status(400).json({ error: 'Invalid subscriber ID.' });
    }

    // Find subscriber's RADIUS username
    const subscriber = await req.prisma.subscribers.findUnique({
      where: { id: subscriberId },
      include: { subscriber_radius: true },
    });
    if (!subscriber) {
      return res.status(404).json({ error: 'Subscriber not found.' });
    }

    const radiusAccounts = subscriber.subscriber_radius;
    if (!radiusAccounts || radiusAccounts.length === 0) {
      return res.status(404).json({ error: 'No RADIUS account linked to this subscriber.' });
    }

    const radiusUsername = radiusAccounts[0].radius_username;

    // Search active devices for the PPPoE session
    const devices = await req.prisma.mikrotik_devices.findMany({
      where: { is_active: true },
    });

    for (const device of devices) {
      try {
        const sessions = await mikrotik.getActivePPPoE(req.prisma, device.id);
        if (Array.isArray(sessions)) {
          const match = sessions.find(s => s.name === radiusUsername);
          if (match) {
            const sessionId = match['.id'] || match.id;
            await mikrotik.execute(req.prisma, device.id, '/ppp/active', 'remove', { id: sessionId });
            return res.json({
              success: true,
              message: `Disconnected ${radiusUsername} from device ${device.id}.`,
              device_id: device.id,
            });
          }
        }
      } catch (_) {
        // Device unreachable, continue
      }
    }

    res.status(404).json({ error: `No active PPPoE session found for ${radiusUsername}.` });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /subscriber/:id/set-bandwidth — Set/update simple queue for a subscriber
router.post('/subscriber/:id/set-bandwidth', async (req, res) => {
  try {
    const subscriberId = parseInt(req.params.id, 10);
    if (isNaN(subscriberId) || subscriberId <= 0) {
      return res.status(400).json({ error: 'Invalid subscriber ID.' });
    }

    const { device_id, max_limit, burst_limit, burst_threshold, burst_time } = req.body;

    if (!device_id) {
      return res.status(400).json({ error: 'device_id is required.' });
    }
    if (!max_limit) {
      return res.status(400).json({ error: 'max_limit is required (e.g. "10M/10M").' });
    }

    const deviceId = parseInt(device_id, 10);

    // Find subscriber's RADIUS username and active session IP
    const subscriber = await req.prisma.subscribers.findUnique({
      where: { id: subscriberId },
      include: { subscriber_radius: true },
    });
    if (!subscriber) {
      return res.status(404).json({ error: 'Subscriber not found.' });
    }

    const radiusAccounts = subscriber.subscriber_radius;
    if (!radiusAccounts || radiusAccounts.length === 0) {
      return res.status(404).json({ error: 'No RADIUS account linked to this subscriber.' });
    }

    const radiusUsername = radiusAccounts[0].radius_username;

    // Find active PPPoE session to get subscriber's IP
    const sessions = await mikrotik.getActivePPPoE(req.prisma, deviceId);
    const session = Array.isArray(sessions) ? sessions.find(s => s.name === radiusUsername) : null;
    if (!session || !session.address) {
      return res.status(404).json({ error: `No active PPPoE session found for ${radiusUsername} on device ${deviceId}.` });
    }

    const target = session.address + '/32';

    // Check if queue already exists for this subscriber
    const queues = await mikrotik.getSimpleQueues(req.prisma, deviceId);
    const existing = Array.isArray(queues)
      ? queues.find(q => q.target === target || q.name === radiusUsername)
      : null;

    const queueData = {
      name: radiusUsername,
      target,
      'max-limit': max_limit,
    };
    if (burst_limit)     queueData['burst-limit'] = burst_limit;
    if (burst_threshold) queueData['burst-threshold'] = burst_threshold;
    if (burst_time)      queueData['burst-time'] = burst_time;

    let result;
    if (existing) {
      // Update existing queue
      const queueId = existing['.id'] || existing.id;
      result = await mikrotik.execute(req.prisma, deviceId, '/queue/simple', 'set', {
        id: queueId,
        data: queueData,
      });
    } else {
      // Create new queue
      result = await mikrotik.execute(req.prisma, deviceId, '/queue/simple', 'add', queueData);
    }

    res.json({
      success: true,
      action: existing ? 'updated' : 'created',
      queue: queueData,
      result,
    });
  } catch (err) {
    console.error('[MikroTik] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
