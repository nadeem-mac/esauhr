// =============================================================================
// joiningReportPdf.js — native English-only PDF for Joining / Rejoining
//
// 2026-05-10 (Nadeem): 'The rejoining form and all kind of forms should be
// in PDF, with enriched details, remove arabic just keep plain english well
// formatted making full use of the A4 size page'.
//
// Built on the same skeleton as vacationFormPdf.js so the family of HR
// forms reads as one document set. Same header, same section bands, same
// signature grid pattern, same 5mm top margin for full-page printing.
//
// HANDLES BOTH JOINING AND REJOINING
// - 'joining'   → first-time hire (replaces the old paper Joining Report)
// - 'rejoining' → employee returning from extended leave / sabbatical
// The two share the same layout; only the title and type checkbox differ.
// =============================================================================

import jsPDF from 'jspdf';
import QRCode from 'qrcode';

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

const CEO_NAME      = 'JOHN HO';
const CEO_TITLE_EN  = 'Country Head / CEO';
const HR_DEFAULT    = 'BASHAIER ALI ALSUBAIE';

// Policies acknowledged on every joining — kept short, fits the
// Acknowledgement band without crowding the rest of the page.
const POLICY_BULLETS = [
  'I have received and reviewed the Employee Handbook and HR policies.',
  'I will follow the official working hours, dress code, and conduct standards.',
  'I understand the leave entitlement and request procedures under KSA Labor Law.',
  'I will safeguard company information, systems, and assets at all times.',
  'I will report to my Department Head / direct supervisor for daily duties.',
];

// Brand palette — IDENTICAL to vacationFormPdf so the family of forms
// reads as one document set when printed and filed.
const C = {
  text:    [31, 27, 22],
  muted:   [115, 110, 100],
  copper:  [157, 107, 83],
  brand:   [45, 95, 63],
  border:  [220, 213, 195],
  banner:  [248, 245, 235],
  labelBg: [252, 250, 244],
  accent:  [232, 240, 233],
};

const PAGE_W    = 210;
const PAGE_H    = 297;
const MARGIN_X  = 14;
const MARGIN_T  = 5;
const CONTENT_W = PAGE_W - (MARGIN_X * 2);

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

function shortRef(id, type) {
  const prefix = type === 'rejoining' ? 'RJ' : 'JN';
  const s = String(id ?? '');
  const hex = s.replace(/-/g, '');
  if (hex.length > 8 && /^[0-9a-f]+$/i.test(hex)) {
    return `${prefix}-${hex.slice(0, 8).toUpperCase()}`;
  }
  return `${prefix}-${s.padStart(5, '0')}`;
}

