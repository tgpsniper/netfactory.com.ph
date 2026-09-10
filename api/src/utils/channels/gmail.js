// ============================================================
// channels/gmail.js — Gmail two-way (IMAP poll inbound + SMTP reply)
// ============================================================
// Inbound is parsed inside the IMAP poller (jobs/inbox-gmail-poll.js),
// which calls ingestInbound directly. Outbound replies reuse the
// existing nodemailer SMTP config and set In-Reply-To/References so the
// reply lands in the same Gmail thread.
// ============================================================

const email = require('../../config/email');

const type = 'gmail';

async function readCfg(prisma) {
  const rows = await prisma.system_settings.findMany({
    where: { key: { in: ['gmail_imap_user', 'gmail_imap_password', 'gmail_imap_host', 'gmail_imap_port'] } },
  });
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  return {
    user: m.gmail_imap_user || '',
    pass: m.gmail_imap_password || '',
    host: m.gmail_imap_host || 'imap.gmail.com',
    port: parseInt(m.gmail_imap_port || '993', 10),
  };
}

function configured(cfg) { return !!(cfg.user && cfg.pass); }

// Send a reply on an existing conversation (threaded).
async function send(prisma, { conversation, text }) {
  const to = conversation.external_user_id;
  if (!to) return { ok: false, error: 'No recipient email on conversation' };
  const baseSubject = conversation.subject || 'your message';
  const subject = /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`;
  const ref = conversation.thread_ref || undefined;
  const res = await email.sendWithPrisma(prisma, {
    to,
    subject,
    text,
    html: String(text || '').replace(/\n/g, '<br>'),
    inReplyTo: ref,
    references: ref,
  });
  if (!res.ok) return { ok: false, error: res.error || res.reason || 'SMTP send failed' };
  return { ok: true, externalMessageId: res.messageId };
}

// Quick connectivity test — open IMAP, list INBOX, close.
async function test(prisma) {
  const cfg = await readCfg(prisma);
  if (!configured(cfg)) return { ok: false, error: 'Gmail IMAP not configured (user + app password required)' };
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    lock.release();
    await client.logout();
    return { ok: true, detail: `Connected as ${cfg.user}` };
  } catch (e) {
    try { await client.close(); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

module.exports = { type, readCfg, configured, send, test };
