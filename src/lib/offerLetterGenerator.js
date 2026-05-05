// =============================================================================
// offerLetterGenerator.js
//
// Generates a SINGLE-PAGE bilingual offer letter PDF for Evergreen
// Shipping Agency Saudi Co., plus the .eml file Bashaier sends from
// her real Outlook mailbox.
//
// Layout (one page A4):
//   ┌────────────────────────────────────────────────┐
//   │  Logo   EVERGREEN LINE       (date · ref)      │  letterhead band
//   ├────────────────────────────────────────────────┤
//   │           LETTER OF OFFER · عرض عمل             │
//   ├────────────────────────────────────────────────┤
//   │  Dear Candidate, ...   |   السيد/ة المحترم/ة...│  bilingual intro
//   │  (English left)        |   (Arabic right, RTL) │
//   ├────────────────────────────────────────────────┤
//   │     Position Details · تفاصيل الوظيفة             │
//   │   ┌─ Position │ Salary breakdown table ─┐       │
//   │   ├ Department │   Basic   3,900        │       │
//   │   ├ Office     │   Housing 1,500        │       │
//   │   ├ Reporting  │   Transp.   600        │       │
//   │   ├ Join date  │   Other       0        │       │
//   │   ├ Probation  │   ────────────         │       │
//   │   └─ Hours     │   TOTAL   6,000        │       │
//   ├────────────────────────────────────────────────┤
//   │  Key Terms (1-line each, by KSA Labor Law)     │
//   │  • Probation 90d  • Notice 60d                 │
//   │  • Annual 21/30d  • Sick 30+60+30              │
//   │  • EOSB Art.84-88 • GOSI registered            │
//   ├────────────────────────────────────────────────┤
//   │  Signatures: signatory line + seal placeholder │
//   │  Candidate acceptance + signature line         │
//   └────────────────────────────────────────────────┘
//
// Bilingual approach: every section has English on left, Arabic on
// right side-by-side. Compact line spacing so everything fits on a
// single A4. The salary breakdown table mirrors the formal joining
// report (Basic + Housing + Transportation + Other = Total).
//
// Honest note on Arabic shaping: jsPDF's default fonts don't fully
// shape Arabic letter joining. For typed standard contract phrasing
// the result is readable, but the first real letter should be
// visually checked by a native Arabic reader. If joining is broken
// we'll embed Amiri + arabic-reshaper in a follow-up phase.
// =============================================================================

const CURRENCY_LABEL = 'SAR';
const BRAND_GREEN     = [15, 76, 42];
const BRAND_GREEN_LT  = [212, 232, 220];
const INK             = [15, 23, 42];
const INK_SOFT        = [60, 65, 75];
const MUTED           = [115, 115, 115];
const PAGE_W_PT       = 595.28;
const PAGE_H_PT       = 841.89;
const MARGIN          = 40;          // Tight margin to fit single-page bilingual

