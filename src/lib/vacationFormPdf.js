// =============================================================================
// vacationFormPdf.js — NATIVE PDF (clean text, not rasterised)
//
// 2026-05-10 Nadeem: rewritten as a true text-based PDF using jsPDF
// primitives. The previous canvas-rasterisation approach produced
// image PDFs that "looked like a screenshot" — text wasn't selectable,
// blurred at zoom, and couldn't be searched. This version uses
// jsPDF.text/rect/line/addImage directly so every label and value is
// real text in the PDF object stream.
//
// LAYOUT (A4 portrait, 210×297mm, 12mm side margins)
//   • Header row:      logo + brand strip · date+ref · QR        (24mm)
//   • Title strip:     bilingual headline "Leave Application..."  (10mm)
//   • Employee block:  5-row label/value table                    (35mm)
//   • Leave details:   6-row table with checkbox rows             (50mm)
//   • Substitutes:     variable rows table                        (≤25mm)
//   • Policy bullets:  3 KSA labor law lines, bilingual           (18mm)
//   • Signature grid:  4 columns EMPLOYEE/MGR/HR/MGT              (24mm)
//   • Footer:          generated-on stamp                          (6mm)
//
// ARABIC TEXT
// jsPDF can't shape Arabic glyphs natively — letters render in their
// isolated forms instead of connected cursive. Two-step pipeline:
//   1. arabic-persian-reshaper's ArabicShaper.convertArabic() converts
//      logical-order Arabic into Unicode presentation forms (FE70–FEFC
//      range), which are the contextual initial/medial/final/isolated
//      glyphs already pre-shaped.
//   2. jsPDF.setR2L(true) + a font that includes those glyphs
//      (Noto Naskh Arabic, fetched lazily from /fonts/) renders them
//      in the correct right-to-left order.
// For bilingual cells (English label · Arabic gloss), we split the
// string at the boundary and render each half in its own font + dir.
//
// FONT LOADING
// The Arabic TTF is ~155KB. We fetch /fonts/NotoNaskhArabic-Regular.ttf
// on first PDF generation, cache the base64 in module scope, and
// re-use for all subsequent generations in the same page load.
// English uses jsPDF's built-in Helvetica (no fetch).
//
// CALLER COMPATIBILITY
//   Same export name (generateVacationFormPdfBlob) and same args
//   as the previous rasterisation version. No call-site changes.
// =============================================================================

import jsPDF from 'jspdf';
import { ArabicShaper } from 'arabic-persian-reshaper';
import QRCode from 'qrcode';

// ─── module-scope caches ───────────────────────────────────────────────────
// Both expensive to compute, both safe to share across generations.
let arabicFontBase64 = null;
let logoDataUrl      = null;

// ─── constants mirroring vacationForm.js ───────────────────────────────────

const VERIFY_BASE_URL = (typeof window !== 'undefined' && window.location?.origin)
  ? window.location.origin
  : 'https://esauhr.netlify.app';

const DEPT_NAMES = {
  BIZ: 'Business',
  CSD: 'Customer Service',
  FIN: 'Finance',
  LOG: 'Logistics',
  SUP: 'Supervisory',
  'RYD OFFICE': 'Riyadh Office',
};
const LOC_NAMES = { DMM: 'Dammam', JED: 'Jeddah', RYD: 'Riyadh' };

const LEAVE_TYPE = {
  annual:      { en: 'Annual',      ar: 'سنوية' },
  sick:        { en: 'Sick',        ar: 'مرضية' },
  emergency:   { en: 'Emergency',   ar: 'طارئة' },
  hajj:        { en: 'Hajj',        ar: 'حج' },
  maternity:   { en: 'Maternity',   ar: 'وضع' },
  paternity:   { en: 'Paternity',   ar: 'أبوة' },
  marriage:    { en: 'Marriage',    ar: 'زواج' },
  bereavement: { en: 'Bereavement', ar: 'وفاة' },
  iddah:       { en: 'Iddah',       ar: 'عدة' },
  unpaid:      { en: 'Unpaid',      ar: 'بدون راتب' },
  other:       { en: 'Other',       ar: 'أخرى' },
};

