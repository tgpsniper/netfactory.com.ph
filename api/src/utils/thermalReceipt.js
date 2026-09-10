// ════════════════════════════════════════════════════════════
// Thermal receipt (POS58 / POS80)
// ════════════════════════════════════════════════════════════
// Renders a payment receipt as a self-contained HTML page sized for a
// continuous thermal roll, then prints itself.
//
// Why HTML and not the PDFKit path used for the A4 invoice: thermal rolls have
// no page height. The receipt has to be ONE page of whatever height the content
// needs, which is exactly what `@page { size: <roll>mm auto }` expresses and
// what a fixed-size PDF cannot. Getting that wrong is what makes a receipt come
// out as a landscape A4 sheet with the address wrapped into a column.
//
// Widths are the paper, not the print head. A 58mm roll prints ~48mm (384 dots
// at 203 dpi) and an 80mm roll ~72mm (576 dots); the driver centres that inside
// the declared page, so `size` gets the roll width and the body gets the
// printable width.

const { getCompanySettings } = require('./invoicePdf');

// `cols` is the character grid the receipt is laid out on — 32 across a 58mm
// roll and 46 across an 80mm one, which is what POS printers themselves use in
// Font A. Everything downstream is sized from it: the font is whatever makes
// exactly that many monospace characters span the printable width, and the
// label column is measured in `ch`, not millimetres. That is what keeps a field
// on one line — a fixed-mm label column steals most of a 48mm body and forces
// every value to wrap.
// 40 columns on 58mm is chosen from the data, not from taste: across every
// subscriber and invoice on file the longest value that has to sit on one line
// is a 30-character name, and 8 (label) + 1 (gap) + 30 lands on 39. 40 gives a
// character of headroom and puts the font at ~5.7pt, which is 16 dots tall on a
// 203dpi head — the printer's own Font B, so it stays crisp. 80mm uses 48, the
// standard POS80 Font A.
const PAPER = {
  58: { page: 58, body: 48, cols: 40, line: 1.3 },
  80: { page: 80, body: 72, cols: 48, line: 1.32 },
};

// Courier advances 0.6em per character, so a cell of (body / cols) mm needs a
// font of cell / 0.6 mm, converted to points at 72pt per inch.
const fontPt = (P) => ((P.body / P.cols) / 0.6) * (72 / 25.4);

const ONES = ['Zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten',
  'Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
const TENS = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];

