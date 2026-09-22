const express = require('express');
const { recordArPayment } = require('../utils/receipts');
const router = express.Router();

// ============================================================
// Netfactory — Subscriber Credits API
// Routes: /api/admin/credits/...
// ============================================================

// Middleware: admin auth (reuse from parent)
function adminAuth() {
  return (req, res, next) => {
    // Same pattern as admin.js — JWT check is done by parent middleware
    const jwt = require('jsonwebtoken');
    const token = req.headers.authorization?.split(' ')[1] || req.query.token;
    if (!token) return res.status(401).json({ error: 'Token required' });
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'j2-network-secret');
      req.adminId = decoded.id || decoded.adminId;
      next();
    } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
  };
}

// ============================================
// GET /api/admin/credits/summary — All subscribers with credit balance
// ============================================
router.get('/summary', adminAuth(), async (req, res) => {
  try {
    const rows = await req.prisma.$queryRaw`
      SELECT s.id, s.account_number, s.first_name, s.last_name, s.email, s.phone,
             COALESCE(s.credit_balance, 0) AS credit_balance,
             (SELECT COUNT(*) FROM subscriber_credits WHERE subscriber_id = s.id) AS credit_entries
      FROM subscribers s
      WHERE COALESCE(s.credit_balance, 0) > 0
      ORDER BY s.credit_balance DESC
    `;
    res.json(rows.map(r => ({
      ...r,
      credit_balance: Number(r.credit_balance),
      credit_entries: Number(r.credit_entries),
      name: `${r.first_name} ${r.last_name}`.trim()
    })));
  } catch (err) {
    console.error('Credits summary error:', err);
    res.status(500).json({ error: 'Failed to load credits summary' });
  }
});

// ============================================
// GET /api/admin/credits/:subscriberId — Credit history for a subscriber
// ============================================
router.get('/:subscriberId', adminAuth(), async (req, res) => {
  try {
    const subscriberId = parseInt(req.params.subscriberId);

    const sub = await req.prisma.subscribers.findUnique({ where: { id: subscriberId } });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    const credits = await req.prisma.$queryRaw`
      SELECT sc.*, 
             p.reference_number AS payment_ref, p.method AS payment_method,
             i.invoice_number AS applied_to_invoice
      FROM subscriber_credits sc
      LEFT JOIN payments p ON p.id = sc.source_payment_id
      LEFT JOIN invoices i ON i.id = sc.applied_invoice_id
      WHERE sc.subscriber_id = ${subscriberId}
      ORDER BY sc.created_at DESC
    `;

    res.json({
      subscriberId,
      accountNumber: sub.account_number,
      name: `${sub.first_name} ${sub.last_name}`.trim(),
      creditBalance: Number(sub.credit_balance || 0),
      history: credits.map(c => ({
        id: c.id,
        type: c.type,
        amount: Number(c.amount),
        runningBalance: Number(c.running_balance),
        paymentRef: c.payment_ref,
        paymentMethod: c.payment_method,
        appliedToInvoice: c.applied_to_invoice,
        notes: c.notes,
        createdBy: c.created_by,
        createdAt: c.created_at
      }))
    });
  } catch (err) {
    console.error('Credit history error:', err);
    res.status(500).json({ error: 'Failed to load credit history' });
  }
});

// ============================================
// POST /api/admin/credits/:subscriberId/adjust — Manual credit adjustment
// ============================================
router.post('/:subscriberId/adjust', adminAuth(), async (req, res) => {
  try {
    const subscriberId = parseInt(req.params.subscriberId);
    const { amount, notes } = req.body;

    if (!amount || amount === 0) return res.status(400).json({ error: 'Amount required (positive to add, negative to deduct)' });

    const sub = await req.prisma.subscribers.findUnique({ where: { id: subscriberId } });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    const currentCredit = Number(sub.credit_balance || 0);
    const adjustAmount = parseFloat(amount);

    if (adjustAmount < 0 && Math.abs(adjustAmount) > currentCredit) {
      return res.status(400).json({ error: `Cannot deduct more than available credit (${currentCredit})` });
    }

    const type = adjustAmount > 0 ? 'manual_add' : 'manual_deduct';

    // Atomic adjust (never below zero); returns authoritative post-update balance
    const adjUpd = await req.prisma.$queryRaw`
      UPDATE subscribers SET credit_balance = ROUND(GREATEST(COALESCE(credit_balance, 0) + ${adjustAmount}::numeric, 0), 2) WHERE id = ${subscriberId} RETURNING credit_balance
    `;
    const newBalance = Number(adjUpd[0].credit_balance);

    await req.prisma.$queryRaw`
      INSERT INTO subscriber_credits (subscriber_id, type, amount, running_balance, notes, created_by)
      VALUES (${subscriberId}, ${type}, ${adjustAmount}, ${newBalance},
              ${notes || (type === 'manual_add' ? 'Manual credit added' : 'Manual credit deducted')},
              ${'admin-' + req.adminId})
    `;

    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'credit_adjusted', entity_type: 'subscribers', entity_id: subscriberId,
        details: { type, amount: adjustAmount, previousBalance: currentCredit, newBalance, notes },
        ip_address: req.ip
      }
    });

    res.json({
      message: `Credit ${type === 'manual_add' ? 'added' : 'deducted'} successfully`,
      previousBalance: currentCredit,
      adjustment: adjustAmount,
      newBalance
    });
  } catch (err) {
    console.error('Credit adjustment error:', err);
    res.status(500).json({ error: 'Failed to adjust credit' });
  }
});

