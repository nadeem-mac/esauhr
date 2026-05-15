// =============================================================================
// rejoiningReportPdf.js — native PDF generator for the rejoining report
//
// Matches the structure of the legacy docx sample
//   /mnt/project/Rejoining_Report_NASIR_KHAN_MUHAMMAD_ANWAR_2026-05-13_1_.docx
// Per Nadeem 2026-05-15: 'just make the same but in english and more
// polished version'.
//
// IMPORTANT: this is structurally different from joiningReportPdf.js.
// A rejoining report is for an EXISTING employee returning from leave,
// not a new hire. So we drop:
//   • National ID / Nationality / Date of birth / Contact
//   • Compensation section (no salary on a rejoining)
//   • Employee Acknowledgement & Declaration (signed at first joining)
//   • Working hours / Workweek (already known to all parties)
// And we add:
//   • ✓ REJOINED status badge top right
//   • TO / FROM line under the title
//   • ORIGINAL LEAVE section (type, period, duration, who approved when)
//   • RETURN DETAILS section (actual return, punctuality, status, Statement)
//   • Statement is auto-generated from leave type + dates + return date
//
// Single-page A4, English only, native jsPDF (selectable text + QR).
// =============================================================================

import {
  newPdf, loadLogoDataUrl, generateQRCode,
  drawHeader, drawSectionHeader, drawTwoColTable,
  drawSignatures, drawGeneratedStamp,
  drawText, drawLine, drawRect,
  C, MARGIN_X, MARGIN_T, PAGE_W, PAGE_H, CONTENT_W,
  DEPT_NAMES, LOC_NAMES, CEO_NAME, CEO_TITLE_EN, HR_DEFAULT,
  fmtDateLong, fmtDateShort, fmtStampCompact, shortRef,
} from './formCore.js';

const LEAVE_TYPE_LABEL = {
  annual:      'Annual Leave',
  sick:        'Sick Leave',
  emergency:   'Emergency Leave',
  hajj:        'Hajj Leave',
  maternity:   'Maternity Leave',
  paternity:   'Paternity Leave',
  marriage:    'Marriage Leave',
  bereavement: 'Bereavement Leave',
  unpaid:      'Unpaid Leave',
  study:       'Study Leave',
  iddah:       'Iddah Leave',
  other:       'Other Leave',
};

// ─── helpers ──────────────────────────────────────────────────────────────

// Compute "X years, Y months" tenure from a joined date. Returns '—' if
// the joined date is missing or unparseable. Matches the docx format
// '4 years, 9 months'.
function tenureFromJoined(joinedIso) {
  if (!joinedIso) return null;
  const joined = new Date(joinedIso);
  if (isNaN(joined.getTime())) return null;
  const now = new Date();
  let years  = now.getFullYear() - joined.getFullYear();
  let months = now.getMonth()    - joined.getMonth();
  if (now.getDate() < joined.getDate()) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  if (years < 0) return null;
  const yLabel = `${years} year${years === 1 ? '' : 's'}`;
  const mLabel = `${months} month${months === 1 ? '' : 's'}`;
  if (years === 0) return mLabel;
  return `${yLabel}, ${mLabel}`;
}

// Compare return date to end_date + 1. Yields a human label for the
// Punctuality field — 'Returned on schedule', 'Returned X days early',
// or 'Returned X days late' — matching the docx terminology.
function punctualityLabel(returnIso, endIso) {
  if (!returnIso || !endIso) return 'Returned on schedule';
  const expected = new Date(endIso);
  expected.setDate(expected.getDate() + 1);   // expected first working day back
  const actual = new Date(returnIso);
  if (isNaN(expected.getTime()) || isNaN(actual.getTime())) return 'Returned on schedule';
  const diffMs = actual.getTime() - expected.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0)  return 'Returned on schedule';
  if (diffDays  >  0)  return `Returned ${diffDays} day${diffDays === 1 ? '' : 's'} late`;
  const early = Math.abs(diffDays);
  return `Returned ${early} day${early === 1 ? '' : 's'} early`;
}

// Format the original leave period as a single string. Single-day leaves
// render as 'Wednesday, 13 May 2026'; multi-day as '13 May 2026  to  20 May 2026'.
function formatOriginalPeriod(startIso, endIso) {
  if (!startIso && !endIso) return '—';
  if (startIso && endIso && startIso === endIso) return fmtDateLong(startIso);
  return `${fmtDateShort(startIso)}  to  ${fmtDateShort(endIso)}`;
}

// Human duration label — '1 day', '7 days', etc.
function durationLabel(days) {
  if (days == null || days === '') return '—';
  const n = Number(days);
  if (isNaN(n)) return '—';
  return `${n} day${n === 1 ? '' : 's'}`;
}

