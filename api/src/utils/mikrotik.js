// ============================================================
// utils/mikrotik.js — RouterOS API Connection Manager
// Per-device connection caching, idle timeout, auto-reconnect
// Config stored in mikrotik_devices + system_settings
// ============================================================

// ── Monkey-patch node-routeros to prevent crash-causing exceptions ──
// 1) Channel.processPacket: RouterOS returns !empty for menus with no
//    entries. The library throws UNKNOWNREPLY — we treat it as !done.
// 2) Receiver.sendTagData: When a response arrives on a tag that was
//    already cleaned up (e.g. timed-out request), the library throws
//    UNREGISTEREDTAG. We silently ignore stale tag data instead.
// ────────────────────────────────────────────────────────────────────
try {
  const { Channel } = require('node-routeros/dist/Channel');
  const _origProcessPacket = Channel.prototype.processPacket;
  Channel.prototype.processPacket = function (packet) {
    if (packet && packet.length > 0 && packet[0] === '!empty') {
      if (!this.trapped) this.emit('done', this.data);
      this.close();
      return;
    }
    return _origProcessPacket.call(this, packet);
  };
} catch (e) {
  console.warn('[MikroTik] Could not patch Channel for !empty handling:', e.message);
}

try {
  const { Receiver } = require('node-routeros/dist/connector/Receiver');
  const _origSendTagData = Receiver.prototype.sendTagData;
  Receiver.prototype.sendTagData = function (currentTag) {
    const tag = this.tags.get(currentTag);
    if (!tag) {
      // Stale tag — response arrived after the channel was cleaned up.
      // Just clean up instead of throwing UNREGISTEREDTAG.
      this.cleanUp();
      return;
    }
    return _origSendTagData.call(this, currentTag);
  };
} catch (e) {
  console.warn('[MikroTik] Could not patch Receiver for UNREGISTEREDTAG handling:', e.message);
}

const { RouterOSClient } = require('routeros-client');

// ── Connection cache & config cache ─────────────────────────
const _connections = new Map();  // deviceId → { client, api, timer }
let _configCache = null;
let _configCacheAt = 0;
const CONFIG_TTL = 30_000;       // re-read global config every 30s
const IDLE_TIMEOUT = 5 * 60_000; // disconnect after 5 min idle

// ── Read global mikrotik settings from system_settings ──────
async function getConfig(prisma) {
  const now = Date.now();
  if (_configCache && (now - _configCacheAt) < CONFIG_TTL) return _configCache;

  const rows = await prisma.system_settings.findMany({
    where: { key: { startsWith: 'mikrotik_' } }
  });
  const cfg = {};
  rows.forEach(r => { cfg[r.key] = r.value; });

  _configCache = {
    enabled:        cfg['mikrotik_enabled'] === 'true',
    defaultPort:    parseInt(cfg['mikrotik_default_port'] || '8728', 10),
    defaultTls:     cfg['mikrotik_default_tls'] === 'true',
    connectTimeout: parseInt(cfg['mikrotik_connect_timeout'] || '10', 10),
  };
  _configCacheAt = now;
  return _configCache;
}

// ── Reset idle timer for a connection ───────────────────────
function _touchIdle(deviceId) {
  const entry = _connections.get(deviceId);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    console.log(`[MikroTik] Idle timeout, disconnecting device ${deviceId}`);
    disconnect(deviceId);
  }, IDLE_TIMEOUT);
}

// ── Connect to a MikroTik device (cached) ───────────────────
async function connect(prisma, deviceId) {
  // Return cached api if still connected
  const existing = _connections.get(deviceId);
  if (existing && existing.api) {
    _touchIdle(deviceId);
    return existing.api;
  }

  // Load device record from DB
  const device = await prisma.mikrotik_devices.findUnique({
    where: { id: deviceId }
  });
  if (!device) throw new Error(`MikroTik device ${deviceId} not found`);
  if (!device.is_active) throw new Error(`MikroTik device ${deviceId} is inactive`);

  // Load global config for defaults
  const globalCfg = await getConfig(prisma);

  const client = new RouterOSClient({
    host:     device.host,
    user:     device.username,
    password: device.password,
    port:     device.port || globalCfg.defaultPort,
    tls:      device.use_tls ?? globalCfg.defaultTls,
    timeout:  globalCfg.connectTimeout,
  });

  // Attach error handler on the client to prevent unhandled errors from crashing the process
  client.on('error', (err) => {
    console.warn(`[MikroTik] Connection error on device ${deviceId}:`, err.message);
    // Mark connection as dead so next call reconnects
    const entry = _connections.get(deviceId);
    if (entry) {
      clearTimeout(entry.timer);
      _connections.delete(deviceId);
    }
  });

  try {
    const api = await client.connect();
    console.log(`[MikroTik] Connected to device ${deviceId} (${device.host})`);

    const entry = { client, api, timer: null };
    _connections.set(deviceId, entry);
    _touchIdle(deviceId);

    return api;
  } catch (err) {
    // Clean up on failure
    _connections.delete(deviceId);
    try { await client.disconnect(); } catch (_) {}
    throw new Error(`MikroTik connect failed for device ${deviceId}: ${err.message}`);
  }
}

// ── Disconnect a specific device ────────────────────────────
async function disconnect(deviceId) {
  const entry = _connections.get(deviceId);
  if (!entry) return;

  clearTimeout(entry.timer);
  _connections.delete(deviceId);

  try {
    await entry.client.disconnect();
    console.log(`[MikroTik] Disconnected device ${deviceId}`);
  } catch (err) {
    console.warn(`[MikroTik] Disconnect error for device ${deviceId}:`, err.message);
  }
}

