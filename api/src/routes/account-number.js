// ============================================================
// NETFACTORY — Account Number Assignment
// ============================================================
// Backs the "Change Account Number" modal in the CRM. Two ways in:
//
//   auto    — take the next number from subscriber_account_seq, formatted the
//             same way the BEFORE INSERT trigger formats it
//   manual  — type a number in, typically one carried over from the old system
//
// The account number is an identity, not a label. Several things key off it and
// would break quietly if it moved underneath them, so nothing is applied until
// it has been checked and every conflict has an answer:
//
//   • another subscriber already holding it        (blocks)
//   • a PPPoE RADIUS login keyed on the old number (rename, or the line drops)
//   • a portal password still derived from it      (rehash, or login breaks)
//   • the auto-sequence later reaching the same
//     number and colliding on the unique index     (advance the sequence)
//   • a referral record snapshotting the old value (update the snapshot)
//
// Invoices, payments, tickets and RADIUS MAC auth all key on subscribers.id and
// are unaffected — checked, not assumed.
// ============================================================

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const adminAuth = require('../middleware/adminAuth');
const radiusDb = require('../config/radius-db');
const { defaultPortalPassword } = require('../utils/generators');

// Reassigning an identity sits with the same roles that may delete a plan.
const ASSIGN_ROLES = ['superadmin', 'admin'];

const MAX_LEN = 20;                    // subscribers.account_number is varchar(20)
const HOUSE_FORMAT = /^\d{10}$/;       // YYMM + a 6-digit serial
const ALLOWED_CHARS = /^[A-Z0-9][A-Z0-9\-_]*$/;
// How far ahead of the counter a serial can be and still plausibly be one of
// ours. Beyond this the number is far likelier to be from the old system, whose
// digits are not a serial at all.
const SAFE_JUMP = 500;

const normalise = (v) => String(v == null ? '' : v).toUpperCase().trim();

const displayName = (s) =>
  (`${s.first_name || ''} ${s.last_name || ''}`.trim() || s.company_name || s.account_number);

/** The next auto number, without consuming the sequence. */
async function peekNext(prisma, createdAt) {
  const rows = await prisma.$queryRaw`
    SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END AS next
      FROM subscriber_account_seq`;
  const serial = Number(rows[0].next);
  return { number: formatAccount(createdAt, serial), serial };
}

