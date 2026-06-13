// =============================================================================
// rejoiningReportPdf.js — native PDF for the rejoining report
//
// 2026-05-16 (Nadeem): 'make it relaxed and make full use of the A4 Page,
// should match exactly as the sample of rejoining in .docx'.
//
// Mirrors /mnt/project/Rejoining_Report_NASIR_KHAN_MUHAMMAD_ANWAR_2026-05-13_1_.docx
// beat for beat:
//   ✓ REJOINED badge (top-right, anchored under the header rule)
//   REJOINING REPORT (From <Leave Type>) title + brand-coloured underline
//   TO: Departmental Head    FROM: <employee>
//   EMPLOYEE INFORMATION  ·  5 single-column rows
//   ORIGINAL LEAVE        ·  5 single-column rows
//   RETURN DETAILS        ·  3 single-column rows + Statement paragraph
//   4-cell signature grid (EMPLOYEE / DEPT MGR / ESAU SUP / ESAU MGT)
//   Generated stamp rotated on the right edge
//
// Differences from the docx (per spec):
//   • English only — Arabic columns removed
//   • Single-page A4, full-bleed (5mm top margin); selectable text; QR
//   • Single-column key-value rows (NOT two-column) so the page reads
//     like the docx — each field on its own line, label left, value right
//   • Relaxed vertical rhythm — generous label padding, larger value
//     type, real breathing room between sections; row sizes tuned so
//     13 single rows + statement + signatures fit comfortably on one
//     A4 page without crowding the bottom-anchored signature grid
//
// Existing-employee specific — no National ID / DOB / Contact /
// Compensation / Acknowledgement (those belong on the new-hire
// joiningReportPdf.js, not here).
// =============================================================================