// ============================================
// POST /api/admin/credits/:subscriberId/apply — Apply credit to specific invoice
// ============================================
router.post('/:subscriberId/apply', adminAuth(), async (req, res) => {
  try {
    const subscriberId = parseInt(req.params.subscriberId);
    const { invoiceId, amount } = req.body;

    if (!invoiceId) return res.status(400).json({ error: 'invoiceId required' });

    const sub = await req.prisma.subscribers.findUnique({ where: { id: subscriberId } });
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    const currentCredit = Number(sub.credit_balance || 0);
    if (currentCredit <= 0) return res.status(400).json({ error: 'No credit available' });

    const invoice = await req.prisma.invoices.findUnique({ where: { id: parseInt(invoiceId) } });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.subscriber_id !== subscriberId) return res.status(400).json({ error: 'Invoice does not belong to this subscriber' });
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });

    // Calculate how much is still owed on this invoice
    const existingPayments = await req.prisma.payments.aggregate({
      where: { invoice_id: invoice.id, status: 'success' },
      _sum: { amount: true }
    });
    const previouslyPaid = Number(existingPayments._sum.amount || 0);
    const remainingBalance = Number(invoice.amount) - previouslyPaid;

    if (remainingBalance <= 0) return res.status(400).json({ error: 'Invoice has no remaining balance' });

    // Determine how much credit to apply.
    // Absence and zero are separated deliberately: 0 is falsy, so `amount ? ... : ...`
    // treated "apply 0" as "apply everything available". Same defect as the payment
    // endpoint, same consequence — an invoice settled that nobody meant to settle.
    const amountOmitted = amount === undefined || amount === null || String(amount).trim() === '';
    let creditToApply = amountOmitted
      ? Math.min(currentCredit, remainingBalance)
      : Number(String(amount).trim());

    if (!Number.isFinite(creditToApply)) {
      return res.status(400).json({ error: 'Credit amount must be a number' });
    }
    if (creditToApply <= 0) {
      return res.status(400).json({ error: 'Credit amount must be greater than 0. Leave it blank to apply as much credit as the invoice allows.' });
    }
    creditToApply = Math.min(creditToApply, currentCredit, remainingBalance);

    const totalAfterCredit = previouslyPaid + creditToApply;
    const newInvoiceStatus = totalAfterCredit >= Number(invoice.amount) ? 'paid' : 'partial';
    let newCreditBalance = +(currentCredit - creditToApply).toFixed(2);

    // 1. Create payment record
    await req.prisma.payments.create({
      data: {
        invoice_id: invoice.id,
        subscriber_id: subscriberId,
        amount: creditToApply,
        method: 'credit',
        reference_number: 'CREDIT-' + invoice.invoice_number,
        status: 'success',
        paid_at: new Date()
      }
    });

    // 2. Update invoice status
    await req.prisma.invoices.update({
      where: { id: invoice.id },
      data: { status: newInvoiceStatus }
    });

    // 3. Decrease subscriber balance
    await req.prisma.subscribers.update({
      where: { id: subscriberId },
      data: { balance: { decrement: creditToApply } }
    });

    // 4. Update credit_balance — atomic, returns authoritative post-update balance
    const credUpd = await req.prisma.$queryRaw`
      UPDATE subscribers SET credit_balance = ROUND(GREATEST(COALESCE(credit_balance, 0) - ${creditToApply}::numeric, 0), 2) WHERE id = ${subscriberId} RETURNING credit_balance
    `;
    newCreditBalance = Number(credUpd[0].credit_balance);

    // 5. Record credit entry
    await req.prisma.$queryRaw`
      INSERT INTO subscriber_credits (subscriber_id, type, amount, running_balance, applied_invoice_id, notes, created_by)
      VALUES (${subscriberId}, 'applied', ${-creditToApply}, ${newCreditBalance}, ${invoice.id},
              ${'Applied to invoice ' + invoice.invoice_number},
              ${'admin-' + req.adminId})
    `;

    // 6. Sync to AR
    try {
      let arRecord = await req.prisma.$queryRaw`
        SELECT id FROM accounts_receivable WHERE billing_invoice_id = ${invoice.id} LIMIT 1
      `;
      if (arRecord.length > 0) {
        await recordArPayment(req.prisma, {
          arId: arRecord[0].id,
          amount: creditToApply,
          method: 'credit',
          referenceNumber: 'CREDIT-' + invoice.invoice_number,
          notes: 'Credit applied to ' + invoice.invoice_number,
          receivedBy: 'admin-' + req.adminId,
        });
      }
    } catch (arErr) { console.error('Credit apply AR sync error:', arErr.message); }

    // 7. Audit log
    await req.prisma.audit_log.create({
      data: {
        user_type: 'admin', user_id: req.adminId,
        action: 'credit_applied', entity_type: 'invoices', entity_id: invoice.id,
        details: { subscriberId, invoiceNumber: invoice.invoice_number, creditApplied: creditToApply, previousCredit: currentCredit, newCreditBalance, newInvoiceStatus },
        ip_address: req.ip
      }
    });

    res.json({
      message: `Credit applied - Invoice ${newInvoiceStatus === 'paid' ? 'fully paid' : 'partially paid'}`,
      creditApplied: creditToApply,
      previousCredit: currentCredit,
      newCreditBalance,
      invoiceNumber: invoice.invoice_number,
      invoiceStatus: newInvoiceStatus,
      invoiceRemaining: Number(invoice.amount) - totalAfterCredit
    });
  } catch (err) {
    console.error('Credit apply error:', err);
    res.status(500).json({ error: 'Failed to apply credit' });
  }
});

module.exports = router;
