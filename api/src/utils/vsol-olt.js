// ============================================================
// utils/vsol-olt.js — VSOL OLT SSH Manager
// SSH CLI for reading OLT/ONU data and write/config commands
// SNMP support available but optional (olt_use_snmp setting)
// Config stored in system_settings + olt_devices
// ============================================================

const { Client: SSHClient } = require('ssh2');

// ── Config cache ────────────────────────────────────────────
let _configCache = null;
let _configCacheAt = 0;
const CONFIG_TTL = 30_000;

// ── Read OLT global config from system_settings ─────────────
async function getConfig(prisma) {
  const now = Date.now();
  if (_configCache && (now - _configCacheAt) < CONFIG_TTL) return _configCache;

  const rows = await prisma.system_settings.findMany({
    where: { key: { startsWith: 'olt_' } },
  });
  const cfg = {};
  rows.forEach(r => { cfg[r.key] = r.value; });

  _configCache = {
    enabled:                   cfg['olt_enabled'] === 'true',
    useSnmp:                   cfg['olt_use_snmp'] === 'true',
    snmpTimeout:               parseInt(cfg['olt_snmp_timeout'], 10) || 5000,
    opticalWarnThreshold:      parseFloat(cfg['olt_optical_warn_threshold']) || -25,
    opticalCriticalThreshold:  parseFloat(cfg['olt_optical_critical_threshold']) || -28,
  };
  _configCacheAt = now;
  return _configCache;
}

// ── Read specific device from DB ────────────────────────────
async function getDeviceConfig(prisma, deviceId) {
  const device = await prisma.olt_devices.findUnique({
    where: { id: deviceId },
  });
  if (!device) throw new Error(`OLT device ${deviceId} not found`);
  if (!device.is_active) throw new Error(`OLT device ${deviceId} is not active`);
  return device;
}

