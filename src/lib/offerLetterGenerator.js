// =============================================================================
// offerLetterGenerator.js
//
// Generates the offer letter PDF by:
//   1. Building the letter as HTML/CSS (A4-sized, full bilingual)
//   2. Letting the browser render it (so Arabic uses the OS's
//      Arabic-capable fonts with proper RTL letter shaping)
//   3. html2canvas-pro captures the rendered DOM to a canvas
//   4. jsPDF wraps the canvas as a single-page A4 PDF
//
// Also exports the .eml builder, token generator, and download
// helper (unchanged from previous version).
//
// Why HTML instead of jsPDF.text():
//   jsPDF's built-in text() only supports Latin scripts. Arabic
//   strings render as garbled Latin1 codepoints because the
//   default Helvetica has no Arabic glyphs. Our previous version
//   produced unreadable Arabic on the offer letter.
//
//   HTML rendered in the browser uses whatever Arabic-capable
//   font the OS provides (Tahoma on Windows, Geeza Pro on macOS,
//   DejaVu Sans on Linux) which handles RTL bidirectional layout,
//   letter joining (ligatures), and contextual shaping natively.
//
// Why html2canvas-pro instead of html2canvas:
//   Pro is the actively-maintained fork that handles modern CSS
//   features (oklch colors, container queries, etc.) without
//   throwing warnings. The original html2canvas hasn't been
//   updated in 2+ years and trips on common CSS we use.
//
// A4 dimensions:
//   210mm × 297mm = 794px × 1123px at 96dpi (the browser default).
//   Container is locked to those exact pixel dimensions so the
//   captured canvas matches A4 perfectly when scaled to mm in
//   jsPDF.
// =============================================================================

const A4_W_PX = 794;
const A4_H_PX = 1123;
const RENDER_SCALE = 2;  // 2x for crisp print output (~190dpi effective)

// ─── PDF: HTML → canvas → A4 PDF ──────────────────────────────────

/**
 * Generate the offer letter PDF as a Blob.
 *
 * @param {Object} offer
 * @param {string} offer.candidateName
 * @param {string} offer.positionTitle
 * @param {string} offer.department
 * @param {string} offer.location
 * @param {string} offer.proposedJoinDate     YYYY-MM-DD
 * @param {number} offer.salaryBasic
 * @param {number} offer.salaryHousing
 * @param {number} offer.salaryTransport
 * @param {number} offer.salaryOther
 * @param {number} offer.salaryTotal
 * @param {string} [offer.managerName]
 * @param {Object} signatory                  { name, title }
 */