/** Exactly what set_subscriber_account_number() builds, so auto matches the trigger. */
function formatAccount(createdAt, serial) {
  const d = createdAt ? new Date(createdAt) : new Date();
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}${mm}${String(serial).padStart(6, '0')}`;
}

/**
 * Everything that could go wrong with putting `next` on this subscriber.
 * Returns { blocking, checks[] } where each check is
 * { id, level: ok|warn|block, title, detail, fix? }.
 * `fix` names a resolution the caller can opt into at apply time.
 *
 * `sub` is null when checking a number for a subscriber who does not exist yet.
 * The checks that compare against a CURRENT number — RADIUS, portal password,
 * referrals — have nothing to compare against then, and are skipped.
 */
async function verify(prisma, sub, next, mode) {
  const checks = [];
  const current = sub ? sub.account_number : null;

  // ── Shape ──
  if (!next) {
    checks.push({ id: 'empty', level: 'block', title: 'No account number given', detail: 'Type a number, or switch to automatic assignment.' });
    return { blocking: true, checks };
  }
  if (next.length > MAX_LEN) {
    checks.push({ id: 'too_long', level: 'block', title: `Too long — ${next.length} characters`, detail: `The account number field holds at most ${MAX_LEN}.` });
  }
  if (!ALLOWED_CHARS.test(next)) {
    checks.push({ id: 'charset', level: 'block', title: 'Contains characters that are not allowed', detail: 'Use letters, digits, hyphens and underscores only, starting with a letter or digit. Spaces and punctuation are not accepted.' });
  }
  if (current && next === current) {
    checks.push({ id: 'unchanged', level: 'block', title: 'Same as the current number', detail: 'Nothing would change.' });
  }

  // ── Already in use ──
  const holder = await prisma.subscribers.findUnique({
    where: { account_number: next },
    select: { id: true, account_number: true, first_name: true, last_name: true, company_name: true, status: true },
  });
  if (holder && (!sub || holder.id !== sub.id)) {
    checks.push({
      id: 'taken', level: 'block',
      title: 'Another subscriber already has this number',
      detail: `${displayName(holder)} (${holder.status}) holds ${next}. Account numbers are unique, so this one has to be freed first or a different number used.`,
      holder: { id: holder.id, name: displayName(holder), status: holder.status },
    });
  } else {
    checks.push({ id: 'available', level: 'ok', title: 'Number is free', detail: 'No other subscriber is using it.' });
  }

  // ── House format ──
  if (!HOUSE_FORMAT.test(next)) {
    checks.push({
      id: 'format_unusual', level: 'warn',
      title: 'Not in the usual format',
      detail: 'Existing numbers are 10 digits — the two-digit year, the two-digit month, then a six-digit serial. A number in a different shape works fine, it just will not sort or read like the others.',
    });
  }

  // ── Would the auto-sequence reach this number later? ──
  // Meaningless for auto, which takes the next serial by definition — flagging it
  // there would put a warning on every routine assignment.
  if (mode !== 'auto' && HOUSE_FORMAT.test(next)) {
    const serial = Number(next.slice(4));
    const rows = await prisma.$queryRaw`
      SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END AS issued
        FROM subscriber_account_seq`;
    const issued = Number(rows[0].issued);
    if (serial > issued) {
      const jump = serial - issued;
      // A 10-digit number is not automatically one of ours. The old system used
      // YYMMDD + a 4-digit serial, which lands in the same 10 digits but means
      // something completely different — reading its tail as our 6-digit serial
      // turns 260708-2383 into "serial 82383" and would skip the counter forward
      // by eighty thousand. So the size of the jump decides whether advancing is
      // a sensible tidy-up or a mistake, and only a small one is pre-ticked.
      const looksLegacy = jump > SAFE_JUMP;
      checks.push({
        id: 'sequence_collision', level: 'warn',
        title: looksLegacy
          ? 'This does not look like one of our serial numbers'
          : 'The automatic counter has not reached this number yet',
        detail: looksLegacy
          ? `Read as one of ours this would be serial ${serial}, which is ${jump.toLocaleString()} ahead of the last one issued (${issued}) — far too big a gap to be a real serial. It is much more likely a number from the old system, where the digits mean something else. Saving it is fine. Do NOT move the counter unless you truly want the next new subscriber numbered ${formatAccount(null, serial + 1)}.`
          : `Serial ${serial} is ${jump} ahead of the last one issued (${issued}). Left alone, a future subscriber would eventually be handed this same serial and the save would fail. Moving the counter past it prevents that.`,
        fix: 'advanceSequence',
        fixLabel: looksLegacy
          ? `Move the automatic counter to ${serial} — skips ${jump.toLocaleString()} numbers`
          : `Move the automatic counter to ${serial}`,
        fixDefault: !looksLegacy,
        jump,
      });
    }
  }

  // ── PPPoE RADIUS logins keyed on the old number ──
  if (current && radiusDb) {
    try {
      const [rc] = await radiusDb.query('SELECT COUNT(*) AS c FROM radcheck WHERE username = ?', [current]);
      const [rg] = await radiusDb.query('SELECT COUNT(*) AS c FROM radusergroup WHERE username = ?', [current]);
      const n = Number(rc?.[0]?.c || 0) + Number(rg?.[0]?.c || 0);
      if (n > 0) {
        checks.push({
          id: 'radius_pppoe', level: 'warn',
          title: 'A RADIUS login uses the current number as its username',
          detail: `${n} RADIUS record${n > 1 ? 's are' : ' is'} keyed on ${current}. This subscriber authenticates by account number, not by MAC, so leaving those behind takes them off the internet at the next reconnect.`,
          fix: 'renameRadius', fixLabel: `Rename ${n} RADIUS record${n > 1 ? 's' : ''} to the new number`, fixDefault: true,
        });
      }
    } catch (err) {
      checks.push({
        id: 'radius_unreachable', level: 'warn',
        title: 'Could not check RADIUS',
        detail: 'The RADIUS tables did not answer, so whether a login is keyed on this number is unknown. Check before relying on the result.',
      });
    }
  }

  // ── Portal password still derived from the old number ──
  const auth = current ? await prisma.subscriber_auth.findFirst({
    where: { subscriber_id: sub.id }, select: { password_hash: true },
  }) : null;
  if (auth && auth.password_hash) {
    let stillDefault = false;
    try { stillDefault = await bcrypt.compare(defaultPortalPassword(current), auth.password_hash); } catch (e) { /* treat as not default */ }
    if (stillDefault) {
      checks.push({
        id: 'portal_password_default', level: 'warn',
        title: 'Portal password is still the one derived from the current number',
        detail: `Their password is the default built from ${current}. It is a stored hash, not something worked out at login, so changing the number does not change it — they would sign in with the new number and the old password, which no one would guess.`,
        fix: 'resetPortalPassword', fixLabel: 'Reset it to the default for the new number', fixDefault: true,
      });
    } else {
      checks.push({
        id: 'portal_password_custom', level: 'ok',
        title: 'Portal password is their own',
        detail: 'It is not derived from the account number, so it keeps working. Only the number they sign in with changes.',
      });
    }
  }

  // ── Referral snapshot ──
  const refs = current ? await prisma.referrals.count({ where: { referrer_account: current } }) : 0;
  if (refs > 0) {
    checks.push({
      id: 'referral_snapshot', level: 'warn',
      title: `${refs} referral record${refs > 1 ? 's record' : ' records'} the old number`,
      detail: 'Referrals keep a copy of the referrer\'s account number for history. Left alone it would still show the old value.',
      fix: 'updateReferrals', fixLabel: 'Update the referral records', fixDefault: true,
    });
  }

  // ── Things that are safe, stated rather than assumed ──
  const invoices = sub ? await prisma.invoices.count({ where: { subscriber_id: sub.id } }) : 0;
  const payments = sub ? await prisma.payments.count({ where: { subscriber_id: sub.id } }) : 0;
  if (invoices || payments) {
    checks.push({
      id: 'billing_safe', level: 'ok',
      title: `${invoices} invoice${invoices === 1 ? '' : 's'} and ${payments} payment${payments === 1 ? '' : 's'} carry over`,
      detail: 'Billing history is linked to the subscriber record itself, not to the number, so it follows them across unchanged.',
    });
  }

  return { blocking: checks.some(c => c.level === 'block'), checks };
}

// ── GET /next-new — what a brand new subscriber would be given ──
// No id yet, so the month comes from today, exactly as the trigger would take it
// from the created_at it is about to write.
router.get('/next-new', adminAuth(), async (req, res) => {
  try {
    const { number, serial } = await peekNext(req.prisma, null);
    res.json({ next: number, serial, canAssign: ASSIGN_ROLES.includes(req.admin.role) });
  } catch (err) {
    console.error('[AccountNumber] Peek (new) failed:', err);
    res.status(500).json({ error: 'Failed to work out the next number' });
  }
});

// ── POST /check-new — verify a number for a subscriber not created yet ──
router.post('/check-new', adminAuth(), async (req, res) => {
  try {
    const mode = req.body.mode === 'auto' ? 'auto' : 'manual';
    const next = mode === 'auto'
      ? (await peekNext(req.prisma, null)).number
      : normalise(req.body.accountNumber);
    const result = await verify(req.prisma, null, next, mode);
    res.json({ current: null, proposed: next, mode, ...result });
  } catch (err) {
    console.error('[AccountNumber] Check (new) failed:', err);
    res.status(500).json({ error: 'Failed to verify the number' });
  }
});

// ── GET /next — what automatic assignment would give this subscriber ──
router.get('/:id/next', adminAuth(), async (req, res) => {
  try {
    const sub = await req.prisma.subscribers.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });
    const { number, serial } = await peekNext(req.prisma, sub.created_at);
    res.json({ current: sub.account_number, next: number, serial, canAssign: ASSIGN_ROLES.includes(req.admin.role) });
  } catch (err) {
    console.error('[AccountNumber] Peek failed:', err);
    res.status(500).json({ error: 'Failed to work out the next number' });
  }
});

// ── POST /check — verify a proposed number, change nothing ──
router.post('/:id/check', adminAuth(), async (req, res) => {
  try {
    const sub = await req.prisma.subscribers.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    const mode = req.body.mode === 'auto' ? 'auto' : 'manual';
    const next = mode === 'auto'
      ? (await peekNext(req.prisma, sub.created_at)).number
      : normalise(req.body.accountNumber);

    const result = await verify(req.prisma, sub, next, mode);
    res.json({ current: sub.account_number, proposed: next, mode, ...result });
  } catch (err) {
    console.error('[AccountNumber] Check failed:', err);
    res.status(500).json({ error: 'Failed to verify the number' });
  }
});

// ── POST /apply — change it ──
router.post('/:id/apply', adminAuth(), async (req, res) => {
  try {
    if (!ASSIGN_ROLES.includes(req.admin.role)) {
      return res.status(403).json({ error: 'Only Administrators and Super Administrators can change an account number' });
    }
    const id = parseInt(req.params.id);
    const sub = await req.prisma.subscribers.findUnique({ where: { id } });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    const mode = req.body.mode === 'auto' ? 'auto' : 'manual';
    const fixes = req.body.resolutions || {};
    const current = sub.account_number;

    // Auto consumes the sequence here rather than at check time, so two admins
    // looking at the same suggestion cannot both take it.
    const next = mode === 'auto'
      ? await (async () => {
          const rows = await req.prisma.$queryRaw`SELECT nextval('subscriber_account_seq') AS v`;
          return formatAccount(sub.created_at, Number(rows[0].v));
        })()
      : normalise(req.body.accountNumber);

    // Re-verify at apply time. The check the operator saw may be minutes old and
    // someone else may have taken the number in between.
    const result = await verify(req.prisma, sub, next, mode);
    if (result.blocking) {
      return res.status(409).json({
        error: result.checks.find(c => c.level === 'block').title,
        checks: result.checks,
      });
    }

    // Anything the operator declined is recorded as declined, not silently lost.
    const applied = [];
    const declined = [];
    const wants = (fix) => {
      const c = result.checks.find(x => x.fix === fix);
      if (!c) return false;
      if (fixes[fix]) { applied.push(fix); return true; }
      declined.push(fix); return false;
    };

    const doRadius = wants('renameRadius');
    const doPassword = wants('resetPortalPassword');
    const doReferrals = wants('updateReferrals');
    const doSequence = wants('advanceSequence');

    let newPassword = null;
    if (doPassword) newPassword = defaultPortalPassword(next);

    // subscribers, referrals, subscriber_auth and the sequence are all in the
    // same database, so they move together or not at all.
    await req.prisma.$transaction(async (tx) => {
      await tx.subscribers.update({ where: { id }, data: { account_number: next } });
      if (doReferrals) {
        await tx.referrals.updateMany({ where: { referrer_account: current }, data: { referrer_account: next } });
      }
      if (doPassword) {
        const hash = await bcrypt.hash(newPassword, 12);
        await tx.subscriber_auth.updateMany({ where: { subscriber_id: id }, data: { password_hash: hash } });
      }
      if (doSequence && HOUSE_FORMAT.test(next)) {
        const serial = Number(next.slice(4));
        await tx.$executeRawUnsafe(`SELECT setval('subscriber_account_seq', ${serial}, true)`);
      }
    });

    // RADIUS goes through its own pool and cannot join that transaction, so it
    // runs after the number is safely changed. A failure here is reported rather
    // than swallowed — the operator needs to know the line is still on the old
    // username.
    let radiusWarning = null;
    if (doRadius && radiusDb) {
      try {
        await radiusDb.query('UPDATE radcheck SET username = ? WHERE username = ?', [next, current]);
        await radiusDb.query('UPDATE radusergroup SET username = ? WHERE username = ?', [next, current]);
      } catch (err) {
        radiusWarning = `The account number was changed, but the RADIUS records could not be renamed (${err.message}). They are still on ${current} and must be fixed by hand or this subscriber will drop off the network.`;
        console.error('[AccountNumber] RADIUS rename failed:', err);
      }
    }

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'account_number_changed', entity_type: 'subscribers', entity_id: id,
        details: {
          from: current, to: next, mode,
          resolutionsApplied: applied, resolutionsDeclined: declined,
          radiusRenameFailed: !!radiusWarning,
        },
        ip_address: req.ip,
      },
    }).catch(() => {});
    req.auditLog('ACCOUNT_NUMBER_CHANGE', { from: current, to: next, mode }).catch(() => {});

    res.json({
      message: `Account number changed from ${current} to ${next}`,
      from: current, to: next,
      // Returned so the operator can pass it on — the subscriber cannot work it
      // out themselves and support has no other way to see it.
      newPortalPassword: newPassword,
      applied, declined, warning: radiusWarning,
    });
  } catch (err) {
    if (err && err.code === 'P2002') {
      return res.status(409).json({ error: 'That number was taken by someone else a moment ago. Check it again and retry.' });
    }
    console.error('[AccountNumber] Apply failed:', err);
    res.status(500).json({ error: 'Failed to change the account number' });
  }
});

// Exported so POST /subscribers can run the same verification on the number a
// new subscriber is created with, rather than a second, drifting copy of it.
module.exports = router;
module.exports.verify = verify;
module.exports.normalise = normalise;
module.exports.peekNext = peekNext;
module.exports.HOUSE_FORMAT = HOUSE_FORMAT;