// ── SSH: execute command via interactive shell ──────────────
// VSOL OLTs use interactive CLI (Cisco-like) — conn.exec()
// often fails. This opens a shell, sends commands, captures output.
function sshShellExec(device, commands, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let output = '';
    let settled = false;
    let ready = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      // Resolving unconditionally here was a false green: when the OLT was unreachable
      // this returned '' after the timeout, and /devices/:id/test read a resolved promise
      // as "connected: true". The Test button showed Connected for a device that had
      // never answered a packet — worse than showing the failure, because it sends you
      // looking for the problem somewhere else entirely.
      if (!ready) {
        return reject(new Error(
          `SSH timed out after ${timeout}ms connecting to ${device.host}:${device.ssh_port || 22} — no session established`));
      }
      if (!output) {
        return reject(new Error(
          `SSH session to ${device.host} opened but the CLI produced no output within ${timeout}ms`));
      }
      resolve(output); // genuine partial read — the session worked, the command was slow
    }, timeout);

    conn.on('ready', () => {
      ready = true;
      conn.shell({ term: 'xterm', cols: 200, rows: 50 }, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          settled = true;
          conn.end();
          return reject(new Error(`SSH shell error on ${device.host}: ${err.message}`));
        }

        // This platform asks to log in TWICE. SSH authenticates you, and then the CLI
        // itself presents its own "User Access Verification / Login: / Password:" prompt.
        // The old code waited a flat 1.5s and started typing commands regardless, so the
        // first command went in as the username and the second as the next username:
        //
        //     Login: terminal length 0
        //     Password:
        //     Bad UserName or Bad Password , Login Failed.
        //
        // which looks exactly like wrong credentials and is not. Drive the prompts instead
        // of guessing at timing, and only start sending real commands once the CLI prompt
        // (ending in > or #) actually appears.
        const cmds = Array.isArray(commands) ? commands : [commands];
        let i = 0;
        let started = false;
        let userSent = false;
        let passSent = false;
        // Privileged mode is a THIRD credential. At "gpon-olt>" the device offers only
        // enable/exit/help/list/show-history/who — no ONU, PON or system command exists
        // until you reach "gpon-olt#". Skipped entirely when no enable password is stored,
        // so devices that do not use one behave exactly as before.
        const wantEnable = !!device.enable_password;
        let enableSent = false;
        let enablePassSent = false;

        const done = (fn, arg) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(fallback);
          try { stream.end(); } catch (_) {}
          try { conn.end(); } catch (_) {}
          fn(arg);
        };

        function begin() {
          if (started || settled) return;
          started = true;
          clearTimeout(fallback);
          sendNext();
        }

        function onData() {
          if (settled || started) return;
          const tail = output.slice(-250);

          // "Too many failer" is the enable lockout; distinguish it so nobody spends an
          // afternoon re-checking a password that was right all along.
          if (/Too many fail/i.test(tail)) {
            return done(reject, new Error(
              `OLT refused privileged mode for "${device.ssh_username}" and has locked out further ` +
              `enable attempts. Check the enable password, then wait before retrying.`));
          }
          if (enableSent && /Bad Password/i.test(tail)) {
            return done(reject, new Error(
              'OLT rejected the enable password. Privileged mode is a separate credential from the SSH login.'));
          }
          if (/Bad UserName|Login Failed|Access denied/i.test(tail) ||
              (!enableSent && /Bad Password/i.test(tail))) {
            return done(reject, new Error(
              `OLT CLI rejected the login for "${device.ssh_username}". SSH authenticated, but the ` +
              `device's own CLI login was refused — check the account's password on the OLT.`));
          }
          if (!userSent && /(?:Login|Username)\s*:\s*$/i.test(tail)) {
            userSent = true;
            stream.write((device.ssh_username || '') + '\n');
            return;
          }
          if (userSent && !passSent && /Password\s*:\s*$/i.test(tail)) {
            passSent = true;
            stream.write((device.ssh_password || '') + '\n');
            return;
          }
          // Unprivileged prompt: climb to privileged mode before doing anything else.
          if (wantEnable && !enableSent && /gpon-olt>\s*$|[^#]>\s*$/.test(tail)) {
            enableSent = true;
            stream.write('enable\n');
            return;
          }
          if (enableSent && !enablePassSent && /Password\s*:\s*$/i.test(tail)) {
            enablePassSent = true;
            stream.write((device.enable_password || '') + '\n');
            return;
          }
          // Only "#" counts once we are climbing — stopping at ">" would send every
          // command into the mode that cannot run any of them.
          if (wantEnable) { if (/#\s*$/.test(tail)) begin(); return; }
          if (/[>#]\s*$/.test(tail)) begin();
        }

        stream.on('data', (data) => { output += data.toString(); onData(); });
        stream.stderr.on('data', (data) => { output += data.toString(); onData(); });

        stream.on('close', () => done(resolve, output));

        function sendNext() {
          if (settled) return;
          if (i < cmds.length) {
            stream.write(cmds[i] + '\n');
            i++;
            setTimeout(sendNext, 800);
          } else {
            setTimeout(() => done(resolve, output), 2000);
          }
        }

        // Firmware that does not ask a second time never shows a Login: prompt, so fall
        // back to the old behaviour rather than hanging on a prompt that will not come.
        var fallback = setTimeout(begin, 6000);
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`SSH connection failed to ${device.host}: ${err.message}`));
      }
    });

    // Answer the keyboard-interactive challenge with the stored password — for these
    // devices the single prompt is just "Password:" under another name.
    conn.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      finish(prompts.map(() => device.ssh_password || ''));
    });

    conn.connect({
      host: device.host,
      port: device.ssh_port || 22,
      username: device.ssh_username,
      password: device.ssh_password,
      // Embedded SSH servers routinely advertise password auth and then only honour
      // keyboard-interactive. Without this, ssh2 exhausts its methods and reports
      // "All configured authentication methods failed", which reads like a wrong
      // password and sends you looking in the wrong place.
      tryKeyboard: true,
      readyTimeout: 10000,
      algorithms: {
        kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1',
              'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521'],
        cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', '3des-cbc', 'aes256-cbc'],
        hmac: ['hmac-sha2-256', 'hmac-sha1', 'hmac-md5'],
      },
    });
  });
}