// 999 → "Nine Hundred Ninety Nine". Used for the "Amount in words" line, which
// is what makes a printed receipt hard to alter after the fact.
function inWords(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + inWords(n % 100) : '');
  for (const [limit, label] of [[1e12, 'Trillion'], [1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']]) {
    if (n >= limit) return inWords(Math.floor(n / limit)) + ' ' + label + (n % limit ? ' ' + inWords(n % limit) : '');
  }
  return String(n);
}

function pesosInWords(v) {
  const n = Math.round((Number(v) || 0) * 100) / 100;
  const whole = Math.floor(n);
  const cents = Math.round((n - whole) * 100);
  const unit = (x, one, many) => x === 1 ? one : many;
  return inWords(whole) + ' ' + unit(whole, 'Peso', 'Pesos')
    + (cents ? ' and ' + inWords(cents) + ' ' + unit(cents, 'Centavo', 'Centavos') : '')
    + ' Only';
}

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const peso = (v) => (Number(v) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Philippine local time, spelled out rather than locale-dependent, so the
// receipt reads the same regardless of the printing machine's locale.
function stamp(d, withTime = true) {
  if (!d) return '';
  const opts = { timeZone: 'Asia/Manila', day: '2-digit', month: 'short', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return new Date(d).toLocaleString('en-PH', opts).replace(/,/g, '');
}

// A counter payment entered by date is stored anchored to noon UTC so it cannot
// slip across a day boundary (see the payment route). That anchor is not a real
// clock time, and printing "20:00:00" on an official receipt would assert a
// precision the record does not have — so the date prints alone in that case.
// Payments captured live (online gateways, same-day recording) keep their time.
function isDateOnlyStamp(d) {
  const t = new Date(d);
  return t.getUTCHours() === 12 && t.getUTCMinutes() === 0
      && t.getUTCSeconds() === 0 && t.getUTCMilliseconds() === 0;
}

async function getReceiptData(prisma, invoiceId) {
  const inv = await prisma.invoices.findUnique({
    where: { id: parseInt(invoiceId) },
    include: {
      subscriber: { include: { plan: true, municipality: true, barangay: true } },
      payments: { where: { status: 'success' }, orderBy: { paid_at: 'desc' } },
    },
  });
  if (!inv) throw new Error('Invoice not found');
  const co = await getCompanySettings(prisma);
  const sub = inv.subscriber;
  const pay = inv.payments[0] || null;

  // Name as it appears on the account: "Last, First Middle" for a person,
  // company name for a business account.
  const person = [
    (sub.last_name || '').trim() ? (sub.last_name || '').trim() + ',' : '',
    (sub.first_name || '').trim(),
    (sub.middle_name || '').trim(),
  ].filter(Boolean).join(' ').trim();
  const name = sub.company_name || person || sub.account_number;

  const address = [sub.address, sub.barangay?.name, sub.municipality?.name]
    .map(x => (x || '').trim()).filter(Boolean).join(', ');

  const paidTotal = inv.payments.reduce((a, p) => a + Number(p.amount), 0);
  const gross = Number(inv.amount) + Number(inv.overdue_fee || 0);

  const planLabel = sub.plan
    ? sub.plan.name + (sub.plan.speed_mbps ? ' ' + sub.plan.speed_mbps + 'Mbps' : '')
    : (inv.billing_period || 'Service');

  return {
    co,
    invoiceNumber: inv.invoice_number,
    accountNumber: sub.account_number,
    name, address,
    period: inv.billing_period || '',
    status: inv.status,
    amount: Number(inv.amount),
    overdueFee: Number(inv.overdue_fee || 0),
    total: gross,
    paidTotal: Math.round(paidTotal * 100) / 100,
    balance: Math.max(0, Math.round((gross - paidTotal) * 100) / 100),
    planLabel,
    payment: pay ? {
      paidAt: pay.paid_at, method: pay.method,
      reference: pay.reference_number, orNumber: pay.or_number,
      amount: Number(pay.amount),
    } : null,
  };
}

// `width` is the roll in mm (58 or 80). `copies` prints the same receipt more
// than once in one job — the usual case is two, one for the payer and one for
// the collector, separated by a cut line.
function buildReceiptHtml(d, { width = 58, copies = 1, autoPrint = true } = {}) {
  const P = PAPER[width] || PAPER[58];
  const fs = fontPt(P);
  // Longest label ("Address", "Account", "Invoice", "Printed") is 7 characters;
  // the box holds the label plus its colon.
  const LABEL = 8;
  const co = d.co;
  const paid = d.status === 'paid';

  // A label/value pair. The value column wraps rather than overflowing, which
  // is what a long address needs on a 48mm-wide body.
  const row = (label, value) => value === '' || value == null ? '' :
    `<div class="r"><span class="k">${esc(label)}</span><span class="v">${esc(value)}</span></div>`;

  // The address is the one field no font size can fit — up to 108 characters on
  // file. It gets the full paper width instead of the value column, so its
  // continuation lines run edge to edge: one or two fewer lines of paper per
  // receipt, at the cost of wrapping back under the label rather than hanging.
  const rowWrap = (label, value) => value === '' || value == null ? '' :
    `<div class="rw"><span class="k2">${esc(label)}</span>${esc(value)}</div>`;

  const money = (label, value, cls) =>
    `<div class="m ${cls || ''}"><span>${esc(label)}</span><span>${esc(peso(value))}</span></div>`;

  const one = () => `
  <div class="rcpt">
    ${co.logoPath ? `<img class="logo" src="${esc(co.logoPath)}" alt="">` : ''}
    <div class="co">${esc(co.name)}</div>
    <div class="addr">${esc([co.address1, co.address2, co.city].filter(Boolean).join(', '))}</div>
    ${co.tin ? `<div class="addr">${esc(co.vatLabel)}: ${esc(co.tin)}</div>` : ''}
    ${co.website ? `<div class="addr">${esc(co.website)}</div>` : ''}
    <div class="title">${paid ? 'OFFICIAL RECEIPT' : 'STATEMENT OF ACCOUNT'}</div>
    <div class="hr"></div>
    ${row('Invoice', d.invoiceNumber)}
    ${row('Account', d.accountNumber)}
    ${row('Name', d.name)}
    ${rowWrap('Address', d.address)}
    ${row('Period', d.period)}
    ${row('Status', d.status.toUpperCase())}
    ${d.payment ? row('Paid', stamp(d.payment.paidAt, !isDateOnlyStamp(d.payment.paidAt))) : ''}
    ${d.payment && d.payment.method ? row('Method', String(d.payment.method).toUpperCase()) : ''}
    ${d.payment && d.payment.orNumber ? row('OR No', d.payment.orNumber) : ''}
    ${d.payment && d.payment.reference ? row('Ref', d.payment.reference) : ''}
    ${row('Printed', stamp(new Date()))}
    <div class="hr2"></div>
    <div class="item">
      <div class="desc">${esc(d.planLabel)} x 1</div>
      ${money('Price', d.amount)}
      ${d.overdueFee > 0 ? money('Overdue fee', d.overdueFee) : ''}
    </div>
    <div class="hr"></div>
    ${money('TOTAL', d.total, 'big')}
    ${d.paidTotal > 0 ? money('Amount Paid', d.paidTotal) : ''}
    ${d.balance > 0 ? money('Balance Due', d.balance, 'big') : ''}
    <div class="hr"></div>
    <div class="words">Amount in words:<br>${esc(pesosInWords(paid ? d.paidTotal : d.total))}</div>
    <div class="hr"></div>
    <div class="foot">
      ${paid ? 'THIS SERVES AS YOUR OFFICIAL RECEIPT' : 'THIS IS NOT AN OFFICIAL RECEIPT'}
      <br>Thank you for your payment!
      ${co.website ? '<br>' + esc(co.website) : ''}
    </div>
    <div class="cut">${'- '.repeat(Math.floor(P.cols / 2)).trim()}</div>
  </div>`;

  const body = Array.from({ length: Math.max(1, Math.min(5, copies)) }, one).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>${esc(d.invoiceNumber)} — ${width}mm receipt</title>
<style>
  /* The roll has no page height: one page, content-height. Getting this wrong
     is what turns a receipt into a landscape A4 sheet. */
  @page { size: ${P.page}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body {
    width: ${P.body}mm;
    /* Thermal heads are 1-bit: pure black on white, no greys, no fills. */
    color: #000;
    font-family: "Courier New", Courier, "DejaVu Sans Mono", monospace;
    /* Sized so exactly ${P.cols} characters span the printable width. */
    font-size: ${fs.toFixed(2)}pt;
    line-height: ${P.line};
    -webkit-font-smoothing: none;
  }
  .rcpt { padding: 2mm 1mm 0; page-break-after: always; }
  .rcpt:last-child { page-break-after: auto; }
  .logo { display: block; margin: 0 auto 1mm; max-width: 60%; max-height: 12mm; filter: grayscale(1) contrast(1.6); }
  .co { text-align: center; font-weight: 700; font-size: ${(fs * 1.5).toFixed(2)}pt; letter-spacing: .5px; }
  .addr, .foot { text-align: center; }
  .title { text-align: center; font-weight: 700; margin: 1.2mm 0 .4mm; letter-spacing: 1px; }
  .hr  { border-top: 1px dashed #000; margin: 1mm 0; }
  .hr2 { border-top: 1px solid #000;  margin: 1mm 0; }
  /* Label column is ${LABEL}ch wide — the longest label plus its colon — so the
     value keeps the remaining ${P.cols - LABEL - 1} characters and ordinary
     fields (invoice number, account, name, timestamps) sit on one line. */
  .r { display: flex; gap: 1ch; align-items: baseline; }
  .r .k { flex: 0 0 ${LABEL}ch; display: flex; justify-content: space-between; white-space: nowrap; }
  .r .k::after { content: ":"; }
  /* Free text longer than the value column — an address, a long billing period
     — still has to wrap; no legible size fits 50 characters across 48mm. It
     wraps with a hanging indent so continuation lines stay in the value column
     instead of running back under the label. */
  .r .v { flex: 1 1 auto; min-width: 0; word-break: break-word; overflow-wrap: anywhere; }
  .rw { word-break: break-word; overflow-wrap: anywhere; }
  .rw .k2 { display: inline-block; width: ${LABEL}ch; margin-right: 1ch; }
  .rw .k2::after { content: ":"; float: right; }
  .item .desc { font-weight: 700; word-break: break-word; margin-bottom: .4mm; }
  .m { display: flex; justify-content: space-between; gap: 1ch; }
  .m.big { font-weight: 700; }
  .words { word-break: break-word; }
  .foot { margin-top: 1.5mm; }
  /* Feed past the tear bar so the last line is not left inside the printer. */
  .cut { text-align: center; margin-top: 2.5mm; padding-bottom: 8mm; }
  @media screen {
    body { margin: 16px auto; box-shadow: 0 0 0 1px #d4d4d8; background: #fff; }
    html { background: #f4f4f5; }
  }
</style></head>
<body>
${body}
${autoPrint ? `<script>
  // Wait for the logo so it is not dropped from the first print job.
  function go(){ window.focus(); window.print(); }
  window.onload = function(){
    var img = document.querySelector('.logo');
    if (img && !img.complete) { img.onload = img.onerror = go; setTimeout(go, 1500); }
    else { go(); }
  };
  window.onafterprint = function(){ window.close(); };
<\/script>` : ''}
</body></html>`;
}

async function renderThermalReceipt(prisma, invoiceId, opts) {
  const d = await getReceiptData(prisma, invoiceId);
  return buildReceiptHtml(d, opts);
}

module.exports = { renderThermalReceipt, buildReceiptHtml, getReceiptData, pesosInWords, PAPER };
