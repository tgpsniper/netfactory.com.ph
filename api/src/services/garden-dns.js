#!/usr/bin/env node
// ============================================================
// garden-dns — wildcard DNS responder for walled-garden clients
// ============================================================
// WHY THIS EXISTS
//
// The captive redirect on the access routers dst-nats a restricted customer's
// port-80 traffic to nginx, which answers 302 to the restricted page. Measured
// against a live restricted session (100.66.48.13 on CLGNT-AC1), that rule has
// matched ZERO packets in six hours while 6,974 DNS packets and 2,632 dropped
// packets went past it. Nothing speaks cleartext HTTP any more, so the redirect
// is never handed anything to redirect.
//
// The one client that still does is the OS captive-portal probe — Android asks
// connectivitycheck.gstatic.com/generate_204 over plain HTTP, and that single
// request is what raises "Sign in to network". It was not firing either,
// because Android caches a network as validated and will not re-probe it.
//
// Pointing every lookup at this server forces the issue: the probe resolves,
// reaches nginx, gets the 302, and the notification appears. This does NOT make
// https:// browsing show the portal — nothing can, short of forging
// certificates — it makes the probe dependable.
//
// WHY NOT dnsmasq: installing a system package needs root on a shared box.
// This binds an unprivileged port as the service user, so the routers dst-nat
// DNS to 10.0.98.4:5354 and nothing on the host's own resolver is touched.
// systemd-resolved keeps 127.0.0.53 to itself.
//
// PASSTHROUGH IS THE SAFETY-CRITICAL PART
//
// A restricted customer must still be able to PAY, and the firewall already
// opens checkout.xendit.co and api.xendit.co. If this answered 10.0.98.4 for
// those, the customer would reach a walled garden they cannot leave and no
// money could be taken — the garden would become a trap rather than a prompt.
// Those domains, and our own, are forwarded to a real resolver untouched.
const dgram = require('dgram');

const LISTEN_ADDR = process.env.GARDEN_DNS_ADDR || '10.0.98.4';
const LISTEN_PORT = parseInt(process.env.GARDEN_DNS_PORT || '5354', 10);
const ANSWER_IP   = process.env.GARDEN_DNS_ANSWER || '10.0.98.4';
const UPSTREAM    = process.env.GARDEN_DNS_UPSTREAM || '1.1.1.1';
const TTL         = 30;   // short: the answer must stop applying the moment they pay

// Suffix match, so www.xendit.co and checkout.xendit.co both pass through.
const PASSTHROUGH = [
  'xendit.co',
  'netfactory.com.ph',
];

const QUERY_TIMEOUT_MS = 4000;

// ── minimal wire-format helpers ─────────────────────────────
// Only what a question needs: everything else is copied from the query verbatim.
function readName(buf, offset) {
  const parts = [];
  let i = offset;
  let guard = 0;
  while (i < buf.length && buf[i] !== 0) {
    const len = buf[i];
    // A compression pointer in a QUESTION is malformed. Refuse rather than chase
    // it — a crafted packet must not be able to walk us around the buffer.
    if ((len & 0xc0) === 0xc0) return null;
    if (i + 1 + len > buf.length) return null;
    parts.push(buf.slice(i + 1, i + 1 + len).toString('ascii'));
    i += 1 + len;
    if (++guard > 127) return null;
  }
  if (i >= buf.length) return null;
  return { name: parts.join('.').toLowerCase(), end: i + 1 };
}

function parseQuestion(buf) {
  if (buf.length < 12) return null;
  const qdcount = buf.readUInt16BE(4);
  if (qdcount !== 1) return null;            // nothing legitimate sends more
  const n = readName(buf, 12);
  if (!n || n.end + 4 > buf.length) return null;
  return {
    id:     buf.readUInt16BE(0),
    flags:  buf.readUInt16BE(2),
    name:   n.name,
    qtype:  buf.readUInt16BE(n.end),
    qclass: buf.readUInt16BE(n.end + 2),
    qEnd:   n.end + 4,
  };
}

function isPassthrough(name) {
  return PASSTHROUGH.some(d => name === d || name.endsWith('.' + d));
}