// ── SSH: execute single command (non-interactive) ───────────
function sshExec(device, command) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let stdout = '';
    let stderr = '';

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { conn.end(); return reject(new Error(`SSH exec error on ${device.host}: ${err.message}`)); }
        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', (data) => { stderr += data.toString(); });
        stream.on('close', (code) => {
          conn.end();
          if (code !== 0 && code !== null && stderr && !stdout) {
            return reject(new Error(`SSH command exited ${code} on ${device.host}: ${stderr}`));
          }
          resolve(stdout || stderr);
        });
      });
    });

    conn.on('error', (err) => {
      reject(new Error(`SSH connection failed to ${device.host}: ${err.message}`));
    });

    conn.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      finish(prompts.map(() => device.ssh_password || ''));
    });

    conn.connect({
      host: device.host,
      port: device.ssh_port || 22,
      username: device.ssh_username,
      password: device.ssh_password,
      // Embedded SSH servers routinely advertise password auth and then only honour
      // keyboard-interactive. Without this, ssh2 exhausts its methods and reports
      // "All configured authentication methods failed", which reads like a wrong
      // password and sends you looking in the wrong place.
      tryKeyboard: true,
      readyTimeout: 10000,
      algorithms: {
        kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1',
              'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521'],
        cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', '3des-cbc', 'aes256-cbc'],
        hmac: ['hmac-sha2-256', 'hmac-sha1', 'hmac-md5'],
      },
    });
  });
}

// ── SSH: execute multiple commands sequentially ─────────────
async function sshExecMulti(device, commands) {
  const results = [];
  for (const cmd of commands) {
    const output = await sshExec(device, cmd);
    results.push({ command: cmd, output });
  }
  return results;
}

// ── CLI output parsers ──────────────────────────────────────

// Strip ANSI escape codes and control chars from shell output
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // ANSI escape sequences
    .replace(/\x1b\][^\x07]*\x07/g, '')       // OSC sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '') // control chars (keep \n \r \t)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

// Parse key:value or key = value lines from CLI output
function parseKeyValue(output) {
  const result = {};
  const clean = stripAnsi(output);
  const lines = clean.split('\n');
  for (const line of lines) {
    // Match "Key : Value" or "Key = Value" or "Key: Value"
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 _-]*?)\s*[:=]\s*(.+?)\s*$/);
    if (m) {
      const key = m[1].trim().toLowerCase().replace(/[\s-]+/g, '_');
      result[key] = m[2].trim();
    }
  }
  return result;
}

// Parse tabular CLI output (header row + data rows)
function parseTable(output) {
  const clean = stripAnsi(output);
  const lines = clean.split('\n').filter(l => l.trim() && !l.match(/^[-=+]+$/));
  if (lines.length < 2) return [];

  // Find the header line (first line with multiple words)
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const words = lines[i].trim().split(/\s{2,}|\t+/);
    if (words.length >= 3) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return [];

  const headers = lines[headerIdx].trim().split(/\s{2,}|\t+/).map(h =>
    h.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[()]/g, '')
  );

  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.match(/^[-=+]+$/) || line.match(/^#|^\s*$/)) continue;

    // Split by 2+ spaces or tabs
    const cells = line.split(/\s{2,}|\t+/);
    if (cells.length < 2) continue;

    const row = {};
    for (let j = 0; j < headers.length && j < cells.length; j++) {
      row[headers[j]] = cells[j].trim();
    }
    rows.push(row);
  }
  return rows;
}

