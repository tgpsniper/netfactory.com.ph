// ============================================================
// utils/zte-olt.js — ZTE TITAN-series (C6xx) OLT SSH driver
// ============================================================
// Why this exists as its own module rather than a branch inside vsol-olt.js:
// the two platforms share nothing but the transport. The VSOL V1600G keeps its ONU
// inventory in running-config ("onu add <id> profile <p> sn <serial>") and exposes
// live state only inside an "interface gpon 0/P" context. The ZTE C600 has none of
// that — it answers "show gpon onu state" at the top level and rejects "show version"
// outright. Sharing one function with a model flag would have meant two disjoint
// command sets and two disjoint parsers behind every `if`, so they are separate files
// and utils/olt-driver.js picks between them.
//
// Verified against OLTZTE-C600 (device id 5, TITAN series) on 2026-09-08:
//   show card                                   -> shelf/slot/card/port inventory
//   show gpon onu state                         -> every ONU index + phase
//   show gpon onu state xml                     -> same, XML-wrapped
//   show gpon onu baseinfo gpon_olt-<s>/<sl>/<p>-> type + SN + state, per PON port
//   show gpon onu detail-info gpon_onu-<idx>    -> full per-ONU detail
// Note the argument spelling: "gpon_olt-" and "gpon_onu-" (underscore, then dash).
// "gpon-onu_1/4/1:2" — the form used elsewhere in ZTE documentation — is rejected by
// this firmware with "%Error 140303: Invalid input detected".
//
// PON PORT ENCODING. This platform addresses a port as shelf/slot/port, but
// olt_onu_mappings.pon_port is a single integer (the VSOL only ever had 0/P). Ports are
// therefore encoded as shelf*10000 + slot*100 + port, so 1/4/1 -> 10401. encodePon()
// and decodePon() are the only places that know this, and the encoding is monotonic so
// ORDER BY pon_port still sorts sensibly.

const { Client: SSHClient } = require('ssh2');
const vsol = require('./vsol-olt');

// Config and DB reads are genuinely platform-independent, so they are reused rather
// than duplicated — they only read system_settings and olt_devices.
const { getConfig, getDeviceConfig, stripAnsi } = vsol;

// ── PON port encoding ───────────────────────────────────────
function encodePon(shelf, slot, port) {
  return Number(shelf) * 10000 + Number(slot) * 100 + Number(port);
}
function decodePon(encoded) {
  const n = Number(encoded);
  return { shelf: Math.floor(n / 10000), slot: Math.floor((n % 10000) / 100), port: n % 100 };
}
function ponLabel(encoded) {
  const { shelf, slot, port } = decodePon(encoded);
  return `${shelf}/${slot}/${port}`;
}

