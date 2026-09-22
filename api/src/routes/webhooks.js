const express = require('express');
const router = express.Router();
const { generateInvoicePDF } = require('../utils/invoicePdf');
// Tolerant load, matching admin.js: a deployment without the RADIUS side must still be
// able to take money.
let radiusDb, restriction;
try { radiusDb = require('../config/radius-db'); } catch (e) { radiusDb = null; }
try { restriction = require('../utils/restriction'); }
catch (e) { restriction = { restoreIfSettled: async () => ({ restored: false, reason: 'restriction module unavailable' }) }; }
let prepaid;
try { prepaid = require('../utils/prepaid'); }
catch (e) { prepaid = null; }
const { getCompany } = require('../utils/company');
const { getPrefs } = require('../utils/notifPrefs');

const METHOD_LABELS = {
  cash: 'Cash', gcash: 'GCash', maya: 'Maya', paymaya: 'Maya',
  xendit: 'Online (Xendit)', bank_transfer: 'Bank Transfer',
  credit: 'Credit Applied', check: 'Check', online: 'Online Payment',
  '7-eleven': '7-Eleven', bayad_center: 'Bayad Center',
  credit_card: 'Credit Card',
};

// ============================================
// AR Sync Helper — Create/update Accounts Receivable entry
// ============================================
async function syncToAR(prisma, invoice, payAmount, method, referenceNumber, adminId) {
  try {
    const arRecord = await prisma.$queryRaw`
      SELECT id FROM accounts_receivable WHERE billing_invoice_id = ${invoice.id} LIMIT 1
    `;

    let arId;
    if (arRecord.length === 0) {
      const subscriberName = (invoice.subscriber.first_name + ' ' + invoice.subscriber.last_name).trim();
      const subscriberAddress = [invoice.subscriber.address, invoice.subscriber.barangay, invoice.subscriber.municipality].filter(Boolean).join(', ');
      const invoiceAmount = Number(invoice.amount);

      const newAr = await prisma.$queryRaw`
        INSERT INTO accounts_receivable 
          (invoice_number, subscriber_id, customer_name, customer_address, invoice_date, due_date, total_amount, amount_paid, category, description, billing_invoice_id, created_by)
        VALUES 
          (${invoice.invoice_number}, ${invoice.subscriber_id}, ${subscriberName}, ${subscriberAddress || ''}, 
           ${new Date(invoice.created_at)}::date, 
           ${invoice.due_date ? new Date(invoice.due_date) : new Date()}::date, 
           ${invoiceAmount}, 0, 'subscription', 
           ${'Billing invoice ' + invoice.invoice_number}, ${invoice.id}, ${adminId || 'system'})
        RETURNING id
      `;
      arId = newAr[0].id;
    } else {
      arId = arRecord[0].id;
    }

    const countResult = await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM ar_payments`;
    const payNum = 'RCV-' + String((countResult[0].count || 0) + 1).padStart(6, '0');

    await prisma.$queryRaw`
      INSERT INTO ar_payments (payment_number, ar_id, payment_date, amount, payment_method, reference_number, notes, received_by)
      VALUES (${payNum}, ${arId}, CURRENT_DATE, ${payAmount}, ${method}, ${referenceNumber || null}, 
              ${'Payment via webhook - ' + invoice.invoice_number}, ${adminId || 'system'})
    `;
    return arId;
  } catch (arErr) {
    console.error('AR sync error (payment still recorded):', arErr.message);
    return null;
  }
}

// ============================================
// Payment webhook handler (shared logic)
// ============================================
async function processPayment(prisma, config, { invoiceNumber, amount, method, referenceNumber, status, rawResponse }) {
  const invoice = await prisma.invoices.findUnique({
    where: { invoice_number: invoiceNumber },
    include: { subscriber: true }
  });

  if (!invoice) {
    console.error(`Webhook: Invoice ${invoiceNumber} not found`);
    return { success: false, error: 'Invoice not found' };
  }

  const payment = await prisma.payments.create({
    data: {
      invoice_id: invoice.id,
      subscriber_id: invoice.subscriber_id,
      amount: parseFloat(amount),
      method,
      reference_number: referenceNumber || null,
      status: status === 'success' ? 'success' : 'pending',
      gateway_response: rawResponse || null,
      paid_at: status === 'success' ? new Date() : null
    }
  });

  if (status === 'success') {
    const totalPaid = await prisma.payments.aggregate({
      where: { invoice_id: invoice.id, status: 'success' },
      _sum: { amount: true }
    });

    const paidAmount = Number(totalPaid._sum.amount || 0);
    const invoiceTotal = Number(invoice.amount);
    const newStatus = paidAmount >= invoiceTotal ? 'paid' : 'partial';

    await prisma.invoices.update({
      where: { id: invoice.id },
      data: { status: newStatus }
    });

    await syncToAR(prisma, invoice, parseFloat(amount), method, referenceNumber, 'webhook');

    await prisma.subscribers.update({
      where: { id: invoice.subscriber_id },
      data: { balance: { decrement: parseFloat(amount) } }
    });

    await prisma.notifications.create({
      data: {
        type: 'success',
        title: `Payment received: ${invoice.subscriber.first_name}${invoice.subscriber.middle_name ? ' ' + invoice.subscriber.middle_name : ''} ${invoice.subscriber.last_name}`,
        message: `P${parseFloat(amount).toLocaleString()} via ${method} for ${invoice.invoice_number}`,
        target_type: 'admin'
      }
    });

    await prisma.audit_log.create({
      data: {
        user_type: 'subscriber',
        user_id: invoice.subscriber_id,
        action: 'payment_received',
        entity_type: 'payments',
        entity_id: payment.id,
        details: { invoice: invoiceNumber, amount, method, reference: referenceNumber }
      }
    });

    const invoiceAmt = Number(invoice.amount);
    const paidAmt = parseFloat(amount);
    const notifOverpay = Math.max(0, paidAmt - invoiceAmt);
    const methodLabel = METHOD_LABELS[method?.toLowerCase()] || method || 'Online Payment';
    const co = await getCompany(prisma).catch(() => null);
    const prefs = await getPrefs(prisma, invoice.subscriber_id);

    if (prefs.emailBilling && invoice.subscriber.email && config?.email) {
      const pdfBuffer = await generateInvoicePDF(prisma, invoice.id)
        .catch(e => { console.error('[EMAIL] PDF gen failed:', e.message); return null; });
      const attachments = pdfBuffer
        ? [{ filename: `Invoice-${invoice.invoice_number}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
        : undefined;
      config.email.sendTemplateWithPrisma(prisma, invoice.subscriber.email, 'payment_received', {
        name: invoice.subscriber.first_name,
        amount: `P${invoiceAmt.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        amountReceived: paidAmt !== invoiceAmt ? `P${paidAmt.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null,
        overpayment: notifOverpay > 0 ? `P${notifOverpay.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null,
        invoiceNumber: invoice.invoice_number,
        method: methodLabel,
        date: new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }),
        reference: referenceNumber || 'N/A',
      }, co, attachments).catch(err => console.error('[EMAIL] Payment confirmation failed:', err.message));
    }

    if (prefs.smsPayment && invoice.subscriber.phone && config?.sms) {
      config.sms.sendTemplateWithPrisma(prisma, invoice.subscriber.phone, 'payment_received', {
        amount: `P${invoiceAmt.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        invoiceNumber: invoice.invoice_number,
        reference: referenceNumber || method,
        overpayment: notifOverpay > 0 ? `P${notifOverpay.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null,
      }).catch(err => console.error('[SMS] Payment confirmation failed:', err.message));
    }

    if (invoice.subscriber.status === 'suspended') {
      const remainingBalance = Number(invoice.subscriber.balance) - parseFloat(amount);
      if (remainingBalance <= 0) {
        await prisma.subscribers.update({
          where: { id: invoice.subscriber_id },
          data: { status: 'active', balance: 0 }
        });

        await prisma.notifications.create({
          data: {
            type: 'success',
            title: `Account reactivated: ${invoice.subscriber.first_name}${invoice.subscriber.middle_name ? ' ' + invoice.subscriber.middle_name : ''} ${invoice.subscriber.last_name}`,
            message: `Account ${invoice.subscriber.account_number} auto-reactivated after full payment`,
            target_type: 'admin'
          }
        });

        if (prefs.outageAlerts && invoice.subscriber.email && config?.email) {
          config.email.sendWithPrisma(prisma, {
            to: invoice.subscriber.email,
            subject: 'Your Netfactory Service Has Been Restored',
            html: '<h2>Welcome Back, ' + invoice.subscriber.first_name + '!</h2><p>Great news - your Netfactory internet service has been <strong>restored</strong> after your recent payment.</p><p>Your account <strong>' + invoice.subscriber.account_number + '</strong> is now active and your connection should be back to normal.</p><p>If you experience any issues, please contact our support team or open a ticket through the Customer Portal.</p><p>Thank you for staying with Netfactory!</p><p>- Netfactory Team</p>',
          }).catch(err => console.error('[EMAIL] Service restored failed:', err.message));
        }

        if (prefs.outageAlerts && invoice.subscriber.phone && config?.sms) {
          config.sms.sendTemplateWithPrisma(prisma, invoice.subscriber.phone, 'service_restored', {
            name: invoice.subscriber.first_name,
          }).catch(err => console.error('[SMS] Service restored failed:', err.message));
        }
      }
    }
  }

  return { success: true, paymentId: payment.id };
}

// ============================================
// GET /api/webhooks/xendit — Branded status page
// ============================================
router.get("/xendit", (req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Netfactory - Payment Webhook</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1e293b;border-radius:16px;padding:48px 40px;text-align:center;max-width:440px;width:90%;box-shadow:0 25px 50px rgba(0,0,0,.4)}.logo{font-size:2.5rem;font-weight:900;color:#3b82f6;letter-spacing:-1px;margin-bottom:4px}.tagline{color:#64748b;font-size:.85rem;margin-bottom:32px}.badge{display:inline-flex;align-items:center;gap:8px;background:#052e16;border:1px solid #16a34a;color:#4ade80;padding:10px 20px;border-radius:999px;font-size:.9rem;font-weight:600;margin-bottom:24px}.dot{width:8px;height:8px;background:#4ade80;border-radius:50%;animation:pulse 2s infinite}.divider{border:none;border-top:1px solid #334155;margin:24px 0}.info{color:#94a3b8;font-size:.85rem;line-height:1.6}strong{color:#e2e8f0}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}</style></head><body><div class="card"><div class="logo">NF</div><div class="tagline">Network & Data Solutions</div><div class="badge"><span class="dot"></span>Webhook Active</div><hr class="divider"><p class="info">This endpoint processes <strong>Xendit payment callbacks</strong> for Netfactory subscribers.<br><br>Payments are automatically recorded and subscribers are notified upon successful transactions.</p></div></body></html>');
});

// ============================================
// POST /api/webhooks/xendit
// ============================================
// NOTE: the real Xendit handler is defined further down and is registered for
// BOTH /xendit and /xendit/payment. The version that used to live here treated
// Xendit's external_id ("NF-PAY-INV-26080010-1786774312996") as an invoice
// number, never matched an invoice, and still answered 200 — so Xendit marked
// the callback delivered and never retried. Paid invoices stayed "unpaid" with
// nothing but a log line to show for it.

// ============================================
// POST /api/webhooks/gcash
// ============================================
router.post('/gcash', async (req, res) => {
  try {
    const { invoice_number, amount, reference_number, status } = req.body;
    const result = await processPayment(req.prisma, req.config, {
      invoiceNumber: invoice_number,
      amount,
      method: 'gcash',
      referenceNumber: reference_number,
      status: status === 'SUCCESS' ? 'success' : 'pending',
      rawResponse: req.body
    });
    res.json(result);
  } catch (err) {
    console.error('GCash webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============================================
// POST /api/webhooks/maya
// ============================================
router.post('/maya', async (req, res) => {
  try {
    const { invoice_number, amount, reference_number, status } = req.body;
    const result = await processPayment(req.prisma, req.config, {
      invoiceNumber: invoice_number,
      amount,
      method: 'maya',
      referenceNumber: reference_number,
      status: status === 'PAYMENT_SUCCESS' ? 'success' : 'pending',
      rawResponse: req.body
    });
    res.json(result);
  } catch (err) {
    console.error('Maya webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============================================
// POST /api/webhooks/manual
// ============================================
router.post('/manual', async (req, res) => {
  try {
    const { invoiceNumber, amount, method, referenceNumber } = req.body;
    if (!invoiceNumber || !amount || !method) {
      return res.status(400).json({ error: 'invoiceNumber, amount, and method required' });
    }
    const validMethods = ['cash', 'bank_transfer', 'gcash', 'maya', 'check', 'online', '7-eleven', 'bayad_center', 'xendit'];
    if (!validMethods.includes(method)) {
      return res.status(400).json({ error: 'Invalid method. Use: ' + validMethods.join(', ') });
    }
    const result = await processPayment(req.prisma, req.config, {
      invoiceNumber,
      amount,
      method,
      referenceNumber: referenceNumber || ('MANUAL-' + Date.now()),
      status: 'success',
      rawResponse: { source: 'manual', recordedBy: 'admin' }
    });
    res.json(result);
  } catch (err) {
    console.error('Manual payment error:', err);
    res.status(500).json({ error: 'Payment recording failed' });
  }
});

// ============================================================
// XENDIT PAYMENT WEBHOOK — Callback when payment completes
// POST /api/webhooks/xendit/payment
// ============================================================
const xenditWebhookHandler = async (req, res) => {
  try {
    const webhookToken = (await req.prisma.system_settings.findUnique({ where: { key: 'xendit_webhook_token' } }))?.value || process.env.XENDIT_WEBHOOK_TOKEN;

    if (webhookToken) {
      const callbackToken = req.headers['x-callback-token'];
      if (callbackToken !== webhookToken) {
        console.warn('Xendit webhook: invalid callback token');
        return res.status(403).json({ error: 'Invalid callback token' });
      }
    }
    const event = req.body;
    console.log('Xendit webhook received: ' + event.status + ' for ' + event.external_id);

    if (event.status !== "PAID") {
      console.log('  Status ' + event.status + ' - no action needed');
      return res.json({ status: "acknowledged" });
    }

    // ── PAY-ALL: batch payment handler ──
    // The pay-all prefix was renamed J2- -> NF- so it does not read as another
    // company on the customer's payment confirmation, where Xendit prints
    // external_id as "Reference ID". The old prefix is still accepted: a checkout
    // opened before the rename can be paid days later, and it must still settle.
    const isBatch = !!event.external_id &&
      (event.external_id.startsWith("NF-PAYALL-") || event.external_id.startsWith("J2-PAYALL-"));
    if (isBatch) {
      const batchInvoices = await req.prisma.invoices.findMany({ where: { xendit_external_id: event.external_id }, include: { subscriber: true } });
      if (batchInvoices.length > 0) {
        const sub = batchInvoices[0].subscriber;
        console.log('  pay-all: ' + batchInvoices.length + ' invoices for ' + sub.account_number);
        const ch2 = (event.payment_channel || event.ewallet_type || "").toUpperCase();
        const chMap2 = { GCASH:"gcash", PH_GCASH:"gcash", PAYMAYA:"maya", PH_PAYMAYA:"maya", MAYA:"maya", GRABPAY:"gcash", SHOPEEPAY:"gcash" };
        const tMap2 = { EWALLET:"gcash", QR_CODE:"gcash", DIRECT_DEBIT:"bank_transfer", CREDIT_CARD:"xendit", BANK_TRANSFER:"bank_transfer", RETAIL_OUTLET:"7-eleven", PAYLATER:"xendit" };
        const batchMethod = chMap2[ch2] || tMap2[event.payment_method] || "xendit";
        const batchGrants = [];
        for (const inv of batchInvoices) {
          if (inv.status === "paid") continue;
          const bPay = await req.prisma.payments.create({ data: { invoice_id: inv.id, subscriber_id: inv.subscriber_id, amount: Number(inv.amount), method: batchMethod, reference_number: event.payment_id || event.id || event.external_id, status: "success", paid_at: event.paid_at ? new Date(event.paid_at) : new Date() } });
          await req.prisma.invoices.update({ where: { id: inv.id }, data: { status: "paid" } });
          await syncToAR(req.prisma, { ...inv, subscriber: sub }, Number(inv.amount), batchMethod, event.payment_id || event.id || event.external_id, 'xendit-batch');
          // A pay-all can carry top-ups too — the walled garden offers "pay everything"
          // and a prepaid customer may have an installation fee sitting alongside their
          // renewal. Each prepaid invoice in the batch grants its own days.
          if (prepaid && inv.prepaid_days) {
            try {
              const g = await prepaid.grant(req.prisma, radiusDb, {
                subscriberId: sub.id, days: Number(inv.prepaid_days), amount: Number(inv.amount),
                invoiceId: inv.id, paymentId: bPay.id, source: 'webhook', by: 'online payment',
              });
              batchGrants.push({ invoice: inv.invoice_number, days: Number(inv.prepaid_days),
                granted: g.granted, expiresAt: g.expiresAfter });
            } catch (err) {
              console.error('[prepaid] GRANT FAILED in pay-all for ' + inv.invoice_number +
                ' (subscriber ' + sub.id + '): ' + err.message);
            }
          }
          console.log('  done: ' + inv.invoice_number + ' paid');
        }
        const remaining = await req.prisma.invoices.findMany({ where: { subscriber_id: sub.id, status: { in: ["pending", "overdue"] } } });
        const newBal = remaining.reduce((s, i) => s + Number(i.amount), 0);
        await req.prisma.subscribers.update({ where: { id: sub.id }, data: { balance: newBal } });
        if (newBal === 0 && sub.status === "suspended") { await req.prisma.subscribers.update({ where: { id: sub.id }, data: { status: "active" } }); }
        const totalPaid = batchInvoices.reduce((s, i) => s + Number(i.amount), 0);
        const bCo = await getCompany(req.prisma).catch(() => null);
        const bMethodLabel = METHOD_LABELS[batchMethod] || batchMethod || 'Online (Xendit)';
        const batchInvoiceList = batchInvoices.map(i => i.invoice_number).join(', ');
        const bPrefs = await getPrefs(req.prisma, sub.id);
        if (bPrefs.emailBilling && sub.email && req.config?.email) {
          req.config.email.sendTemplateWithPrisma(req.prisma, sub.email, 'payment_received', {
            name: sub.first_name,
            invoiceNumber: batchInvoiceList,
            amount: `P${totalPaid.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            method: bMethodLabel,
            date: new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }),
            reference: event.payment_id || event.id || 'N/A',
          }, bCo).catch(e => console.error('Email err:', e.message));
        }
        if (bPrefs.smsPayment && sub.phone && req.config?.sms) {
          req.config.sms.sendTemplateWithPrisma(req.prisma, sub.phone, 'payment_received', {
            amount: `P${totalPaid.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            invoiceNumber: batchInvoices.length + ' invoices',
            reference: event.payment_id || event.id,
          }).catch(e => console.error('SMS err:', e.message));
        }
        // Lift the restriction, same as the single-invoice path below does. This branch
        // returns before reaching that code, so without this a customer who settles by
        // pay-all — which is what the walled garden and the portal's "pay all" button
        // both use — has every invoice marked paid and stays cut off regardless.
        // grant() already lifted the cutoff for any top-up in this batch. Only fall back
        // to the postpaid restore when nothing in the batch bought service time.
        const bRestore = batchGrants.length
          ? { restored: batchGrants.some(g => g.granted) }
          : await restriction.restoreIfSettled(req.prisma, radiusDb, sub.id,
              { by: 'auto (online payment ' + (event.payment_id || event.id || event.external_id) + ')' });
        if (bRestore.restored) {
          console.log('Access restored for subscriber ' + sub.id + ' after pay-all ' + event.external_id);
        }

        console.log('Pay-all done: ' + batchInvoices.length + ' invoices, P' + totalPaid + ' via ' + batchMethod);
        return res.json({ status: "paid", invoiceCount: batchInvoices.length, total: totalPaid,
          accessRestored: !!bRestore.restored,
          prepaid: batchGrants.length ? batchGrants : undefined });
      }
    }

    // ── SINGLE invoice lookup ──
    console.log("  Xendit payload:", JSON.stringify({ pm: event.payment_method, pc: event.payment_channel, et: event.ewallet_type }));
    const ch = (event.payment_channel || event.ewallet_type || "").toUpperCase();
    const chMap = { GCASH:"gcash", PH_GCASH:"gcash", PAYMAYA:"maya", PH_PAYMAYA:"maya", MAYA:"maya", GRABPAY:"gcash", SHOPEEPAY:"gcash" };
    const tMap = { EWALLET:"gcash", QR_CODE:"gcash", DIRECT_DEBIT:"bank_transfer", CREDIT_CARD:"xendit", BANK_TRANSFER:"bank_transfer", RETAIL_OUTLET:"7-eleven", PAYLATER:"xendit" };
    const paymentMethod = chMap[ch] || tMap[event.payment_method] || "xendit";

    let invoice = null;
    if (event.id) { invoice = await req.prisma.invoices.findFirst({ where: { xendit_invoice_id: event.id }, include: { subscriber: true } }); }
    if (!invoice && event.external_id) { invoice = await req.prisma.invoices.findFirst({ where: { xendit_external_id: event.external_id }, include: { subscriber: true } }); }
    if (!invoice && event.external_id) { const match = event.external_id.match(/(INV-\d{4}\d+)/); if (match) { invoice = await req.prisma.invoices.findFirst({ where: { invoice_number: match[1] }, include: { subscriber: true } }); } }
    if (!invoice && event.metadata?.invoice_id) { invoice = await req.prisma.invoices.findUnique({ where: { id: event.metadata.invoice_id }, include: { subscriber: true } }); }

    if (!invoice) {
      console.warn('Xendit webhook: no matching invoice for ' + event.external_id);
      return res.json({ status: "no_match", message: "Invoice not found" });
    }

    const sub = invoice.subscriber;
    const payAmt = Number(event.paid_amount || invoice.amount);
    const payment = await req.prisma.payments.create({ data: { invoice_id: invoice.id, subscriber_id: invoice.subscriber_id, amount: payAmt, method: paymentMethod, reference_number: event.payment_id || event.id || event.external_id, status: "success", paid_at: event.paid_at ? new Date(event.paid_at) : new Date() } });

    // Check total paid for partial support
    const totalPaidResult = await req.prisma.payments.aggregate({ where: { invoice_id: invoice.id, status: 'success' }, _sum: { amount: true } });
    const totalPaidAmt = Number(totalPaidResult._sum.amount || 0);
    const invoiceStatus = totalPaidAmt >= Number(invoice.amount) ? 'paid' : 'partial';
    await req.prisma.invoices.update({ where: { id: invoice.id }, data: { status: invoiceStatus } });

    // Sync to AR
    await syncToAR(req.prisma, invoice, payAmt, paymentMethod, event.payment_id || event.id || event.external_id, 'xendit-webhook');

    const remaining = await req.prisma.invoices.findMany({ where: { subscriber_id: sub.id, status: { in: ["pending", "overdue"] } } });
    const newBal = remaining.reduce((s, i) => s + Number(i.amount), 0);
    await req.prisma.subscribers.update({ where: { id: sub.id }, data: { balance: newBal } });
    if (newBal === 0 && sub.status === "suspended") { await req.prisma.subscribers.update({ where: { id: sub.id }, data: { status: "active" } }); }

    const xInvAmt = Number(invoice.amount);
    const xMethodLabel = METHOD_LABELS[paymentMethod] || paymentMethod || 'Online (Xendit)';
    const xCo = await getCompany(req.prisma).catch(() => null);
    const xPrefs = await getPrefs(req.prisma, sub.id);
    const xPdfBuf = await generateInvoicePDF(req.prisma, invoice.id).catch(e => { console.error('[EMAIL] PDF gen failed:', e.message); return null; });
    const xAttachments = xPdfBuf ? [{ filename: `Invoice-${invoice.invoice_number}.pdf`, content: xPdfBuf, contentType: 'application/pdf' }] : undefined;
    if (xPrefs.emailBilling && sub.email && req.config?.email) {
      req.config.email.sendTemplateWithPrisma(req.prisma, sub.email, 'payment_received', {
        name: sub.first_name,
        invoiceNumber: invoice.invoice_number,
        amount: `P${xInvAmt.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        method: xMethodLabel,
        date: new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }),
        reference: event.payment_id || event.id || 'N/A',
      }, xCo, xAttachments).catch(e => console.error('Email err:', e.message));
    }
    if (xPrefs.smsPayment && sub.phone && req.config?.sms) {
      req.config.sms.sendTemplateWithPrisma(req.prisma, sub.phone, 'payment_received', {
        amount: `P${xInvAmt.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        invoiceNumber: invoice.invoice_number,
        reference: event.payment_id || event.id,
      }).catch(e => console.error('SMS err:', e.message));
    }

    await req.prisma.audit_log.create({ data: { user_type: "system", user_id: 0, action: "payment_received", entity_type: "payment", entity_id: payment.id, details: JSON.stringify({ invoiceNumber: invoice.invoice_number, amount: invoice.amount, method: paymentMethod, xenditId: event.id }) } }).catch(() => {});

    // Same policy as the counter: settling the account brings the line back immediately,
    // so an online payment at midnight does not wait for anyone to notice. Best effort —
    // the webhook must still return 200 or the gateway will keep retrying a payment that
    // is already recorded.
    // A prepaid top-up buys days, not a settled debt, so it takes a different path:
    // grant() extends the expiry and lifts the cutoff itself. Running restoreIfSettled
    // as well would be harmless but misleading in the logs, and it would restore before
    // the expiry had actually moved. grant() is idempotent on invoice_id, which matters
    // here because Xendit re-delivers callbacks.
    let xRestore = { restored: false, reason: 'not restricted' };
    let xGrant = null;
    if (prepaid && invoice.prepaid_days && invoiceStatus === 'paid') {
      try {
        xGrant = await prepaid.grant(req.prisma, radiusDb, {
          subscriberId: sub.id, days: Number(invoice.prepaid_days), amount: payAmt,
          invoiceId: invoice.id, paymentId: payment.id,
          source: 'webhook', by: 'online payment',
        });
        if (xGrant.restored) xRestore = xGrant.restored;
        console.log('Prepaid top-up: subscriber ' + sub.id + ' +' + invoice.prepaid_days +
          'd, expires ' + (xGrant.expiresAfter ? new Date(xGrant.expiresAfter).toISOString() : 'unchanged') +
          (xGrant.granted ? '' : ' (already granted — duplicate callback)'));
      } catch (err) {
        // Money is recorded; the grant is not. Loud, because this is the one failure
        // that leaves a paying customer switched off.
        console.error('[prepaid] GRANT FAILED after payment on ' + invoice.invoice_number +
          ' (subscriber ' + sub.id + '): ' + err.message);
      }
    } else {
      xRestore = await restriction.restoreIfSettled(req.prisma, radiusDb, sub.id,
        { by: 'auto (online payment ' + (event.payment_id || event.id || invoice.invoice_number) + ')' });
    }
    if (xRestore.restored) {
      console.log('Access restored for subscriber ' + sub.id + ' after payment on ' + invoice.invoice_number);
    }

    console.log('Payment recorded: ' + invoice.invoice_number + ' - P' + invoice.amount + ' via ' + paymentMethod);
    res.json({ status: "paid", invoiceNumber: invoice.invoice_number, paymentId: payment.id,
      accessRestored: !!xRestore.restored,
      prepaid: xGrant ? { granted: xGrant.granted, days: xGrant.days || Number(invoice.prepaid_days),
        expiresAt: xGrant.expiresAfter } : undefined });

  } catch (err) {
    console.error("Xendit webhook error:", err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
};

// Xendit is configured to call /api/webhooks/xendit, but the working handler
// was only mounted at /xendit/payment. Serve both from the same code so the
// callback lands on real logic whichever URL is registered in the dashboard.
router.post('/xendit', xenditWebhookHandler);
router.post('/xendit/payment', xenditWebhookHandler);

// ============================================
// POST /api/webhooks/3cx — 3CX Call Event Webhook
// Events: ringing, answered, ended, missed
// ============================================
router.post('/3cx', async (req, res) => {
  try {
    // Validate webhook secret
    const secretRow = await req.prisma.system_settings.findUnique({ where: { key: '3cx_webhook_secret' } });
    const webhookSecret = secretRow?.value;

    if (webhookSecret) {
      const headerSecret = req.headers['x-3cx-secret'] || req.headers['x-webhook-secret'];
      if (headerSecret !== webhookSecret) {
        console.warn('[3CX Webhook] Invalid secret');
        return res.status(403).json({ error: 'Invalid webhook secret' });
      }
    }

    const event = req.body;
    const eventType = (event.type || event.event || event.Event || '').toLowerCase();
    const callId = event.callId || event.call_id || event.CallId || `3CX-${Date.now()}`;
    const direction = (event.direction || event.Direction || '').toLowerCase() || 'inbound';
    const callerNumber = event.callerNumber || event.caller_number || event.CallerNumber || event.from || '';
    const calleeNumber = event.calleeNumber || event.callee_number || event.CalleeNumber || event.to || '';
    const ext = event.extension || event.Extension || event.ext || '';

    console.log(`[3CX Webhook] ${eventType} | ${direction} | ${callerNumber} → ${calleeNumber} | ext ${ext}`);

    // Normalize phone and look up subscriber
    const { phoneLast10 } = require('../utils/threecx');
    const lookupNumber = direction === 'inbound' ? callerNumber : calleeNumber;
    const last10 = phoneLast10(lookupNumber);

    let subscriber = null;
    if (last10.length >= 7) {
      subscriber = await req.prisma.subscribers.findFirst({
        where: {
          OR: [
            { phone: { endsWith: last10 } },
            { phone: { endsWith: last10.slice(-7) } },
          ]
        },
        select: { id: true, first_name: true, last_name: true, account_number: true, status: true }
      });
    }

    // Map event type to status
    const statusMap = {
      ringing: 'ringing',
      answered: 'answered',
      connected: 'answered',
      ended: 'answered',    // ended means it was answered then hung up
      hangup: 'answered',
      missed: 'missed',
      notanswered: 'missed',
      busy: 'busy',
      voicemail: 'voicemail',
    };
    const callStatus = statusMap[eventType] || 'unknown';

    // Upsert call log by call_id (idempotent for retries)
    const existingLog = await req.prisma.call_logs.findFirst({ where: { call_id: callId } });

    const logData = {
      direction,
      caller_number: callerNumber,
      callee_number: calleeNumber,
      subscriber_id: subscriber?.id || null,
      subscriber_name: subscriber ? `${subscriber.first_name} ${subscriber.last_name}` : null,
      extension: ext,
      status: callStatus,
      raw_event: event,
    };

    if (existingLog) {
      // Update existing log
      const updateData = { ...logData };
      if (eventType === 'answered' || eventType === 'connected') {
        updateData.answered_at = new Date();
      }
      if (eventType === 'ended' || eventType === 'hangup') {
        updateData.ended_at = new Date();
        if (existingLog.answered_at) {
          updateData.duration_sec = Math.round((Date.now() - new Date(existingLog.answered_at).getTime()) / 1000);
        }
        if (event.duration || event.Duration) {
          updateData.duration_sec = parseInt(event.duration || event.Duration);
        }
      }
      await req.prisma.call_logs.update({ where: { id: existingLog.id }, data: updateData });
    } else {
      // Create new log
      logData.call_id = callId;
      logData.started_at = new Date();
      if (eventType === 'answered' || eventType === 'connected') logData.answered_at = new Date();
      await req.prisma.call_logs.create({ data: logData });
    }

    // Create notification for missed inbound calls
    if (eventType === 'missed' && direction === 'inbound') {
      const callerLabel = subscriber
        ? `${subscriber.first_name} ${subscriber.last_name} (${subscriber.account_number})`
        : callerNumber;

      await req.prisma.notifications.create({
        data: {
          type: 'warning',
          title: `Missed call from ${callerLabel}`,
          message: `Missed inbound call from ${callerNumber}${ext ? ` on ext. ${ext}` : ''}`,
          target_type: subscriber ? 'subscriber' : 'admin',
          target_id: subscriber?.id || null,
          is_read: false,
        }
      }).catch(err => console.error('[3CX] Notification error:', err.message));
    }

    // Emit socket event if io is available
    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('call_event', {
        type: eventType,
        callId,
        direction,
        callerNumber,
        calleeNumber,
        extension: ext,
        subscriber: subscriber || null,
        status: callStatus,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({ status: 'ok', callId, eventType: eventType });
  } catch (err) {
    console.error('[3CX Webhook] Error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============================================
// GET /api/webhooks/3cx — Branded status page
// ============================================
router.get('/3cx', (req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Netfactory - 3CX Webhook</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1e293b;border-radius:16px;padding:48px 40px;text-align:center;max-width:440px;width:90%;box-shadow:0 25px 50px rgba(0,0,0,.4)}.logo{font-size:2.5rem;font-weight:900;color:#3b82f6;letter-spacing:-1px;margin-bottom:4px}.tagline{color:#64748b;font-size:.85rem;margin-bottom:32px}.badge{display:inline-flex;align-items:center;gap:8px;background:#052e16;border:1px solid #16a34a;color:#4ade80;padding:10px 20px;border-radius:999px;font-size:.9rem;font-weight:600;margin-bottom:24px}.dot{width:8px;height:8px;background:#4ade80;border-radius:50%;animation:pulse 2s infinite}.divider{border:none;border-top:1px solid #334155;margin:24px 0}.info{color:#94a3b8;font-size:.85rem;line-height:1.6}strong{color:#e2e8f0}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}</style></head><body><div class="card"><div class="logo">NF</div><div class="tagline">Network & Data Solutions</div><div class="badge"><span class="dot"></span>3CX Webhook Active</div><hr class="divider"><p class="info">This endpoint processes <strong>3CX PBX call events</strong> for Netfactory CRM.<br><br>Inbound and outbound calls are automatically logged and linked to subscriber accounts.</p></div></body></html>');
});

// ============================================
// Omnichannel Inbox webhooks (Facebook Messenger + Viber)
// Public, signature-verified. Gmail uses IMAP polling (no webhook).
// ============================================
const inboxChannels = require('../utils/channels');
const { ingestInbound } = require('../utils/inbox');

function inboxChannelRow(prisma, type) {
  return prisma.message_channels.findFirst({ where: { type } });
}

// Facebook webhook verification handshake
router.get('/facebook', async (req, res) => {
  try {
    const fb = inboxChannels.get('facebook');
    const cfg = await fb.readCfg(req.prisma);
    const challenge = fb.verifyGet(req, cfg);
    if (challenge != null) return res.status(200).send(String(challenge));
    return res.sendStatus(403);
  } catch (e) { res.sendStatus(500); }
});

// Facebook inbound messages
router.post('/facebook', async (req, res) => {
  try {
    const fb = inboxChannels.get('facebook');
    const cfg = await fb.readCfg(req.prisma);
    if (!fb.verifyPost(req, cfg)) return res.sendStatus(403);
    const channel = await inboxChannelRow(req.prisma, 'facebook');
    if (channel && channel.enabled) {
      const io = req.app.get('io');
      for (const n of fb.parseInbound(req.body)) {
        if (n.externalUserId) await ingestInbound(req.prisma, io, channel, n);
      }
    }
    res.sendStatus(200); // always 200 so Meta keeps the webhook active
  } catch (e) { console.error('[webhook facebook]', e.message); res.sendStatus(200); }
});

// Viber inbound events
router.post('/viber', async (req, res) => {
  try {
    const vb = inboxChannels.get('viber');
    const cfg = await vb.readCfg(req.prisma);
    if (!vb.verifyPost(req, cfg)) return res.sendStatus(403);
    if (req.body && req.body.event === 'webhook') return res.sendStatus(200); // set_webhook validation ping
    const channel = await inboxChannelRow(req.prisma, 'viber');
    if (channel && channel.enabled) {
      const n = vb.parseInbound(req.body);
      if (n && n.externalUserId) await ingestInbound(req.prisma, req.app.get('io'), channel, n);
    }
    res.sendStatus(200);
  } catch (e) { console.error('[webhook viber]', e.message); res.sendStatus(200); }
});

module.exports = router;
