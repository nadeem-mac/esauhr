// =============================================================================
// offerLetterGenerator.js
//
// Generates a corporate-style bilingual offer letter as a single A4
// page PDF. Rendered as HTML in the browser, captured with
// html2canvas-pro, wrapped as A4 by jsPDF — so Arabic uses the OS's
// native Arabic-capable font with proper RTL bidi and letter
// joining (Helvetica embedded in jsPDF can't shape Arabic).
//
// Document structure (top to bottom):
//
//   ┌─ LETTERHEAD ────────────────────────────────────────────┐
//   │  Logo │ Company EN + corporate details │ Company AR     │
//   │       │ Branch · CR · Tel · Email      │ (mirrored RTL) │
//   ├─ Reference & date row ──────────────────────────────────┤
//   ├─ TITLE: LETTER OF OFFER · عرض عمل ──────────────────────┤
//   ├─ Intro paragraph (EN left ‖ AR right) ──────────────────┤
//   ├─ POSITION & COMPENSATION (band) ────────────────────────┤
//   │  Position table (EN label, AR below in black, value)    │
//   │  Salary breakdown table (same EN/AR stacking, amounts)  │
//   ├─ KEY TERMS · أهم البنود (band) ─────────────────────────┤
//   │  7 KSA-Labor-Law clauses, EN ‖ AR side-by-side          │
//   ├─ ⚠ 14-DAY VALIDITY CALLOUT (red accent, prominent) ─────┤
//   ├─ Acceptance instruction ────────────────────────────────┤
//   │                                                         │
//   │              (flex spacer — pushes ↓ down)              │
//   │                                                         │
//   ├─ SIGNATURES (bottom of page) ───────────────────────────┤
//   │  ┌─ For Evergreen ──┐  ┌─ Seal ─┐  ┌─ Candidate ─┐      │
//   │  │ Sig line         │  │  ⊕     │  │ Sig line    │      │
//   │  │ JOHN HO          │  └────────┘  │ [Name]      │      │
//   │  │ Country Head     │              │ Date        │      │
//   │  │ Company name     │                                   │
//   │  │ Branch Office    │                                   │
//   │  │ CR # · Tel · Email                                   │
//   ├─ Confidentiality footer ───────────────────────────────┤
//
// Per Nadeem's review of an earlier version: the "Reporting to"
// row was removed from the letter (manager_id is still saved on
// the offer record for internal tracking, just not displayed).
// =============================================================================

const A4_W_PX = 794;
const A4_H_PX = 1123;
const RENDER_SCALE = 2;

// Company contact details — single source of truth for the
// letterhead and the corporate signature block. If any of these
// change (new branch office, phone number, etc.) update them here.
const COMPANY = {
  nameFullEn:  'Evergreen Shipping Agency Saudi Co. (LLC)',
  nameFullAr:  'شركة إيفرغرين للملاحة المحدودة',
  brandEn:     'EVERGREEN LINE',
  brandAr:     'إيفرغرين لاين',
  branchEn:    'Branch Office: P.O. Box 1008, Dammam 31431, KSA',
  branchAr:    'فرع المكتب: ص.ب 1008، الدمام 31431، المملكة العربية السعودية',
  cr:          'C.R. 2050145335',
  computerNo:  'Computer No. 7023475051',
  tel:         '(013) 8333566',
  fax:         '(013) 8341182',
  email:       'esau@evergreen-shipping.com.sa',
  hrDeptEn:    'HR Department · Dammam',
  hrDeptAr:    'قسم الموارد البشرية · الدمام',
};

// ─── PDF: HTML → canvas → A4 PDF ──────────────────────────────────