import { designationOf } from './designation.js';
import {
  newPdf, loadLogoDataUrl, generateQRCode,
  drawHeader, drawTitle, drawSectionHeader, drawSingleRow,
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

// ─── computed helpers ─────────────────────────────────────────────────────

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

function punctualityLabel(returnIso, endIso) {
  if (!returnIso || !endIso) return 'Returned on schedule';
  const expected = new Date(endIso);
  expected.setDate(expected.getDate() + 1);
  const actual = new Date(returnIso);
  if (isNaN(expected.getTime()) || isNaN(actual.getTime())) return 'Returned on schedule';
  const diffDays = Math.round((actual.getTime() - expected.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Returned on schedule';
  if (diffDays  >  0) return `Returned ${diffDays} day${diffDays === 1 ? '' : 's'} late`;
  const early = Math.abs(diffDays);
  return `Returned ${early} day${early === 1 ? '' : 's'} early`;
}

function formatOriginalPeriod(startIso, endIso) {
  if (!startIso && !endIso) return '—';
  if (startIso && endIso && startIso === endIso) return fmtDateLong(startIso);
  return `${fmtDateShort(startIso)}  to  ${fmtDateShort(endIso)}`;
}

function durationLabel(days) {
  if (days == null || days === '') return '—';
  const n = Number(days);
  if (isNaN(n)) return '—';
  return `${n} day${n === 1 ? '' : 's'}`;
}

function buildStatement({ leaveTypeId, startIso, endIso, returnIso, durationDays }) {
  const typeLabel = (LEAVE_TYPE_LABEL[leaveTypeId] || 'Leave').toLowerCase();
  const startStr  = fmtDateShort(startIso);
  const endStr    = fmtDateShort(endIso);
  const returnStr = fmtDateShort(returnIso);
  const n         = Number(durationDays) || 0;
  let totalPhrase = '';
  if (n === 1)      totalPhrase = ', totaling one day';
  else if (n > 1)   totalPhrase = `, totaling ${n} days`;
  return `I would like to formally confirm that I was on ${typeLabel} from ${startStr} to ${endStr}${totalPhrase}. I am pleased to inform you that I have resumed my duties effective ${returnStr}. Kindly acknowledge my rejoining and update my employment status accordingly. I would also appreciate your support in arranging the activation of my payroll effective ${returnStr}.`;
}

// ─── drawing primitives ───────────────────────────────────────────────────

function drawRejoinedBadge(pdf, y) {
  const label = 'REJOINED';
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  const labelW   = pdf.getTextWidth(label);
  const padding  = 5.5;
  const checkW   = 5;
  const badgeW   = checkW + labelW + padding * 2;
  const badgeH   = 8;
  const badgeX   = PAGE_W - MARGIN_X - badgeW;
  pdf.setFillColor(...C.brand);
  pdf.roundedRect(badgeX, y, badgeW, badgeH, 1.6, 1.6, 'F');
  pdf.setDrawColor(255, 255, 255);
  pdf.setLineWidth(0.8);
  const cx = badgeX + padding;
  const cy = y + badgeH / 2;
  pdf.line(cx,       cy + 0.5, cx + 1.6, cy + 2.0);
  pdf.line(cx + 1.6, cy + 2.0, cx + 4.0, cy - 1.6);
  pdf.setTextColor(255, 255, 255);
  pdf.text(label, badgeX + padding + checkW + 0.5, y + 5.5);
  return y + badgeH;
}

function drawRejoiningTitle(pdf, y, leaveTypeLabel) {
  const titleText = 'REJOINING REPORT';
  const subTitle  = `(From ${leaveTypeLabel})`;
  drawText(pdf, titleText, PAGE_W / 2, y + 7, {
    size: 22, color: C.brand, style: 'bold', align: 'center',
  });
  drawText(pdf, subTitle, PAGE_W / 2, y + 13.5, {
    size: 12, color: C.copper, style: 'italic', align: 'center',
  });
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(22);
  const tw = pdf.getTextWidth(titleText);
  drawLine(pdf, (PAGE_W - tw) / 2, y + 10.5, (PAGE_W + tw) / 2, y + 10.5,
    { color: C.brand, width: 0.5 });
  return y + 16;
}

function drawToFromLine(pdf, y, employeeName) {
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10.5);
  pdf.setTextColor(...C.muted);
  pdf.text('TO:', MARGIN_X, y);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(...C.text);
  pdf.text('Departmental Head', MARGIN_X + 11, y);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(...C.muted);
  pdf.text('FROM:', MARGIN_X + 92, y);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(...C.text);
  pdf.text(String(employeeName || '—'), MARGIN_X + 108, y);
  return y + 4;
}

// drawSectionHeader + drawSingleRow promoted to formCore — see
// formCore.js. The local copies (identical) were removed so every form
// stays in sync. Nadeem 2026-05-18.

function drawStatementRow(pdf, y, label, statement) {
  const labelW  = 60;
  const valueW  = CONTENT_W - labelW - 4;
  const wrapped = pdf.splitTextToSize(String(statement || '—'), valueW);
  const lineCount = Array.isArray(wrapped) ? wrapped.length : 1;
  const rowH = Math.max(18, lineCount * 4.8 + 3);
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.2 });
  drawText(pdf, label, MARGIN_X + 3, y + 6, {
    size: 10, color: C.muted, style: 'bold',
  });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10.5);
  pdf.setTextColor(...C.text);
  pdf.text(wrapped, MARGIN_X + labelW + 2, y + 6);
  drawLine(pdf, MARGIN_X, y + rowH, MARGIN_X + CONTENT_W, y + rowH,
    { color: C.border, width: 0.2 });
  return y + rowH;
}

// ─── main export ──────────────────────────────────────────────────────────