const TYPE_CHECKBOX_ORDER = [
  'annual', 'sick', 'emergency', 'hajj', 'maternity',
  'paternity', 'marriage', 'bereavement', 'unpaid', 'other',
];

const CEO_NAME      = 'JOHN HO';
const CEO_TITLE_EN  = 'Country Head / CEO';

const HR_SIGNATURE = {
  name: 'BASHAIER ALI ALSUBAIE',
  unit: 'ESAU SADMN SUP / HR Dept',
};

// KSA Labor Law summary bullets (bilingual).
const POLICY_BULLETS = [
  {
    en: '01.  Annual leave: 21 calendar days/year after 1 year of service; 30 days after 5 years.',
    ar: 'الإجازة السنوية: 21 يومًا في السنة بعد سنة من الخدمة، و30 يومًا بعد 5 سنوات.',
  },
  {
    en: '02.  Annual leave should be requested at least 14 days in advance.',
    ar: 'تُقدَّم طلبات الإجازة السنوية قبل 14 يومًا على الأقل.',
  },
  {
    en: '03.  Sick leave requires a valid medical certificate from an approved facility.',
    ar: 'تتطلب الإجازة المرضية شهادة طبية معتمدة من جهة معتمدة.',
  },
];

// Brand palette — converted to jsPDF's [r,g,b] format from hex.
const C = {
  text:     [31, 27, 22],     // #1F1B16 warm black
  muted:    [92, 68, 6],      // #5C4406 dark olive
  copper:   [157, 107, 83],   // #9D6B53 italic accent
  brand:    [45, 95, 63],     // #2D5F3F evergreen green
  border:   [201, 184, 148],  // #C9B894 warm tan
  banner:   [244, 238, 223],  // #F4EEDF cream
  labelBg:  [251, 246, 233],  // #FBF6E9 light cream
  white:    [255, 255, 255],
};

// Page layout in mm.
const PAGE_W   = 210;
const PAGE_H   = 297;
const MARGIN_X = 12;
const MARGIN_T = 12;
const CONTENT_W = PAGE_W - (MARGIN_X * 2);  // 186mm

// ─── formatters ────────────────────────────────────────────────────────────