// Answer built by appending to the original query, so the question section is
// echoed back byte-for-byte — resolvers reject a reply whose question differs.
function buildAnswer(query, q, ip) {
  const head = Buffer.from(query.slice(0, q.qEnd));
  // QR=1, AA=1, RA=1, and RD copied from the query.
  head.writeUInt16BE(0x8180 | (q.flags & 0x0100), 2);
  head.writeUInt16BE(1, 4);   // QDCOUNT
  head.writeUInt16BE(1, 6);   // ANCOUNT
  head.writeUInt16BE(0, 8);
  head.writeUInt16BE(0, 10);

  const rr = Buffer.alloc(16);
  rr.writeUInt16BE(0xc00c, 0);              // pointer to the question's name
  rr.writeUInt16BE(1, 2);                   // TYPE A
  rr.writeUInt16BE(1, 4);                   // CLASS IN
  rr.writeUInt32BE(TTL, 6);
  rr.writeUInt16BE(4, 10);                  // RDLENGTH
  ip.split('.').forEach((o, i) => { rr[12 + i] = parseInt(o, 10) & 0xff; });
  return Buffer.concat([head, rr]);
}

// NOERROR with zero answers. Used for AAAA and anything that is not an A query:
// a client that gets no reply at all stalls for seconds before trying IPv4,
// which looks exactly like the dead network we are trying to explain.
function buildEmpty(query, q, rcode = 0) {
  const head = Buffer.from(query.slice(0, q.qEnd));
  head.writeUInt16BE((0x8180 | (q.flags & 0x0100)) | (rcode & 0x0f), 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(0, 6);
  head.writeUInt16BE(0, 8);
  head.writeUInt16BE(0, 10);
  return head;
}

// ── server ──────────────────────────────────────────────────
const server = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const stats = { hijacked: 0, passed: 0, empty: 0, malformed: 0, upstreamFail: 0 };

function forward(query, rinfo) {
  const client = dgram.createSocket('udp4');
  let done = false;
  const finish = (buf) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { client.close(); } catch (_) {}
    if (buf) server.send(buf, rinfo.port, rinfo.address);
  };
  const timer = setTimeout(() => {
    stats.upstreamFail++;
    // SERVFAIL rather than silence, so the client retries instead of hanging.
    const q = parseQuestion(query);
    finish(q ? buildEmpty(query, q, 2) : null);
  }, QUERY_TIMEOUT_MS);

  client.on('message', (msg) => finish(msg));
  client.on('error', () => { stats.upstreamFail++; finish(null); });
  try {
    client.send(query, 53, UPSTREAM);
  } catch (_) {
    stats.upstreamFail++;
    finish(null);
  }
}

server.on('message', (msg, rinfo) => {
  try {
    const q = parseQuestion(msg);
    if (!q) { stats.malformed++; return; }

    if (isPassthrough(q.name)) {
      stats.passed++;
      return forward(msg, rinfo);
    }
    // A (1) is hijacked. AAAA and everything else get an empty NOERROR so the
    // client falls straight through to the A answer above.
    if (q.qtype === 1 && q.qclass === 1) {
      stats.hijacked++;
      return server.send(buildAnswer(msg, q, ANSWER_IP), rinfo.port, rinfo.address);
    }
    stats.empty++;
    return server.send(buildEmpty(msg, q), rinfo.port, rinfo.address);
  } catch (err) {
    // A malformed packet from a restricted client must never take the responder
    // down: if this dies, every restricted customer loses DNS entirely.
    stats.malformed++;
    console.error('[garden-dns] handler error: ' + err.message);
  }
});

server.on('error', (err) => {
  console.error('[garden-dns] socket error: ' + err.message);
  process.exit(1);
});

server.bind(LISTEN_PORT, LISTEN_ADDR, () => {
  console.log('[garden-dns] listening on ' + LISTEN_ADDR + ':' + LISTEN_PORT +
              ' — answering A ' + ANSWER_IP + ', passthrough: ' + PASSTHROUGH.join(', ') +
              ', upstream ' + UPSTREAM);
});

setInterval(() => {
  if (stats.hijacked || stats.passed || stats.empty || stats.malformed || stats.upstreamFail) {
    console.log('[garden-dns] hijacked=' + stats.hijacked + ' passed=' + stats.passed +
                ' empty=' + stats.empty + ' malformed=' + stats.malformed +
                ' upstreamFail=' + stats.upstreamFail);
  }
}, 300000).unref();

module.exports = { server, stats };
