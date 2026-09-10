const PDFDocument = require('pdfkit');

const C = {
  blue:[8,145,178], dark:[30,41,59], mid:[71,85,105], light:[148,163,184],
  red:[220,38,38], border:[203,213,225], bg:[248,250,252], rowAlt:[241,245,249]
};

const fmtMoney = (v) => {
  const n = Number(v) || 0;
  return 'P ' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

function t(doc, str, x, y, opts = {}) {
  const sx = doc.x, sy = doc.y;
  doc.save();
  doc.font(opts.b ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.s || 8).fillColor(opts.c || C.dark);
  const txt = String(str);
  if (opts.a === 'r' && opts.w) {
    doc.text(txt, x + opts.w - doc.widthOfString(txt), y, { lineBreak: false });
  } else if (opts.a === 'c' && opts.w) {
    doc.text(txt, x + (opts.w - doc.widthOfString(txt)) / 2, y, { lineBreak: false });
  } else {
    doc.text(txt, x, y, { lineBreak: false });
  }
  doc.restore();
  doc.x = sx; doc.y = sy;
}

function r(doc, x, y, w, h, f, s) {
  const sx = doc.x, sy = doc.y;
  if (f) { doc.save(); doc.rect(x, y, w, h).fill(f); doc.restore(); }
  if (s) { doc.save(); doc.rect(x, y, w, h).strokeColor(s).lineWidth(0.5).stroke(); doc.restore(); }
  doc.x = sx; doc.y = sy;
}

function l(doc, x1, y1, x2, y2, c, w) {
  const sx = doc.x, sy = doc.y;
  doc.save(); doc.strokeColor(c || C.border).lineWidth(w || 0.5).moveTo(x1, y1).lineTo(x2, y2).stroke(); doc.restore();
  doc.x = sx; doc.y = sy;
}

async function getCompanySettings(prisma) {
  const rows = await prisma.system_settings.findMany({ where: { category: { in: ['company', 'billing'] } } });
  const s = {}; rows.forEach(x => { s[x.key] = x.value; });
  return {
    name: s.company_name || 'Netfactory', shortName: s.company_short_name || 'NF',
    tagline: s.company_tagline || '.network', subtitle: s.company_subtitle || 'AND DATA SOLUTION',
    logoPath: s.company_logo || '',
    tin: s.company_tin || '230-888-342-00000', vatLabel: s.company_vat_label || 'Non VAT Reg. TIN',
    brc: s.company_brc || '21BRC20230X221', address1: s.company_address1 || 'Sitio Dudurot Paligui',
    address2: s.company_address2 || 'Colgante', city: s.company_city || 'Apalit, Pampanga 2016',
    website: s.company_website || 'www.netfactory.com.ph',
    bankName: s.bank_name || '',
    bankAcctNumber: s.bank_account_number || '',
    bankAcctName: s.bank_account_name || '',
    taxRate: parseFloat(s.default_tax_rate || '0.03'), taxLabel: s.default_tax_label || 'DTI 3% PT',
  };
}

async function generateInvoicePDF(prisma, invoiceId) {
  const inv = await prisma.invoices.findUnique({
    where: { id: parseInt(invoiceId) },
    include: {
      subscriber: { include: { plan: { include: { features: { where: { is_active: true }, orderBy: { sort_order: 'asc' } } } }, municipality: true, barangay: true } },
      payments: { orderBy: { paid_at: 'desc' }, take: 5 }
    }
  });
  if (!inv) throw new Error('Invoice not found');
  const co = await getCompanySettings(prisma);
  const sub = inv.subscriber;
  const fd = (d) => d ? new Date(d).toLocaleDateString('en-PH', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '';
  const fp = (p) => { if (!p) return ''; const d = p.replace(/\D/g, ''); return d.length === 11 ? '(' + d.slice(0,4) + ') ' + d.slice(4,7) + ' - ' + d.slice(7) : p; };

  // Resolve payment details + CRM operator if applicable
  let paymentInfo = null;
  if (inv.status === 'paid' && inv.payments.length > 0) {
    const payment = inv.payments[0];
    let recordedBy = null;
    let source = 'online';
    const auditEntry = await prisma.audit_log.findFirst({
      where: { action: 'payment_recorded', entity_id: inv.id, entity_type: { in: ['invoices', 'invoice'] } },
      orderBy: { created_at: 'desc' }
    });
    const auditDetails = auditEntry?.details && typeof auditEntry.details === 'object' ? auditEntry.details : null;
    if (auditEntry && auditEntry.user_type === 'admin' && auditEntry.user_id) {
      const admin = await prisma.admin_users.findUnique({ where: { id: Number(auditEntry.user_id) }, select: { full_name: true, username: true } });
      recordedBy = admin?.full_name || admin?.username || null;
      source = 'crm';
    }
    const isCredit = payment.method === 'credit';
    const amountReceived  = auditDetails?.amount        != null ? Number(auditDetails.amount)          : Number(payment.amount);
    const amountApplied   = auditDetails?.effectivePayment != null ? Number(auditDetails.effectivePayment) : Number(payment.amount);
    const overpayment     = auditDetails?.overpayment   != null ? Number(auditDetails.overpayment)     : 0;
    paymentInfo = { paidAt: payment.paid_at, method: payment.method, reference: payment.reference_number, recordedBy, source, isCredit, amountReceived, amountApplied, overpayment };
  }

  const items = [];
  let coveragePeriod = '';
  const noteLines = (inv.notes || '').split('\n').filter(x => x.trim() && !x.startsWith('TYPE:'));
  const covIdx = noteLines.findIndex(x => x.includes('Internet Service Coverage'));
  if (covIdx >= 0) { coveragePeriod = noteLines.splice(covIdx, 1)[0]; }
  const parts = noteLines.join(' | ').split(' | ').filter(Boolean);
  for (const p of parts) {
    const m = p.match(/^(.+?):\s*([\d,.]+)/);
    if (m) { const lb = m[1].trim(), am = parseFloat(m[2].replace(/,/g, '')); if (!isNaN(am) && am > 0) items.push({ item: lb.split(' ').map(w => w[0]).join('').substring(0, 6), description: lb, unitCost: am, quantity: 1, discount: 0, lineTotal: am }); }
  }
  if (!items.length) {
    const MANUAL_CATS = ['subscription', 'installation', 'reconnection', 'other'];
    const isActivation = inv.billing_period?.includes('Activation');
    const isManualCat = MANUAL_CATS.includes((inv.billing_period || '').toLowerCase());
    const planName = sub.plan ? sub.plan.name + ' (' + sub.plan.speed_mbps + ' Mbps)' : '';
    let desc = '', itemCode = '';
    if (isActivation) {
      desc = inv.billing_period || 'Activation';
      itemCode = 'ACTIV';
    } else if (isManualCat) {
      const catLabel = (inv.billing_period || 'other').charAt(0).toUpperCase() + (inv.billing_period || 'other').slice(1);
      // Use user-supplied description from notes; skip auto-generated plan/AR-ref lines
      const userDesc = noteLines.filter(l => !l.includes('Mbps') && !l.startsWith('AR Ref:') && !l.startsWith('TYPE:') && l.trim()).join(' — ');
      desc = userDesc || (catLabel + ' Charge');
      itemCode = catLabel.substring(0, 6).toUpperCase();
    } else {
      if (planName && inv.billing_period) { desc = planName + ' — Service for ' + inv.billing_period; }
      else { desc = inv.billing_period || 'Service Charge'; }
      itemCode = sub.plan ? sub.plan.name : 'MONTH';
    }
    const features = (!isActivation && !isManualCat && sub.plan?.features?.length) ? [...new Set(sub.plan.features.map(f => f.feature_text))].join(' | ') : '';
    items.push({ item: itemCode, description: desc + (features ? '\n' + features : ''), unitCost: Number(inv.amount), quantity: 1, discount: 0, lineTotal: Number(inv.amount) });
  }
  const SKIP_COVERAGE = ['subscription', 'installation', 'reconnection', 'other'];
  if (!coveragePeriod && inv.billing_period && !inv.billing_period.includes('Activation') && !inv.billing_period.includes('Prorated') && !SKIP_COVERAGE.includes((inv.billing_period || '').toLowerCase())) {
    const dueStr = inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
    coveragePeriod = 'Internet Service Coverage: ' + inv.billing_period + (dueStr ? ' — Due: ' + dueStr : '');
  }

  // Referral discount applied to THIS invoice — FIFO walk of the subscriber's
  // credit ledger (credits are fungible, so attribute referral lots oldest-first).
  let referralDiscount = 0;
  try {
    const ledger = await prisma.subscriber_credits.findMany({
      where: { subscriber_id: inv.subscriber_id },
      select: { type: true, amount: true, applied_invoice_id: true, created_at: true, id: true },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    const lots = [];
    for (const e of ledger) {
      const amt = Number(e.amount);
      if (amt > 0) { lots.push({ remaining: amt, isReferral: e.type === 'referral_reward' }); }
      else if (amt < 0) {
        let need = -amt, refConsumed = 0;
        while (need > 0.0001 && lots.length) {
          const lot = lots[0];
          const take = Math.min(lot.remaining, need);
          if (lot.isReferral) refConsumed += take;
          lot.remaining -= take; need -= take;
          if (lot.remaining <= 0.0001) lots.shift();
        }
        if (e.applied_invoice_id === inv.id && refConsumed > 0.0001) referralDiscount += refConsumed;
      }
    }
    referralDiscount = Math.round(referralDiscount * 100) / 100;
  } catch (e) { referralDiscount = 0; }

  const st = Number(inv.amount);
  // Actual paid-to-date from all successful payments (handles partial/credit, not just paid/unpaid).
  const paidAgg = await prisma.payments.aggregate({ where: { invoice_id: inv.id, status: 'success' }, _sum: { amount: true } });
  const paidToDate = Math.min(st, Math.round(Number(paidAgg._sum.amount || 0) * 100) / 100);
  const balanceDue = Math.max(0, Math.round((st - paidToDate) * 100) / 100);
  // Referral credit applications are already counted inside paidToDate (recorded as method='credit'
  // payments). Break that portion out so the referral line is shown once, not double-counted.
  const paidExclReferral = Math.max(0, Math.round((paidToDate - referralDiscount) * 100) / 100);
  return buildPDF({
    invoiceNumber: inv.invoice_number, invoiceDate: fd(inv.generated_at || inv.created_at), dueDate: fd(inv.due_date),
    customerName: ((sub.first_name || '') + (sub.middle_name ? ' ' + sub.middle_name : '') + ' ' + (sub.last_name || '')).trim(), accountNumber: sub.account_number,
    address: sub.address || '', barangay: sub.barangay?.name || '', municipality: sub.municipality?.name || '',
    province: '', zip: sub.postal_code || '', email: sub.email || '', phone: fp(sub.phone),
    items, coveragePeriod, subtotal: st, taxLabel: co.taxLabel, taxRate: co.taxRate, taxAmount: Math.round(st * co.taxRate * 100) / 100,
    total: st, paidToDate, paidExclReferral, balanceDue,
    referralDiscount, notes: '', paymentInfo,
  }, co);
}

function buildPDF(data, co) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'letter', margin: 0 });
      const buf = [];
      doc.on('data', c => buf.push(c));
      doc.on('end', () => resolve(Buffer.concat(buf)));
      doc.on('error', reject);

      const W = 612, H = 792, M = 50, rw = W - 2 * M;
      doc.x = 0; doc.y = 0;
      let y = M;

      // PAID WATERMARK — drawn first so all content renders on top
      if (data.paymentInfo) {
        doc.save();
        doc.opacity(0.07);
        doc.font('Helvetica-Bold').fontSize(130).fillColor([22, 163, 74]);
        doc.rotate(-45, { origin: [W / 2, H / 2] });
        doc.text('PAID', W / 2 - 120, H / 2 - 65, { lineBreak: false });
        doc.restore();
      }

      // HEADER - Logo or blank + company name centered
      const fs = require('fs');
      const path = require('path');
      if (co.logoPath) {
        const logoFile = path.resolve(co.logoPath);
        if (fs.existsSync(logoFile)) {
          try { doc.image(logoFile, M, y, { height: 45 }); } catch(e) { /* skip if image fails */ }
        }
      }
      t(doc, co.name, M, y + 8, { b: true, s: 9, c: C.blue, a: 'c', w: rw });
      t(doc, co.vatLabel + ': ' + co.tin, M, y + 22, { s: 8, c: C.mid, a: 'c', w: rw });
      [co.address1, co.address2, co.city, co.brc].filter(Boolean).forEach((ln, i) => {
        t(doc, ln, M, y + 8 + i * 12, { s: 8, c: C.mid, a: 'r', w: rw });
      });
      y += 55;

      // INVOICE + RED LINE
      t(doc, 'INVOICE', M, y, { b: true, s: 13, c: C.blue });
      y += 16;
      l(doc, M, y, W - M, y, C.red, 1.5);
      y += 14;

      // INFO BOX
      var bh = 100;
      r(doc, M, y, rw, bh, C.bg, C.border);
      var lx = M + 10, ly = y + 10;
      t(doc, 'Invoice', lx, ly, { s: 8, c: C.mid });
      t(doc, data.invoiceNumber || '', lx + 90, ly, { b: true, s: 8.5, c: C.dark });
      ly += 13;
      t(doc, 'Number', lx, ly, { s: 8, c: C.mid });
      ly += 13;
      [['Invoice Date', data.invoiceDate], ['Due Date', data.dueDate], ['Invoice Total', fmtMoney(data.total)], ['Balance Due', fmtMoney(data.balanceDue)]].forEach(function(p) {
        t(doc, p[0], lx, ly, { s: 8, c: C.mid });
        t(doc, String(p[1]), lx + 90, ly, { b: true, s: 8.5, c: C.dark });
        ly += 13;
      });
      l(doc, M + 210, y, M + 210, y + bh, C.border, 0.5);
      var rx = M + 225, ry = y + 10;
      t(doc, (data.customerName || '').toUpperCase(), rx, ry, { b: true, s: 9, c: C.dark });
      ry += 14;
      t(doc, String(data.accountNumber || ''), rx, ry, { s: 8, c: C.mid });
      ry += 13;
      var cls = [];
      if (data.address) cls.push(data.address);
      var bm = [data.barangay, data.municipality].filter(Boolean).join(', ');
      if (data.province) bm += ', ' + data.province;
      if (data.zip) bm += ' ' + data.zip;
      if (bm) cls.push(bm);
      if (data.email) cls.push(data.email);
      if (data.phone) cls.push(data.phone);
      cls.forEach(function(c) { t(doc, String(c), rx, ry, { s: 8, c: C.mid }); ry += 13; });
      y += bh + 16;

      // COVERAGE PERIOD
      if (data.coveragePeriod) {
        t(doc, data.coveragePeriod, M, y, { b: true, s: 9, c: C.blue, a: 'c', w: rw });
        y += 20;
      }

      // TABLE
      var cw = [70, 190, 85, 55, 60, 70], tw2 = 530, tx = M + (rw - tw2) / 2, rh = 22;
      r(doc, tx, y, tw2, rh, C.bg, C.border);
      var hdrs = ['Item', 'Description', 'Unit Cost', 'Quantity', 'Discount', 'Line Total'];
      var hx = tx;
      hdrs.forEach(function(h, i) {
        t(doc, h, hx + 6, y + 6, { b: true, s: 7.5, c: C.mid, a: i >= 2 ? 'r' : undefined, w: cw[i] - 12 });
        hx += cw[i];
      });
      y += rh;

      (data.items || []).forEach(function(item, idx) {
        if (idx % 2 === 1) r(doc, tx, y, tw2, rh, C.rowAlt);
        l(doc, tx, y + rh, tx + tw2, y + rh, C.border, 0.25);
        var descLines = (item.description || '').split('\n');
        var vals = [
          { v: item.item || '', c: C.blue },
          { v: descLines[0] || '', c: C.dark },
          { v: fmtMoney(item.unitCost), c: C.dark, a: 'r' },
          { v: String(item.quantity || 1), c: C.dark, a: 'r' },
          { v: item.discount ? fmtMoney(item.discount) : '', c: C.dark, a: 'r' },
          { v: fmtMoney(item.lineTotal), c: C.dark, a: 'r' },
        ];
        var cx = tx;
        vals.forEach(function(v, ci) {
          t(doc, v.v, cx + 6, y + 6, { s: 8, c: v.c, a: v.a, w: cw[ci] - 12 });
          cx += cw[ci];
        });
        y += rh;
        if (descLines.length > 1) {
          var featY = y;
          t(doc, descLines[1], tx + cw[0] + 6, featY + 4, { s: 6.5, c: C.mid });
          y += 14;
          l(doc, tx, y, tx + tw2, y, C.border, 0.25);
        }
      });
      l(doc, tx, y, tx + tw2, y, C.border, 0.5);
      y += 16;

      // TOTALS
      var tl = tx + tw2 - 200, tv = tx + tw2;
      var totalsRows = [
        { lb: 'Net', v: data.subtotal, b: false },
        { lb: 'Subtotal', v: data.subtotal, b: false },
        { lb: 'Tax ' + (data.taxLabel || '3%'), v: data.taxAmount, b: false },
        { lb: 'Total', v: data.total, b: true, ln: true },
      ];
      if (data.referralDiscount > 0) {
        // Show the referral credit on its own line; "Paid to Date" excludes it so the column reconciles.
        totalsRows.push({ lb: 'Paid to Date', v: data.paidExclReferral || 0, b: false });
        totalsRows.push({ lb: 'Referral Discount (credit applied)', v: -data.referralDiscount, b: false, green: true });
      } else {
        totalsRows.push({ lb: 'Paid to Date', v: data.paidToDate || 0, b: false });
      }
      totalsRows.push({ lb: 'Balance Due', v: data.balanceDue, b: true, ln: true });
      var GREEN = [22, 163, 74];
      totalsRows.forEach(function(x) {
        if (x.ln) { l(doc, tl, y, tv - 6, y, C.border, 0.5); y += 4; }
        var fs = x.b ? 9 : 8;
        var col = x.green ? GREEN : (x.b ? C.dark : C.mid);
        t(doc, x.lb, tl, y, { b: x.b, s: fs, c: col });
        t(doc, fmtMoney(x.v), tl, y, { b: x.b, s: fs, c: col, a: 'r', w: tv - tl - 6 });
        y += 16;
      });
      y += 30;

      // PAYMENT CONFIRMATION BOX (paid invoices only)
      if (data.paymentInfo) {
        const pi = data.paymentInfo;
        const methodLabels = { cash: 'Cash', gcash: 'GCash', maya: 'Maya', paymaya: 'Maya', xendit: 'Online — Xendit', bank_transfer: 'Bank Transfer', credit: 'Credit Applied', check: 'Check', online: 'Online Payment' };
        const methodLabel = methodLabels[pi.method?.toLowerCase()] || pi.method || 'Online Payment';
        const fmtDT = (d) => {
          if (!d) return '';
          const dt = new Date(d);
          return dt.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
            + '  ' + dt.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
        };
        const rows = [
          ['Paid on', fmtDT(pi.paidAt)],
          ['Method', methodLabel],
        ];
        if (pi.isCredit) {
          rows.push(['Applied from Credits', fmtMoney(pi.amountApplied)]);
        } else {
          rows.push(['Amount Received', fmtMoney(pi.amountReceived)]);
          if (pi.amountApplied !== pi.amountReceived) {
            rows.push(['Applied to Invoice', fmtMoney(pi.amountApplied)]);
            if (pi.overpayment > 0) rows.push(['Overpayment to Credits', fmtMoney(pi.overpayment)]);
          }
        }
        if (pi.reference) rows.push(['Reference #', pi.reference]);
        if (pi.recordedBy) rows.push(['Received by', pi.recordedBy + '  (CRM)']);

        const boxH = 26 + rows.length * 17 + 8;
        const green = [22, 163, 74];
        r(doc, M, y, rw, boxH, [240, 253, 244], [22, 163, 74]);
        r(doc, M, y, 5, boxH, green);
        t(doc, '\u2713  PAYMENT CONFIRMED', M + 14, y + 8, { b: true, s: 9.5, c: green });
        let ry = y + 24;
        rows.forEach(([label, value]) => {
          t(doc, label + ':', M + 14, ry, { s: 8, c: C.mid });
          t(doc, String(value), M + 140, ry, { b: true, s: 8, c: C.dark });
          ry += 17;
        });
        y += boxH + 16;
      }

      // BANK (only if configured)
      if (co.bankName && co.bankAcctNumber) {
        t(doc, 'For Payments via Bank Transfer or Deposit Bank:', M, y, { b: true, s: 8.5, c: C.dark });
        y += 16;
        [co.bankName, 'Account Number: ' + co.bankAcctNumber, 'Account Name: ' + co.bankAcctName].forEach(function(b) {
          t(doc, b, M, y, { s: 8, c: C.mid }); y += 13;
        });
        y += 10;
      }

      // ONLINE PAYMENT — anchored just above footer
      var py = H - 100;
      t(doc, 'Pay Online:', M, py, { b: true, s: 8.5, c: C.dark });
      t(doc, 'Visit your subscriber portal to pay securely via our Xendit payment gateway:', M, py + 14, { s: 8, c: C.mid });
      t(doc, co.website ? 'https://' + co.website.replace(/^https?:\/\//, '') + '/portal' : 'https://netfactory.com.ph/portal', M, py + 26, { b: true, s: 8.5, c: C.blue });
      t(doc, 'Available methods:  GCash  |  Maya  |  GrabPay  |  Credit/Debit Card  |  BPI  |  UnionBank  |  BDO  |  7-Eleven  |  Cebuana  |  Palawan Express', M, py + 40, { s: 7.5, c: C.mid });
      // FOOTER
      l(doc, M, H - 50, W - M, H - 50, C.border, 0.5);
      t(doc, co.name + '  \u2022  ' + co.website + '  \u2022  Thank you for your business!', M, H - 40, { s: 6, c: C.light, a: 'c', w: rw });

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { generateInvoicePDF, buildPDF, getCompanySettings };