// ── High-level: get system info via SSH ─────────────────────
async function getSystemInfo(prisma, deviceId) {
  const config = await getConfig(prisma);
  if (!config.enabled) throw new Error('OLT management is disabled');

  const device = await getDeviceConfig(prisma, deviceId);

  try {
    // Try shell-based command for interactive CLI devices
    const output = await sshShellExec(device, [
      'terminal length 0',
      'show version',
      'show system',
      'exit',
    ], 12000);

    const parsed = parseKeyValue(output);
    const clean = stripAnsi(output);

    // Extract uptime from various formats
    let uptimeStr = parsed.uptime || parsed.system_uptime || parsed.up_time || null;
    if (!uptimeStr) {
      const uptimeMatch = clean.match(/[Uu]ptime\s*[:=]\s*(.+?)$/m) ||
                          clean.match(/[Uu]p\s+[Tt]ime\s*[:=]\s*(.+?)$/m);
      if (uptimeMatch) uptimeStr = uptimeMatch[1].trim();
    }

    // Extract version
    let version = parsed.software_version || parsed.system_software_version || parsed.version || null;
    if (!version) {
      const verMatch = clean.match(/[Vv]ersion\s*[:=]\s*(.+?)$/m);
      if (verMatch) version = verMatch[1].trim();
    }

    // Extract system name/description
    let sysDescr = parsed.system_description || parsed.system_type || parsed.description || null;
    if (!sysDescr) {
      const descrMatch = clean.match(/[Dd]escription\s*[:=]\s*(.+?)$/m);
      if (descrMatch) sysDescr = descrMatch[1].trim();
    }

    let sysName = parsed.hostname || parsed.system_name || parsed.host_name || null;

    // Update DB
    prisma.olt_devices.update({
      where: { id: deviceId },
      data: { last_seen: new Date(), last_uptime: uptimeStr },
    }).catch(() => {});

    return {
      deviceId,
      host: device.host,
      label: device.label,
      model: device.olt_model,
      sysDescr,
      sysName,
      sysUpTime: uptimeStr,
      softwareVersion: version,
      temperature: parsed.temperature ? Number(parsed.temperature) : null,
      rawOutput: clean.substring(0, 2000),
    };
  } catch (err) {
    throw new Error(`Failed to get system info from ${device.host}: ${err.message}`);
  }
}

// ── Reading ONUs off this firmware ──────────────────────────
// The commands this driver was written for — "show gpon onu state",
// "show gpon onu detail-info" — do not exist on the V1600G. Every one returns
// "% Unknown command.", which is why auto-discover had never produced a single mapping.
//
// What this platform actually offers:
//   • running-config carries, per "interface gpon 0/P" block, the ONU inventory as
//     "onu add <id> profile <p> sn <serial>" plus "onu <id> profile line|srv name <n>"
//   • "show onu state", INSIDE the interface context, gives live phase per ONU
//
// The line profile is carried through deliberately. An ONU with no line profile has no
// T-CONT, no GEM port and no VLAN binding: it reports itself working, shows Online in
// every UI, and cannot obtain an address. Two subscribers sat in exactly that state for
// two days while every screen insisted they were fine, so it belongs in the ONU list
// rather than three menus away.
async function fetchOnuInventory(device) {
  const cfg = stripAnsi(await sshShellExec(device,
    ['terminal length 0', 'show running-config', 'exit', 'exit'], 60000));

  const onus = [];
  let pon = null;
  for (const raw of cfg.split('\n')) {
    const l = raw.trim();
    let m;
    if ((m = l.match(/^interface gpon (\d+)\/(\d+)$/))) { pon = parseInt(m[2], 10); continue; }
    if (pon && (m = l.match(/^onu add (\d+) profile (\S+) sn (\S+)/))) {
      onus.push({ ponPort: pon, onuId: parseInt(m[1], 10), serial: m[3],
                  onuProfile: m[2], lineProfile: null, srvProfile: null,
                  status: 'unknown', description: null, model: null });
    }
    if (pon && (m = l.match(/^onu (\d+) profile (line|srv) name (\S+)/))) {
      const o = onus.find(x => x.ponPort === pon && x.onuId === parseInt(m[1], 10));
      if (o) o[m[2] === 'line' ? 'lineProfile' : 'srvProfile'] = m[3];
    }
    if (pon && (m = l.match(/^onu (\d+) desc (.+)$/))) {
      const o = onus.find(x => x.ponPort === pon && x.onuId === parseInt(m[1], 10));
      if (o) o.description = m[2].trim();
    }
  }

  // Live phase, one session per PON that actually holds ONUs — no point walking all 16.
  for (const p of [...new Set(onus.map(o => o.ponPort))]) {
    let out;
    try {
      out = stripAnsi(await sshShellExec(device, [
        'terminal length 0', 'configure terminal', `interface gpon 0/${p}`,
        'show onu state', 'end', 'exit', 'exit',
      ], 60000));
    } catch (_) { continue; }   // a PON we cannot read must not lose the whole inventory
    // Fields arrive one per line: "1/1/2:3", then admin, omcc, phase, channel.
    const rows = out.split('\n').map(x => x.trim());
    rows.forEach((r, i) => {
      const m = r.match(/^\d+\/\d+\/(\d+):(\d+)$/);
      if (!m) return;
      const o = onus.find(x => x.ponPort === parseInt(m[1], 10) && x.onuId === parseInt(m[2], 10));
      if (!o) return;
      o.phase = (rows[i + 3] || '').toLowerCase();
      o.adminState = (rows[i + 1] || '').toLowerCase();
      o.status = o.phase === 'working' ? 'online' : (o.phase ? 'offline' : 'unknown');
    });
  }

  return onus.sort((a, b) => a.ponPort - b.ponPort || a.onuId - b.onuId);
}