// ── Disconnect all cached connections ───────────────────────
async function disconnectAll() {
  const ids = [..._connections.keys()];
  await Promise.allSettled(ids.map(id => disconnect(id)));
  console.log(`[MikroTik] All connections closed (${ids.length})`);
}

// ── Generic command executor ────────────────────────────────
// Actions: print, add, set, remove, enable, disable, exec
async function execute(prisma, deviceId, path, action = 'print', params = {}) {
  const api = await connect(prisma, deviceId);

  try {
    switch (action) {
      case 'print': {
        const menu = api.menu(path);
        let query = menu;
        if (params.where)  query = query.where(params.where);
        if (params.select) query = query.select(params.select);
        const result = await query.getAll();
        return result || [];
      }
      case 'add': {
        const menu = api.menu(path);
        return await menu.add(params.data || params);
      }
      case 'set': {
        if (!params.id) throw new Error('execute set: params.id required');
        const menu = api.menu(path);
        return await menu.where('id', params.id).update(params.data || {});
      }
      case 'remove': {
        if (!params.id) throw new Error('execute remove: params.id required');
        const menu = api.menu(path);
        return await menu.where('id', params.id).remove();
      }
      case 'enable': {
        if (!params.id) throw new Error('execute enable: params.id required');
        const menu = api.menu(path);
        return await menu.where('id', params.id).enable();
      }
      case 'disable': {
        if (!params.id) throw new Error('execute disable: params.id required');
        const menu = api.menu(path);
        return await menu.where('id', params.id).disable();
      }
      case 'exec': {
        // Use raw RouterOS API write for exec commands (tools, reboot, etc.)
        // The high-level menu.exec() appends command to path, causing duplication
        // e.g., menu('/ping').exec('ping') → '/ping/ping' (wrong)
        // Raw write sends the exact API sentence we need.
        const entry = _connections.get(deviceId);
        const rawApi = entry?.client?.rosApi;
        if (!rawApi) throw new Error('No raw API connection available');

        const cmd = params.command || params.cmd;
        // Build full API path: avoid duplicating the command in the path
        // e.g., path='/ping', cmd='ping' → '/ping' (not '/ping/ping')
        // e.g., path='/interface', cmd='monitor-traffic' → '/interface/monitor-traffic'
        // e.g., path='/system', cmd='reboot' → '/system/reboot'
        const pathEnd = path.split('/').pop();
        const fullPath = (cmd && cmd !== pathEnd) ? `${path}/${cmd}` : path;

        const data = params.data || {};
        const args = [fullPath];
        for (const [key, val] of Object.entries(data)) {
          args.push(`=${key}=${val}`);
        }
        return await rawApi.write(args);
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (err) {
    // Handle stale connection — clear cache so next call reconnects
    if (err.errno === 'SOCKTMOUT' || err.errno === 'ECONNRESET' ||
        err.errno === 'ECONNREFUSED' || err.message?.includes('closed')) {
      console.warn(`[MikroTik] Connection lost for device ${deviceId}, clearing cache`);
      const entry = _connections.get(deviceId);
      if (entry) {
        clearTimeout(entry.timer);
        _connections.delete(deviceId);
      }
    }
    throw err;
  }
}

// ── Convenience wrappers ────────────────────────────────────

function getSystemIdentity(prisma, deviceId) {
  return execute(prisma, deviceId, '/system/identity');
}

function getSystemResources(prisma, deviceId) {
  return execute(prisma, deviceId, '/system/resource');
}

function getSystemHealth(prisma, deviceId) {
  return execute(prisma, deviceId, '/system/health');
}

function getInterfaces(prisma, deviceId) {
  return execute(prisma, deviceId, '/interface');
}

function getActivePPPoE(prisma, deviceId) {
  return execute(prisma, deviceId, '/ppp/active');
}

function getSimpleQueues(prisma, deviceId) {
  return execute(prisma, deviceId, '/queue/simple');
}

function getFirewallFilter(prisma, deviceId) {
  return execute(prisma, deviceId, '/ip/firewall/filter');
}

function getFirewallNAT(prisma, deviceId) {
  return execute(prisma, deviceId, '/ip/firewall/nat');
}

function getAddressLists(prisma, deviceId) {
  return execute(prisma, deviceId, '/ip/firewall/address-list');
}

function getIPAddresses(prisma, deviceId) {
  return execute(prisma, deviceId, '/ip/address');
}

function getRoutes(prisma, deviceId) {
  return execute(prisma, deviceId, '/ip/route');
}

function getDHCPLeases(prisma, deviceId) {
  return execute(prisma, deviceId, '/ip/dhcp-server/lease');
}

function getARPTable(prisma, deviceId) {
  return execute(prisma, deviceId, '/ip/arp');
}

function getLogs(prisma, deviceId) {
  return execute(prisma, deviceId, '/log');
}

module.exports = {
  getConfig,
  connect,
  disconnect,
  disconnectAll,
  execute,
  getSystemIdentity,
  getSystemResources,
  getSystemHealth,
  getInterfaces,
  getActivePPPoE,
  getSimpleQueues,
  getFirewallFilter,
  getFirewallNAT,
  getAddressLists,
  getIPAddresses,
  getRoutes,
  getDHCPLeases,
  getARPTable,
  getLogs,
};
