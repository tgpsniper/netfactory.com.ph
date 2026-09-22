// ============================================================
// invoiceNumber.js — the one place invoice numbers are minted
// ============================================================
// Format: INV-YYMM#### — twelve characters, the sequence restarting each month.
// Every invoice the CRM, the portal and the prepaid top-up path create already
// looks like this; generate-invoices.js was the odd one out, building the tail
// from five random digits instead:
//
//     const rand = String(Math.floor(10000 + Math.random() * 90000));
//
// invoices.invoice_number carries a UNIQUE index, so with ~142 invoices drawn
// from 90,000 values a monthly run had roughly an 11% chance of colliding with
// itself. A collision throws, the script counts it as an error and moves on, and
// one subscriber silently goes unbilled for the month — the kind of failure
// nobody notices until the customer does. It also produced thirteen-character
// numbers that nextInvoiceNumber's `LENGTH(invoice_number) = 12` filter skips,
// so the two schemes could not even see each other's highest number.
//
// Sequential removes the birthday problem entirely. What remains is a narrow
// race: two callers reading MAX() at the same instant get the same number and
// one loses on the unique index. That is what `create` below retries, rather
// than pretending a read-then-write is atomic.
const PREFIX_LEN = 8;   // "INV-YYMM"
const SEQ_LEN    = 4;
const TOTAL_LEN  = PREFIX_LEN + SEQ_LEN;

function monthPrefix(when = new Date()) {
  const yy = String(when.getFullYear()).slice(-2);
  const mm = String(when.getMonth() + 1).padStart(2, '0');
  return `INV-${yy}${mm}`;
}

// Highest sequence already used this month, + 1. Length is pinned so a stray
// number in some other shape cannot be parsed as a sequence and jump the counter.
async function next(prisma, when = new Date()) {
  const prefix = monthPrefix(when);
  // Positions are interpolated, not bound: Prisma sends JS integers as bigint and
  // postgres has no substring(varchar, bigint, bigint), so binding them fails with
  // 42883. They are module constants, never caller input, so there is nothing to
  // inject. Only the prefix is bound.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM ${PREFIX_LEN + 1} FOR ${SEQ_LEN}) AS INTEGER)), 0) + 1 AS next_num ` +
    `FROM invoices WHERE invoice_number LIKE $1 AND LENGTH(invoice_number) = ${TOTAL_LEN}`,
    prefix + '%');
  return `${prefix}${String(rows[0].next_num).padStart(SEQ_LEN, '0')}`;
}

// Create an invoice, re-minting the number if someone else took it first.
// P2002 is Prisma's unique-constraint violation; anything else is a real error
// and is rethrown untouched.
async function create(prisma, data, { attempts = 5, when = new Date() } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const invoice_number = await next(prisma, when);
    try {
      return await prisma.invoices.create({ data: { ...data, invoice_number } });
    } catch (err) {
      const dup = err && (err.code === 'P2002' ||
        /unique/i.test(String(err.message || '')));
      if (!dup) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

module.exports = { monthPrefix, next, create, TOTAL_LEN };