export async function generateRejoiningReportPdfBlob({
  request = {},
  employee = {},
  position = {},
  approvals = {},
  manager = {},
  hrName = HR_DEFAULT,
} = {}) {
  const pdf = newPdf();
  const logoUrl   = await loadLogoDataUrl();
  // QR encodes the public verify URL — must match the /verify-rejoin/:uuid
  // route in App.jsx. Earlier versions encoded the display ref ('RJ-XXX...')
  // which didn't match any route, so the QR scan went nowhere.
  const qrDataUrl = await generateQRCode(`/verify-rejoin/${request.id}`);

  const ltKey      = request.leave_type_id || 'annual';
  const leaveLabel = LEAVE_TYPE_LABEL[ltKey] || 'Leave';

  // Field-name guards — the employees table stores the hire date as
  // `join_date` (not `joined`). Defending against both for forward
  // compatibility in case any caller still passes the old shape.
  const joinedIso      = employee.join_date || employee.joined || null;
  const tenure         = tenureFromJoined(joinedIso);
  const joinedShort    = joinedIso ? fmtDateShort(joinedIso) : null;
  const joinedTenure   = (joinedShort && tenure)
    ? `${joinedShort}   ·   ${tenure}`
    : (joinedShort || '—');

  // Designation falls back to 'Department Member' the same way the
  // vacation form does — that's the default non-supervisory title at
  // ESAU so we never have to show a dash where a real role belongs.
  const designation = designationOf(position.designation, employee.designation);

  const deptCombined   = position.department
    ? `${DEPT_NAMES[position.department] || position.department}${position.location ? '   ·   ' + (LOC_NAMES[position.location] || position.location) : ''}`
    : '—';
  const returnIso      = request.return_date || request.actual_return_date;
  const punctuality    = punctualityLabel(returnIso, request.end_date);
  const originalPeriod = formatOriginalPeriod(request.start_date, request.end_date);

  // Duration — prefer the stored count, otherwise compute inclusive
  // calendar days from start/end. Half-day leaves carry 0.5 in the
  // stored value, so we can't unconditionally recompute. Accepts both
  // `request.days` (canonical DB column) and `request.duration_days`
  // (legacy alias from earlier code paths) so it works either way.
  let durationDays = request.days != null ? request.days : request.duration_days;
  if (durationDays == null && request.start_date && request.end_date) {
    const s = new Date(request.start_date);
    const e = new Date(request.end_date);
    if (!isNaN(s.getTime()) && !isNaN(e.getTime())) {
      durationDays = Math.max(1, Math.round((e - s) / 86400000) + 1);
    }
  }

  const statement      = buildStatement({
    leaveTypeId:  ltKey,
    startIso:     request.start_date,
    endIso:       request.end_date,
    returnIso,
    durationDays,
  });
  const managerApprovedAt = approvals.manager_approved_at
    ? fmtStampCompact(approvals.manager_approved_at)
    : '—';
  const hrApprovedAt = approvals.hr_approved_at
    ? fmtStampCompact(approvals.hr_approved_at)
    : '—';
  // Submitted timestamp — canonical DB column is requested_at; submitted_at
  // is a legacy alias still produced by some callers. Accept either so the
  // signature subtitle has the right date.
  const submittedIso = request.requested_at || request.submitted_at;
  const submittedStamp = submittedIso ? fmtStampCompact(submittedIso) : '—';
  const managerName = manager?.name || approvals.manager_name || '—';

  let y = MARGIN_T;
  y = drawHeader(pdf, y, { logoUrl, qrDataUrl, request, refPrefix: 'RJ' });
  drawRejoinedBadge(pdf, y - 6);

  y += 3;
  y = drawRejoiningTitle(pdf, y, leaveLabel);
  y += 3;

  y = drawToFromLine(pdf, y, employee.name);
  y += 3;

  y = drawSectionHeader(pdf, y, 'EMPLOYEE INFORMATION');
  y = drawSingleRow(pdf, y, 'Employee name',     employee.name,     { emphasis: true });
  y = drawSingleRow(pdf, y, 'PSN ID',            employee.id);
  y = drawSingleRow(pdf, y, 'Department',        deptCombined);
  y = drawSingleRow(pdf, y, 'Designation',       designation);
  y = drawSingleRow(pdf, y, 'Joined / Tenure',   joinedTenure);
  y += 3;

  y = drawSectionHeader(pdf, y, 'ORIGINAL LEAVE');
  y = drawSingleRow(pdf, y, 'Leave type',          leaveLabel, { emphasis: true });
  y = drawSingleRow(pdf, y, 'Original period',     originalPeriod);
  y = drawSingleRow(pdf, y, 'Duration (approved)', durationLabel(durationDays), { emphasis: true });
  y = drawSingleRow(pdf, y, 'Manager approved',    managerApprovedAt);
  y = drawSingleRow(pdf, y, 'HR approved',         hrApprovedAt);
  y += 3;

  y = drawSectionHeader(pdf, y, 'RETURN DETAILS');
  y = drawSingleRow(pdf, y, 'Actual return date', returnIso ? fmtDateLong(returnIso) : '—', { emphasis: true });
  y = drawSingleRow(pdf, y, 'Punctuality',         punctuality);
  y = drawSingleRow(pdf, y, 'Return status',       'RETURNED', { emphasis: true });
  y = drawStatementRow(pdf, y, 'Statement / Notes', statement);

  const sigH = 35.4;
  const sigY = PAGE_H - MARGIN_T - sigH;
  drawSignatures(pdf, sigY, [
    {
      label:    'EMPLOYEE',
      name:     employee.name || '',
      subtitle: submittedIso ? `Submitted ${submittedStamp}` : 'Signature & Date',
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