// ── High-level: get PON ports via SSH ───────────────────────
async function getPonPorts(prisma, deviceId) {
  const config = await getConfig(prisma);
  if (!config.enabled) throw new Error('OLT management is disabled');
  const device = await getDeviceConfig(prisma, deviceId);

  try {
    const onus = await fetchOnuInventory(device);
    const portMap = {};
    for (let i = 1; i <= device.pon_port_count; i++) {
      portMap[i] = { ponPort: i, onuCount: 0, onlineCount: 0, offlineCount: 0, noDataPath: 0 };
    }
    for (const o of onus) {
      const p = portMap[o.ponPort] ||
        (portMap[o.ponPort] = { ponPort: o.ponPort, onuCount: 0, onlineCount: 0, offlineCount: 0, noDataPath: 0 });
      p.onuCount++;
      if (o.status === 'online') p.onlineCount++; else p.offlineCount++;
      if (!o.lineProfile) p.noDataPath++;
    }
    return Object.values(portMap).sort((a, b) => a.ponPort - b.ponPort);
  } catch (err) {
    throw new Error(`Failed to get PON ports from ${device.host}: ${err.message}`);
  }
}

// ── High-level: get ONUs via SSH ────────────────────────────
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

// ── High-level: ONU detail via SSH ──────────────────────────
// Detail reads are expensive: a fresh SSH session plus four commands, ~8s each. The OLT
// allows Max Sessions 3 / Max Startups 3, so three staff opening subscriber panels at once
// exhaust it and the reads start failing — which is exactly what put "error" into
// liveStatus and made mapped, online ONUs look unmapped. A short cache keeps the panel
// responsive and the OLT unbothered; 60s is far shorter than anything an operator would
// notice, and Refresh still forces a read by passing {fresh:true}.
const _onuDetailCache = new Map();
const ONU_DETAIL_TTL = 60_000;