function fmtDateLong(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function fmtDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function fmtStampCompact(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

function shortRef(id) {
  const s = String(id ?? '');
  const hex = s.replace(/-/g, '');
  if (hex.length > 8 && /^[0-9a-f]+$/i.test(hex)) {
    return `LV-${hex.slice(0, 8).toUpperCase()}`;
  }
  return `LV-${s.padStart(5, '0')}`;
}

function yearsOfService(joinDate) {
  if (!joinDate) return '—';
  const join = new Date(joinDate);
  const now = new Date();
  let y = now.getFullYear() - join.getFullYear();
  let m = now.getMonth() - join.getMonth();
  if (m < 0) { y--; m += 12; }
  if (y === 0 && m === 0) return 'Less than a month';
  if (y === 0) return `${m} month${m === 1 ? '' : 's'}`;
  return `${y} year${y === 1 ? '' : 's'}${m > 0 ? `, ${m} month${m === 1 ? '' : 's'}` : ''}`;
}

// ─── asset loaders ─────────────────────────────────────────────────────────

async function loadArabicFont() {
  if (arabicFontBase64) return arabicFontBase64;
  const res = await fetch('/fonts/NotoNaskhArabic-Regular.ttf');
  if (!res.ok) throw new Error(`Arabic font fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  // Convert binary → base64 in chunks (large fonts overflow String.fromCharCode).
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  arabicFontBase64 = btoa(binary);
  return arabicFontBase64;
}

async function loadLogoDataUrl() {
  if (logoDataUrl) return logoDataUrl;
  try {
    const res = await fetch('/evergreen-logo.jpg');
    if (!res.ok) return null;
    const blob = await res.blob();
    logoDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return logoDataUrl;
  } catch {
    return null;
  }
}

// ─── Arabic helper ─────────────────────────────────────────────────────────

// Reshape + render Arabic text right-justified at (rightX, y).
// Uses Noto Naskh Arabic via the fontName key. Caller must have
// already addFont'd the family. rightX is the position where the
// RIGHT edge of the text sits (Arabic text grows leftward from there).
function drawArabic(pdf, text, rightX, y, opts = {}) {
  if (!text) return;
  const shaped = ArabicShaper.convertArabic(String(text));
  pdf.setFont('NotoNaskhArabic', 'normal');
  pdf.setFontSize(opts.size || 8.5);
  if (opts.color) pdf.setTextColor(...opts.color);
  pdf.setR2L(true);
  pdf.text(shaped, rightX, y, { align: 'right', ...opts });
  pdf.setR2L(false);
}

// Latin text (selectable).
function drawText(pdf, text, x, y, opts = {}) {
  if (!text && text !== 0) return;
  pdf.setFont(opts.font || 'helvetica', opts.style || 'normal');
  pdf.setFontSize(opts.size || 9);
  if (opts.color) pdf.setTextColor(...opts.color);
  pdf.text(String(text), x, y, opts);
}

function drawRect(pdf, x, y, w, h, opts = {}) {
  if (opts.fill) {
    pdf.setFillColor(...opts.fill);
    if (opts.stroke) pdf.setDrawColor(...opts.stroke);
    pdf.setLineWidth(opts.strokeWidth || 0.2);
    pdf.rect(x, y, w, h, opts.stroke ? 'FD' : 'F');
  } else if (opts.stroke) {
    pdf.setDrawColor(...opts.stroke);
    pdf.setLineWidth(opts.strokeWidth || 0.2);
    pdf.rect(x, y, w, h, 'S');
  }
}

// Bilingual label row: English on the left, Arabic on the right.
function drawBilingualLabel(pdf, en, ar, x, y, w) {
  drawText(pdf, en, x + 1.5, y + 3.2, { size: 7.5, color: C.muted, style: 'bold' });
  drawArabic(pdf, ar, x + w - 1.5, y + 3.2, { size: 7, color: C.muted });
}

// Tickbox helper — small square that's filled (✓) or empty.
function drawTickbox(pdf, x, y, checked) {
  const size = 2.4;
  if (checked) {
    pdf.setFillColor(...C.brand);
    pdf.setDrawColor(...C.brand);
    pdf.setLineWidth(0.3);
    pdf.rect(x, y - size, size, size, 'FD');
    // The ✓ — drawn as two short lines
    pdf.setDrawColor(255, 255, 255);
    pdf.setLineWidth(0.5);
    pdf.line(x + 0.5, y - size / 2,   x + 1.0, y - 0.4);
    pdf.line(x + 1.0, y - 0.4,         x + 2.0, y - size + 0.4);
  } else {
    pdf.setDrawColor(...C.border);
    pdf.setLineWidth(0.3);
    pdf.rect(x, y - size, size, size, 'S');
  }
}

// ─── main export ───────────────────────────────────────────────────────────

/**
 * Build the bilingual vacation form as a single-page A4 PDF Blob.
 * Text is selectable, searchable, and prints crisp at any zoom.
 *
 * @param {object} args.employee     — { id, name, department, location, designation, join_date }
 * @param {object} args.request      — leave_requests row
 * @param {object} args.manager      — manager employee row (optional)
 * @param {object} args.hrApprover   — current HR approver employee row (optional)
 * @param {Array}  args.substitutes  — array of substitute decisions (optional)
 * @returns {Promise<Blob>} PDF blob with type 'application/pdf'
 */
export async function generateVacationFormPdfBlob({
  employee, request, manager, hrApprover, substitutes = [],
}) {
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  // 1) Load + register Arabic font.
  const fontB64 = await loadArabicFont();
  pdf.addFileToVFS('NotoNaskhArabic-Regular.ttf', fontB64);
  pdf.addFont('NotoNaskhArabic-Regular.ttf', 'NotoNaskhArabic', 'normal');

  // 2) Generate the QR code as data URL.
  const verifyUrl = `${VERIFY_BASE_URL}/verify-leave/${request.id}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 220,
    color: { dark: '#1F4530', light: '#FFFFFF' },
  });

  // 3) Load logo (best-effort — form still works if it 404s).
  const logoUrl = await loadLogoDataUrl();

  // 4) Resolve display strings.
  const ltKey  = LEAVE_TYPE[request.leave_type_id] ? request.leave_type_id : 'annual';
  const dept   = DEPT_NAMES[employee?.department] || employee?.department || '—';
  const loc    = LOC_NAMES[employee?.location]    || employee?.location    || '—';
  const designation = employee?.designation || 'Department Member';

  const submitted14d = request.requested_at && request.start_date
    ? (new Date(request.start_date).getTime() - new Date(request.requested_at).getTime()) >= 14 * 24 * 3600 * 1000
    : null;
  const noticePlanned = submitted14d === true;

  const dayCount   = Number(request.days || 0);
  const daysLabel  = `${dayCount} day${dayCount === 1 ? '' : 's'}`;
  const periodValue = request.start_date === request.end_date
    ? fmtDateLong(request.start_date)
    : `${fmtDateLong(request.start_date)}  →  ${fmtDateLong(request.end_date)}`;

  // === RENDER PIPELINE ===

  let y = MARGIN_T;

  // 5) HEADER — three-column row 26mm tall.
  const headerH = 26;
  drawRect(pdf, MARGIN_X, y, CONTENT_W, headerH, { stroke: C.border, strokeWidth: 0.4 });

  // Left cell: logo + brand text (90mm)
  const leftW = 95;
  if (logoUrl) {
    try {
      pdf.addImage(logoUrl, 'JPEG', MARGIN_X + 2, y + 2, 22, 22);
    } catch { /* fall through to text-only */ }
  }
  drawText(pdf, 'EVERGREEN LINE', MARGIN_X + 26, y + 9, {
    size: 13, color: C.brand, style: 'bold',
  });
  drawText(pdf, 'Evergreen Shipping Agency Saudi Co. (L.L.C)', MARGIN_X + 26, y + 14, {
    size: 8, color: C.muted, style: 'italic',
  });
  drawText(pdf, 'ESAU SADMN SUP / HR Dept', MARGIN_X + 26, y + 18, {
    size: 7.5, color: C.muted,
  });

  // Middle cell: Date + Ref (60mm)
  const midX = MARGIN_X + leftW;
  pdf.setLineWidth(0.2);
  pdf.setDrawColor(...C.border);
  pdf.line(midX, y, midX, y + headerH);
  drawText(pdf, 'Date',  midX + 2, y + 6, { size: 7, color: C.muted });
  drawText(pdf, fmtDateShort(new Date().toISOString()), midX + 2, y + 11,
    { size: 10, color: C.text, style: 'bold' });
  drawText(pdf, 'Ref',  midX + 2, y + 17, { size: 7, color: C.muted });
  drawText(pdf, shortRef(request.id), midX + 2, y + 22,
    { size: 10, color: C.text, font: 'courier', style: 'bold' });

  // Right cell: QR + caption (~36mm)
  const qrW = 30;
  const qrX = PAGE_W - MARGIN_X - qrW;
  pdf.line(qrX - 2, y, qrX - 2, y + headerH);
  pdf.addImage(qrDataUrl, 'PNG', qrX, y + 2, qrW - 1, qrW - 1);
  drawText(pdf, 'SCAN TO VERIFY', qrX - 1, y + headerH - 1,
    { size: 5.5, color: C.muted });

  y += headerH + 4;

  // 6) TITLE STRIP — full-width bilingual headline.
  const titleH = 10;
  drawRect(pdf, MARGIN_X, y, CONTENT_W, titleH,
    { fill: C.banner, stroke: C.brand, strokeWidth: 0.5 });
  const ltLabel = LEAVE_TYPE[ltKey].en;
  drawText(pdf, `Leave Application — ${ltLabel}`,
    MARGIN_X + CONTENT_W / 2, y + 4.5,
    { size: 12, color: C.brand, style: 'bold', align: 'center' });
  drawArabic(pdf, `طلب إجازة · إجازة ${LEAVE_TYPE[ltKey].ar}`,
    MARGIN_X + CONTENT_W / 2 + 18, y + 8.5,
    { size: 8.5, color: C.muted, align: 'center' });

  y += titleH + 2;

  // 7) EMPLOYEE INFORMATION block.
  y = drawSectionBanner(pdf, y, 'EMPLOYEE INFORMATION', 'معلومات الموظف');
  const empRows = [
    { en: 'Employee name',     ar: 'اسم الموظف',          value: employee?.name || '—' },
    { en: 'PSN ID',            ar: 'الرقم الوظيفي',         value: employee?.id   || '—' },
    { en: 'Department',        ar: 'القسم',                value: `${dept}  ·  ${loc}` },
    { en: 'Designation',       ar: 'المسمى الوظيفي',         value: designation },
    { en: 'Joined / Tenure',   ar: 'الالتحاق / المدة',       value: `${fmtDateShort(employee?.join_date)}   ·   ${yearsOfService(employee?.join_date)}` },
  ];
  y = drawLabelValueTable(pdf, y, empRows);
  y += 3;

  // 8) LEAVE DETAILS block.
  y = drawSectionBanner(pdf, y, 'LEAVE DETAILS', 'تفاصيل الإجازة');

  // Custom row: leave-type checkboxes (special render).
  const typeRowH = 9;
  drawRect(pdf, MARGIN_X, y, CONTENT_W, typeRowH, { stroke: C.border, strokeWidth: 0.2 });
  drawRect(pdf, MARGIN_X, y, 50, typeRowH, { fill: C.labelBg, stroke: C.border, strokeWidth: 0.2 });
  drawBilingualLabel(pdf, 'Leave type', 'نوع الإجازة', MARGIN_X, y, 50);
  let chkX = MARGIN_X + 53;
  for (const k of TYPE_CHECKBOX_ORDER) {
    drawTickbox(pdf, chkX, y + 5.5, k === ltKey);
    drawText(pdf, LEAVE_TYPE[k].en, chkX + 3.2, y + 5.3, {
      size: 7.5, color: C.text,
    });
    chkX += pdf.getTextWidth(LEAVE_TYPE[k].en) + 8;
  }
  y += typeRowH;

  // Remaining leave-detail rows.
  const leaveRows = [
    { en: 'Period',       ar: 'الفترة',          value: periodValue },
    { en: 'Duration',     ar: 'المدة',          value: `${daysLabel}     ·     ${request.is_half_day ? '☑ Half day' : '☐ Half day'}` },
    { en: 'Notice',       ar: 'الإشعار',         value: `${noticePlanned ? '☑' : '☐'} Planned (≥14 days)     ${!noticePlanned ? '☑' : '☐'} Urgent (<14 days)` },
    { en: 'Reason / details', ar: 'السبب / التفاصيل', value: request.reason || '—' },
    { en: 'Submitted',    ar: 'تاريخ التقديم',    value: fmtStampCompact(request.requested_at) },
  ];
  y = drawLabelValueTable(pdf, y, leaveRows);
  y += 3;

  // 9) SUBSTITUTE COVERAGE (optional).
  if (substitutes && substitutes.length > 0) {
    y = drawSectionBanner(pdf, y, 'SUBSTITUTE COVERAGE', 'البديل أثناء الغياب');
    y = drawSubstitutesTable(pdf, y, substitutes, request);
    y += 3;
  }

  // 10) POLICY block.
  y = drawSectionBanner(pdf, y, 'LEAVE POLICY · KSA LABOR LAW', 'سياسة الإجازات · نظام العمل السعودي');
  y = drawPolicyBlock(pdf, y);
  y += 3;

  // 11) SIGNATURE GRID (4 columns).
  y = drawSignatureGrid(pdf, y, {
    employee, request, manager, hrApprover,
  });

  // 12) GENERATED footer — centred, italic, small.
  const stamp = `Generated on ${fmtDateShort(new Date().toISOString())}, ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} GMT+3  ·  ${HR_SIGNATURE.name}`;
  drawText(pdf, stamp, PAGE_W / 2, PAGE_H - 8,
    { size: 7, color: C.copper, style: 'italic', align: 'center' });

  // PDF metadata for any viewer.
  pdf.setProperties({
    title:    `Vacation Form ${shortRef(request.id)}`,
    subject:  `Approved leave for ${employee?.name || request.employee_id}`,
    author:   'ESAU HR · esauhr.netlify.app',
    creator:  'ESAU HR Portal',
    keywords: 'vacation,leave,esau,evergreen,hr',
  });

  return pdf.output('blob');
}

// ─── section primitives ────────────────────────────────────────────────────

function drawSectionBanner(pdf, y, enText, arText) {
  const h = 5.5;
  drawRect(pdf, MARGIN_X, y, CONTENT_W, h,
    { fill: C.banner, stroke: C.brand, strokeWidth: 0.3 });
  drawText(pdf, enText, MARGIN_X + 2, y + 3.8, {
    size: 8.5, color: C.brand, style: 'bold',
  });
  drawArabic(pdf, arText, PAGE_W - MARGIN_X - 2, y + 3.8, {
    size: 7.5, color: C.brand,
  });
  return y + h;
}

function drawLabelValueTable(pdf, startY, rows) {
  const labelW = 50;
  const valueW = CONTENT_W - labelW;
  const rowH   = 6.5;
  let y = startY;
  for (const r of rows) {
    // Reason row is taller to fit multiline.
    const isReason = /reason|details/i.test(r.en);
    const thisRowH = isReason ? Math.max(rowH, 11) : rowH;
    drawRect(pdf, MARGIN_X, y, CONTENT_W, thisRowH,
      { stroke: C.border, strokeWidth: 0.2 });
    drawRect(pdf, MARGIN_X, y, labelW, thisRowH,
      { fill: C.labelBg, stroke: C.border, strokeWidth: 0.2 });
    drawBilingualLabel(pdf, r.en, r.ar, MARGIN_X, y, labelW);

    // Value — wrap if too long.
    const valX = MARGIN_X + labelW + 2;
    const valW = valueW - 4;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(...C.text);
    const wrapped = pdf.splitTextToSize(String(r.value || '—'), valW);
    pdf.text(wrapped, valX, y + 4.2);

    y += thisRowH;
  }
  return y;
}

function drawSubstitutesTable(pdf, startY, substitutes, request) {
  const headerH = 5;
  const colWidths = [10, 70, 56, 50];  // # / Substitute / Signature / Date
  let x = MARGIN_X;
  let y = startY;

  // Header row.
  drawRect(pdf, MARGIN_X, y, CONTENT_W, headerH,
    { fill: C.labelBg, stroke: C.border, strokeWidth: 0.2 });
  const headers = [
    { en: '#',            ar: '' },
    { en: 'Substitute',   ar: 'البديل' },
    { en: 'Signature',    ar: 'التوقيع' },
    { en: 'Date',         ar: 'التاريخ' },
  ];
  x = MARGIN_X;
  for (let i = 0; i < headers.length; i++) {
    drawText(pdf, headers[i].en, x + 1.5, y + 3.5,
      { size: 7.5, color: C.brand, style: 'bold' });
    if (headers[i].ar) {
      drawArabic(pdf, headers[i].ar, x + colWidths[i] - 1.5, y + 3.5,
        { size: 6.5, color: C.brand });
    }
    x += colWidths[i];
  }
  y += headerH;

  // Body rows.
  const bodyH = 9;
  substitutes.forEach((sub, i) => {
    drawRect(pdf, MARGIN_X, y, CONTENT_W, bodyH,
      { stroke: C.border, strokeWidth: 0.15 });
    let cx = MARGIN_X;
    drawText(pdf, String(i + 1), cx + 1.5, y + 5.5,
      { size: 9, color: C.text, style: 'bold' });
    cx += colWidths[0];

    const subName = sub?.name || '—';
    const subId   = sub?.id   || sub?.employee_id || '';
    drawText(pdf, subName, cx + 1.5, y + 4,
      { size: 8.5, color: C.text, style: 'bold' });
    if (subId) {
      drawText(pdf, subId, cx + 1.5, y + 7.5,
        { size: 7, color: C.muted, font: 'courier' });
    }
    cx += colWidths[1];

    drawText(pdf, '✓ Accepted online', cx + 1.5, y + 4,
      { size: 7.5, color: C.brand, style: 'italic' });
    drawText(pdf, 'Signature', cx + 1.5, y + 7.5,
      { size: 6.5, color: C.muted });
    cx += colWidths[2];

    drawText(pdf, fmtStampCompact(request.requested_at), cx + 1.5, y + 4,
      { size: 7.5, color: C.text });
    drawText(pdf, 'Accepted online', cx + 1.5, y + 7.5,
      { size: 6.5, color: C.copper, style: 'italic' });
    y += bodyH;
  });
  return y;
}

function drawPolicyBlock(pdf, startY) {
  const rowH = 5.5;
  let y = startY;
  for (const bullet of POLICY_BULLETS) {
    drawRect(pdf, MARGIN_X, y, CONTENT_W, rowH,
      { stroke: C.border, strokeWidth: 0.15 });
    drawText(pdf, bullet.en, MARGIN_X + 2, y + 3.8,
      { size: 7.5, color: C.text });
    drawArabic(pdf, bullet.ar, PAGE_W - MARGIN_X - 2, y + 3.8,
      { size: 7, color: C.muted });
    y += rowH;
  }
  return y;
}

function drawSignatureGrid(pdf, startY, { employee, request, manager, hrApprover }) {
  const colCount = 4;
  const colW = CONTENT_W / colCount;
  const headerH = 5;
  const bodyH   = 22;
  const totalH  = headerH + bodyH;

  // Header row.
  drawRect(pdf, MARGIN_X, startY, CONTENT_W, headerH,
    { fill: C.labelBg, stroke: C.border, strokeWidth: 0.2 });
  const cols = [
    { en: 'EMPLOYEE', ar: 'الموظف',         name: employee?.name || '',
      footer: request.requested_at ? `Submitted ${fmtStampCompact(request.requested_at)}` : '' },
    { en: 'DEPT MGR', ar: 'مدير القسم',     name: manager?.name || '',
      footer: request.manager_decided_at ? `Approved ${fmtStampCompact(request.manager_decided_at)}` : '' },
    { en: 'ESAU SUP', ar: 'الموارد البشرية', name: hrApprover?.name || HR_SIGNATURE.name,
      footer: request.hr_decided_at ? `Approved ${fmtStampCompact(request.hr_decided_at)}` : '' },
    { en: 'ESAU MGT', ar: 'الإدارة',         name: CEO_NAME,
      footer: CEO_TITLE_EN },
  ];

  for (let i = 0; i < colCount; i++) {
    const cx = MARGIN_X + i * colW;
    drawText(pdf, cols[i].en, cx + 1.5, startY + 3.3,
      { size: 7.5, color: C.brand, style: 'bold' });
    drawArabic(pdf, cols[i].ar, cx + colW - 1.5, startY + 3.5,
      { size: 6.5, color: C.brand });
  }

  // Body row.
  const by = startY + headerH;
  drawRect(pdf, MARGIN_X, by, CONTENT_W, bodyH,
    { stroke: C.border, strokeWidth: 0.2 });
  for (let i = 1; i < colCount; i++) {
    const cx = MARGIN_X + i * colW;
    pdf.setDrawColor(...C.border);
    pdf.setLineWidth(0.2);
    pdf.line(cx, by, cx, by + bodyH);
  }
  for (let i = 0; i < colCount; i++) {
    const cx = MARGIN_X + i * colW;
    // Name wraps if long. splitTextToSize gives us word-wrapped lines.
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8.5);
    pdf.setTextColor(...C.text);
    const wrappedName = pdf.splitTextToSize(cols[i].name || '—', colW - 3);
    pdf.text(wrappedName, cx + 1.5, by + 4.5);

    if (cols[i].footer) {
      drawText(pdf, cols[i].footer, cx + 1.5, by + 12,
        { size: 6.5, color: C.copper, style: 'italic' });
    }
    drawText(pdf, 'Signature', cx + 1.5, by + bodyH - 2,
      { size: 6.5, color: C.muted });
  }
  return startY + totalH;
}

// ─── small download helper kept here for callers ───────────────────────────

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
