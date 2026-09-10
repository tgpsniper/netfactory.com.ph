// ============================================================
// channels/facebook.js — Facebook Messenger two-way
// ============================================================
const crypto = require('crypto');
const fetch = require('node-fetch');

const type = 'facebook';
const GRAPH = 'https://graph.facebook.com/v19.0';

async function readCfg(prisma) {
  const rows = await prisma.system_settings.findMany({
    where: { key: { in: ['fb_page_access_token', 'fb_app_secret', 'fb_verify_token', 'fb_page_id'] } },
  });
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  return { token: m.fb_page_access_token || '', appSecret: m.fb_app_secret || '', verifyToken: m.fb_verify_token || '', pageId: m.fb_page_id || '' };
}
function configured(cfg) { return !!cfg.token; }

// Webhook handshake (GET): echo hub.challenge when verify token matches.
function verifyGet(req, cfg) {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === cfg.verifyToken && cfg.verifyToken) {
    return req.query['hub.challenge'];
  }
  return null;
}

// HMAC: 'sha256=' + HMAC-SHA256(appSecret, rawBody), compared to X-Hub-Signature-256.
function verifyPost(req, cfg) {
  const sig = req.get('x-hub-signature-256') || '';
  if (!cfg.appSecret || !req.rawBody || !sig) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', cfg.appSecret).update(req.rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch (e) { return false; }
}

function parseInbound(body) {
  const out = [];
  if (!body || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) {
    for (const m of (entry.messaging || [])) {
      if (!m.message || m.message.is_echo) continue; // skip echoes/delivery/read
      const attachments = (m.message.attachments || []).map(a => ({ type: a.type, url: a.payload && a.payload.url }));
      out.push({
        externalUserId: m.sender && m.sender.id,
        externalMessageId: m.message.mid || null,
        text: m.message.text || '',
        attachments,
        timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
      });
    }
  }
  return out;
}

async function send(prisma, { conversation, text }) {
  const cfg = await readCfg(prisma);
  if (!configured(cfg)) return { ok: false, error: 'Facebook not configured' };
  const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(cfg.token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: conversation.external_user_id }, messaging_type: 'RESPONSE', message: { text } }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.error) {
    const code = json.error.code;
    const windowIssue = code === 10 || /outside.*window|24.?hour|message.*tag/i.test(json.error.message || '');
    const friendly = windowIssue
      ? "Outside the 24-hour messaging window — Facebook only allows free-form replies within 24h of the customer's last message."
      : json.error.message;
    return { ok: false, error: friendly };
  }
  return { ok: true, externalMessageId: json.message_id || null };
}

async function test(prisma) {
  const cfg = await readCfg(prisma);
  if (!configured(cfg)) return { ok: false, error: 'Page access token required' };
  const res = await fetch(`${GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(cfg.token)}`);
  const json = await res.json().catch(() => ({}));
  if (json.error) return { ok: false, error: json.error.message };
  return { ok: true, detail: `Page: ${json.name || json.id}` };
}

module.exports = { type, readCfg, configured, verifyGet, verifyPost, parseInbound, send, test };