function fmtSAR(amount) {
  if (amount == null || amount === '') return '—';
  const n = Number(amount);
  if (isNaN(n)) return String(amount);
  return `SAR ${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
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

function drawTickbox(pdf, x, y, checked) {
  const size = 2.8;
  if (checked) {
    pdf.setFillColor(...C.brand);
    pdf.setDrawColor(...C.brand);
    pdf.setLineWidth(0.3);
    pdf.rect(x, y - size + 0.4, size, size, 'FD');
    pdf.setDrawColor(255, 255, 255);
    pdf.setLineWidth(0.5);
    pdf.line(x + 0.7, y - size / 2 + 0.4, x + 1.2, y - 0.2);
    pdf.line(x + 1.2, y - 0.2,            x + 2.2, y - size + 0.9);
  } else {
    pdf.setDrawColor(...C.border);
    pdf.setLineWidth(0.3);
    pdf.rect(x, y - size + 0.4, size, size, 'S');
  }
}

// ─── header / title / section / table builders ────────────────────────────

function drawHeader(pdf, y, { logoUrl, qrDataUrl, request, type }) {
  const h = 28;
  drawLine(pdf, MARGIN_X, y + h, MARGIN_X + CONTENT_W, y + h,
    { color: C.brand, width: 0.6 });
  if (logoUrl) {
    try { pdf.addImage(logoUrl, 'JPEG', MARGIN_X, y + 1, 24, 24); } catch {}
  }
  drawText(pdf, 'EVERGREEN LINE', MARGIN_X + 28, y + 9, {
    size: 16, color: C.brand, style: 'bold',
  });
  drawText(pdf, 'Evergreen Shipping Agency Saudi Co. (L.L.C)', MARGIN_X + 28, y + 14.5, {
    size: 9, color: C.muted, style: 'italic',
  });
  drawText(pdf, 'ESAU · SADMN SUP / HR Department', MARGIN_X + 28, y + 19, {
    size: 8.5, color: C.muted,
  });

  const qrSize = 22;
  const qrX = PAGE_W - MARGIN_X - qrSize;
  const refX = qrX - 50;
  drawText(pdf, 'DATE', refX, y + 5, { size: 7, color: C.muted, style: 'bold' });
  drawText(pdf, fmtDateShort(new Date().toISOString()), refX, y + 10, {
    size: 11, color: C.text, style: 'bold',
  });
  drawText(pdf, 'REFERENCE', refX, y + 16, { size: 7, color: C.muted, style: 'bold' });
  drawText(pdf, shortRef(request.id, type), refX, y + 21, {
    size: 11, color: C.text, font: 'courier', style: 'bold',
  });
  if (qrDataUrl) {
    pdf.addImage(qrDataUrl, 'PNG', qrX, y + 2, qrSize, qrSize);
    drawText(pdf, 'Scan to verify', qrX + qrSize / 2, y + 26.5, {
      size: 6.5, color: C.muted, align: 'center',
    });
  }
  return y + h;
}

function drawTitle(pdf, y, type) {
  const titleText = type === 'rejoining' ? 'Rejoining Report' : 'Joining Report';
  drawText(pdf, titleText, PAGE_W / 2, y + 5, {
    size: 16, color: C.brand, style: 'bold', align: 'center',
  });
  const tw = pdf.getTextWidth(titleText);
  drawLine(pdf, (PAGE_W - tw) / 2, y + 7.5, (PAGE_W + tw) / 2, y + 7.5,
    { color: C.brand, width: 0.4 });
  return y + 8;
}

// Section header — full-width green-tinted band with thick brand-
// coloured left stripe. Matches the shared formCore drawSectionHeader
// dimensions so leave applications, permission requests, rejoining
// reports, and joining reports all use the same visual treatment.
// Nadeem 2026-05-18: 'theme for all the form should be same as
// Permission Request — Late Arrival'.
function drawSectionHeader(pdf, y, text) {
  const h = 9;
  drawRect(pdf, MARGIN_X, y, CONTENT_W, h, { fill: C.accent });
  drawRect(pdf, MARGIN_X, y, 2.2, h, { fill: C.brand });
  drawText(pdf, text, MARGIN_X + 7, y + 6.2, {
    size: 11, color: C.brand, style: 'bold',
  });
  return y + h + 1.5;
}

// Two-column label/value table — used for most sections so the page
// shows two pieces of information per row, doubling vertical efficiency
// without sacrificing readability. Each "column" is a label-value pair.
function drawTwoColTable(pdf, startY, rows) {
  // Each row is [[labelA, valueA], [labelB, valueB]]
  // Either side can be null to leave a blank cell.
  const colW       = CONTENT_W / 2;
  const labelW     = 32;
  const valueW     = colW - labelW - 4;
  let y = startY;
  for (const row of rows) {
    const [left, right] = row;
    const leftLines  = left  ? pdf.splitTextToSize(String(left[1]  || '—'), valueW) : [''];
    const rightLines = right ? pdf.splitTextToSize(String(right[1] || '—'), valueW) : [''];
    const lineCount  = Math.max(leftLines.length, rightLines.length, 1);
    const rowH       = Math.max(7, lineCount * 4.3 + 2.5);

    if (y > startY) {
      drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
        { color: C.border, width: 0.15 });
    }
    // Vertical divider between two columns
    drawLine(pdf, MARGIN_X + colW, y, MARGIN_X + colW, y + rowH,
      { color: C.border, width: 0.15 });

    if (left) {
      drawText(pdf, left[0], MARGIN_X + 1, y + 4.8, {
        size: 8, color: C.muted, style: 'bold',
      });
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9.5);
      pdf.setTextColor(...C.text);
      pdf.text(leftLines, MARGIN_X + labelW + 2, y + 4.8);
    }
    if (right) {
      drawText(pdf, right[0], MARGIN_X + colW + 2, y + 4.8, {
        size: 8, color: C.muted, style: 'bold',
      });
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9.5);
      pdf.setTextColor(...C.text);
      pdf.text(rightLines, MARGIN_X + colW + labelW + 3, y + 4.8);
    }
    y += rowH;
  }
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });
  return y;
}

// Single-column label/value (for sections where the value can be long,
// e.g. the declaration sentence).
function drawLabelValueTable(pdf, startY, rows) {
  const labelW = 42;
  const valueW = CONTENT_W - labelW;
  let y = startY;
  for (const [label, value] of rows) {
    const wrapped   = pdf.splitTextToSize(String(value || '—'), valueW - 6);
    const lineCount = Array.isArray(wrapped) ? wrapped.length : 1;
    const rowH      = Math.max(7, lineCount * 4.3 + 2.5);

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

// Type indicator row — like the leave-type checkbox row on the vacation
// form. Two boxes: New Joining / Rejoining.
function drawTypeRow(pdf, y, type) {
  const h = 9;
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });
  drawText(pdf, 'Report type', MARGIN_X + 1, y + 5.8, {
    size: 8.5, color: C.muted, style: 'bold',
  });
  const opts = [
    { key: 'joining',   label: 'New Joining' },
    { key: 'rejoining', label: 'Rejoining (returning from extended leave)' },
  ];
  let cx = MARGIN_X + 44;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(...C.text);
  for (const o of opts) {
    drawTickbox(pdf, cx, y + 6.2, o.key === type);
    pdf.text(o.label, cx + 4, y + 5.8);
    cx += pdf.getTextWidth(o.label) + 12;
  }
  drawLine(pdf, MARGIN_X, y + h, MARGIN_X + CONTENT_W, y + h,
    { color: C.border, width: 0.15 });
  return y + h;
}

// Salary table — five rows with SAR amounts and a bold total row.
function drawSalaryTable(pdf, startY, salary) {
  const rows = [
    ['Basic Salary',           fmtSAR(salary.basic)],
    ['Housing Allowance',      fmtSAR(salary.housing)],
    ['Transportation',         fmtSAR(salary.transportation)],
    ['Other Allowance',        fmtSAR(salary.other)],
  ];
  const labelW = 60;
  let y = startY;
  for (const [label, value] of rows) {
    if (y > startY) {
      drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
        { color: C.border, width: 0.15 });
    }
    drawText(pdf, label, MARGIN_X + 2, y + 5, {
      size: 9, color: C.muted, style: 'bold',
    });
    drawText(pdf, value, MARGIN_X + labelW + 4, y + 5, {
      size: 10, color: C.text,
    });
    y += 7;
  }
  // Bold total row with a tinted background.
  drawRect(pdf, MARGIN_X, y, CONTENT_W, 9, { fill: C.banner });
  drawText(pdf, 'TOTAL MONTHLY SALARY', MARGIN_X + 2, y + 6, {
    size: 9.5, color: C.brand, style: 'bold',
  });
  const total = (Number(salary.basic) || 0)
              + (Number(salary.housing) || 0)
              + (Number(salary.transportation) || 0)
              + (Number(salary.other) || 0);
  drawText(pdf, fmtSAR(total), MARGIN_X + labelW + 4, y + 6, {
    size: 11, color: C.brand, style: 'bold',
  });
  y += 9;
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });
  return y;
}

// Acknowledgement bullets — quietly numbered list. Tight spacing so
// the section never collides with the bottom-anchored signature grid,
// even when the Joining Details section grows for the rejoining case
// (which adds Previous-last-day + Absence-reason).
function drawAcknowledgement(pdf, y) {
  drawText(pdf,
    'I, the undersigned employee, hereby confirm and acknowledge the following:',
    MARGIN_X + 2, y + 5, { size: 9, color: C.text, style: 'italic' });
  y += 6.5;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  pdf.setTextColor(...C.text);
  POLICY_BULLETS.forEach((b, i) => {
    const num = `${(i + 1).toString().padStart(2, '0')}.`;
    drawText(pdf, num, MARGIN_X + 4, y + 3.5, {
      size: 8, color: C.brand, style: 'bold',
    });
    const wrapped = pdf.splitTextToSize(b, CONTENT_W - 16);
    pdf.text(wrapped, MARGIN_X + 12, y + 3.5);
    y += wrapped.length * 3.8 + 0.5;
  });
  return y;
}

// Signature grid — four cells along the bottom of the page.
// Names auto-shrink so long full names still fit within their cell
// width (the original 9pt assumed short names like "JOHN HO" but
// some employees have 4-part Arabic names that overflow into the
// next cell). Auto-fit: try 9pt; if too wide, drop to 8pt, then 7pt.
function drawSignatures(pdf, y, { employee, manager, hrName }) {
  const cellW = CONTENT_W / 4;
  const cellH = 35.4;
  const innerW = cellW - 4;
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.3 });
  const cells = [
    { label: 'EMPLOYEE',          name: employee?.name || '',     subtitle: 'Signature & Date' },
    { label: 'DEPARTMENT HEAD',   name: manager?.name  || '',     subtitle: 'Approve & Date' },
    { label: 'ESAU HR',           name: hrName,                   subtitle: 'Process & Stamp' },
    { label: 'MANAGEMENT',        name: CEO_NAME,                 subtitle: CEO_TITLE_EN },
  ];
  for (let i = 0; i < cells.length; i++) {
    const cx = MARGIN_X + i * cellW;
    if (i > 0) {
      drawLine(pdf, cx, y, cx, y + cellH, { color: C.border, width: 0.15 });
    }
    drawText(pdf, cells[i].label, cx + 2, y + 4.5, {
      size: 8, color: C.muted, style: 'bold',
    });
    const lineY = y + cellH - 11;
    drawLine(pdf, cx + 2, lineY, cx + cellW - 2, lineY,
      { color: C.text, width: 0.3 });
    // Auto-fit the name: try 9pt → 8pt → 7pt. If still too wide,
    // wrap onto two lines (some Arabic-origin Saudi names are long
    // enough that even 7pt overflows a 41.5mm cell width). Shows the
    // wrapped text on two lines stacked above the signature line.
    pdf.setFont('helvetica', 'bold');
    let nameSize = 9;
    let nameLines = [cells[i].name || '_________________'];
    let fitOnOneLine = false;
    for (const sz of [9, 8, 7]) {
      pdf.setFontSize(sz);
      if (pdf.getTextWidth(nameLines[0]) <= innerW) {
        nameSize = sz;
        fitOnOneLine = true;
        break;
      }
      nameSize = sz;
    }
    if (!fitOnOneLine) {
      pdf.setFontSize(nameSize);
      nameLines = pdf.splitTextToSize(cells[i].name || '_________________', innerW).slice(0, 2);
    }
    // Top-anchor the wrapped name so the first line sits just above
    // the line. Two-line names get 3.2mm line height at 7pt.
    const lineH = nameSize * 0.45;
    nameLines.forEach((ln, idx) => {
      drawText(pdf, ln,
        cx + 2,
        lineY + 5 - (nameLines.length - 1 - idx) * lineH,
        { size: nameSize, color: C.text, style: 'bold' });
    });
    drawText(pdf, cells[i].subtitle, cx + 2, lineY + 9, {
      size: 7.5, color: C.muted, style: 'italic',
    });
  }
  drawLine(pdf, MARGIN_X, y + cellH, MARGIN_X + CONTENT_W, y + cellH,
    { color: C.border, width: 0.3 });
  return y + cellH;
}

// Generated stamp — rotated 90° along the right edge so it doesn't
// compete with the form content but is visible for audit. Identical
// positioning to vacationFormPdf for consistency.
function drawGeneratedStamp(pdf, generatedBy) {
  const stamp = `Generated on ${fmtStampCompact(new Date().toISOString())}  ·  ${generatedBy || HR_DEFAULT}`;
  pdf.setFont('helvetica', 'italic');
  pdf.setFontSize(7);
  pdf.setTextColor(...C.muted);
  pdf.text(stamp, PAGE_W - 3, PAGE_H - 8, { angle: 90 });
}

// ─── main export ───────────────────────────────────────────────────────────

/**
 * Generate a Joining or Rejoining Report PDF as a Blob.
 *
 * @param {object} args
 * @param {'joining'|'rejoining'} args.type
 * @param {object} args.request — { id, ...form-specific fields }
 * @param {object} args.employee — { id, name, national_id, nationality,
 *                                   dob, phone, email }
 * @param {object} args.position — { designation, department, location,
 *                                   manager_id }
 * @param {object} args.joining  — { joining_date, effective_from,
 *                                   employment_type, probation_months,
 *                                   working_hours, workweek,
 *                                   previous_last_day, reason }
 * @param {object} args.salary   — { basic, housing, transportation, other }
 * @param {object} args.manager  — { name } (resolved by caller)
 * @param {string} args.hrName   — HR signatory (defaults to BASHAIER)
 * @returns {Promise<Blob>}
 */
export async function generateJoiningReportPdfBlob({
  type = 'joining',
  request = {},
  employee = {},
  position = {},
  joining = {},
  salary = {},
  manager = {},
  hrName = HR_DEFAULT,
} = {}) {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const logoUrl = await loadLogoDataUrl();
  const verifyUrl = `${VERIFY_BASE_URL}/verify/${shortRef(request.id, type)}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
    margin: 0, width: 180, errorCorrectionLevel: 'M',
  });

  let y = MARGIN_T;
  y = drawHeader(pdf, y, { logoUrl, qrDataUrl, request, type });
  y += 2;
  y = drawTitle(pdf, y, type);
  y += 2;

  // Type row
  y = drawTypeRow(pdf, y, type);
  y += 3;

  // ── Section 1: Employee Information ──
  y = drawSectionHeader(pdf, y, 'EMPLOYEE INFORMATION');
  y = drawTwoColTable(pdf, y, [
    [['Full name',     employee.name],          ['PSN ID',        employee.id]],
    [['National ID',   employee.national_id],   ['Nationality',   employee.nationality]],
    [['Date of birth', fmtDateShort(employee.dob)], ['Contact',   employee.phone]],
  ]);
  // Email gets its own full-width row (long addresses don't fit
  // in a half-width column without wrapping mid-domain).
  y = drawLabelValueTable(pdf, y, [
    ['Email', employee.email],
  ]);
  y += 3;

  // ── Section 2: Position & Department ──
  y = drawSectionHeader(pdf, y, 'POSITION & DEPARTMENT');
  const deptLabel = position.department
    ? `${position.department}${DEPT_NAMES[position.department] ? ` — ${DEPT_NAMES[position.department]}` : ''}`
    : '—';
  const locLabel = position.location
    ? `${position.location}${LOC_NAMES[position.location] ? ` — ${LOC_NAMES[position.location]}` : ''}`
    : '—';
  y = drawTwoColTable(pdf, y, [
    [['Designation',   position.designation],   ['Department',    deptLabel]],
    [['Location',      locLabel],               ['Reports to',    manager?.name]],
  ]);
  y += 3;

  // ── Section 3: Joining Details ──
  const dateLabel = type === 'rejoining' ? 'Rejoining date' : 'Joining date';
  y = drawSectionHeader(pdf, y, type === 'rejoining' ? 'REJOINING DETAILS' : 'JOINING DETAILS');
  const joiningRows = [
    [[dateLabel,          fmtDateLong(joining.joining_date)], ['Effective on payroll', fmtDateShort(joining.effective_from)]],
    [['Employment type',  joining.employment_type || 'Full-time'], ['Probation', joining.probation_months ? `${joining.probation_months} months` : '—']],
    [['Working hours',    joining.working_hours || '08:00 — 17:00'], ['Workweek', joining.workweek || 'Sunday — Thursday']],
  ];
  if (type === 'rejoining') {
    joiningRows.push(
      [['Previous last day', fmtDateShort(joining.previous_last_day)], ['Absence reason', joining.reason]],
    );
  }
  y = drawTwoColTable(pdf, y, joiningRows);
  y += 3;

  // ── Section 4: Compensation ──
  y = drawSectionHeader(pdf, y, 'COMPENSATION  ·  FOR ADMIN USE ONLY');
  y = drawSalaryTable(pdf, y, salary);
  y += 3;

  // ── Section 5: Acknowledgement ──
  y = drawSectionHeader(pdf, y, 'EMPLOYEE ACKNOWLEDGEMENT & DECLARATION');
  y = drawAcknowledgement(pdf, y);
  y += 3;

  // ── Section 6: Signatures (anchor to bottom of page) ──
  const sigH = 32;
  const sigY = PAGE_H - MARGIN_T - sigH;
  drawSignatures(pdf, sigY, { employee, manager, hrName });

  // Stamp
  drawGeneratedStamp(pdf, hrName);

  return pdf.output('blob');
}

export default generateJoiningReportPdfBlob;