export async function generateOfferLetterPDF(offer, signatory) {
  // Build off-screen DOM container with the letter HTML
  const container = document.createElement('div');
  container.id = 'offer-letter-render-host';
  container.innerHTML = buildLetterHtml(offer, signatory);

  Object.assign(container.style, {
    position: 'fixed',
    top: '0px',
    left: '-100000px',  // off-screen; html2canvas still captures it
    width: `${A4_W_PX}px`,
    height: `${A4_H_PX}px`,
    background: '#FFFFFF',
    pointerEvents: 'none',
    zIndex: '-1',
  });

  document.body.appendChild(container);

  try {
    // Wait for fonts to fully load before capture — otherwise
    // html2canvas captures placeholder glyphs.
    if (document.fonts && typeof document.fonts.ready?.then === 'function') {
      await document.fonts.ready;
    }

    // Wait for the logo image to load (or fail). Without this,
    // the capture happens before the logo is decoded and the PDF
    // shows a broken-image placeholder.
    const img = container.querySelector('img.evg-logo');
    if (img && !img.complete) {
      await new Promise(resolve => {
        const done = () => resolve();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
        // Safety timeout — if the logo can't load, render without
        // it rather than blocking forever.
        setTimeout(done, 3000);
      });
    }

    // Small additional delay so any layout shifts settle. Modern
    // browsers paint asynchronously and html2canvas can fire too
    // early on fast machines.
    await new Promise(r => setTimeout(r, 100));

    // Lazy-load both libraries (only on offer creation, never on
    // app start) so the bundle stays light for the 99% of users
    // who never trigger this codepath.
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

    // Wrap the canvas as a single A4 page.
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    // jpeg compression keeps the file size reasonable; the offer
    // letter is graphical so PNG would be 4-8x larger for no
    // visible quality gain.
    const imgData = canvas.toDataURL('image/jpeg', 0.92);
    pdf.addImage(imgData, 'JPEG', 0, 0, 210, 297);

    return pdf.output('blob');
  } finally {
    // Always clean up — leaving the off-screen div in the DOM
    // would slowly grow memory after repeated offer generation.
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
  // Arabic locale gives us Hijri-aware month names where the OS
  // supports it; falls back to Gregorian otherwise.
  const dateAR = new Date().toLocaleDateString('ar-SA', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  const sar = (v) => `SAR ${Number(v || 0).toLocaleString('en-GB')}`;
  const e = escapeHtml;

  return `
    <style>
      .offer-letter, .offer-letter * { box-sizing: border-box; }
      .offer-letter {
        font-family: 'Helvetica Neue', 'Arial', sans-serif;
        color: #0F172A;
        line-height: 1.4;
        padding: 26px 36px 22px;
        font-size: 11px;
        width: ${A4_W_PX}px;
        height: ${A4_H_PX}px;
        background: #FFFFFF;
        position: relative;
      }
      .offer-letter .ar {
        font-family: 'Tahoma', 'Geeza Pro', 'Arial Unicode MS', 'Segoe UI', sans-serif;
        direction: rtl;
        text-align: right;
        unicode-bidi: embed;
      }
      .offer-letter .brand-band {
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 5px;
        background: #0F4C2A;
      }
      .offer-letter .header {
        display: grid;
        grid-template-columns: 80px 1fr 1fr;
        gap: 14px;
        align-items: center;
        margin-top: 8px;
      }
      .offer-letter .header img.evg-logo {
        width: 70px;
        height: 70px;
        object-fit: contain;
      }
      .offer-letter .header .h1-en, .offer-letter .header .h1-ar {
        font-size: 14px;
        color: #0F4C2A;
        font-weight: 700;
        margin: 0 0 3px;
      }
      .offer-letter .header .sub {
        font-size: 9px;
        color: #737373;
        line-height: 1.35;
      }
      .offer-letter .date-row {
        display: flex;
        justify-content: space-between;
        font-size: 9px;
        color: #525252;
        margin: 8px 0 10px;
        padding-top: 6px;
        border-top: 1px solid #E5E5E5;
      }
      .offer-letter h2.title {
        text-align: center;
        font-size: 17px;
        color: #0F4C2A;
        font-weight: 700;
        margin: 6px 0 12px;
        letter-spacing: 1.5px;
      }
      .offer-letter .two-col-intro {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 18px;
        margin-bottom: 12px;
      }
      .offer-letter .two-col-intro p {
        margin: 0 0 5px;
        line-height: 1.45;
      }
      .offer-letter .two-col-intro strong {
        color: #0F172A;
      }
      .offer-letter .band {
        background: #D4E8DC;
        padding: 6px 10px;
        font-weight: 700;
        color: #0F4C2A;
        font-size: 11px;
        display: flex;
        justify-content: space-between;
        margin: 6px 0 8px;
        letter-spacing: 0.5px;
      }
      .offer-letter .details-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 18px;
        margin-bottom: 10px;
      }
      .offer-letter .position-table .row {
        display: grid;
        grid-template-columns: 1fr auto;
        padding: 5px 0;
        border-bottom: 1px solid #F0F0F0;
        font-size: 10px;
        align-items: center;
      }
      .offer-letter .position-table .label {
        color: #525252;
      }
      .offer-letter .position-table .label-ar {
        font-size: 9px;
        color: #999;
        margin-top: 1px;
      }
      .offer-letter .position-table .value {
        color: #0F172A;
        font-weight: 700;
        font-size: 11px;
        text-align: right;
      }
      .offer-letter .salary-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 10px;
      }
      .offer-letter .salary-table th, .offer-letter .salary-table td {
        padding: 5px 8px;
      }
      .offer-letter .salary-table thead th {
        background: #0F4C2A;
        color: #FFFFFF;
        font-size: 10px;
        text-align: left;
        font-weight: 700;
        letter-spacing: 0.4px;
      }
      .offer-letter .salary-table thead th.ar {
        text-align: right;
      }
      .offer-letter .salary-table tbody tr:nth-child(even) {
        background: #F8FAF8;
      }
      .offer-letter .salary-table tbody td.label-en {
        color: #525252;
      }
      .offer-letter .salary-table tbody td.label-ar {
        font-size: 9.5px;
        color: #737373;
      }
      .offer-letter .salary-table tbody td.amount {
        text-align: right;
        font-weight: 700;
        color: #0F172A;
        font-size: 11px;
        white-space: nowrap;
      }
      .offer-letter .salary-table tfoot td {
        background: #0F4C2A;
        color: #FFFFFF;
        font-weight: 700;
        font-size: 12px;
        padding: 7px 8px;
      }
      .offer-letter .salary-table tfoot td.amount {
        text-align: right;
      }
      .offer-letter .terms-list {
        list-style: none;
        padding: 0;
        margin: 0 0 8px;
      }
      .offer-letter .terms-list li {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 18px;
        padding: 4px 0;
        font-size: 10px;
        border-bottom: 1px dotted #F0F0F0;
      }
      .offer-letter .terms-list .en::before {
        content: '• ';
        color: #0F4C2A;
        font-weight: 700;
      }
      .offer-letter .terms-list .ar::before {
        content: ' •';
        color: #0F4C2A;
        font-weight: 700;
      }
      .offer-letter .accept-box {
        background: #FEF6E2;
        border: 1px solid #E8C896;
        border-radius: 4px;
        padding: 8px 12px;
        margin: 8px 0;
        font-size: 10px;
        color: #854F0B;
      }
      .offer-letter .accept-box .row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 18px;
        line-height: 1.45;
      }
      .offer-letter .signatures {
        display: grid;
        grid-template-columns: 1fr 130px 1fr;
        gap: 18px;
        margin-top: 26px;
        align-items: end;
      }
      .offer-letter .sig-col {
        font-size: 10px;
      }
      .offer-letter .sig-col .line {
        border-top: 1px solid #737373;
        margin-bottom: 7px;
        height: 0;
      }
      .offer-letter .sig-col strong {
        font-size: 11.5px;
        color: #0F172A;
        font-weight: 700;
      }
      .offer-letter .sig-col .meta {
        color: #737373;
        margin-top: 2px;
        line-height: 1.4;
      }
      .offer-letter .seal {
        width: 110px;
        height: 110px;
        border: 2px dashed #B5B5B5;
        border-radius: 50%;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        font-size: 8.5px;
        color: #999;
        text-align: center;
        line-height: 1.4;
        margin: 0 auto;
        font-weight: 600;
        letter-spacing: 0.5px;
      }
      .offer-letter .foot {
        position: absolute;
        bottom: 18px;
        left: 36px;
        right: 36px;
        padding-top: 6px;
        border-top: 1px solid #E5E5E5;
        font-size: 8px;
        color: #999;
        display: flex;
        justify-content: space-between;
      }
    </style>

    <div class="offer-letter">
      <div class="brand-band"></div>

      <div class="header">
        <div><img class="evg-logo" src="/evergreen-logo.jpg" alt="" /></div>
        <div>
          <div class="h1-en">EVERGREEN LINE</div>
          <div class="sub">Evergreen Shipping Agency Saudi Co. (LLC)</div>
          <div class="sub">HR Department · Dammam, KSA</div>
        </div>
        <div class="ar">
          <div class="h1-ar ar">إيفرغرين لاين</div>
          <div class="sub ar">شركة إيفرغرين للملاحة المحدودة</div>
          <div class="sub ar">قسم الموارد البشرية · الدمام، المملكة العربية السعودية</div>
        </div>
      </div>

      <div class="date-row">
        <span>Date: ${e(dateEN)}</span>
        <span class="ar">التاريخ: ${e(dateAR)}</span>
      </div>

      <h2 class="title">LETTER OF OFFER  ·  عرض عمل</h2>

      <div class="two-col-intro">
        <div>
          <p><strong>Dear ${e(offer.candidateName || '')},</strong></p>
          <p>We are pleased to offer you the position detailed below at Evergreen Shipping Agency Saudi Co. (LLC). Acceptance is subject to the Terms set out herein and successful onboarding through SOL.</p>
        </div>
        <div class="ar">
          <p><strong>السيد/ة ${e(offer.candidateName || '')} المحترم/ة،</strong></p>
          <p>يسرنا أن نعرض عليكم الانضمام إلى شركة إيفرغرين للملاحة المحدودة في الوظيفة الموضحة أدناه. يخضع القبول للشروط الواردة هنا وإتمام التسجيل عبر نظام SOL.</p>
        </div>
      </div>

      <div class="band">
        <span>POSITION DETAILS</span>
        <span class="ar">تفاصيل الوظيفة</span>
      </div>

      <div class="details-grid">
        <div class="position-table">
          ${posRow('Position', 'الوظيفة', offer.positionTitle)}
          ${posRow('Department', 'الإدارة', offer.department)}
          ${posRow('Office', 'المكتب', offer.location)}
          ${posRow('Reporting to', 'الرئيس المباشر', offer.managerName)}
          ${posRow('Joining date', 'تاريخ المباشرة', formatDateLong(offer.proposedJoinDate))}
          ${posRow('Probation', 'فترة التجربة', '90 days')}
          ${posRow('Working hours', 'ساعات العمل', '40 hr/week, Sun-Thu')}
        </div>

        <table class="salary-table">
          <thead>
            <tr>
              <th colspan="2">SALARY BREAKDOWN</th>
              <th class="ar">تفاصيل الراتب</th>
            </tr>
          </thead>
          <tbody>
            ${salRow('Basic Salary', 'الراتب الأساسي', sar(offer.salaryBasic))}
            ${salRow('Housing Allowance', 'بدل السكن', sar(offer.salaryHousing))}
            ${salRow('Transportation', 'بدل النقل', sar(offer.salaryTransport))}
            ${salRow('Other Allowance', 'بدل آخر', sar(offer.salaryOther))}
          </tbody>
          <tfoot>
            <tr>
              <td>TOTAL</td>
              <td class="ar">الإجمالي</td>
              <td class="amount">${sar(offer.salaryTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div class="band">
        <span>KEY TERMS · Per KSA Labor Law</span>
        <span class="ar">أهم البنود · وفقاً لنظام العمل السعودي</span>
      </div>

      <ul class="terms-list">
        ${termRow('Probation: 90 days (Article 53)', 'فترة التجربة: 90 يوماً (المادة 53)')}
        ${termRow('Notice period: 60 days (Article 75)', 'فترة الإشعار: 60 يوماً (المادة 75)')}
        ${termRow('Annual leave: 21 days (1-5 yr), 30 days from yr 6', 'الإجازة السنوية: 21 يوماً (السنوات 1-5)، 30 يوماً من السنة 6')}
        ${termRow('Sick leave: 30d full + 60d 75% + 30d unpaid (Art. 117)', 'الإجازة المرضية: 30 يوم بأجر كامل + 60 يوم بثلاثة أرباع الأجر + 30 يوم بدون أجر (المادة 117)')}
        ${termRow('End-of-service gratuity (Articles 84-88)', 'مكافأة نهاية الخدمة (المواد 84-88)')}
        ${termRow('GOSI registered + medical insurance per KSA law', 'مسجل في التأمينات الاجتماعية + تأمين صحي وفقاً لأنظمة المملكة')}
        ${termRow('Confidentiality of Company info during & after employment', 'السرية التامة لمعلومات الشركة أثناء وبعد العمل')}
      </ul>

      <div class="accept-box">
        <div class="row">
          <div>To accept: use the secure link sent in the covering email (valid 14 days). On acceptance, HR will register you in SOL and issue your PSN.</div>
          <div class="ar">للقبول: استخدم الرابط الآمن في الإيميل المرفق (صالح لمدة 14 يوماً). بعد القبول، تقوم الموارد البشرية بتسجيلك في SOL وإصدار رقم خدمة الموظف.</div>
        </div>
      </div>

      <div class="signatures">
        <div class="sig-col">
          <div class="line"></div>
          <strong>${e(signatory?.name || '—')}</strong>
          <div class="meta">${e(signatory?.title || '—')}</div>
          <div class="meta">For the Company · عن الشركة</div>
        </div>
        <div class="seal">
          <div>COMPANY SEAL</div>
          <div class="ar" style="margin-top:4px;">ختم الشركة</div>
        </div>
        <div class="sig-col">
          <div class="line"></div>
          <strong>${e(offer.candidateName || '—')}</strong>
          <div class="meta">Candidate · المرشح</div>
          <div class="meta">Signature & date · التوقيع والتاريخ</div>
        </div>
      </div>

      <div class="foot">
        <span>This document is confidential and addressed solely to the named candidate.</span>
        <span class="ar">هذا المستند سري ومخصص للمرشح المسمى أعلاه فقط.</span>
      </div>
    </div>
  `;
}

// ─── HTML helper templates ─────────────────────────────────────────

function posRow(en, ar, value) {
  const e = escapeHtml;
  return `
    <div class="row">
      <div>
        <div class="label">${e(en)}</div>
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
      <td class="label-en">${e(en)}</td>
      <td class="label-ar ar">${e(ar)}</td>
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
    `The link is valid for 14 days. After accepting, we will proceed with onboarding through the SOL system and issue your Personal Service Number (PSN).`,
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