export async function generateOfferLetterPDF(offer, signatory) {
  const container = document.createElement('div');
  container.id = 'offer-letter-render-host';
  container.innerHTML = buildLetterHtml(offer, signatory);

  Object.assign(container.style, {
    position: 'fixed',
    top: '0px',
    left: '-100000px',
    width: `${A4_W_PX}px`,
    height: `${A4_H_PX}px`,
    background: '#FFFFFF',
    pointerEvents: 'none',
    zIndex: '-1',
  });

  document.body.appendChild(container);

  try {
    if (document.fonts && typeof document.fonts.ready?.then === 'function') {
      await document.fonts.ready;
    }

    const img = container.querySelector('img.evg-logo');
    if (img && !img.complete) {
      await new Promise(resolve => {
        const done = () => resolve();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
        setTimeout(done, 3000);
      });
    }

    await new Promise(r => setTimeout(r, 100));

    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
      import('html2canvas-pro'),
      import('jspdf'),
    ]);

    const canvas = await html2canvas(container, {
      scale: RENDER_SCALE,
      backgroundColor: '#FFFFFF',
      logging: false,
      useCORS: true,
      width: A4_W_PX,
      height: A4_H_PX,
      windowWidth: A4_W_PX,
      windowHeight: A4_H_PX,
    });

    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    const imgData = canvas.toDataURL('image/jpeg', 0.92);
    pdf.addImage(imgData, 'JPEG', 0, 0, 210, 297);

    return pdf.output('blob');
  } finally {
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
  }
}

// ─── HTML BUILDER ──────────────────────────────────────────────────