// Auto-generate the rejoining statement text that matches the docx
// sample. Adapts to single-day vs multi-day, prefers leave type name
// from LEAVE_TYPE_LABEL, and includes the payroll-activation request
// at the end (which mirrors how the docx version closes).
function buildStatement({ leaveTypeId, startIso, endIso, returnIso, durationDays }) {
  const typeLabel = (LEAVE_TYPE_LABEL[leaveTypeId] || 'Leave').toLowerCase();
  const startStr  = fmtDateShort(startIso);
  const endStr    = fmtDateShort(endIso);
  const returnStr = fmtDateShort(returnIso);
  const n         = Number(durationDays) || 0;
  // 'totaling one day' for 1, 'totaling N days' otherwise — natural English
  let totalPhrase = '';
  if (n === 1)      totalPhrase = ', totaling one day';
  else if (n > 1)   totalPhrase = `, totaling ${n} days`;

  return `I would like to formally confirm that I was on ${typeLabel} from ${startStr} to ${endStr}${totalPhrase}. I am pleased to inform you that I have resumed my duties effective ${returnStr}. Kindly acknowledge my rejoining and update my employment status accordingly. I would also appreciate your support in arranging the activation of my payroll effective ${returnStr}.`;
}

// Draws a "✓ REJOINED" pill at the supplied y position. Green fill with
// white check + label. Same shape as the docx sample's badge.
function drawRejoinedBadge(pdf, y) {
  const label = 'REJOINED';
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  const labelW   = pdf.getTextWidth(label);
  const padding  = 4;
  const checkW   = 4;
  const badgeW   = checkW + labelW + padding * 2;
  const badgeH   = 6;
  const badgeX   = PAGE_W - MARGIN_X - badgeW;
  // Pill background
  pdf.setFillColor(...C.brand);
  pdf.roundedRect(badgeX, y, badgeW, badgeH, 1.2, 1.2, 'F');
  // Check mark
  pdf.setDrawColor(255, 255, 255);
  pdf.setLineWidth(0.6);
  const cx = badgeX + padding;
  const cy = y + badgeH / 2;
  pdf.line(cx,       cy + 0.3, cx + 1.2, cy + 1.5);
  pdf.line(cx + 1.2, cy + 1.5, cx + 3.0, cy - 1.2);
  // Label
  pdf.setTextColor(255, 255, 255);
  pdf.text(label, badgeX + padding + checkW + 0.5, y + 4.2);
  return y + badgeH;
}

// Full-width label / paragraph row — used for the Statement / Notes
// section which is always longer than one line.
function drawParagraphRow(pdf, y, label, paragraph) {
  const labelW = 42;
  const valueW = CONTENT_W - labelW - 6;
  const wrapped = pdf.splitTextToSize(String(paragraph || '—'), valueW);
  const rowH = Math.max(8, wrapped.length * 4.3 + 3);
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });
  drawText(pdf, label, MARGIN_X + 1, y + 5, {
    size: 8.5, color: C.muted, style: 'bold',
  });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9.5);
  pdf.setTextColor(...C.text);
  pdf.text(wrapped, MARGIN_X + labelW + 2, y + 5);
  drawLine(pdf, MARGIN_X, y + rowH, MARGIN_X + CONTENT_W, y + rowH,
    { color: C.border, width: 0.15 });
  return y + rowH;
}

// TO / FROM line under the title — formal memo-style addressing.
function drawToFromLine(pdf, y, employeeName) {
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9.5);
  pdf.setTextColor(...C.muted);
  pdf.text('TO:', MARGIN_X, y);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(...C.text);
  pdf.text('Departmental Head', MARGIN_X + 8, y);

  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(...C.muted);
  pdf.text('FROM:', MARGIN_X + 70, y);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(...C.text);
  pdf.text(String(employeeName || '—'), MARGIN_X + 82, y);
  return y + 4;
}

// Rejoining-specific title block. Uses the leave type in the title so
// HR can tell at a glance which leave the employee is returning from.
function drawRejoiningTitle(pdf, y, leaveTypeLabel) {
  const titleText = 'REJOINING REPORT';
  const subTitle  = `(From ${leaveTypeLabel})`;
  drawText(pdf, titleText, PAGE_W / 2, y + 5, {
    size: 16, color: C.brand, style: 'bold', align: 'center',
  });
  drawText(pdf, subTitle, PAGE_W / 2, y + 10, {
    size: 10.5, color: C.copper, style: 'italic', align: 'center',
  });
  // Underline matches the form-suite default but spans the subtitle width
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(16);
  const tw = pdf.getTextWidth(titleText);
  drawLine(pdf, (PAGE_W - tw) / 2, y + 7.5, (PAGE_W + tw) / 2, y + 7.5,
    { color: C.brand, width: 0.4 });
  return y + 13;
}

// ─── main export ───────────────────────────────────────────────────────────

