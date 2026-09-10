const PDFDocument = require('pdfkit');

const C = {
  blue:[8,145,178], dark:[30,41,59], mid:[71,85,105], light:[148,163,184],
  red:[220,38,38], green:[22,163,74], border:[203,213,225], bg:[248,250,252], rowAlt:[241,245,249]
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

async function generateSOAPDF(prisma, subscriberId, periodFrom, periodTo, includeAll) {
  const { getCompanySettings } = require('./invoicePdf');
  const co = await getCompanySettings(prisma);

  const sub = await prisma.subscribers.findUnique({
    where: { id: parseInt(subscriberId) },
    include: { plan: true, municipality: true, barangay: true }
  });
  if (!sub) throw new Error('Subscriber not found');

  // Build period list for filtering
  const periods = [];
  if (periodFrom && periodTo) {
    const [fromMonth, fromYear] = [new Date(periodFrom + ' 1').getMonth(), new Date(periodFrom + ' 1').getFullYear()];
    const [toMonth, toYear] = [new Date(periodTo + ' 1').getMonth(), new Date(periodTo + ' 1').getFullYear()];
    let y = fromYear, m = fromMonth;
    while (y < toYear || (y === toYear && m <= toMonth)) {
      periods.push(new Date(y, m, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }));
      m++; if (m > 11) { m = 0; y++; }
    }
  }

  // Fetch invoices + payments
  const invoicesRaw = await prisma.invoices.findMany({
    where: { subscriber_id: parseInt(subscriberId) },
    include: { payments: { orderBy: { paid_at: 'asc' } } },
    orderBy: [{ due_date: 'asc' }, { created_at: 'asc' }]
  });

  // Date range for non-periodic invoices
  const fromDate = periodFrom ? new Date(periodFrom + ' 1') : null;
  const toDate = periodTo ? new Date(new Date(periodTo + ' 1').getFullYear(), new Date(periodTo + ' 1').getMonth() + 1, 0, 23, 59, 59) : null;

  // Filter by period range if specified
  const invoices = periods.length > 0
    ? invoicesRaw.filter(inv => {
        if (inv.status === 'cancelled') return false;
        // Periodic match
        if (inv.billing_period && periods.includes(inv.billing_period)) return true;
        // Non-periodic: include if toggle is on and date falls in range
        if (includeAll && (!inv.billing_period || !periods.includes(inv.billing_period))) {
          const invDate = new Date(inv.generated_at || inv.created_at || 0);
          return fromDate && toDate && invDate >= fromDate && invDate <= toDate;
        }
        return false;
      })
    : invoicesRaw;

  const fd = (d) => d ? new Date(d).toLocaleDateString('en-PH', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '';
  const customerName = ((sub.first_name || '') + (sub.middle_name ? ' ' + sub.middle_name : '') + ' ' + (sub.last_name || '')).trim();

  // Build line items: each invoice is a charge row, each payment is a credit row
  const lines = [];
  invoices.forEach(inv => {
    const isPeriodic = inv.billing_period && periods.includes(inv.billing_period);
    const label = isPeriodic ? inv.billing_period : (inv.billing_period || 'One-time Charge');
    // Invoice charge line
    lines.push({
      date: inv.generated_at || inv.created_at,
      type: 'charge',
      description: label + ' — ' + (inv.invoice_number || ''),
      invoiceNumber: inv.invoice_number,
      period: inv.billing_period || '',
      isPeriodic,
      debit: Number(inv.amount),
      credit: 0,
      status: inv.status
    });
    // Payment lines — cap total payments at invoice amount (overpayments go to credit, not SOA)
    const invAmount = Number(inv.amount);
    let appliedSoFar = 0;
    (inv.payments || []).forEach(p => {
      if (p.status === 'failed' || p.status === 'refunded' || p.status === 'voided') return;
      const pAmt = Number(p.amount);
      const remaining = Math.max(invAmount - appliedSoFar, 0);
      const applied = Math.min(pAmt, remaining);
      if (applied <= 0) return;
      appliedSoFar += applied;
      const methodLabels = { cash:'Cash', gcash:'GCash', maya:'Maya', bank_transfer:'Bank', credit:'Credit', check:'Check', online:'Online' };
      lines.push({
        date: p.paid_at || p.created_at,
        type: 'payment',
        description: 'Payment — ' + (methodLabels[p.method] || p.method || '') + (p.reference_number ? ' (Ref: ' + p.reference_number + ')' : '') + (p.or_number ? ' OR#' + p.or_number : ''),
        invoiceNumber: inv.invoice_number,
        period: inv.billing_period || '',
        debit: 0,
        credit: applied,
        status: 'payment'
      });
    });
  });

  // Sort by date
  lines.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Compute running balance
  let running = 0;
  lines.forEach(ln => {
    running += ln.debit - ln.credit;
    ln.balance = running;
  });

  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);

  // Build PDF
  return buildSOAPDF({
    customerName, accountNumber: sub.account_number,
    address: sub.address || '', barangay: sub.barangay?.name || '', municipality: sub.municipality?.name || '',
    email: sub.email || '', phone: sub.phone || '',
    planName: sub.plan ? sub.plan.name + ' (' + sub.plan.speed_mbps + ' Mbps)' : '',
    periodLabel: periods.length > 0 ? periodFrom + ' — ' + periodTo : 'All Periods',
    generatedDate: new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }),
    lines, totalDebit, totalCredit, finalBalance: running,
  }, co);
}