// ── SSH shell ───────────────────────────────────────────────
// A dedicated implementation rather than vsol.sshShellExec for two reasons, both of
// which would otherwise have to be conditionals inside the VSOL path:
//
//   1. The C600 authenticates once, over SSH, and drops straight to "ZXAN#". The VSOL
//      presents a SECOND login prompt inside the CLI and a third enable password; that
//      driver drives those prompts, and feeding them to a device that never asks would
//      send "cmarimla" into the command line as a command.
//   2. The C600 pages long output with "--More--" and ignores "terminal length 0"
//      (accepted without error, no effect — detail-info still pages). Paging must be
//      answered with a space or the reader deadlocks until the timeout and returns a
//      truncated table, which parses as "this ONU does not exist".
//
// The OLT allows only a small number of concurrent sessions (three observed), so this
// opens exactly one session per call and closes it deterministically.
function zteShellExec(device, commands, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let output = '';
    let settled = false;
    let ready = false;
    let stream = null;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (stream) stream.end(); } catch (_) {}
      try { conn.end(); } catch (_) {}
      fn(arg);
    };

    const timer = setTimeout(() => {
      // Resolving on timeout regardless of state is a false green: an unreachable OLT
      // returns '' and the caller reads a resolved promise as a successful read. Only a
      // session that actually produced output is worth returning.
      if (!ready) {
        return finish(reject, new Error(
          `SSH timed out after ${timeout}ms connecting to ${device.host}:${device.ssh_port || 22} — no session established`));
      }
      if (!output.trim()) {
        return finish(reject, new Error(
          `SSH session to ${device.host} opened but the CLI produced no output within ${timeout}ms`));
      }
      finish(resolve, output);
    }, timeout);

    conn.on('ready', () => {
      ready = true;
      conn.shell({ term: 'vt100', cols: 200, rows: 80 }, (err, s) => {
        if (err) return finish(reject, new Error(`SSH shell error on ${device.host}: ${err.message}`));
        stream = s;

        const cmds = Array.isArray(commands) ? commands : [commands];
        let idx = 0;
        let started = false;
        let sawPrompt = false;

        // Commands are sent one at a time, each only after the prompt returns, rather
        // than on a fixed timer. detail-info on a busy PON takes several seconds and a
        // timer-driven sender interleaves the next command into the pager.
        const sendNext = () => {
          if (idx >= cmds.length) {
            // Give the last command a moment to drain before closing.
            setTimeout(() => finish(resolve, output), 1200);
            return;
          }
          const c = cmds[idx++];
          s.write(c + '\n');
        };

        s.on('data', (chunk) => {
          const text = chunk.toString();
          output += text;

          // Answer the pager immediately; do not treat a paged screen as a prompt.
          if (/--More--|--more--|\(q\)uit/i.test(text)) {
            s.write(' ');
            return;
          }

          // "ZXAN#" means the CLI is idle and ready for input. Sub-modes bracket the
          // mode name — "ZXAN(config)#", "ZXAN(config-gpon-onu-mng)#" — so the
          // parenthesised part has to be optional here; matching only [\w.-]+ before the
          // # meant every command sent inside a config context waited for a prompt that
          // never arrived and timed out.
          if (/[\r\n][\w.\-]+(?:\([\w.\- ]*\))?[#>]\s*$/.test(output) ||
              /^[\w.\-]+(?:\([\w.\- ]*\))?[#>]\s*$/.test(text)) {
            if (!started) { started = true; sawPrompt = true; sendNext(); return; }
            sendNext();
          }
        });

        s.on('close', () => finish(resolve, output));

        // If the banner never ends in a recognisable prompt, start anyway rather than
        // sitting silent until the timeout.
        setTimeout(() => { if (!started) { started = true; sendNext(); } }, 3000);
      });
    });

    conn.on('error', (e) => finish(reject, new Error(`SSH error on ${device.host}: ${e.message}`)));

    conn.connect({
      host: device.host,
      port: device.ssh_port || 22,
      username: device.ssh_username,
      password: device.ssh_password,
      readyTimeout: Math.min(timeout, 15000),
      // The TITAN firmware negotiates only legacy KEX and ciphers; Node's modern
      // defaults produce "no matching key exchange algorithm" against it.
      algorithms: {
        kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1',
              'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group14-sha256'],
        serverHostKey: ['ssh-rsa', 'ssh-dss'],
        cipher: ['aes128-cbc', '3des-cbc', 'aes256-cbc', 'aes128-ctr', 'aes256-ctr'],
      },
    });
  });
}

// ── Parsers ─────────────────────────────────────────────────
// "--More--" arrives mid-line and the firmware pads around it, so it has to be removed
// from the text rather than dropped line-wise:
//     "  ONU Distance:         8m\n --More--           Online Duration: 98h 17m 26s"
function depage(text) {
  return stripAnsi(text)
    .replace(/\r/g, '')
    .replace(/--More--\s*/gi, '')
    .replace(/\s*\(q\)uit[^\n]*/gi, '');
}