function buildLetterHtml(offer, signatory) {
  const dateEN = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const dateAR = new Date().toLocaleDateString('ar-SA', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  // Compute the offer-expiry date (today + 14 days). Used to make
  // the validity callout concrete with a real deadline rather than
  // just saying "14 days".
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 14);
  const expiryEN = expiry.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const expiryAR = expiry.toLocaleDateString('ar-SA', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  // Reference number — short, human-readable. First 6 chars of the
  // offer token make a workable identifier (collision-free in
  // practice for HR's volume).
  const refToken = (offer.offerToken || '').slice(0, 6).toUpperCase();
  const yearShort = new Date().getFullYear();
  const ref = `ESAU/HR/${yearShort}/${refToken || 'XXXXXX'}`;

  const sar = (v) => `SAR ${Number(v || 0).toLocaleString('en-GB')}`;
  const e = escapeHtml;

  return `
    <style>
      .offer-letter, .offer-letter * { box-sizing: border-box; }
      .offer-letter {
        font-family: 'Helvetica Neue', 'Arial', sans-serif;
        color: #0F172A;
        line-height: 1.4;
        padding: 26px 34px 18px;
        font-size: 10.5px;
        width: ${A4_W_PX}px;
        height: ${A4_H_PX}px;
        background: #FFFFFF;
        position: relative;
        display: flex;
        flex-direction: column;
      }
      .offer-letter .ar {
        font-family: 'Tahoma', 'Geeza Pro', 'Arial Unicode MS', 'Segoe UI', sans-serif;
        direction: rtl;
        text-align: right;
        unicode-bidi: embed;
      }
      /* Top brand band */
      .offer-letter .brand-band {
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 5px;
        background: #0F4C2A;
      }

      /* ─── LETTERHEAD ─── */
      .offer-letter .letterhead {
        display: grid;
        grid-template-columns: 80px 1fr 1fr;
        gap: 14px;
        align-items: center;
        margin-top: 6px;
        flex-shrink: 0;
      }
      .offer-letter .letterhead img.evg-logo {
        width: 70px;
        height: 70px;
        object-fit: contain;
      }
      .offer-letter .letterhead .h1 {
        font-size: 15px;
        color: #0F4C2A;
        font-weight: 700;
        margin: 0 0 3px;
        letter-spacing: 0.3px;
      }
      .offer-letter .letterhead .company-name {
        font-size: 10px;
        color: #0F172A;
        font-weight: 600;
        line-height: 1.35;
      }
      .offer-letter .letterhead .corp-detail {
        font-size: 8.5px;
        color: #525252;
        line-height: 1.45;
      }

      /* ─── REFERENCE & DATE ROW ─── */
      .offer-letter .ref-date {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 9.5px;
        color: #0F172A;
        margin: 8px 0 6px;
        padding: 5px 0;
        border-top: 1px solid #E5E5E5;
        border-bottom: 1px solid #E5E5E5;
        flex-shrink: 0;
      }
      .offer-letter .ref-date strong { color: #0F4C2A; }

      /* ─── TITLE ─── */
      .offer-letter h2.title {
        text-align: center;
        font-size: 18px;
        color: #0F4C2A;
        font-weight: 700;
        margin: 8px 0 10px;
        letter-spacing: 1.5px;
        flex-shrink: 0;
      }

      /* ─── INTRO ─── */
      .offer-letter .intro {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
        margin-bottom: 10px;
        flex-shrink: 0;
      }
      .offer-letter .intro p {
        margin: 0 0 4px;
        line-height: 1.45;
        font-size: 10.5px;
      }
      .offer-letter .intro strong { color: #0F172A; font-weight: 700; }

      /* ─── SECTION BANDS ─── */
      .offer-letter .band {
        background: #D4E8DC;
        padding: 6px 10px;
        font-weight: 700;
        color: #0F4C2A;
        font-size: 11px;
        display: flex;
        justify-content: space-between;
        margin: 6px 0 6px;
        letter-spacing: 0.5px;
        flex-shrink: 0;
      }

      /* ─── POSITION & COMPENSATION ─── */
      .offer-letter .pos-comp {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px;
        margin-bottom: 6px;
        flex-shrink: 0;
      }

      /* Position table — Arabic stacked under English in BLACK */
      .offer-letter .pos-table {
        width: 100%;
      }
      .offer-letter .pos-table .row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        padding: 5px 0;
        border-bottom: 1px solid #EAEAEA;
        align-items: center;
      }
      .offer-letter .pos-table .row:last-child { border-bottom: none; }
      .offer-letter .pos-table .label-stack {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .offer-letter .pos-table .label-en {
        color: #0F172A;
        font-weight: 600;
        font-size: 10px;
      }
      .offer-letter .pos-table .label-ar {
        color: #0F172A;
        font-size: 10px;
        font-weight: 500;
      }
      .offer-letter .pos-table .value {
        color: #0F172A;
        font-weight: 700;
        font-size: 11px;
        text-align: right;
        white-space: nowrap;
      }

      /* Salary table — same Arabic-below-English treatment in black */
      .offer-letter .sal-table {
        width: 100%;
        border-collapse: collapse;
      }
      .offer-letter .sal-table thead th {
        background: #0F4C2A;
        color: #FFFFFF;
        font-size: 10px;
        font-weight: 700;
        padding: 6px 8px;
        text-align: left;
        letter-spacing: 0.4px;
      }
      .offer-letter .sal-table thead th.amount-col {
        text-align: right;
      }
      .offer-letter .sal-table tbody tr:nth-child(even) {
        background: #F8FAF8;
      }
      .offer-letter .sal-table tbody td {
        padding: 6px 8px;
        vertical-align: middle;
      }
      .offer-letter .sal-table tbody .label-stack {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .offer-letter .sal-table tbody .label-en {
        color: #0F172A;
        font-weight: 600;
        font-size: 10px;
      }
      .offer-letter .sal-table tbody .label-ar {
        color: #0F172A;
        font-size: 10px;
      }
      .offer-letter .sal-table tbody .amount {
        text-align: right;
        font-weight: 700;
        color: #0F172A;
        font-size: 11.5px;
        white-space: nowrap;
      }
      .offer-letter .sal-table tfoot td {
        background: #0F4C2A;
        color: #FFFFFF;
        font-weight: 700;
        font-size: 12px;
        padding: 8px;
      }
      .offer-letter .sal-table tfoot td.total-label-stack {
        display: table-cell;
      }
      .offer-letter .sal-table tfoot .total-en { font-size: 12px; }
      .offer-letter .sal-table tfoot .total-ar { font-size: 11px; opacity: 0.95; }
      .offer-letter .sal-table tfoot td.amount {
        text-align: right;
        font-size: 13px;
      }

      /* ─── KEY TERMS ─── */
      .offer-letter .terms-list {
        list-style: none;
        padding: 0;
        margin: 0 0 6px;
        flex-shrink: 0;
      }
      .offer-letter .terms-list li {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
        padding: 3.5px 0;
        font-size: 9.5px;
        border-bottom: 1px dotted #F0F0F0;
      }
      .offer-letter .terms-list li:last-child { border-bottom: none; }
      .offer-letter .terms-list .en::before {
        content: '◆ ';
        color: #0F4C2A;
        font-weight: 700;
        font-size: 8px;
      }
      .offer-letter .terms-list .ar::before {
        content: ' ◆';
        color: #0F4C2A;
        font-weight: 700;
        font-size: 8px;
      }

      /* ─── 14-DAY VALIDITY CALLOUT (prominent) ─── */
      .offer-letter .validity-callout {
        background: linear-gradient(to right, #FEF2F2 0%, #FEF6E2 100%);
        border: 1.5px solid #DC2626;
        border-left: 5px solid #DC2626;
        border-radius: 4px;
        padding: 10px 14px;
        margin: 8px 0;
        flex-shrink: 0;
      }
      .offer-letter .validity-callout .row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 18px;
        align-items: center;
      }
      .offer-letter .validity-callout .head {
        font-size: 11px;
        font-weight: 700;
        color: #991B1B;
        margin-bottom: 2px;
        letter-spacing: 0.3px;
      }
      .offer-letter .validity-callout .head.ar { font-size: 11.5px; }
      .offer-letter .validity-callout .deadline {
        font-size: 10px;
        color: #0F172A;
        font-weight: 600;
      }
      .offer-letter .validity-callout .deadline strong { color: #991B1B; }

      /* ─── ACCEPTANCE NOTE ─── */
      .offer-letter .accept-note {
        font-size: 9.5px;
        color: #525252;
        margin: 4px 0;
        padding: 0 2px;
        line-height: 1.5;
        flex-shrink: 0;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }

      /* ─── SPACER PUSHING SIGNATURES TO BOTTOM ─── */
      .offer-letter .spacer { flex: 1 1 auto; }

      /* ─── SIGNATURES ─── */
      .offer-letter .signatures {
        display: grid;
        grid-template-columns: 1.4fr 100px 1fr;
        gap: 14px;
        margin-top: 14px;
        align-items: stretch;
        flex-shrink: 0;
      }
      .offer-letter .sig-company,
      .offer-letter .sig-candidate {
        display: flex;
        flex-direction: column;
        font-size: 9.5px;
      }
      .offer-letter .sig-label {
        font-size: 8.5px;
        color: #525252;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 14px;
        font-weight: 600;
      }
      .offer-letter .sig-line {
        border-top: 1px solid #525252;
        margin-bottom: 6px;
        height: 0;
      }
      .offer-letter .sig-name {
        font-size: 11.5px;
        color: #0F172A;
        font-weight: 700;
        letter-spacing: 0.3px;
      }
      .offer-letter .sig-title {
        font-size: 10px;
        color: #525252;
        margin-top: 1px;
        margin-bottom: 8px;
      }
      .offer-letter .corp-block {
        margin-top: 4px;
        padding-top: 6px;
        border-top: 1px dashed #D5D5D5;
        font-size: 8.5px;
        line-height: 1.55;
        color: #0F172A;
      }
      .offer-letter .corp-block .corp-line { color: #525252; }
      .offer-letter .corp-block .corp-name { font-weight: 700; color: #0F4C2A; }

      .offer-letter .seal {
        width: 100px;
        height: 100px;
        border: 2px dashed #B5B5B5;
        border-radius: 50%;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        font-size: 8px;
        color: #999;
        text-align: center;
        line-height: 1.4;
        font-weight: 600;
        letter-spacing: 0.3px;
        align-self: center;
        margin: 0 auto;
      }

      .offer-letter .candidate-confirm {
        margin-top: 6px;
        font-size: 8.5px;
        color: #525252;
        line-height: 1.4;
        font-style: italic;
      }

      /* ─── CONFIDENTIALITY FOOTER ─── */
      .offer-letter .foot {
        margin-top: 10px;
        padding-top: 6px;
        border-top: 1px solid #E5E5E5;
        font-size: 7.5px;
        color: #999;
        display: flex;
        justify-content: space-between;
        flex-shrink: 0;
      }
    </style>

    <div class="offer-letter">
      <div class="brand-band"></div>

      <!-- LETTERHEAD with full corporate contact details -->
      <div class="letterhead">
        <div><img class="evg-logo" src="/evergreen-logo.jpg" alt="" /></div>
        <div>
          <div class="h1">${e(COMPANY.brandEn)}</div>
          <div class="company-name">${e(COMPANY.nameFullEn)}</div>
          <div class="corp-detail">${e(COMPANY.branchEn)}</div>
          <div class="corp-detail">${e(COMPANY.cr)} · ${e(COMPANY.computerNo)}</div>
          <div class="corp-detail">Tel: ${e(COMPANY.tel)} · Fax: ${e(COMPANY.fax)}</div>
          <div class="corp-detail">Email: ${e(COMPANY.email)}</div>
        </div>
        <div class="ar">
          <div class="h1">${e(COMPANY.brandAr)}</div>
          <div class="company-name">${e(COMPANY.nameFullAr)}</div>
          <div class="corp-detail">${e(COMPANY.branchAr)}</div>
          <div class="corp-detail">${e(COMPANY.cr)} · ${e(COMPANY.computerNo)}</div>
          <div class="corp-detail">هاتف: ${e(COMPANY.tel)} · فاكس: ${e(COMPANY.fax)}</div>
          <div class="corp-detail">البريد الإلكتروني: ${e(COMPANY.email)}</div>
        </div>
      </div>

      <!-- REFERENCE & DATE -->
      <div class="ref-date">
        <span><strong>Ref:</strong> ${e(ref)}</span>
        <span><strong>Date · التاريخ:</strong> ${e(dateEN)} · ${e(dateAR)}</span>
      </div>

      <!-- TITLE -->
      <h2 class="title">LETTER OF OFFER  ·  عرض عمل</h2>

      <!-- INTRO -->
      <div class="intro">
        <div>
          <p><strong>Dear ${e(offer.candidateName || '')},</strong></p>
          <p>We are pleased to extend you a formal offer of employment to join ${e(COMPANY.nameFullEn)} on the terms and conditions set out below. Acceptance is subject to your agreement to these Terms and successful onboarding through the SOL system.</p>
        </div>
        <div class="ar">
          <p><strong>السيد/ة ${e(offer.candidateName || '')} المحترم/ة،</strong></p>
          <p>يسرنا أن نقدم لكم عرض عمل رسمي للانضمام إلى ${e(COMPANY.nameFullAr)} وفقاً للشروط والأحكام المحددة أدناه. يخضع القبول لموافقتكم على هذه الشروط وإتمام إجراءات الالتحاق عبر نظام SOL.</p>
        </div>
      </div>

      <!-- POSITION & COMPENSATION BAND -->
      <div class="band">
        <span>POSITION &amp; COMPENSATION DETAILS</span>
        <span class="ar">تفاصيل الوظيفة والراتب</span>
      </div>

      <!-- POSITION + SALARY (side by side) -->
      <div class="pos-comp">
        <!-- Position table — Arabic stacked under English in BLACK -->
        <div class="pos-table">
          ${posRow('Position', 'الوظيفة', offer.positionTitle)}
          ${posRow('Department', 'الإدارة', offer.department)}
          ${posRow('Office', 'المكتب', offer.location)}
          ${posRow('Joining Date', 'تاريخ المباشرة', formatDateLong(offer.proposedJoinDate))}
          ${posRow('Probation Period', 'فترة التجربة', '90 days · 90 يوماً')}
          ${posRow('Working Hours', 'ساعات العمل', '40 hr/week · Sun-Thu')}
          ${posRow('Contract Type', 'نوع العقد', 'Indefinite · غير محدد')}
        </div>

        <!-- Salary table — Arabic below English in BLACK -->
        <table class="sal-table">
          <thead>
            <tr>
              <th>SALARY BREAKDOWN<br><span style="font-weight:500;font-size:9px;direction:rtl;display:inline-block;">تفاصيل الراتب</span></th>
              <th class="amount-col">Amount<br><span style="font-weight:500;font-size:9px;direction:rtl;display:inline-block;">المبلغ</span></th>
            </tr>
          </thead>
          <tbody>
            ${salRow('Basic Salary', 'الراتب الأساسي', sar(offer.salaryBasic))}
            ${salRow('Housing Allowance', 'بدل السكن', sar(offer.salaryHousing))}
            ${salRow('Transportation Allowance', 'بدل النقل', sar(offer.salaryTransport))}
            ${salRow('Other Allowance', 'بدل آخر', sar(offer.salaryOther))}
          </tbody>
          <tfoot>
            <tr>
              <td>
                <div class="total-en">TOTAL MONTHLY SALARY</div>
                <div class="total-ar ar">إجمالي الراتب الشهري</div>
              </td>
              <td class="amount">${sar(offer.salaryTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <!-- KEY TERMS BAND -->
      <div class="band">
        <span>KEY TERMS — Per KSA Labor Law</span>
        <span class="ar">أهم البنود — وفقاً لنظام العمل السعودي</span>
      </div>

      <ul class="terms-list">
        ${termRow('Probation: 90 days from joining date (Article 53)', 'فترة التجربة: 90 يوماً من تاريخ المباشرة (المادة 53)')}
        ${termRow('Notice period: 60 days written notice (Article 75)', 'فترة الإشعار: 60 يوماً إشعار خطي (المادة 75)')}
        ${termRow('Annual leave: 21 days (years 1–5), 30 days from year 6 (Art. 109)', 'الإجازة السنوية: 21 يوماً (السنوات 1-5)، 30 يوماً من السنة 6 (المادة 109)')}
        ${termRow('Sick leave: 30 days full + 60 days at 75% + 30 days unpaid (Art. 117)', 'الإجازة المرضية: 30 يوم بأجر كامل + 60 يوم بثلاثة أرباع الأجر + 30 يوم بدون أجر (المادة 117)')}
        ${termRow('End-of-service gratuity per Articles 84–88', 'مكافأة نهاية الخدمة وفقاً للمواد 84-88')}
        ${termRow('GOSI registration + medical insurance from joining date', 'التسجيل في التأمينات الاجتماعية + تأمين صحي من تاريخ المباشرة')}
        ${termRow('Confidentiality of Company information during &amp; after employment', 'السرية التامة لمعلومات الشركة أثناء العمل وبعده')}
      </ul>

      <!-- 14-DAY VALIDITY CALLOUT (prominent, red accent) -->
      <div class="validity-callout">
        <div class="row">
          <div>
            <div class="head">⏱  THIS OFFER IS VALID FOR 14 DAYS ONLY</div>
            <div class="deadline">Please accept by <strong>${e(expiryEN)}</strong>. After this date the offer expires automatically.</div>
          </div>
          <div class="ar">
            <div class="head ar">⏱  هذا العرض صالح لمدة 14 يوماً فقط</div>
            <div class="deadline ar">يرجى القبول قبل <strong>${e(expiryAR)}</strong>. بعد هذا التاريخ ينتهي العرض تلقائياً.</div>
          </div>
        </div>
      </div>

      <!-- ACCEPTANCE INSTRUCTION -->
      <div class="accept-note">
        <div>To accept, please use the secure acceptance link sent in the covering email. After acceptance, HR will register you in SOL and issue your Personal Service Number (PSN).</div>
        <div class="ar">للقبول، يرجى استخدام رابط القبول الآمن المرسل في الإيميل المرفق. بعد القبول، تقوم الموارد البشرية بتسجيلكم في SOL وإصدار رقم الخدمة الشخصي.</div>
      </div>

      <!-- SPACER pushing signatures to bottom -->
      <div class="spacer"></div>

      <!-- SIGNATURES at bottom of page -->
      <div class="signatures">
        <!-- LEFT: Company side, full corporate signature -->
        <div class="sig-company">
          <div class="sig-label">For and on behalf of · عن الشركة</div>
          <div class="sig-line"></div>
          <div class="sig-name">${e((signatory?.name || '—').toUpperCase())}</div>
          <div class="sig-title">${e(signatory?.title || '—')}</div>
          <div class="corp-block">
            <div class="corp-name">${e(COMPANY.nameFullEn)}</div>
            <div class="corp-line">${e(COMPANY.branchEn)}</div>
            <div class="corp-line">${e(COMPANY.cr)}</div>
            <div class="corp-line">Tel: ${e(COMPANY.tel)} · Fax: ${e(COMPANY.fax)}</div>
            <div class="corp-line">${e(COMPANY.email)}</div>
          </div>
        </div>

        <!-- MIDDLE: Company seal placeholder -->
        <div class="seal">
          <div>COMPANY</div>
          <div>SEAL</div>
          <div class="ar" style="margin-top:5px;">ختم الشركة</div>
        </div>

        <!-- RIGHT: Candidate signature -->
        <div class="sig-candidate">
          <div class="sig-label">Candidate Acceptance · قبول المرشح</div>
          <div class="sig-line"></div>
          <div class="sig-name">${e((offer.candidateName || '—').toUpperCase())}</div>
          <div class="sig-title">Signature &amp; Date · التوقيع والتاريخ</div>
          <div class="candidate-confirm">By signing, I accept the offer above and the Terms set out in this letter.<br><span class="ar" style="display:block;margin-top:3px;">بالتوقيع أعلاه، أقبل العرض والشروط الواردة في هذا الخطاب.</span></div>
        </div>
      </div>

      <!-- CONFIDENTIALITY FOOTER -->
      <div class="foot">
        <span>Confidential · addressed solely to the named candidate.</span>
        <span class="ar">سري · مخصص للمرشح المسمى أعلاه فقط.</span>
      </div>
    </div>
  `;
}

// ─── HTML helper templates ─────────────────────────────────────────

function posRow(en, ar, value) {
  const e = escapeHtml;
  return `
    <div class="row">
      <div class="label-stack">
        <div class="label-en">${e(en)}</div>
        <div class="label-ar ar">${e(ar)}</div>
      </div>
      <div class="value">${e(value || '—')}</div>
    </div>
  `;
}

function salRow(en, ar, amount) {
  const e = escapeHtml;
  return `
    <tr>
      <td>
        <div class="label-stack">
          <div class="label-en">${e(en)}</div>
          <div class="label-ar ar">${e(ar)}</div>
        </div>
      </td>
      <td class="amount">${e(amount)}</td>
    </tr>
  `;
}

function termRow(en, ar) {
  const e = escapeHtml;
  return `
    <li>
      <span class="en">${e(en)}</span>
      <span class="ar">${e(ar)}</span>
    </li>
  `;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateLong(yyyymmdd) {
  if (!yyyymmdd) return '—';
  const [y, m, d] = String(yyyymmdd).split('-').map(Number);
  if (!y || !m || !d) return yyyymmdd;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ═══════════════════════════════════════════════════════════════════
// EMAIL (.eml) GENERATION — unchanged
// ═══════════════════════════════════════════════════════════════════

export function buildOfferEmailBody(offer, acceptanceUrl, sender) {
  const candidate = offer.candidateName || 'Candidate';
  const position = offer.positionTitle || 'the role';

  return [
    `Dear ${candidate},`,
    ``,
    `We are pleased to extend an offer for the position of ${position} at Evergreen Shipping Agency Saudi Co. (LLC).`,
    ``,
    `Please find the formal offer letter attached. The letter contains the full details of the position, salary breakdown, joining date, and key terms in both English and Arabic.`,
    ``,
    `To accept this offer, please click the secure acceptance link below:`,
    ``,
    `  ${acceptanceUrl}`,
    ``,
    `IMPORTANT: This offer is valid for 14 days only. Please accept within this period or the offer will expire automatically.`,
    ``,
    `After accepting, we will proceed with onboarding through the SOL system and issue your Personal Service Number (PSN).`,
    ``,
    `If you have any questions or wish to discuss any of the terms, please reply to this email — I will be happy to help.`,
    ``,
    `We look forward to welcoming you to the team.`,
    ``,
    `Best regards,`,
    `${sender.name}`,
    `Evergreen Shipping Agency Saudi Co. (LLC)`,
    `${sender.email}`,
  ].join('\r\n');
}

export async function buildEmlMessage(args) {
  const {
    fromName, fromEmail, toEmail, toName,
    subject, body, pdfBlob, pdfFilename,
  } = args;

  const pdfBase64 = await blobToBase64(pdfBlob);
  const wrappedBase64 = wrapLine(pdfBase64, 76);

  const boundary = 'evergreen-offer-' + Math.random().toString(36).slice(2, 10);
  const dateHeader = new Date().toUTCString().replace('GMT', '+0000');
  const fromHeader = `${escapeHeader(fromName)} <${fromEmail}>`;
  const toHeader   = toName ? `${escapeHeader(toName)} <${toEmail}>` : toEmail;

  const lines = [
    `From: ${fromHeader}`,
    `To: ${toHeader}`,
    `Subject: ${escapeHeader(subject)}`,
    `Date: ${dateHeader}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    quotedPrintableEncode(body),
    ``,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${pdfFilename}"`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="${pdfFilename}"`,
    ``,
    wrappedBase64,
    ``,
    `--${boundary}--`,
    ``,
  ];

  const eml = lines.join('\r\n');
  return new Blob([eml], { type: 'message/rfc822' });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const base64 = dataUrl.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function wrapLine(s, width) {
  if (!s) return '';
  const lines = [];
  for (let i = 0; i < s.length; i += width) {
    lines.push(s.slice(i, i + width));
  }
  return lines.join('\r\n');
}

function escapeHeader(s) {
  const str = String(s || '');
  if (/[^\x20-\x7E]/.test(str) || /["\\]/.test(str)) {
    const b64 = btoa(unescape(encodeURIComponent(str)));
    return `=?UTF-8?B?${b64}?=`;
  }
  return str;
}

function quotedPrintableEncode(text) {
  if (!text) return '';
  const bytes = new TextEncoder().encode(text);
  let out = '';
  let lineLen = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    let chunk;
    if (b === 0x0d) continue;
    if (b === 0x0a) { out += '\r\n'; lineLen = 0; continue; }
    if (b === 0x3d) chunk = '=3D';
    else if (b >= 0x20 && b <= 0x7e) chunk = String.fromCharCode(b);
    else chunk = '=' + b.toString(16).toUpperCase().padStart(2, '0');
    if (lineLen + chunk.length > 75) { out += '=\r\n'; lineLen = 0; }
    out += chunk;
    lineLen += chunk.length;
  }
  return out;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function generateOfferToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