export async function generateRejoiningReportPdfBlob({
  request = {},
  employee = {},
  position = {},
  approvals = {},      // { manager_approved_at, hr_approved_at, manager_name, hr_name }
  manager = {},
  hrName = HR_DEFAULT,
} = {}) {
  const pdf = newPdf();
  const logoUrl   = await loadLogoDataUrl();
  const qrDataUrl = await generateQRCode(`/verify/${shortRef(request.id, 'RJ')}`);

  const ltKey      = request.leave_type_id || 'annual';
  const leaveLabel = LEAVE_TYPE_LABEL[ltKey] || 'Leave';

  // Computed display values
  const tenure         = tenureFromJoined(employee.joined);
  const joinedShort    = employee.joined ? fmtDateShort(employee.joined) : '—';
  const joinedTenure   = (joinedShort && tenure)
    ? `${joinedShort}  ·  ${tenure}`
    : joinedShort;
  const deptCombined   = position.department
    ? `${DEPT_NAMES[position.department] || position.department}${position.location ? '  ·  ' + (LOC_NAMES[position.location] || position.location) : ''}`
    : '—';
  const returnIso      = request.return_date || request.actual_return_date;
  const punctuality    = punctualityLabel(returnIso, request.end_date);
  const originalPeriod = formatOriginalPeriod(request.start_date, request.end_date);
  const statement      = buildStatement({
    leaveTypeId:  ltKey,
    startIso:     request.start_date,
    endIso:       request.end_date,
    returnIso,
    durationDays: request.duration_days,
  });
  const managerApprovedAt = approvals.manager_approved_at
    ? fmtStampCompact(approvals.manager_approved_at)
    : '—';
  const hrApprovedAt = approvals.hr_approved_at
    ? fmtStampCompact(approvals.hr_approved_at)
    : '—';
  const submittedStamp = request.submitted_at
    ? fmtStampCompact(request.submitted_at)
    : '—';
  const managerName = manager?.name || approvals.manager_name || '—';

  // ─── render ───────────────────────────────────────────────────────────
  let y = MARGIN_T;
  y = drawHeader(pdf, y, { logoUrl, qrDataUrl, request, refPrefix: 'RJ' });

  // ✓ REJOINED badge — anchored just under the header rule
  drawRejoinedBadge(pdf, y - 5);

  y += 2;
  y = drawRejoiningTitle(pdf, y, leaveLabel);
  y += 2;

  y = drawToFromLine(pdf, y, employee.name);
  y += 3;

  // EMPLOYEE INFORMATION — minimal, matches the docx (5 fields)
  y = drawSectionHeader(pdf, y, 'EMPLOYEE INFORMATION');
  y = drawTwoColTable(pdf, y, [
    [['Employee name', employee.name], ['PSN ID', employee.id]],
    [['Department',    deptCombined],  ['Designation', position.designation]],
    [['Joined / Tenure', joinedTenure], [null, null]],
  ]);
  y += 3;

  // ORIGINAL LEAVE
  y = drawSectionHeader(pdf, y, 'ORIGINAL LEAVE');
  y = drawTwoColTable(pdf, y, [
    [['Leave type',         leaveLabel],
     ['Duration (approved)', durationLabel(request.duration_days)]],
    [['Original period',    originalPeriod],
     [null, null]],
    [['Manager approved',   managerApprovedAt],
     ['HR approved',        hrApprovedAt]],
  ]);
  y += 3;

  // RETURN DETAILS
  y = drawSectionHeader(pdf, y, 'RETURN DETAILS');
  y = drawTwoColTable(pdf, y, [
    [['Actual return date', returnIso ? fmtDateLong(returnIso) : '—'],
     ['Punctuality',         punctuality]],
    [['Return status',      'RETURNED'],
     [null, null]],
  ]);
  // Statement / Notes — full width, longer text
  y = drawParagraphRow(pdf, y, 'Statement / Notes', statement);

  // Signatures anchored to bottom — 4 cells with role + name + timestamp
  // matching the docx layout
  const sigH = 35.4;
  const sigY = PAGE_H - MARGIN_T - sigH;
  drawSignatures(pdf, sigY, [
    {
      label:    'EMPLOYEE',
      name:     employee.name || '',
      subtitle: request.submitted_at ? `Submitted ${submittedStamp}` : 'Signature & Date',
    },
    {
      label:    'DEPT MGR',
      name:     managerName,
      subtitle: approvals.manager_approved_at ? `Approved ${managerApprovedAt}` : 'Approve & Date',
    },
    {
      label:    'ESAU SUP',
      name:     hrName || HR_DEFAULT,
      subtitle: approvals.hr_approved_at ? `Approved ${hrApprovedAt}` : 'Process & Stamp',
    },
    {
      label:    'ESAU MGT',
      name:     CEO_NAME,
      subtitle: CEO_TITLE_EN,
    },
  ]);

  drawGeneratedStamp(pdf, hrName);
  return pdf.output('blob');
}

export default generateRejoiningReportPdfBlob;