// "show gpon onu state" — the top-level ONU list.
//   OnuIndex     Admin state  OMCC state  Phase state  Speed mode
//   1/4/1:2       enable       enable      working      GPON
function parseOnuState(text) {
  const out = [];
  for (const raw of depage(text).split('\n')) {
    const m = raw.trim().match(/^(\d+)\/(\d+)\/(\d+):(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/);
    if (!m) continue;
    const phase = m[7].toLowerCase();
    out.push({
      ponPort: encodePon(m[1], m[2], m[3]),
      ponLabel: `${m[1]}/${m[2]}/${m[3]}`,
      onuId: parseInt(m[4], 10),
      adminState: m[5].toLowerCase(),
      omccState: m[6].toLowerCase(),
      phase,
      speedMode: m[8],
      status: phase === 'working' ? 'online' : (phase ? 'offline' : 'unknown'),
    });
  }
  return out;
}

// "show gpon onu baseinfo gpon_olt-1/4/1" — type and serial for every ONU on one PON.
//   OnuIndex            Type        Mode    AuthInfo                State
//   gpon_onu-1/4/1:2    F670LV7.1   sn      SN:ZXICCD550702         ready
function parseBaseInfo(text) {
  const out = [];
  for (const raw of depage(text).split('\n')) {
    const m = raw.trim().match(
      /^gpon_onu-(\d+)\/(\d+)\/(\d+):(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(\S*)/);
    if (!m) continue;
    const auth = m[7];
    const snMatch = auth.match(/^SN:(\S+)/i);
    out.push({
      ponPort: encodePon(m[1], m[2], m[3]),
      onuId: parseInt(m[4], 10),
      model: m[5] === 'N/A' ? null : m[5],
      authMode: m[6],
      serial: snMatch ? snMatch[1] : (auth && auth !== 'N/A' ? auth : null),
      baseState: (m[8] || '').toLowerCase() || null,
    });
  }
  return out;
}

// "show card" — which slots hold PON line cards and how many ports each has.
//   Shelf Slot CfgType CardName     Port HardVer Status
//   1     4    GFBL    B03GFBL      16   V1.0.0  INSERVICE
// GFBL/GFCL/GTGO etc. are the GPON line cards; SFUB is the switch fabric and PRVR the
// power card, neither of which has subscriber-facing ports, so only rows with a nonzero
// port count and a recognised PON card type are treated as PON slots.
function parseCards(text) {
  const cards = [];
  for (const raw of depage(text).split('\n')) {
    const m = raw.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)/);
    if (!m) continue;
    const ports = parseInt(m[5], 10);
    if (!ports) continue;
    const cfgType = m[3].toUpperCase();
    // Fabric/uplink cards also report ports; they are not PON.
    if (/^(SFU|CTU|PRV|FCV|MPU|SCXM)/.test(cfgType)) continue;
    cards.push({ shelf: parseInt(m[1], 10), slot: parseInt(m[2], 10),
                 cfgType: m[3], cardName: m[4], ports, hardVer: m[6], status: m[7] });
  }
  return cards;
}