async function getONUDetail(prisma, deviceId, ponPort, onuId, opts = {}) {
  const cacheKey = `${deviceId}/${ponPort}/${onuId}`;
  const hit = _onuDetailCache.get(cacheKey);
  if (!opts.fresh && hit && (Date.now() - hit.at) < ONU_DETAIL_TTL) return hit.value;

  const config = await getConfig(prisma);
  if (!config.enabled) throw new Error('OLT management is disabled');
  const device = await getDeviceConfig(prisma, deviceId);

  // "show gpon onu detail-info" / "show pon power attenuation" do not exist on this
  // firmware — they returned "% Unknown command." and the subscriber panel rendered the
  // resulting nulls as a confident red "Offline" for an ONU that was working perfectly.
  // The real commands live inside the PON interface context and give everything the card
  // wants: optical levels, distance, vendor, model and software version.
  const p = Number(ponPort), o = Number(onuId);
  try {
    const out = stripAnsi(await sshShellExec(device, [
      'terminal length 0', 'configure terminal', `interface gpon 0/${p}`,
      `show onu ${o} optical_info`,
      `show onu ${o} distance`,
      `show onu detail-info ${o}`,
      'show onu state',
      'end', 'exit', 'exit',
    ], 60000));

    const num = (re) => {
      const m = out.match(re);
      if (!m) return null;
      const v = parseFloat(m[1]);
      return Number.isFinite(v) ? v : null;
    };
    const str = (re) => {
      const m = out.match(re);
      const v = m ? m[1].trim() : null;
      return !v || v === 'N/A' ? null : v;
    };

    // Live phase for this ONU specifically: fields print one per line after the index.
    const rows = out.split('\n').map(x => x.trim());
    let status = 'unknown';
    rows.forEach((r, i) => {
      const m = r.match(/^\d+\/\d+\/(\d+):(\d+)$/);
      if (m && Number(m[1]) === p && Number(m[2]) === o) {
        status = (rows[i + 3] || '').toLowerCase() === 'working' ? 'online' : 'offline';
      }
    });

    const rxPower = num(/Rx optical level:\s*(-?[\d.]+)/);

    const result = {
      ponPort: p,
      onuId: o,
      status,
      description: null,
      serial: str(/^SN:\s*(\S+)/m),
      model: str(/Equipment ID:\s*(.+)$/m),
      vendor: str(/Vendor ID:\s*(.+)$/m),
      firmware: str(/Main software version:\s*(.+)$/m),
      rxPower,
      txPower: num(/Tx optical level:\s*(-?[\d.]+)/),
      distance: num(/Distance:\s*(\d+)\s*m/),
      temperature: num(/Temperature:\s*([\d.]+)/),
      voltage: num(/Power feed voltage:\s*([\d.]+)/),
      biasCurrent: num(/Laser bias current:\s*([\d.]+)/),
      adminStatus: str(/Admin status:\s*(\S+)/),
      macAddress: null,
      // Thresholds come from settings so an operator can tune what counts as marginal
      // without a code change.
      signalLevel: rxPower == null ? null
        : (rxPower <= config.opticalCriticalThreshold ? 'critical'
          : rxPower <= config.opticalWarnThreshold ? 'warning' : 'ok'),
    };

    _onuDetailCache.set(cacheKey, { at: Date.now(), value: result });
    return result;
  } catch (err) {
    throw new Error(`Failed to get ONU detail from ${device.host}: ${err.message}`);
  }
}

// ── High-level: ONU optical levels via SSH ──────────────────
async function getONUOpticalLevels(prisma, deviceId, ponPort, onuId) {
  const config = await getConfig(prisma);
  if (!config.enabled) throw new Error('OLT management is disabled');

  const device = await getDeviceConfig(prisma, deviceId);

  try {
    const output = await sshShellExec(device, [
      'terminal length 0',
      `show pon power attenuation gpon 0/${ponPort}`,
      'exit',
    ], 12000);

    const clean = stripAnsi(output);
    let rxPower = null, txPower = null, distance = null;

    // Parse attenuation table for specific ONU
    const lines = clean.split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*(\d+)\s+([-\d.]+)\s+([-\d.]+)\s+([\d.]+)/);
      if (m && parseInt(m[1], 10) === onuId) {
        rxPower = parseFloat(m[2]);
        txPower = parseFloat(m[3]);
        distance = parseInt(m[4], 10);
        break;
      }
    }

    let signalLevel = null;
    if (rxPower != null) {
      if (rxPower <= config.opticalCriticalThreshold) signalLevel = 'critical';
      else if (rxPower <= config.opticalWarnThreshold) signalLevel = 'warning';
      else signalLevel = 'good';
    }

    return {
      ponPort,
      onuId,
      rxPower,
      txPower,
      distance,
      signalLevel,
      thresholds: {
        warn: config.opticalWarnThreshold,
        critical: config.opticalCriticalThreshold,
      },
    };
  } catch (err) {
    throw new Error(`Failed to get optical levels from ${device.host}: ${err.message}`);
  }
}

