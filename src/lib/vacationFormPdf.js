// =============================================================================
// vacationFormPdf.js — native English-only PDF
//
// 2026-05-10 (Nadeem): stripped Arabic + bilingual complexity per the
// "make it plain English, better looking, relax" feedback. The previous
// build had the right architecture (native jsPDF for selectable text)
// but the layout was cramped trying to fit two languages per cell.
//
// THIS VERSION
//   • English only — no Arabic font loading, no shaping pipeline,
//     no RTL helpers. Smaller bundle, faster generation, fewer deps.
//   • Generous spacing — 4mm row padding, 5mm section gaps. The
//     form breathes, doesn't crowd the page.
//   • Bigger type — 10pt body, 12pt values, 14pt title. Comfortable
//     reading without zoom.
//   • Cleaner grid — soft borders, subtle band fills for labels.
//     One accent column (brand green) on each section header.
//   • Single A4 page. Selectable text everywhere. Logo + QR + brand
//     wordmark in header. Signature grid with manager name resolved
//     from request.manager_decided_by → employee.manager_id fallback.
// =============================================================================

import jsPDF from 'jspdf';
import QRCode from 'qrcode';

// ─── module-scope caches ───────────────────────────────────────────────────
let logoDataUrl = null;

// ─── constants ─────────────────────────────────────────────────────────────

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

const LEAVE_TYPE_LABEL = {
  annual:      'Annual',
  sick:        'Sick',
  emergency:   'Emergency',
  hajj:        'Hajj',
  maternity:   'Maternity',
  paternity:   'Paternity',
  marriage:    'Marriage',
  bereavement: 'Bereavement',
  iddah:       'Iddah',
  unpaid:      'Unpaid',
  other:       'Other',
};
const TYPE_CHECKBOX_ORDER = [
  'annual', 'sick', 'emergency', 'hajj', 'maternity',
  'paternity', 'marriage', 'bereavement', 'unpaid', 'other',
];

const CEO_NAME      = 'JOHN HO';
const CEO_TITLE_EN  = 'Country Head / CEO';
const HR_DEFAULT    = 'BASHAIER ALI ALSUBAIE';

const POLICY_BULLETS = [
  'Annual leave: 21 calendar days per year after 1 year of service; 30 days after 5 years.',
  'Annual leave should be requested at least 14 days in advance.',
  'Sick leave requires a valid medical certificate from an approved facility.',
];

// Brand palette (jsPDF wants [r,g,b], not hex).
const C = {
  text:    [31, 27, 22],     // warm black
  muted:   [115, 110, 100],  // soft grey (gentler than the old dark olive)
  copper:  [157, 107, 83],   // italic accents
  brand:   [45, 95, 63],     // evergreen green
  border:  [220, 213, 195],  // lighter tan border
  banner:  [248, 245, 235],  // softer cream
  labelBg: [252, 250, 244],  // very light cream
  accent:  [232, 240, 233],  // green-tinted background for section headers
};

const PAGE_W    = 210;
const PAGE_H    = 297;
const MARGIN_X  = 14;     // a touch wider margins than before for breathing room
const MARGIN_T  = 14;
const CONTENT_W = PAGE_W - (MARGIN_X * 2);   // 182mm

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
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
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

// ─── drawing primitives ────────────────────────────────────────────────────

function drawText(pdf, text, x, y, opts = {}) {
  if (!text && text !== 0) return;
  pdf.setFont(opts.font || 'helvetica', opts.style || 'normal');
  pdf.setFontSize(opts.size || 10);
  if (opts.color) pdf.setTextColor(...opts.color);
  pdf.text(String(text), x, y, opts);
}

function drawRect(pdf, x, y, w, h, opts = {}) {
  if (opts.fill) {
    pdf.setFillColor(...opts.fill);
    if (opts.stroke) {
      pdf.setDrawColor(...opts.stroke);
      pdf.setLineWidth(opts.strokeWidth || 0.2);
      pdf.rect(x, y, w, h, 'FD');
    } else {
      pdf.rect(x, y, w, h, 'F');
    }
  } else if (opts.stroke) {
    pdf.setDrawColor(...opts.stroke);
    pdf.setLineWidth(opts.strokeWidth || 0.2);
    pdf.rect(x, y, w, h, 'S');
  }
}

