// ============================================================
// routes/inbox.js — Omnichannel Unified Inbox (admin API)
// ============================================================
// Mounted at /api/admin/inbox. Conversations + messages across the
// configured channels (gmail now; viber/facebook in later phases).
// Replies go out through the channel adapter; outbound is recorded and
// broadcast live via socket.io (utils/inbox.recordOutbound).
// ============================================================

const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const channels = require('../utils/channels');
const { recordOutbound } = require('../utils/inbox');

const CHANNEL_TYPES = ['gmail', 'viber', 'facebook'];

function audit(req, action, details) {
  try { if (typeof req.auditLog === 'function') return req.auditLog(action, details || {}); } catch (e) {}
}

// ──────────── conversations ────────────

// GET /conversations?channel=&status=&assigned=&unread=&q=&page=&pageSize=
router.get('/conversations', adminAuth(), async (req, res) => {
  try {
    const { channel = '', status = '', assigned = '', unread = '', q = '' } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, parseInt(req.query.pageSize, 10) || 30);

    const where = {};
    if (status && status !== 'all') where.status = String(status);
    if (channel && channel !== 'all') {
      if (CHANNEL_TYPES.includes(channel)) where.channel = { type: channel };
      else if (/^\d+$/.test(channel)) where.channel_id = parseInt(channel, 10);
    }
    if (unread === 'true' || unread === '1') where.unread_count = { gt: 0 };
    if (assigned === 'me') where.assigned_to = req.adminId;
    else if (assigned === 'unassigned') where.assigned_to = null;
    else if (/^\d+$/.test(assigned)) where.assigned_to = parseInt(assigned, 10);
    if (q) where.OR = [
      { external_name: { contains: String(q), mode: 'insensitive' } },
      { external_user_id: { contains: String(q), mode: 'insensitive' } },
      { last_preview: { contains: String(q), mode: 'insensitive' } },
    ];

    const [total, rows] = await Promise.all([
      req.prisma.conversations.count({ where }),
      req.prisma.conversations.findMany({
        where,
        orderBy: { last_message_at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          channel: { select: { id: true, type: true, name: true } },
          subscriber: { select: { id: true, first_name: true, last_name: true, account_number: true } },
          admin: { select: { id: true, full_name: true, username: true } },
        },
      }),
    ]);
    res.json({ total, page, pageSize, conversations: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /conversations/:id (+ messages)
router.get('/conversations/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const convo = await req.prisma.conversations.findUnique({
      where: { id },
      include: {
        channel: { select: { id: true, type: true, name: true } },
        subscriber: { select: { id: true, first_name: true, last_name: true, account_number: true, email: true, phone: true, status: true } },
        admin: { select: { id: true, full_name: true, username: true } },
      },
    });
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
    const messages = await req.prisma.messages.findMany({
      where: { conversation_id: id }, orderBy: { created_at: 'asc' }, take: 500,
    });
    res.json({ conversation: convo, messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /conversations/:id/reply  { text }
router.post('/conversations/:id/reply', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const text = (req.body && req.body.text || '').toString().trim();
    if (!text) return res.status(400).json({ error: 'Message text required' });

    const convo = await req.prisma.conversations.findUnique({ where: { id }, include: { channel: true } });
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
    if (convo.status === 'closed') return res.status(409).json({ error: 'Conversation is closed' });

    const adapter = channels.get(convo.channel.type);
    if (!adapter || !adapter.send) return res.status(400).json({ error: `Channel "${convo.channel.type}" cannot send yet` });

    const sent = await adapter.send(req.prisma, { conversation: convo, text });
    if (!sent.ok) {
      // record a failed attempt so the agent sees it
      await recordOutbound(req.prisma, req.app.get('io'), convo, {
        text, channelType: convo.channel.type, status: 'failed', error: sent.error, createdBy: req.admin.username,
      });
      return res.status(422).json({ error: sent.error || 'Send failed' });
    }
    const msg = await recordOutbound(req.prisma, req.app.get('io'), convo, {
      text, channelType: convo.channel.type, status: 'sent',
      externalMessageId: sent.externalMessageId || null, createdBy: req.admin.username,
    });
    // sending implicitly reads the thread, so clear unread
    await req.prisma.conversations.update({ where: { id }, data: { unread_count: 0 } }).catch(() => {});
    audit(req, 'INBOX_REPLY', { conversationId: id, channel: convo.channel.type });
    res.json({ ok: true, message: msg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /conversations/:id  { status?, assigned_to?, mark_read?, subscriber_id? }
router.patch('/conversations/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = {};
    const b = req.body || {};
    if (b.status && ['open', 'pending', 'closed'].includes(b.status)) data.status = b.status;
    if (b.mark_read) data.unread_count = 0;
    if (Object.prototype.hasOwnProperty.call(b, 'assigned_to')) {
      data.assigned_to = b.assigned_to == null ? null : parseInt(b.assigned_to, 10);
    }
    if (Object.prototype.hasOwnProperty.call(b, 'subscriber_id')) {
      data.subscriber_id = b.subscriber_id == null ? null : parseInt(b.subscriber_id, 10);
    }
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update' });
    data.updated_at = new Date();
    const convo = await req.prisma.conversations.update({ where: { id }, data });
    audit(req, 'INBOX_CONVERSATION_UPDATE', { conversationId: id, changes: Object.keys(data) });
    res.json({ ok: true, conversation: convo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ──────────── channels ────────────

router.get('/channels', adminAuth(), async (req, res) => {
  try {
    const rows = await req.prisma.message_channels.findMany({ orderBy: { id: 'asc' } });
    // unread totals per channel for badges
    const counts = await req.prisma.conversations.groupBy({
      by: ['channel_id'], _sum: { unread_count: true },
    }).catch(() => []);
    const unreadByChannel = {};
    for (const c of counts) unreadByChannel[c.channel_id] = c._sum.unread_count || 0;
    res.json({ channels: rows.map(c => ({ ...c, unread: unreadByChannel[c.id] || 0 })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /channels  { type, name } — create (or return existing) a channel row
router.post('/channels', adminAuth(), async (req, res) => {
  try {
    const { type, name } = req.body || {};
    if (!CHANNEL_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid channel type' });
    let row = await req.prisma.message_channels.findFirst({ where: { type } });
    if (row) {
      row = await req.prisma.message_channels.update({ where: { id: row.id }, data: { name: name || row.name, updated_at: new Date() } });
    } else {
      row = await req.prisma.message_channels.create({ data: { type, name: name || type, enabled: false } });
    }
    audit(req, 'INBOX_CHANNEL_SAVE', { type });
    res.json({ ok: true, channel: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /channels/:id  { enabled?, name? }
router.patch('/channels/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = { updated_at: new Date() };
    if (Object.prototype.hasOwnProperty.call(req.body, 'enabled')) data.enabled = !!req.body.enabled;
    if (req.body.name) data.name = String(req.body.name);
    const row = await req.prisma.message_channels.update({ where: { id }, data });
    audit(req, 'INBOX_CHANNEL_UPDATE', { id, changes: Object.keys(data) });
    res.json({ ok: true, channel: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /channels/:id/webhook-url — URL to paste into Meta/Viber
router.get('/channels/:id/webhook-url', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await req.prisma.message_channels.findUnique({ where: { id } });
    if (!row) return res.status(404).json({ error: 'Channel not found' });
    const base = (process.env.PUBLIC_BASE_URL || `https://${req.get('host')}`).replace(/\/$/, '');
    const map = {
      facebook: `${base}/api/webhooks/facebook`,
      viber: `${base}/api/webhooks/viber`,
      gmail: 'n/a — Gmail uses IMAP polling (no webhook)',
    };
    res.json({ type: row.type, webhookUrl: map[row.type] || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /channels/:id/test — connectivity/credential test
router.post('/channels/:id/test', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await req.prisma.message_channels.findUnique({ where: { id } });
    if (!row) return res.status(404).json({ error: 'Channel not found' });
    const adapter = channels.get(row.type);
    if (!adapter || !adapter.test) return res.status(400).json({ error: `No test for "${row.type}" yet` });
    const result = await adapter.test(req.prisma, row);
    await req.prisma.message_channels.update({
      where: { id }, data: { status: result.ok ? 'connected' : 'error', status_detail: result.ok ? (result.detail || null) : (result.error || 'failed'), updated_at: new Date() },
    });
    audit(req, 'INBOX_CHANNEL_TEST', { id, type: row.type, ok: result.ok });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
