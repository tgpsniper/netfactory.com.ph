// ============================================================
// jobs/inbox-gmail-poll.js — Gmail inbound poller
// ============================================================
// Polls the configured Gmail mailbox over IMAP for UNSEEN messages,
// parses them, and ingests each into the unified inbox. No-op until a
// 'gmail' channel row exists and is enabled. Replies go out via SMTP
// (channels/gmail.js). Marks messages \Seen after successful ingest.
// ============================================================

const { ingestInbound } = require('../utils/inbox');
const gmail = require('../utils/channels/gmail');

function stripHtml(h) {
  return String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = {
  name: 'inbox-gmail-poll',
  schedule: '*/2 * * * *',
  async run(prisma, io) {
    const channel = await prisma.message_channels.findFirst({ where: { type: 'gmail', enabled: true } });
    if (!channel) return; // not configured yet — silent no-op

    const cfg = await gmail.readCfg(prisma);
    if (!gmail.configured(cfg)) return;

    const { ImapFlow } = require('imapflow');
    const { simpleParser } = require('mailparser');
    const client = new ImapFlow({
      host: cfg.host, port: cfg.port, secure: true,
      auth: { user: cfg.user, pass: cfg.pass }, logger: false,
    });

    let processed = 0;
    let errored = null;
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ seen: false }, { uid: true });
        if (uids && uids.length) {
          for await (const m of client.fetch(uids, { source: true }, { uid: true })) {
            try {
              const parsed = await simpleParser(m.source);
              const from = parsed.from && parsed.from.value && parsed.from.value[0];
              if (!from || !from.address) continue;
              const attachments = (parsed.attachments || []).map(a => ({
                type: 'file', name: a.filename || 'attachment', mime: a.contentType, size: a.size,
              }));
              await ingestInbound(prisma, io, channel, {
                externalUserId: String(from.address).toLowerCase(),
                externalName: from.name || from.address,
                externalMessageId: parsed.messageId || null,
                text: parsed.text || stripHtml(parsed.html) || '',
                attachments,
                subject: parsed.subject || '',
                threadRef: parsed.messageId || null,
                timestamp: parsed.date || new Date(),
              });
              await client.messageFlagsAdd(m.uid, ['\\Seen'], { uid: true });
              processed++;
            } catch (e) {
              // leave this message UNSEEN so it retries next poll
            }
          }
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (e) {
      errored = e.message;
      try { await client.close(); } catch (_) {}
    }

    await prisma.message_channels.update({
      where: { id: channel.id },
      data: { last_polled_at: new Date(), status: errored ? 'error' : 'connected', status_detail: errored || null },
    }).catch(() => {});

    if (processed) console.log(`[inbox-gmail-poll] ingested ${processed} message(s)`);
  },
};