// ─── Logo loader (matches permission letter pattern) ──────────────
async function loadLogoDataUrl() {
  try {
    const res = await fetch('/evergreen-logo.jpg');
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// ─── PDF: single-page bilingual offer letter ──────────────────────

/**
 * Generate the offer letter PDF as a Blob.
 *
 * @param {Object} offer
 * @param {string} offer.candidateName
 * @param {string} offer.positionTitle
 * @param {string} offer.department
 * @param {string} offer.location
 * @param {string} offer.proposedJoinDate     YYYY-MM-DD
 * @param {number} offer.salaryBasic          Basic salary component
 * @param {number} offer.salaryHousing        Housing allowance
 * @param {number} offer.salaryTransport      Transportation allowance
 * @param {number} offer.salaryOther          Other allowance
 * @param {number} offer.salaryTotal          Sum of the four (precomputed)
 * @param {string} [offer.managerName]
 * @param {Object} signatory                  { name, title }
 */
export async function generateOfferLetterPDF(offer, signatory) {
  const { jsPDF } = await import('jspdf');

  const companyName   = 'Evergreen Shipping Agency Saudi Co. (LLC)';
  const companyNameAr = 'شركة إيفرغرين للملاحة المحدودة';
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  const logoDataUrl = await loadLogoDataUrl();

  // ═══ HEADER BAND ═══════════════════════════════════════════════
  // Brand green strip across the very top
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, 0, PAGE_W_PT, 5, 'F');

  // Logo + dual-language company name
  if (logoDataUrl) {
    try { doc.addImage(logoDataUrl, 'JPEG', MARGIN, 16, 48, 48); }
    catch (e) { console.warn('Logo embed failed:', e); }
  }

  // English company name (left of logo)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...BRAND_GREEN);
  doc.text('EVERGREEN LINE', MARGIN + 60, 32);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text(companyName, MARGIN + 60, 44);
  doc.text('HR Department · Dammam, KSA', MARGIN + 60, 54);

  // Arabic company name (right side)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...BRAND_GREEN);
  doc.text('إيفرغرين لاين', PAGE_W_PT - MARGIN, 32, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text(companyNameAr, PAGE_W_PT - MARGIN, 44, { align: 'right' });
  doc.text('قسم الموارد البشرية · الدمام، المملكة العربية السعودية', PAGE_W_PT - MARGIN, 54, { align: 'right' });

  // Divider
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, 75, PAGE_W_PT - MARGIN, 75);

  // Date
  const today = new Date();
  const dateEn = today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...INK_SOFT);
  doc.text(`Date: ${dateEn}`, MARGIN, 87);
  doc.text(`التاريخ: ${dateEn}`, PAGE_W_PT - MARGIN, 87, { align: 'right' });

  // ═══ TITLE ═════════════════════════════════════════════════════
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...BRAND_GREEN);
  doc.text('LETTER OF OFFER  ·  عرض عمل', PAGE_W_PT / 2, 105, { align: 'center' });

  // ═══ BILINGUAL INTRO ═══════════════════════════════════════════
  let y = 124;
  const colW = (PAGE_W_PT - MARGIN * 2 - 16) / 2;  // Two columns with 16pt gutter
  const leftX  = MARGIN;
  const rightX = MARGIN + colW + 16;

  // English candidate addressing (left col)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...INK);
  doc.text(`Dear ${offer.candidateName || ''},`, leftX, y);

  // Arabic candidate addressing (right col)
  doc.text(`السيد/ة ${offer.candidateName || ''} المحترم/ة،`, PAGE_W_PT - MARGIN, y, { align: 'right' });

  y += 14;

  // Intro body — English left
  const introEn =
    `We are pleased to offer you the position detailed below at ${companyName}. ` +
    `Acceptance is subject to the Terms set out herein and successful onboarding through SOL.`;
  const introEnLines = doc.splitTextToSize(introEn, colW);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...INK_SOFT);
  doc.text(introEnLines, leftX, y);

  // Intro body — Arabic right
  const introAr =
    `يسرنا أن نعرض عليكم الانضمام إلى ${companyNameAr} في الوظيفة الموضحة أدناه. ` +
    `يخضع القبول للشروط الواردة هنا وإتمام التسجيل عبر نظام SOL.`;
  const introArLines = doc.splitTextToSize(introAr, colW);
  introArLines.forEach((line, i) => {
    doc.text(line, PAGE_W_PT - MARGIN, y + i * 11, { align: 'right' });
  });

  // Move y past the longer of the two intros
  const introHeight = Math.max(introEnLines.length, introArLines.length) * 11 + 4;
  y += introHeight;

  // ═══ POSITION DETAILS HEADING ══════════════════════════════════
  y += 4;
  doc.setFillColor(...BRAND_GREEN_LT);
  doc.rect(MARGIN, y, PAGE_W_PT - MARGIN * 2, 18, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...BRAND_GREEN);
  doc.text('POSITION DETAILS', leftX + 4, y + 12);
  doc.text('تفاصيل الوظيفة', PAGE_W_PT - MARGIN - 4, y + 12, { align: 'right' });
  y += 24;

  // ═══ DETAILS GRID — left: position info, right: salary table ══
  // Left column: position fields
  const leftRows = [
    ['Position',     'الوظيفة',         offer.positionTitle || '—'],
    ['Department',   'الإدارة',          offer.department || '—'],
    ['Office',       'المكتب',           offer.location || '—'],
    ['Reporting to', 'الرئيس المباشر',   offer.managerName || '—'],
    ['Joining date', 'تاريخ المباشرة',   formatDateLong(offer.proposedJoinDate)],
    ['Probation',    'فترة التجربة',     '90 days · 90 يوماً'],
    ['Working hours','ساعات العمل',     '40 hr/week, Sun-Thu'],
  ];

  doc.setFontSize(8.5);
  let leftY = y;
  leftRows.forEach((r) => {
    // English label (left)
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED);
    doc.text(r[0], leftX, leftY);
    // Arabic label (small, italic-look, faded)
    doc.setFontSize(7.5);
    doc.text(r[1], leftX, leftY + 9);
    // Value
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...INK);
    doc.text(String(r[2]), leftX + 92, leftY + 4);
    leftY += 17;
    doc.setFontSize(8.5);
  });

  // Right column: salary breakdown table
  const tableX = rightX;
  const tableW = colW;
  const rowH = 14;

  // Salary table header row
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(tableX, y, tableW, rowH, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(255, 255, 255);
  doc.text('SALARY BREAKDOWN', tableX + 4, y + 9);
  doc.text('تفاصيل الراتب', tableX + tableW - 4, y + 9, { align: 'right' });

  let salY = y + rowH;

  const salaryRows = [
    ['Basic Salary',         'الراتب الأساسي',       offer.salaryBasic],
    ['Housing Allowance',    'بدل السكن',            offer.salaryHousing],
    ['Transportation',       'بدل النقل',            offer.salaryTransport],
    ['Other Allowance',      'بدل آخر',              offer.salaryOther],
  ];

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  salaryRows.forEach((r, i) => {
    if (i % 2 === 0) {
      doc.setFillColor(248, 250, 248);
      doc.rect(tableX, salY, tableW, rowH, 'F');
    }
    doc.setTextColor(...INK_SOFT);
    doc.text(r[0], tableX + 4, salY + 9);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text(r[1], tableX + tableW / 2 - 8, salY + 9, { align: 'right' });
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    const amount = Number(r[2] || 0).toLocaleString('en-GB');
    doc.text(`${CURRENCY_LABEL} ${amount}`, tableX + tableW - 4, salY + 9, { align: 'right' });
    salY += rowH;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
  });

  // Total row — solid green
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(tableX, salY, tableW, rowH + 2, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text('TOTAL  ·  الإجمالي', tableX + 4, salY + 10);
  const totalAmount = Number(offer.salaryTotal || 0).toLocaleString('en-GB');
  doc.text(`${CURRENCY_LABEL} ${totalAmount}`, tableX + tableW - 4, salY + 10, { align: 'right' });
  salY += rowH + 2;

  // Move y past the taller of the two columns
  y = Math.max(leftY, salY) + 8;

  // ═══ KEY TERMS ═════════════════════════════════════════════════
  // Single-line bullets summarising KSA labor terms. Compact format
  // because we have very little vertical space left. Each clause
  // tagged with its KSA Labor Law article reference.
  doc.setFillColor(...BRAND_GREEN_LT);
  doc.rect(MARGIN, y, PAGE_W_PT - MARGIN * 2, 16, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...BRAND_GREEN);
  doc.text('KEY TERMS · أهم البنود', leftX + 4, y + 11);
  doc.text('Per KSA Labor Law · وفقاً لنظام العمل السعودي', PAGE_W_PT - MARGIN - 4, y + 11, { align: 'right' });
  y += 22;

  const keyTerms = [
    ['Probation: 90 days (Article 53)',                   'فترة التجربة: 90 يوماً (المادة 53)'],
    ['Notice period: 60 days (Article 75)',               'فترة الإشعار: 60 يوماً (المادة 75)'],
    ['Annual leave: 21 days (1-5 yr), 30 days from yr 6', 'الإجازة السنوية: 21 يوماً (السنوات 1-5)، 30 يوماً من السنة 6'],
    ['Sick leave: 30d full + 60d 75% + 30d unpaid (Art. 117)', 'الإجازة المرضية: 30 يوم أجر كامل + 60 يوم بثلاثة أرباع الأجر + 30 يوم بدون أجر (المادة 117)'],
    ['End-of-service gratuity (Articles 84-88)',          'مكافأة نهاية الخدمة (المواد 84-88)'],
    ['GOSI registered + medical insurance per KSA law',   'مسجل في التأمينات الاجتماعية + تأمين صحي وفقاً لأنظمة المملكة'],
    ['Confidentiality of Company info during & after employment', 'السرية التامة لمعلومات الشركة أثناء وبعد العمل'],
  ];

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  keyTerms.forEach(([en, ar]) => {
    doc.setTextColor(...BRAND_GREEN);
    doc.text('•', leftX, y);
    doc.setTextColor(...INK_SOFT);
    doc.text(en, leftX + 6, y);
    doc.setTextColor(...BRAND_GREEN);
    doc.text('•', PAGE_W_PT - MARGIN, y, { align: 'right' });
    doc.setTextColor(...INK_SOFT);
    doc.text(ar, PAGE_W_PT - MARGIN - 6, y, { align: 'right' });
    y += 10;
  });

  y += 4;

  // ═══ ACCEPTANCE INSTRUCTION ════════════════════════════════════
  doc.setFillColor(254, 246, 226);  // soft amber
  doc.roundedRect(MARGIN, y, PAGE_W_PT - MARGIN * 2, 22, 3, 3, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(133, 79, 11);
  doc.text(
    'To accept: use the secure link sent in the covering email (valid 14 days).',
    leftX + 4, y + 9
  );
  doc.text(
    'للقبول: استخدم الرابط الآمن في الإيميل المرفق (صالح لمدة 14 يوماً).',
    PAGE_W_PT - MARGIN - 4, y + 9, { align: 'right' }
  );
  doc.text(
    'On acceptance, HR will register you in SOL and issue your PSN.',
    leftX + 4, y + 18
  );
  doc.text(
    'بعد القبول، تقوم الموارد البشرية بتسجيلك في SOL وإصدار رقم خدمة الموظف.',
    PAGE_W_PT - MARGIN - 4, y + 18, { align: 'right' }
  );
  y += 28;

  // ═══ SIGNATURE BLOCK ══════════════════════════════════════════
  // Three columns: signatory (left) | seal (center) | candidate (right)
  const sigColW = (PAGE_W_PT - MARGIN * 2) / 3;

  // Left col — signatory
  doc.setDrawColor(...MUTED);
  doc.setLineWidth(0.5);
  doc.line(leftX, y + 30, leftX + sigColW - 10, y + 30);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...INK);
  doc.text(signatory?.name || '—', leftX, y + 40);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...MUTED);
  doc.text(signatory?.title || '—', leftX, y + 49);
  doc.text('For the Company · عن الشركة', leftX, y + 57);

  // Middle col — company seal placeholder
  const sealCx = MARGIN + sigColW + sigColW / 2;
  const sealCy = y + 25;
  doc.setDrawColor(...MUTED);
  doc.setLineDashPattern([2, 2], 0);
  doc.circle(sealCx, sealCy, 24, 'S');
  doc.setLineDashPattern([], 0);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  doc.setTextColor(...MUTED);
  doc.text('COMPANY SEAL', sealCx, sealCy - 1, { align: 'center' });
  doc.text('ختم الشركة', sealCx, sealCy + 7, { align: 'center' });

  // Right col — candidate signature
  const candX = MARGIN + sigColW * 2 + 10;
  doc.line(candX, y + 30, candX + sigColW - 10, y + 30);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...INK);
  doc.text(offer.candidateName || '—', candX, y + 40);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...MUTED);
  doc.text('Candidate · المرشح', candX, y + 49);
  doc.text('Signature & date · التوقيع والتاريخ', candX, y + 57);

  y += 70;

  // ═══ FOOTER ══════════════════════════════════════════════════
  const footerY = PAGE_H_PT - 22;
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, footerY - 8, PAGE_W_PT - MARGIN, footerY - 8);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...MUTED);
  doc.text(
    'This document is confidential and addressed solely to the named candidate.',
    MARGIN, footerY
  );
  doc.text(
    'هذا المستند سري ومخصص للمرشح المسمى أعلاه فقط.',
    PAGE_W_PT - MARGIN, footerY, { align: 'right' }
  );

  return doc.output('blob');
}

// ─── Helper: format ISO date as "1 June 2026" ─────────────────────
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
