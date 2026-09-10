// ============================================================
// channels/viber.js — Viber two-way (webhook inbound + send API)
// ============================================================
const crypto = require('crypto');
const fetch = require('node-fetch');

const type = 'viber';

async function readCfg(prisma) {
  const rows = await prisma.system_settings.findMany({
    where: { key: { in: ['viber_auth_token', 'viber_bot_name', 'viber_bot_avatar'] } },
  });
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  return { authToken: m.viber_auth_token || '', botName: m.viber_bot_name || 'Netfactory', botAvatar: m.viber_bot_avatar || '' };
}
function configured(cfg) { return !!cfg.authToken; }

// HMAC-SHA256(authToken, rawBody) hex, compared to X-Viber-Content-Signature.
function verifyPost(req, cfg) {
  const sig = req.get('x-viber-content-signature') || '';
  if (!cfg.authToken || !req.rawBody || !sig) return false;
  const expected = crypto.createHmac('sha256', cfg.authToken).update(req.rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch (e) { return false; }
}

function parseInbound(body) {
  if (!body || body.event !== 'message') return null;
  const s = body.sender || {};
  const msg = body.message || {};
  const attachments = [];
  if (msg.media) attachments.push({ type: msg.type || 'media', url: msg.media });
  return {
    externalUserId: s.id,
    externalName: s.name || null,
    externalAvatar: s.avatar || null,
    externalMessageId: (msg.token || body.message_token) ? String(msg.token || body.message_token) : null,
    text: msg.text || '',
    attachments,
    timestamp: body.timestamp ? new Date(body.timestamp) : new Date(),
  };
}

async function send(prisma, { conversation, text }) {
  const cfg = await readCfg(prisma);
  if (!configured(cfg)) return { ok: false, error: 'Viber not configured' };
  const res = await fetch('https://chatapi.viber.com/pa/send_message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Viber-Auth-Token': cfg.authToken },
    body: JSON.stringify({ receiver: conversation.external_user_id, type: 'text', sender: { name: cfg.botName, avatar: cfg.botAvatar || undefined }, text }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.status !== 0) return { ok: false, error: json.status_message || `Viber status ${json.status}` };
  return { ok: true, externalMessageId: json.message_token ? String(json.message_token) : null };
}

async function setWebhook(prisma, url) {
  const cfg = await readCfg(prisma);
  if (!configured(cfg)) return { ok: false, error: 'Viber not configured' };
  const res = await fetch('https://chatapi.viber.com/pa/set_webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Viber-Auth-Token': cfg.authToken },
    body: JSON.stringify({ url, event_types: ['message', 'conversation_started', 'webhook'], send_name: true, send_photo: true }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.status !== 0) return { ok: false, error: json.status_message || `Viber status ${json.status}` };
  return { ok: true };
}

async function test(prisma) {
  const cfg = await readCfg(prisma);
  if (!configured(cfg)) return { ok: false, error: 'Viber auth token required' };
  const base = (process.env.PUBLIC_BASE_URL || 'https://netfactory.com.ph').replace(/\/$/, '');
  const wh = await setWebhook(prisma, base + '/api/webhooks/viber');
  if (!wh.ok) return wh;
  return { ok: true, detail: 'Webhook registered with Viber' };
}

module.exports = { type, readCfg, configured, verifyPost, parseInbound, send, setWebhook, test };
