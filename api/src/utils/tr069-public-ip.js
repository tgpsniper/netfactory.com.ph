'use strict';

// Correlate the public source IP of CPE inform requests by matching
// nginx /acs/ access log entries with GenieACS CWMP Inform events by
// timestamp. Nginx sees the real public IP, GenieACS sees ::ffff:127.0.0.1
// (because nginx proxies localhost). Both write timestamped log lines
// within the same ~1s window for each Inform.

const fs = require('fs');
const readline = require('readline');

const NGINX_LOG = '/var/log/nginx/acs.log';
const GENIE_LOG = '/var/log/genieacs/cwmp-access.log';
const MAX_BYTES = 256 * 1024;          // tail at most last 256KB of each log
const MATCH_WINDOW_MS = 5_000;         // nginx entry must be ±5s of inform
const CACHE_TTL_MS = 30_000;
const RECENT_MS = 30 * 60 * 1000;      // ignore log entries older than 30 min

let cache = { at: 0, map: new Map() };

async function tail(path, maxBytes) {
  let stat;
  try { stat = await fs.promises.stat(path); }
  catch { return []; }
  const start = Math.max(0, stat.size - maxBytes);
  const stream = fs.createReadStream(path, { start, encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) lines.push(line);
  // If we sliced mid-line, drop the first (partial) line
  if (start > 0 && lines.length) lines.shift();
  return lines;
}

// Nginx format (configured): "$time_iso8601\t$remote_addr\t$method\t$status\t$req_len\t$bytes_sent"
// Note $time_iso8601 is "2026-05-01T17:41:36+00:00" (no millis).
function parseNginxLine(line) {
  const parts = line.split('\t');
  if (parts.length < 4) return null;
  const ts = Date.parse(parts[0]);
  if (!ts) return null;
  return { ts, ip: parts[1], method: parts[2], status: parts[3] };
}

// GenieACS CWMP format: "<ts> [INFO] ::ffff:127.0.0.1 <serial>: Inform; ..."
const GENIE_INFORM_RE = /^(\S+) \[INFO\] \S+ ([^:]+):\s+Inform;/;
function parseGenieInformLine(line) {
  const m = line.match(GENIE_INFORM_RE);
  if (!m) return null;
  const ts = Date.parse(m[1]);
  if (!ts) return null;
  return { ts, deviceId: m[2] };
}

async function buildMap() {
  const now = Date.now();
  const cutoff = now - RECENT_MS;

  const [nginxLines, genieLines] = await Promise.all([
    tail(NGINX_LOG, MAX_BYTES),
    tail(GENIE_LOG, MAX_BYTES),
  ]);

  const nginxEntries = nginxLines
    .map(parseNginxLine)
    .filter(e => e && e.ts >= cutoff && e.method === 'POST');

  const informs = genieLines
    .map(parseGenieInformLine)
    .filter(e => e && e.ts >= cutoff);

  // For each Inform, find the closest nginx POST within ±MATCH_WINDOW_MS.
  // Keep the most recent IP per device.
  const map = new Map();
  for (const inf of informs) {
    let best = null;
    let bestDelta = MATCH_WINDOW_MS + 1;
    for (const ng of nginxEntries) {
      const delta = Math.abs(ng.ts - inf.ts);
      if (delta < bestDelta) {
        best = ng;
        bestDelta = delta;
      }
    }
    if (best) {
      const cur = map.get(inf.deviceId);
      if (!cur || cur.ts < inf.ts) {
        map.set(inf.deviceId, { ip: best.ip, ts: inf.ts });
      }
    }
  }
  return map;
}

// Cached lookup: returns Map<deviceId, { ip, ts }>
async function getPublicIpMap() {
  const now = Date.now();
  if (now - cache.at < CACHE_TTL_MS) return cache.map;
  try {
    cache = { at: now, map: await buildMap() };
  } catch (e) {
    // Fail open — return previous cache (or empty map) if logs unreadable
    if (!cache.map) cache.map = new Map();
  }
  return cache.map;
}

function publicIpFor(deviceId, map) {
  const e = map.get(deviceId);
  return e ? e.ip : null;
}

// Convenience: best-effort sync invalidation (e.g. after manual log clear)
function invalidate() { cache = { at: 0, map: new Map() }; }

module.exports = { getPublicIpMap, publicIpFor, invalidate };