function drawLine(pdf, x1, y1, x2, y2, opts = {}) {
  pdf.setDrawColor(...(opts.color || C.border));
  pdf.setLineWidth(opts.width || 0.2);
  pdf.line(x1, y1, x2, y2);
}

// Tickbox — small square that's filled (✓) or empty.
function drawTickbox(pdf, x, y, checked) {
  const size = 2.8;
  if (checked) {
    pdf.setFillColor(...C.brand);
    pdf.setDrawColor(...C.brand);
    pdf.setLineWidth(0.3);
    pdf.rect(x, y - size + 0.4, size, size, 'FD');
    // ✓ stroke
    pdf.setDrawColor(255, 255, 255);
    pdf.setLineWidth(0.5);
    pdf.line(x + 0.7, y - size / 2 + 0.4,   x + 1.2, y - 0.2);
    pdf.line(x + 1.2, y - 0.2,              x + 2.2, y - size + 0.9);
  } else {
    pdf.setDrawColor(...C.border);
    pdf.setLineWidth(0.3);
    pdf.rect(x, y - size + 0.4, size, size, 'S');
  }
}

// ─── main export ───────────────────────────────────────────────────────────

export async function generateVacationFormPdfBlob({
  employee, request, manager, hrApprover, substitutes = [],
}) {
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  // ── prepare data ──
  const verifyUrl = `${VERIFY_BASE_URL}/verify-leave/${request.id}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
    color: { dark: '#2D5F3F', light: '#FFFFFF' },
  });
  const logoUrl = await loadLogoDataUrl();

  const ltKey = LEAVE_TYPE_LABEL[request.leave_type_id] ? request.leave_type_id : 'annual';
  const dept  = DEPT_NAMES[employee?.department] || employee?.department || '—';
  const loc   = LOC_NAMES[employee?.location]    || employee?.location    || '—';
  const designation = employee?.designation || 'Department Member';

  const submitted14d = request.requested_at && request.start_date
    ? (new Date(request.start_date).getTime() - new Date(request.requested_at).getTime()) >= 14 * 24 * 3600 * 1000
    : null;
  const noticePlanned = submitted14d === true;
  const dayCount   = Number(request.days || 0);
  const daysLabel  = `${dayCount} day${dayCount === 1 ? '' : 's'}${request.is_half_day ? '   ·   half day' : ''}`;
  const periodValue = request.start_date === request.end_date
    ? fmtDateLong(request.start_date)
    : `${fmtDateLong(request.start_date)}   ->   ${fmtDateLong(request.end_date)}`;

  // === RENDER ===
  // Spacing pass tuned 2026-05-10 to ensure the form always fits in
  // one A4 page even with the maximum 3 substitutes AND the 35.4mm
  // signature box. Section gaps trimmed from 5/6mm to 3mm, internal
  // row heights kept comfortable but no longer luxurious.

  let y = MARGIN_T;

  // 1) HEADER — 28mm tall, three columns: logo+brand · ref · QR
  y = drawHeader(pdf, y, { logoUrl, qrDataUrl, request });

  y += 4;

  // 2) TITLE — large, centred, single line
  y = drawTitle(pdf, y, ltKey);

  y += 4;

  // 3) EMPLOYEE INFORMATION
  y = drawSectionHeader(pdf, y, 'Employee information');
  y = drawLabelValueTable(pdf, y, [
    ['Employee name', employee?.name || '—'],
    ['PSN ID',        employee?.id   || '—'],
    ['Department',    `${dept}  ·  ${loc}`],
    ['Designation',   designation],
    ['Joined',        `${fmtDateShort(employee?.join_date)}   ·   ${yearsOfService(employee?.join_date)}`],
  ]);

  y += 3;

  // 4) LEAVE DETAILS
  y = drawSectionHeader(pdf, y, 'Leave details');
  y = drawLeaveTypeRow(pdf, y, ltKey);
  y = drawLabelValueTable(pdf, y, [
    ['Period',     periodValue],
    ['Duration',   daysLabel],
    ['Notice',     noticePlanned ? 'Planned   (≥14 days in advance)' : 'Urgent   (less than 14 days)'],
    ['Reason',     request.reason || '—'],
    ['Submitted',  fmtStampCompact(request.requested_at)],
  ]);

  y += 3;

  // 5) LEAVE POLICY (moved before substitutes per Nadeem 2026-05-10
  //     — policy is the standing context, substitute coverage is the
  //     case-specific record; reading order makes more sense this way)
  y = drawSectionHeader(pdf, y, 'Leave policy · KSA Labor Law');
  y = drawPolicyBullets(pdf, y);

  y += 3;

  // 6) SUBSTITUTE COVERAGE (only if any)
  if (substitutes && substitutes.length > 0) {
    y = drawSectionHeader(pdf, y, 'Substitute coverage');
    y = drawSubstitutesTable(pdf, y, substitutes, request);
    y += 3;
  }

  // 7) APPROVAL CHAIN — 3.54cm signature box per company stationery std
  y = drawSectionHeader(pdf, y, 'Approval chain');
  y = drawSignatureGrid(pdf, y, { employee, request, manager, hrApprover });

  // 8) FOOTER stamp
  const stamp = `Generated ${fmtDateShort(new Date().toISOString())} · ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} GMT+3   ·   ESAU HR Portal`;
  drawText(pdf, stamp, PAGE_W / 2, PAGE_H - 9, {
    size: 7.5, color: C.muted, style: 'italic', align: 'center',
  });

  pdf.setProperties({
    title:    `Vacation Form ${shortRef(request.id)}`,
    subject:  `Approved leave for ${employee?.name || request.employee_id}`,
    author:   'ESAU HR · esauhr.netlify.app',
    creator:  'ESAU HR Portal',
    keywords: 'vacation,leave,esau,evergreen,hr',
  });

  return pdf.output('blob');
}

// ─── section renderers ─────────────────────────────────────────────────────

function drawHeader(pdf, y, { logoUrl, qrDataUrl, request }) {
  const h = 28;
  // Soft bottom border instead of full box (cleaner, less boxed-in).
  drawLine(pdf, MARGIN_X, y + h, MARGIN_X + CONTENT_W, y + h,
    { color: C.brand, width: 0.6 });

  // Logo (24×24mm, left).
  if (logoUrl) {
    try {
      pdf.addImage(logoUrl, 'JPEG', MARGIN_X, y + 1, 24, 24);
    } catch { /* fall through */ }
  }

  // Brand wordmark + subtitle (next to logo).
  drawText(pdf, 'EVERGREEN LINE', MARGIN_X + 28, y + 9, {
    size: 16, color: C.brand, style: 'bold',
  });
  drawText(pdf, 'Evergreen Shipping Agency Saudi Co. (L.L.C)', MARGIN_X + 28, y + 14.5, {
    size: 9, color: C.muted, style: 'italic',
  });
  drawText(pdf, 'ESAU · SADMN SUP / HR Department', MARGIN_X + 28, y + 19, {
    size: 8.5, color: C.muted,
  });

  // Reference block (middle-right of header).
  const qrSize = 22;
  const qrX = PAGE_W - MARGIN_X - qrSize;
  const refX = qrX - 50;
  drawText(pdf, 'DATE', refX, y + 5, { size: 7, color: C.muted, style: 'bold' });
  drawText(pdf, fmtDateShort(new Date().toISOString()), refX, y + 10, {
    size: 11, color: C.text, style: 'bold',
  });
  drawText(pdf, 'REFERENCE', refX, y + 16, { size: 7, color: C.muted, style: 'bold' });
  drawText(pdf, shortRef(request.id), refX, y + 21, {
    size: 11, color: C.text, font: 'courier', style: 'bold',
  });

  // QR code (right).
  pdf.addImage(qrDataUrl, 'PNG', qrX, y + 2, qrSize, qrSize);
  drawText(pdf, 'Scan to verify', qrX + qrSize / 2, y + 26.5, {
    size: 6.5, color: C.muted, align: 'center',
  });

  return y + h;
}

function drawTitle(pdf, y, ltKey) {
  const titleText = `Leave Application — ${LEAVE_TYPE_LABEL[ltKey]}`;
  drawText(pdf, titleText, PAGE_W / 2, y + 5, {
    size: 16, color: C.brand, style: 'bold', align: 'center',
  });
  // Soft underline tick mark for the title.
  const tw = pdf.getTextWidth(titleText);
  drawLine(pdf, (PAGE_W - tw) / 2, y + 7.5, (PAGE_W + tw) / 2, y + 7.5,
    { color: C.brand, width: 0.4 });
  return y + 8;
}

function drawSectionHeader(pdf, y, text) {
  const h = 7;
  // Subtle green-tinted band with brand-coloured left edge.
  drawRect(pdf, MARGIN_X, y, CONTENT_W, h, { fill: C.accent });
  drawRect(pdf, MARGIN_X, y, 1.5, h, { fill: C.brand });
  drawText(pdf, text, MARGIN_X + 5, y + 4.8, {
    size: 9.5, color: C.brand, style: 'bold',
  });
  return y + h + 1;
}

function drawLabelValueTable(pdf, startY, rows) {
  // 7mm minimum row (was 8mm) to keep page-fit tight even with the
  // 35.4mm signature box and 3 substitutes. Multiline rows (long
  // reason) still grow as needed.
  const labelW = 42;
  const valueW = CONTENT_W - labelW;
  let y = startY;
  for (const [label, value] of rows) {
    const wrapped = pdf.splitTextToSize(String(value || '—'), valueW - 6);
    const lineCount = Array.isArray(wrapped) ? wrapped.length : 1;
    const rowH = Math.max(7, lineCount * 4.3 + 2.5);

    if (y > startY) {
      drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
        { color: C.border, width: 0.15 });
    }

    drawText(pdf, label, MARGIN_X + 1, y + 4.8, {
      size: 8.5, color: C.muted, style: 'bold',
    });
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.setTextColor(...C.text);
    pdf.text(wrapped, MARGIN_X + labelW + 2, y + 4.8);

    y += rowH;
  }
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });
  return y;
}

function drawLeaveTypeRow(pdf, startY, ltKey) {
  // 10 leave types don't fit on a single line at readable size — they
  // wrap onto multiple rows. The row grows in height to accommodate
  // however many wraps are needed. Label "Leave type" sits at the top
  // of the block; checkboxes flow left-to-right, wrapping when they'd
  // hit the right margin.
  const labelW = 42;
  const lineH  = 5.2;
  drawLine(pdf, MARGIN_X, startY, MARGIN_X + CONTENT_W, startY,
    { color: C.border, width: 0.15 });

  drawText(pdf, 'Leave type', MARGIN_X + 1, startY + 5.5, {
    size: 8.5, color: C.muted, style: 'bold',
  });

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  const leftBound  = MARGIN_X + labelW + 2;
  const rightBound = MARGIN_X + CONTENT_W - 3;
  let cx = leftBound;
  let cy = startY + 5.5;

  for (const k of TYPE_CHECKBOX_ORDER) {
    const label = LEAVE_TYPE_LABEL[k];
    const itemW = pdf.getTextWidth(label) + 8;   // tickbox + label + trailing gap
    if (cx + itemW > rightBound) {
      cx = leftBound;
      cy += lineH;
    }
    drawTickbox(pdf, cx, cy + 1, k === ltKey);
    drawText(pdf, label, cx + 4, cy, {
      size: 8.5, color: C.text,
    });
    cx += itemW;
  }
  return cy + 4;
}

function drawSubstitutesTable(pdf, startY, substitutes, request) {
  // Row taller (12mm) to fit name+PSN on the left + a real signature
  // line in the middle column — substitutes can ink-sign on a printed
  // copy. "✓ Accepted online" becomes a small caption above the line
  // so the digital + physical paths both have a place.
  const headerH = 5.5;
  const bodyH   = 12;
  const colWidths = [10, 60, 65, CONTENT_W - 10 - 60 - 65];
  let y = startY;

  drawRect(pdf, MARGIN_X, y, CONTENT_W, headerH, { fill: C.labelBg });
  let cx = MARGIN_X;
  const headers = ['#', 'Substitute', 'Signature', 'Date'];
  for (let i = 0; i < headers.length; i++) {
    drawText(pdf, headers[i], cx + 2, y + 3.8, {
      size: 8, color: C.muted, style: 'bold',
    });
    cx += colWidths[i];
  }
  y += headerH;

  substitutes.forEach((sub, i) => {
    drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
      { color: C.border, width: 0.15 });
    cx = MARGIN_X;
    // # column
    drawText(pdf, String(i + 1), cx + 2, y + 7, {
      size: 9, color: C.text, style: 'bold',
    });
    cx += colWidths[0];
    // Substitute name + PSN
    drawText(pdf, sub?.name || '—', cx + 2, y + 5, {
      size: 9.5, color: C.text, style: 'bold',
    });
    drawText(pdf, sub?.id || sub?.employee_id || '', cx + 2, y + 9, {
      size: 7.5, color: C.muted, font: 'courier',
    });
    cx += colWidths[1];
    // Signature: blank ink-signature line, no caption (moved to Date col).
    drawLine(pdf, cx + 2, y + 9.5, cx + colWidths[2] - 3, y + 9.5,
      { color: C.border, width: 0.3 });
    cx += colWidths[2];
    // Date column — 'Accepted online' caption sits ABOVE the date,
    // both centred horizontally + vertically in the cell. Dropped the
    // ✓ glyph because it doesn't render in standard Helvetica encoding
    // (renders as a corrupted ! or blank). The italic green colour
    // alone communicates the accepted state.
    const dateColCenter = cx + colWidths[3] / 2;
    drawText(pdf, 'Accepted online', dateColCenter, y + 5, {
      size: 7, color: C.brand, style: 'italic', align: 'center',
    });
    drawText(pdf, fmtStampCompact(request.requested_at), dateColCenter, y + 9, {
      size: 8.5, color: C.text, align: 'center',
    });
    y += bodyH;
  });
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });
  return y;
}

function drawSignatureGrid(pdf, startY, { employee, request, manager, hrApprover }) {
  // 35.4mm body — Nadeem 2026-05-10: signature box must be exactly
  // 3.54cm tall to match the company's stationery standard. Header
  // band stays at 6mm; body fills the rest.
  const colCount = 4;
  const colW = CONTENT_W / colCount;
  const headerH = 6;
  const bodyH   = 35.4;

  const cols = [
    { title: 'Employee', name: employee?.name || '—',
      footer: request.requested_at ? `Submitted ${fmtStampCompact(request.requested_at)}` : '' },
    { title: 'Department Manager', name: manager?.name || '—',
      footer: request.manager_decided_at ? `Approved ${fmtStampCompact(request.manager_decided_at)}` : 'Pending' },
    { title: 'ESAU HR (SUP)', name: hrApprover?.name || HR_DEFAULT,
      footer: request.hr_decided_at ? `Approved ${fmtStampCompact(request.hr_decided_at)}` : 'Pending' },
    { title: 'ESAU Management', name: CEO_NAME,
      footer: CEO_TITLE_EN },
  ];

  drawRect(pdf, MARGIN_X, startY, CONTENT_W, headerH, { fill: C.labelBg });
  for (let i = 0; i < colCount; i++) {
    const cx = MARGIN_X + i * colW;
    drawText(pdf, cols[i].title, cx + colW / 2, startY + 4.2, {
      size: 8, color: C.muted, style: 'bold', align: 'center',
    });
  }

  const by = startY + headerH;
  drawRect(pdf, MARGIN_X, by, CONTENT_W, bodyH, {
    stroke: C.border, strokeWidth: 0.2,
  });
  for (let i = 1; i < colCount; i++) {
    const cx = MARGIN_X + i * colW;
    drawLine(pdf, cx, by, cx, by + bodyH, { color: C.border, width: 0.15 });
  }
  drawLine(pdf, MARGIN_X, by, MARGIN_X + CONTENT_W, by, { color: C.border, width: 0.2 });

  for (let i = 0; i < colCount; i++) {
    const cx = MARGIN_X + i * colW;

    // Vertical anchoring (Nadeem 2026-05-10):
    // The 35.4mm cell is divided into three zones:
    //   [0  .. 20]   — empty signing area (sign with ink here)
    //   [20]         — faint horizontal signature line
    //   [21 .. 30]   — printed name (up to 3 lines, anchored to
    //                  bottom of band at by + 30)
    //   [33]         — footer baseline (timestamp or CEO title)
    //   [33.4 .. 35.4] — 2mm bottom padding
    //
    // Critical: signature line sits ABOVE the name band, not in the
    // middle of it. The previous version positioned the line in the
    // name band centre, so a 4-line wrap of a long name overlapped
    // the line and ran into adjacent cells. Now the name has its
    // own dedicated 9mm strip and cannot collide with the line.
    //
    // For names that wrap to 4+ lines (rare — only happens at very
    // long names like 'SADAKATHULLAH SHADULY PALAYAM MEERA SAHIB' at
    // narrow column width), we cap at 3 lines and let jsPDF truncate.
    // To minimise wrapping, name font is 7pt (was 8pt) — small but
    // still readable; this fits most full names in 1-2 lines.

    const SIGN_LINE_OFFSET   = 20;   // signature line Y inside cell
    const NAME_BOTTOM_OFFSET = 30;   // last name line baseline Y
    const FOOTER_OFFSET      = 33.5; // footer baseline Y
    const NAME_LINE_HEIGHT   = 3;    // 7pt name spacing

    // 1) Signature line (faint, near top).
    drawLine(pdf, cx + 4, by + SIGN_LINE_OFFSET,
                  cx + colW - 4, by + SIGN_LINE_OFFSET,
      { color: C.border, width: 0.3 });

    // 2) Printed name — wrap, cap at 3 lines, centre, anchor to bottom.
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7);
    pdf.setTextColor(...C.text);
    const wrapped     = pdf.splitTextToSize(cols[i].name, colW - 4);
    const allLines    = Array.isArray(wrapped) ? wrapped : [wrapped];
    const displayLines = allLines.slice(0, 3);
    const lineCount   = displayLines.length;
    const nameTopY    = by + NAME_BOTTOM_OFFSET - (lineCount - 1) * NAME_LINE_HEIGHT;
    pdf.text(displayLines, cx + colW / 2, nameTopY, { align: 'center' });

    // 3) Footer (timestamp / title) — copper italic, 6pt, centred.
    drawText(pdf, cols[i].footer, cx + colW / 2, by + FOOTER_OFFSET, {
      size: 6, color: C.copper, style: 'italic', align: 'center',
    });
  }
  return by + bodyH;
}

function drawPolicyBullets(pdf, startY) {
  const rowH = 5.5;
  let y = startY;
  POLICY_BULLETS.forEach((text, i) => {
    drawText(pdf, `${String(i + 1).padStart(2, '0')}.`, MARGIN_X + 1, y + 3.8, {
      size: 8, color: C.copper, style: 'bold',
    });
    drawText(pdf, text, MARGIN_X + 7, y + 3.8, {
      size: 8.5, color: C.text,
    });
    y += rowH;
  });
  return y;
}

// ─── caller helper ─────────────────────────────────────────────────────────

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
