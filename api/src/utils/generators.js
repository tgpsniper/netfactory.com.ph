const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * NOT IN USE. Live account numbers (e.g. 2608000522) are produced by a database
 * trigger, not by this function — nothing in src/ calls it. It is kept only so
 * the export surface does not change, and deliberately no longer emits the old
 * "J2-YYYY-NNNN" shape, which would conflict with the real numbering scheme.
 */
async function generateAccountNumber() {
  const year = new Date().getFullYear();
  const last = await prisma.subscribers.findFirst({
    where: { account_number: { startsWith: `${year}-` } },
    orderBy: { account_number: 'desc' },
    select: { account_number: true }
  });

  let seq = 1;
  if (last) {
    // Dropping the "J2-" prefix moved the sequence from index 2 to index 1.
    const parts = last.account_number.split('-');
    seq = parseInt(parts[1], 10) + 1;
  }

  return `${year}-${String(seq).padStart(4, '0')}`;
}

/**
 * Generate next invoice number: INV-YYYY-NNNN
 */
async function generateInvoiceNumber() {
  const year = new Date().getFullYear();
  const last = await prisma.invoices.findFirst({
    where: { invoice_number: { startsWith: `INV-${year}` } },
    orderBy: { invoice_number: 'desc' },
    select: { invoice_number: true }
  });

  let seq = 1;
  if (last) {
    const parts = last.invoice_number.split('-');
    seq = parseInt(parts[2]) + 1;
  }

  return `INV-${year}-${String(seq).padStart(4, '0')}`;
}

/**
 * Generate next ticket number: TK-YYYY-NNNN
 */
async function generateTicketNumber() {
  const year = new Date().getFullYear();
  const last = await prisma.tickets.findFirst({
    where: { ticket_number: { startsWith: `TK-${year}` } },
    orderBy: { ticket_number: 'desc' },
    select: { ticket_number: true }
  });

  let seq = 1;
  if (last) {
    const parts = last.ticket_number.split('-');
    seq = parseInt(parts[2]) + 1;
  }

  return `TK-${year}-${String(seq).padStart(4, '0')}`;
}

/**
 * Default portal password handed to a subscriber on activation: nf + last 4
 * digits of the account number.
 *
 * This used to be spelled inline in three places in admin.js, which meant the
 * value that gets hashed and the value quoted in the welcome message could
 * drift apart. Both now come from here, so they cannot.
 *
 * Prefix history: "j2net####", then "nfnet####" — that second one was a rename
 * of j2 to nf that left the "net" behind, which is why it never matched the
 * "nf + last 4" this comment always described. It is now plain "nf####".
 * Changing it does NOT change anyone's password: existing bcrypt hashes are
 * untouched, so a subscriber still on an older default keeps that older value
 * until it is reset. Only accounts created or activated from here on get "nf####".
 */
const PORTAL_PASSWORD_PREFIX = 'nf';

function defaultPortalPassword(accountNumber) {
  return PORTAL_PASSWORD_PREFIX + String(accountNumber || '').slice(-4);
}

module.exports = {
  generateAccountNumber, generateInvoiceNumber, generateTicketNumber,
  defaultPortalPassword, PORTAL_PASSWORD_PREFIX,
};