function buildSOAPDF(data, co) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'letter', margin: 0, bufferPages: true });
      const buf = [];
      doc.on('data', c => buf.push(c));
      doc.on('end', () => resolve(Buffer.concat(buf)));
      doc.on('error', reject);

      const W = 612, H = 792, M = 40, rw = W - 2 * M;
      doc.x = 0; doc.y = 0;
      let y = M;

      // ── HEADER ──
      const fs = require('fs');
      const path = require('path');
      if (co.logoPath) {
        const logoFile = path.resolve(co.logoPath);
        if (fs.existsSync(logoFile)) {
          try { doc.image(logoFile, M, y, { height: 40 }); } catch(e) {}
        }
      }
      t(doc, co.name, M, y + 6, { b: true, s: 9, c: C.blue, a: 'c', w: rw });
      t(doc, co.vatLabel + ': ' + co.tin, M, y + 20, { s: 7.5, c: C.mid, a: 'c', w: rw });
      [co.address1, co.address2, co.city].filter(Boolean).forEach((ln, i) => {
        t(doc, ln, M, y + 6 + i * 11, { s: 7.5, c: C.mid, a: 'r', w: rw });
      });
      y += 48;

      // ── TITLE + RED LINE ──
      t(doc, 'STATEMENT OF ACCOUNT', M, y, { b: true, s: 13, c: C.blue });
      t(doc, 'Date: ' + data.generatedDate, M, y + 2, { s: 8, c: C.mid, a: 'r', w: rw });
      y += 16;
      l(doc, M, y, W - M, y, C.red, 1.5);
      y += 12;

      // ── CUSTOMER INFO BOX ──
      const bh = 72;
      r(doc, M, y, rw, bh, C.bg, C.border);
      const lx = M + 10; let ly = y + 8;
      t(doc, (data.customerName || '').toUpperCase(), lx, ly, { b: true, s: 9, c: C.dark });
      t(doc, 'Account #: ' + (data.accountNumber || ''), lx + 230, ly, { s: 8, c: C.mid });
      ly += 14;
      if (data.planName) { t(doc, 'Plan: ' + data.planName, lx, ly, { s: 8, c: C.mid }); ly += 12; }
      const addrParts = [data.address, [data.barangay, data.municipality].filter(Boolean).join(', ')].filter(Boolean);
      if (addrParts.length) { t(doc, addrParts.join(', '), lx, ly, { s: 8, c: C.mid }); ly += 12; }
      const contactParts = [data.email, data.phone].filter(Boolean);
      if (contactParts.length) { t(doc, contactParts.join('  |  '), lx, ly, { s: 8, c: C.mid }); }
      // Period label on the right side
      t(doc, 'Period: ' + data.periodLabel, lx + 230, y + 22, { b: true, s: 8, c: C.blue });
      y += bh + 12;

      // ── TABLE ──
      const cols = [65, 200, 75, 75, 75]; // Date, Description, Debit, Credit, Balance
      const tw = cols.reduce((s, c) => s + c, 0);
      const tx = M + (rw - tw) / 2;
      const rh = 18;

      // Header row
      r(doc, tx, y, tw, rh + 2, C.blue);
      const hdrs = ['Date', 'Description', 'Charges', 'Payments', 'Balance'];
      let hx = tx;
      hdrs.forEach((h, i) => {
        t(doc, h, hx + 5, y + 5, { b: true, s: 7.5, c: [255,255,255], a: i >= 2 ? 'r' : undefined, w: cols[i] - 10 });
        hx += cols[i];
      });
      y += rh + 2;

      // Data rows
      const maxRowsPerPage = 32;
      let rowCount = 0;

      const drawRow = (ln, idx) => {
        // Page break check
        if (y > H - 120) {
          // Footer on current page
          l(doc, M, H - 50, W - M, H - 50, C.border, 0.5);
          t(doc, co.name + '  \u2022  ' + co.website + '  \u2022  Statement of Account', M, H - 40, { s: 6, c: C.light, a: 'c', w: rw });
          doc.addPage();
          y = M;
          // Re-draw header on new page
          r(doc, tx, y, tw, rh + 2, C.blue);
          let hx2 = tx;
          hdrs.forEach((h, i) => {
            t(doc, h, hx2 + 5, y + 5, { b: true, s: 7.5, c: [255,255,255], a: i >= 2 ? 'r' : undefined, w: cols[i] - 10 });
            hx2 += cols[i];
          });
          y += rh + 2;
        }

        // Alternate row bg
        if (idx % 2 === 0) r(doc, tx, y, tw, rh, C.rowAlt);
        // Color-code: green for payments, default for charges
        const isPayment = ln.type === 'payment';
        const descColor = isPayment ? C.green : C.dark;

        let cx = tx;
        const dateStr = ln.date ? new Date(ln.date).toLocaleDateString('en-PH', { month:'2-digit', day:'2-digit', year:'2-digit' }) : '';
        t(doc, dateStr, cx + 5, y + 5, { s: 7, c: C.mid, w: cols[0] - 10 });
        cx += cols[0];
        // Truncate description to fit
        const maxDescW = cols[1] - 10;
        let descText = ln.description || '';
        doc.save(); doc.font('Helvetica').fontSize(7);
        while (doc.widthOfString(descText) > maxDescW && descText.length > 10) descText = descText.slice(0, -4) + '...';
        doc.restore();
        t(doc, descText, cx + 5, y + 5, { s: 7, c: descColor, w: cols[1] - 10 });
        cx += cols[1];
        t(doc, ln.debit > 0 ? fmtMoney(ln.debit) : '', cx + 5, y + 5, { s: 7.5, c: C.dark, a: 'r', w: cols[2] - 10 });
        cx += cols[2];
        t(doc, ln.credit > 0 ? fmtMoney(ln.credit) : '', cx + 5, y + 5, { s: 7.5, c: C.green, a: 'r', w: cols[3] - 10 });
        cx += cols[3];
        t(doc, fmtMoney(ln.balance), cx + 5, y + 5, { s: 7.5, b: true, c: ln.balance > 0 ? C.red : C.green, a: 'r', w: cols[4] - 10 });
        l(doc, tx, y + rh, tx + tw, y + rh, C.border, 0.25);
        y += rh;
      };

      data.lines.forEach((ln, idx) => drawRow(ln, idx));

      // Totals row
      y += 2;
      l(doc, tx, y, tx + tw, y, C.dark, 1);
      y += 4;
      r(doc, tx, y, tw, rh + 4, C.bg, C.border);
      let cx = tx;
      t(doc, 'TOTALS', cx + 5, y + 6, { b: true, s: 8, c: C.dark });
      cx += cols[0] + cols[1];
      t(doc, fmtMoney(data.totalDebit), cx + 5, y + 6, { b: true, s: 8, c: C.dark, a: 'r', w: cols[2] - 10 });
      cx += cols[2];
      t(doc, fmtMoney(data.totalCredit), cx + 5, y + 6, { b: true, s: 8, c: C.green, a: 'r', w: cols[3] - 10 });
      cx += cols[3];
      t(doc, fmtMoney(data.finalBalance), cx + 5, y + 6, { b: true, s: 9, c: data.finalBalance > 0 ? C.red : C.green, a: 'r', w: cols[4] - 10 });
      y += rh + 16;

      // ── BALANCE SUMMARY BOX ──
      if (y < H - 160) {
        const boxColor = data.finalBalance <= 0 ? C.green : C.red;
        const boxBg = data.finalBalance <= 0 ? [240, 253, 244] : [254, 242, 242];
        r(doc, M, y, rw, 50, boxBg, boxColor);
        r(doc, M, y, 5, 50, boxColor);
        t(doc, data.finalBalance <= 0 ? '\u2713  ACCOUNT CURRENT — NO BALANCE DUE' : '\u26A0  OUTSTANDING BALANCE', M + 14, y + 10, { b: true, s: 10, c: boxColor });
        t(doc, data.finalBalance <= 0 ? 'All invoices have been settled. Thank you!' : 'Amount Due: ' + fmtMoney(data.finalBalance), M + 14, y + 28, { s: 9, c: data.finalBalance <= 0 ? C.mid : boxColor });
        t(doc, 'As of ' + data.generatedDate, M + rw - 140, y + 28, { s: 8, c: C.mid });
        y += 62;
      }

      // ── FOOTER ──
      l(doc, M, H - 50, W - M, H - 50, C.border, 0.5);
      t(doc, co.name + '  \u2022  ' + co.website + '  \u2022  Statement of Account', M, H - 40, { s: 6, c: C.light, a: 'c', w: rw });

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { generateSOAPDF };