// "show gpon onu detail-info gpon_onu-1/4/1:2" — "Label: value" block.
function parseDetail(text) {
  const kv = {};
  for (const raw of depage(text).split('\n')) {
    const m = raw.match(/^\s{1,4}([A-Za-z][A-Za-z0-9 +\-/.]*?):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const val = m[2].trim();
    if (key && !(key in kv)) kv[key] = val;
  }
  return kv;
}

const clean = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  // The firmware masks Name and Description as "********" when unset.
  if (!s || s === 'N/A' || /^\*+$/.test(s)) return null;
  return s;
};
const num = (v) => {
  if (v == null) return null;
  const m = String(v).match(/-?[\d.]+/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
};

// ── Inventory ───────────────────────────────────────────────
// One session: the global ONU list, then one baseinfo per PON that actually holds ONUs.
// Walking all 64 ports would mean 64 commands to learn nothing about 63 of them.
async function fetchOnuInventory(device) {
  const stateOut = await zteShellExec(device, ['show gpon onu state'], 40000);
  const onus = parseOnuState(stateOut);
  if (!onus.length) return [];

  const ports = [...new Set(onus.map(o => o.ponPort))];
  const cmds = ports.map(p => `show gpon onu baseinfo gpon_olt-${ponLabel(p)}`);

  let baseOut = '';
  try {
    baseOut = await zteShellExec(device, cmds, Math.max(40000, ports.length * 8000));
  } catch (_) {
    // Serial/type enrichment failing must not lose the inventory itself.
  }
  const base = parseBaseInfo(baseOut);

  for (const o of onus) {
    const b = base.find(x => x.ponPort === o.ponPort && x.onuId === o.onuId);
    o.serial = b ? b.serial : null;
    o.model = b ? b.model : null;
    o.authMode = b ? b.authMode : null;
    // Shape parity with the VSOL driver — the CRM reads these fields directly.
    o.onuProfile = null;
    o.lineProfile = null;
    o.srvProfile = null;
    o.description = null;
  }
  return onus.sort((a, b) => a.ponPort - b.ponPort || a.onuId - b.onuId);
}

// ── High-level API (mirrors vsol-olt.js) ────────────────────
async function getSystemInfo(prisma, deviceId) {
  const config = await getConfig(prisma);
  if (!config.enabled) throw new Error('OLT management is disabled');
  const device = await getDeviceConfig(prisma, deviceId);

  try {
    // "show version" and "show system-group" are both rejected by this firmware, so the
    // card inventory is the system read: it proves the OLT answered and yields the real
    // shelf/slot/port topology, which is the thing the CRM actually needs.
    const out = await zteShellExec(device, ['show card'], 25000);
    const cards = parseCards(out);
    const text = depage(out);

    const ponPorts = cards.reduce((n, c) => n + c.ports, 0);
    const sysName = (text.match(/[\r\n]([\w.\-]+)#/) || [])[1] || null;

    prisma.olt_devices.update({
      where: { id: deviceId },
      data: { last_seen: new Date() },
    }).catch(() => {});

    return {
      deviceId,
      host: device.host,
      label: device.label,
      model: device.olt_model,
      sysDescr: cards.length ? `ZTE TITAN — ${cards.length} PON card(s), ${ponPorts} PON ports` : null,
      sysName,
      sysUpTime: null,          // no uptime command on this firmware
      softwareVersion: null,    // "show version" is rejected
      temperature: null,
      cards,
      ponPortCount: ponPorts,
      rawOutput: text.substring(0, 2000),
    };
  } catch (err) {
    throw new Error(`Failed to get system info from ${device.host}: ${err.message}`);
  }
}

async function getPonPorts(prisma, deviceId) {
  const config = await getConfig(prisma);
  if (!config.enabled) throw new Error('OLT management is disabled');
  const device = await getDeviceConfig(prisma, deviceId);

  try {
    // Ports come from the card inventory, not from olt_devices.pon_port_count — that
    // column said 272 for a chassis that actually has 64, and every port past the 64th
    // rendered as an empty PON in the UI.
    let cards = [];
    try { cards = parseCards(await zteShellExec(device, ['show card'], 25000)); } catch (_) {}

    const portMap = {};
    for (const c of cards) {
      for (let p = 1; p <= c.ports; p++) {
        const key = encodePon(c.shelf, c.slot, p);
        portMap[key] = { ponPort: key, ponLabel: `${c.shelf}/${c.slot}/${p}`,
                         card: c.cardName, onuCount: 0, onlineCount: 0,
                         offlineCount: 0, noDataPath: 0 };
      }
    }

    const onus = await fetchOnuInventory(device);
    for (const o of onus) {
      const p = portMap[o.ponPort] ||
        (portMap[o.ponPort] = { ponPort: o.ponPort, ponLabel: o.ponLabel, card: null,
                                onuCount: 0, onlineCount: 0, offlineCount: 0, noDataPath: 0 });
      p.onuCount++;
      if (o.status === 'online') p.onlineCount++; else p.offlineCount++;
    }
    return Object.values(portMap).sort((a, b) => a.ponPort - b.ponPort);
  } catch (err) {
    throw new Error(`Failed to get PON ports from ${device.host}: ${err.message}`);
  }
}

async function getONUs(prisma, deviceId, ponPort) {
  const config = await getConfig(prisma);
  if (!config.enabled) throw new Error('OLT management is disabled');
  const device = await getDeviceConfig(prisma, deviceId);

  try {
    const onus = await fetchOnuInventory(device);
    return ponPort != null ? onus.filter(o => o.ponPort === Number(ponPort)) : onus;
  } catch (err) {
    throw new Error(`Failed to get ONUs from ${device.host}: ${err.message}`);
  }
}

const _detailCache = new Map();
const DETAIL_TTL = 60_000;

async function getONUDetail(prisma, deviceId, ponPort, onuId, opts = {}) {
  const cacheKey = `zte/${deviceId}/${ponPort}/${onuId}`;
  const hit = _detailCache.get(cacheKey);
  if (!opts.fresh && hit && (Date.now() - hit.at) < DETAIL_TTL) return hit.value;

  const config = await getConfig(prisma);
  if (!config.enabled) throw new Error('OLT management is disabled');
  const device = await getDeviceConfig(prisma, deviceId);

  const p = Number(ponPort), o = Number(onuId);
  const idx = `${ponLabel(p)}:${o}`;

  try {
    const out = await zteShellExec(device, [`show gpon onu detail-info gpon_onu-${idx}`], 40000);
    const kv = parseDetail(out);

    // The firmware reports no optical levels in detail-info; rx/tx need a separate
    // command that is not yet confirmed on this platform, so they are reported as
    // unknown rather than guessed. signalLevel stays null in that case — a null renders
    // as "no reading", where a fabricated 0 would render as a healthy signal.
    const rxPower = num(kv.rx_optical_level ?? kv.rx_power);
    const phase = (kv.phase_state || '').toLowerCase();

    const result = {
      ponPort: p,
      ponLabel: ponLabel(p),
      onuId: o,
      status: phase === 'working' ? 'online' : (phase ? 'offline' : 'unknown'),
      description: clean(kv.description),
      name: clean(kv.name),
      serial: clean(kv.serial_number),
      model: clean(kv.type),
      vendor: null,
      firmware: null,
      rxPower,
      txPower: num(kv.tx_optical_level),
      distance: num(kv.onu_distance),
      temperature: null,
      voltage: null,
      biasCurrent: null,
      adminStatus: clean(kv.admin_state),
      authMode: clean(kv.authentication_mode),
      configState: clean(kv.config_state),
      lineProfile: clean(kv.line_profile),
      srvProfile: clean(kv.service_profile),
      onlineDuration: clean(kv.online_duration),
      macAddress: null,
      signalLevel: rxPower == null ? null
        : (rxPower <= config.opticalCriticalThreshold ? 'critical'
          : rxPower <= config.opticalWarnThreshold ? 'warning' : 'ok'),
    };

    _detailCache.set(cacheKey, { at: Date.now(), value: result });
    return result;
  } catch (err) {
    throw new Error(`Failed to get ONU detail from ${device.host}: ${err.message}`);
  }
}

// Optical levels are not available from any command confirmed on this firmware.
// Returning nulls keeps the CRM's optical card rendering "no reading" instead of the
// caller throwing and the whole subscriber panel failing — the failure mode that made
// working ONUs display as Offline on the VSOL before that driver was fixed.
async function getONUOpticalLevels(prisma, deviceId, ponPort, onuId) {
  const detail = await getONUDetail(prisma, deviceId, ponPort, onuId).catch(() => null);
  return {
    ponPort: Number(ponPort),
    onuId: Number(onuId),
    rxPower: detail ? detail.rxPower : null,
    txPower: detail ? detail.txPower : null,
    distance: detail ? detail.distance : null,
    signalLevel: detail ? detail.signalLevel : null,
    supported: false,
    note: 'Optical levels are not exposed by any verified command on this ZTE firmware.',
  };
}

// ── The ONU management context ──────────────────────────────
// Per-ONU configuration lives in "pon-onu-mng gpon_onu-<idx>", and this is the one piece
// of platform behaviour that cannot be guessed:
//
//   pon-onu-mng MUST be entered from config mode, not from the exec prompt.
//
// Issuing it at "ZXAN#" does not return an error — the firmware RESETS THE SSH SESSION,
// which surfaces as "write ECONNRESET" and looks exactly like an unreachable OLT or an
// exhausted session pool. Three separate probes were misdiagnosed that way before the
// pattern was clear. From "ZXAN(config)#" the same command enters cleanly.
//
// Verified available inside the context on this chassis (2026-09-08):
//   reboot                       Reboot remote ONU
//   tr069-mgmt <1-255> ...       acs | state | tag | untag      (VEIP id first)
//   wan <1-255> | wan ctrl       WAN provisioning
//   ssid / wifi / vlan / service / mgmt-ip / interface / restore / reconfig
//
// The prompt inside the context is "ZXAN(config-gpon-onu-mng)#", which contains
// parentheses and hyphens — any prompt matcher used with these commands has to accept
// them or it will wait for a prompt that never arrives.
function onuMgmtCommands(ponPort, onuId, inner) {
  const idx = `${ponLabel(ponPort)}:${Number(onuId)}`;
  return ['configure terminal', `pon-onu-mng gpon_onu-${idx}`, ...inner, 'exit', 'exit'];
}

// ── Write operations ────────────────────────────────────────
// Reboot is implemented: the command exists in the context help, and the ONU index
// spelling ("gpon_onu-1/4/1:2") is the same one that detail-info accepts, so there is no
// guesswork about which ONU it addresses.
async function rebootONU(prisma, deviceId, ponPort, onuId) {
  const config = await getConfig(prisma);
  if (!config.enabled) throw new Error('OLT management is disabled');
  const device = await getDeviceConfig(prisma, deviceId);

  const out = await zteShellExec(
    device, onuMgmtCommands(ponPort, onuId, ['reboot']), 45000);
  const text = depage(out);

  // The firmware reports refusals as "%Error <code>: ..." rather than a non-zero status,
  // so a silent failure would otherwise be reported to the operator as a successful
  // reboot and send them looking at the ONU instead of the command.
  const err = text.match(/%Error[^\n]*/);
  if (err) throw new Error(`OLT refused the reboot: ${err[0].trim()}`);

  return {
    deviceId, ponPort: Number(ponPort), onuId: Number(onuId),
    ponLabel: ponLabel(ponPort), success: true, output: text.substring(0, 1000),
  };
}

// Registration and deregistration are NOT enabled. Their syntax ("onu add ..." /
// "no onu ...") lives in the PON interface context, not in pon-onu-mng, and was never
// exercised here — the only ONU on this chassis is a live subscriber, and a mis-typed
// "no onu" deregisters them. Guard rather than guess: a stray UI click must not fire an
// unverified config command at a production OLT.
function assertWritesEnabled(action) {
  throw new Error(
    `${action} is not enabled for ZTE TITAN OLTs: the command syntax has not been ` +
    `verified on this chassis. Exercise it manually on a spare ONU first, then ` +
    `implement it in utils/zte-olt.js.`);
}

async function registerONU(prisma, deviceId, params) {
  assertWritesEnabled('ONU registration');
}
async function deregisterONU(prisma, deviceId, ponPort, onuId) {
  assertWritesEnabled('ONU deregistration');
}

// Pushing TR-069 settings to an ONU from the OLT — the thing that would let an ONU whose
// own web UI has no TR069 service option be onboarded without a site visit. The command
// tree is confirmed present ("tr069-mgmt <veip> acs | state | tag | untag"), but the
// argument form under `acs` was not probed and the only ONU available to test against is
// a live subscriber, so this stays closed until it can be run on a spare unit.
async function setTr069(prisma, deviceId, ponPort, onuId, opts = {}) {
  assertWritesEnabled('TR-069 provisioning');
}

function disconnectAll() { /* each call opens and closes its own session */ }

module.exports = {
  getConfig,
  getDeviceConfig,
  sshShellExec: zteShellExec,
  stripAnsi,
  getSystemInfo,
  getPonPorts,
  getONUs,
  getONUDetail,
  getONUOpticalLevels,
  registerONU,
  deregisterONU,
  rebootONU,
  setTr069,
  disconnectAll,
  // exported for the dispatcher, discovery job and tests
  encodePon,
  decodePon,
  ponLabel,
  parseOnuState,
  parseBaseInfo,
  parseCards,
  parseDetail,
  fetchOnuInventory,
  onuMgmtCommands,
};