// ── High-level: register ONU via SSH ────────────────────────
async function registerONU(prisma, deviceId, params) {
  const config = await getConfig(prisma);
  if (!config.enabled) throw new Error('OLT management is disabled');

  const device = await getDeviceConfig(prisma, deviceId);
  if (!device.use_ssh) throw new Error('SSH is not enabled for this device');

  const { ponPort, onuId, serial, profileName, description, svlan, cvlan } = params;
  if (!ponPort || !onuId) throw new Error('ponPort and onuId are required');

  const commands = [
    'configure terminal',
    `interface gpon 0/${ponPort}`,
  ];

  if (serial) commands.push(`onu ${onuId} serial ${serial}`);
  if (profileName) commands.push(`onu ${onuId} profile ${profileName}`);
  if (description) commands.push(`onu ${onuId} description ${description}`);
  if (svlan != null && cvlan != null) {
    commands.push(`onu ${onuId} service 1 gemport 1 vlan ${svlan} cos 0`);
    commands.push(`onu ${onuId} service-translate 1 translate 1 eth 1 vlan ${cvlan}`);
  }

  commands.push('exit', 'exit', 'write memory');

  const output = await sshShellExec(device, commands, 20000);
  return { success: true, commands, output: stripAnsi(output) };
}

// ── High-level: deregister ONU via SSH ──────────────────────
async function deregisterONU(prisma, deviceId, ponPort, onuId) {
  const config = await getConfig(prisma);
  if (!config.enabled) throw new Error('OLT management is disabled');

  const device = await getDeviceConfig(prisma, deviceId);
  if (!device.use_ssh) throw new Error('SSH is not enabled for this device');

  const commands = [
    'configure terminal',
    `interface gpon 0/${ponPort}`,
    `no onu ${onuId}`,
    'exit',
    'exit',
    'write memory',
  ];

  const output = await sshShellExec(device, commands, 15000);
  return { success: true, ponPort, onuId, output: stripAnsi(output) };
}

// ── High-level: reboot ONU via SSH ──────────────────────────
async function rebootONU(prisma, deviceId, ponPort, onuId) {
  const config = await getConfig(prisma);
  if (!config.enabled) throw new Error('OLT management is disabled');

  const device = await getDeviceConfig(prisma, deviceId);
  if (!device.use_ssh) throw new Error('SSH is not enabled for this device');

  const commands = [
    'configure terminal',
    `interface gpon 0/${ponPort}`,
    `onu reset ${ponPort} ${onuId}`,
    'exit',
    'exit',
  ];

  const output = await sshShellExec(device, commands, 12000);
  return { success: true, ponPort, onuId, output: stripAnsi(output) };
}

// ── Cleanup ─────────────────────────────────────────────────
function disconnectAll() {
  _configCache = null;
  _configCacheAt = 0;
}

// ── Exports ─────────────────────────────────────────────────
module.exports = {
  getConfig,
  getDeviceConfig,

  // SSH operations
  sshExec,
  sshShellExec,
  sshExecMulti,

  // CLI parsers
  stripAnsi,
  parseKeyValue,
  parseTable,

  // High-level functions
  getSystemInfo,
  getPonPorts,
  getONUs,
  getONUDetail,
  getONUOpticalLevels,
  registerONU,
  deregisterONU,
  rebootONU,

  // Cleanup
  disconnectAll,
};
