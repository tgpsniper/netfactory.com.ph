// ============================================================
// utils/inbox.js — shared omnichannel ingest pipeline
// ============================================================
// Used by both the public webhooks (Facebook/Viber) and the Gmail
// IMAP poller. Normalises an inbound message into a conversation +
// message, links the subscriber when possible, and emits a live
// socket event to the 'admins' room (same pattern as the 3CX webhook).
// ============================================================

function emitInbox(io, payload) {
  try { if (io) io.to('admins').emit('inbox_message', payload); } catch (e) { /* non-fatal */ }
}

// Match an inbound sender to a CRM subscriber.
//  - gmail: by unique email
//  - facebook/viber: no contact info in the payload by default → null
//    (agent links manually; if a phone is ever resolved, match endsWith)
async function matchSubscriber(prisma, channelType, n) {
  try {
    if (channelType === 'gmail' && n.externalUserId) {
      const sub = await prisma.subscribers.findFirst({
        where: { email: { equals: n.externalUserId, mode: 'insensitive' } },
        select: { id: true },
      });
      return sub ? sub.id : null;
    }
    if (n.phone) {
      const digits = String(n.phone).replace(/\D/g, '');
      const last10 = digits.slice(-10);
      if (last10.length >= 7) {
        const sub = await prisma.subscribers.findFirst({
          where: { phone: { endsWith: last10 } }, select: { id: true },
        });
        return sub ? sub.id : null;
      }
    }
  } catch (e) { /* matching is best-effort */ }
  return null;
}

function previewOf(n) {
  const base = n.text || (Array.isArray(n.attachments) && n.attachments.length ? '[attachment]' : '');
  return String(base || '').slice(0, 280);
}

// normalized (n): { externalUserId, externalName?, externalAvatar?, externalMessageId?,
//                   text?, attachments?, subject?, threadRef?, phone?, timestamp? }
async function ingestInbound(prisma, io, channel, n) {
  if (!n || !n.externalUserId) return { skipped: true };

  // Idempotency — webhooks/poller may resend the same message.
  if (n.externalMessageId) {
    const dup = await prisma.messages.findFirst({
      where: { external_message_id: n.externalMessageId, direction: 'in' },
      select: { id: true },
    });
    if (dup) return { duplicate: true, messageId: dup.id };
  }

  const now = n.timestamp ? new Date(n.timestamp) : new Date();
  const preview = previewOf(n);

  let convo = await prisma.conversations.findUnique({
    where: { channel_id_external_user_id: { channel_id: channel.id, external_user_id: n.externalUserId } },
  });

  if (convo) {
    const patch = {
      unread_count: { increment: 1 },
      last_message_at: now, last_preview: preview, last_direction: 'in', updated_at: new Date(),
    };
    if (n.externalName) patch.external_name = n.externalName;
    if (n.externalAvatar) patch.external_avatar = n.externalAvatar;
    if (n.subject) patch.subject = String(n.subject).slice(0, 500);
    if (n.threadRef) patch.thread_ref = n.threadRef;
    if (!convo.subscriber_id) {
      const sid = await matchSubscriber(prisma, channel.type, n);
      if (sid) patch.subscriber_id = sid;
    }
    convo = await prisma.conversations.update({ where: { id: convo.id }, data: patch });
  } else {
    const sid = await matchSubscriber(prisma, channel.type, n);
    convo = await prisma.conversations.create({
      data: {
        channel_id: channel.id,
        external_user_id: n.externalUserId,
        external_name: n.externalName || null,
        external_avatar: n.externalAvatar || null,
        subject: n.subject ? String(n.subject).slice(0, 500) : null,
        subscriber_id: sid,
        status: 'open',
        last_message_at: now, last_preview: preview, last_direction: 'in',
        unread_count: 1,
        thread_ref: n.threadRef || null,
      },
    });
  }

  const msg = await prisma.messages.create({
    data: {
      conversation_id: convo.id,
      direction: 'in',
      body: n.text || null,
      attachments: Array.isArray(n.attachments) ? n.attachments : [],
      external_message_id: n.externalMessageId || null,
      status: 'received',
      created_by: null,
      created_at: now,
    },
  });

  emitInbox(io, {
    conversationId: convo.id, channelId: channel.id, channelType: channel.type,
    direction: 'in', preview, externalName: convo.external_name,
    unreadCount: convo.unread_count, subscriberId: convo.subscriber_id, at: now,
  });

  return { conversationId: convo.id, messageId: msg.id };
}

// Record an outbound reply (already sent via the channel adapter).
// m: { text?, attachments?, externalMessageId?, status?, error?, createdBy?, channelType? }
async function recordOutbound(prisma, io, conversation, m) {
  const now = new Date();
  const preview = String(m.text || '').slice(0, 280);
  const msg = await prisma.messages.create({
    data: {
      conversation_id: conversation.id,
      direction: 'out',
      body: m.text || null,
      attachments: Array.isArray(m.attachments) ? m.attachments : [],
      external_message_id: m.externalMessageId || null,
      status: m.status || 'sent',
      error_detail: m.error || null,
      created_by: m.createdBy || null,
      created_at: now,
    },
  });
  await prisma.conversations.update({
    where: { id: conversation.id },
    data: { last_message_at: now, last_preview: preview, last_direction: 'out', updated_at: now },
  });
  emitInbox(io, {
    conversationId: conversation.id, channelType: m.channelType, direction: 'out',
    preview, at: now,
  });
  return msg;
}

module.exports = { ingestInbound, recordOutbound, matchSubscriber, emitInbox };
