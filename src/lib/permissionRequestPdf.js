// =============================================================================
// permissionRequestPdf.js — Late Arrival / Early Departure permission form
//
// Replaces ESAU_New_Permission_Request_Form.docx with a native A4 PDF.
// English only, full-bleed print, selectable text, QR-verifiable.
//
// Permission policy (KSA HR convention):
//   • Max 3 permissions per calendar month
//   • Max 60 minutes per request
//   • Planned (at least 24h notice) or Urgent (<24h)
// =============================================================================

import {
  newPdf, loadLogoDataUrl, generateQRCode,
  drawHeader, drawTitle, drawPolicyBullets, drawSignatures, drawGeneratedStamp,
  drawSectionHeader, drawSingleRow,
  drawText, drawLine, drawRect,
  C, MARGIN_X, MARGIN_T, PAGE_W, PAGE_H, CONTENT_W,
  DEPT_NAMES, LOC_NAMES, CEO_NAME, CEO_TITLE_EN, HR_DEFAULT,
  fmtDateLong, fmtDateShort, shortRef,
} from './formCore.js';

const PERMISSION_POLICY = [
  'Each employee is entitled to a maximum of 3 permissions per calendar month (late arrival or early departure combined).',
  'Each individual permission must not exceed 60 minutes under any circumstance.',
  'Permission must be requested at least 24 hours in advance whenever possible (planned). Urgent (<24h) permissions require the manager\'s prior verbal approval and immediate written follow-up.',
  'Repeated or excess permissions may result in disciplinary action under company policy.',
  'It is the employee\'s responsibility to arrange replacement coverage where their absence affects operations.',
];

const PERMISSION_TYPES = [
  { key: 'late_arrival',    label: 'Late Arrival' },
  { key: 'early_departure', label: 'Early Departure' },
];

// ─── relaxed layout helpers ───────────────────────────────────────────────
// Same vertical rhythm as rejoiningReportPdf — single-column key-value
// rows with generous heights, taller section header bands, full A4 fit.
// Sizing tuned to fit 9 single rows + statement + 5 policy bullets +
// signatures on a single A4 page without overflow.

// (drawTitle promoted to formCore — see formCore.js.)

// (drawSectionHeader + drawSingleRow promoted to formCore so every
// form uses the same primitive — see formCore.js.)

function drawReasonRow(pdf, y, label, paragraph) {
  const labelW  = 60;
  const valueW  = CONTENT_W - labelW - 4;
  const wrapped = pdf.splitTextToSize(String(paragraph || '—'), valueW);
  const lineCount = Array.isArray(wrapped) ? wrapped.length : 1;
  const rowH = Math.max(16, lineCount * 4.8 + 3);
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

export async function generatePermissionRequestPdfBlob({
  request = {},
  employee = {},
  position = {},
  permission = {},
  manager = {},
  hrName = HR_DEFAULT,
} = {}) {
  const pdf = newPdf();
  const logoUrl = await loadLogoDataUrl();
  // QR encodes the public verify URL — must match the /verify/:integer
  // route in App.jsx (permission_requests uses integer ids). Earlier
  // versions encoded the display ref ('PR-XXXXX') which didn't match
  // the route regex, so the QR scan went nowhere.
  const qrDataUrl = await generateQRCode(`/verify/${request.id}`);

  let y = MARGIN_T;
  y = drawHeader(pdf, y, { logoUrl, qrDataUrl, request, refPrefix: 'PR' });
  y += 4;

  // Title — type-specific so HR can identify the kind at a glance.
  const typeLabel = PERMISSION_TYPES.find(t => t.key === permission.type)?.label;
  const titleText = typeLabel ? `Permission Request — ${typeLabel}` : 'Permission Request';
  y = drawTitle(pdf, y, titleText);
  y += 4;

  // EMPLOYEE INFORMATION — single-column rows, one field per line
  y = drawSectionHeader(pdf, y, 'EMPLOYEE INFORMATION');
  const deptLabel = position.department
    ? `${position.department}${DEPT_NAMES[position.department] ? '  —  ' + DEPT_NAMES[position.department] : ''}`
    : '—';
  const locLabel = position.location
    ? `${position.location}${LOC_NAMES[position.location] ? '  —  ' + LOC_NAMES[position.location] : ''}`
    : '—';
  const designation = position.designation
                   || employee.designation
                   || 'Department Member';
  y = drawSingleRow(pdf, y, 'Full name',   employee.name, { emphasis: true });
  y = drawSingleRow(pdf, y, 'PSN ID',      employee.id);
  y = drawSingleRow(pdf, y, 'Designation', designation);
  y = drawSingleRow(pdf, y, 'Department',  deptLabel);
  y = drawSingleRow(pdf, y, 'Location',    locLabel);
  y = drawSingleRow(pdf, y, 'Reports to',  manager?.name);
  y += 4;

  // PERMISSION DETAILS — combined From/To row, separate Date / Duration /
  // Notice rows. Type is in the title so we don't repeat it here.
  y = drawSectionHeader(pdf, y, 'PERMISSION DETAILS');
  const timeWindow = (permission.from_time && permission.to_time)
    ? `${permission.from_time}  to  ${permission.to_time}`
    : (permission.from_time || permission.to_time || '—');
  const durationStr = permission.duration_min
    ? `${permission.duration_min} minutes`
    : '—';
  const noticeStr = permission.urgency === 'urgent'
    ? 'Urgent  (less than 24h notice)'
    : 'Planned  (at least 24h notice)';
  y = drawSingleRow(pdf, y, 'Date',       permission.date ? fmtDateLong(permission.date) : '—', { emphasis: true });
  y = drawSingleRow(pdf, y, 'Time window', timeWindow);
  y = drawSingleRow(pdf, y, 'Duration',   durationStr, { emphasis: true });
  y = drawSingleRow(pdf, y, 'Notice',     noticeStr);
  y += 4;

  // REASON — full-width paragraph row (taller, accommodates longer text)
  y = drawSectionHeader(pdf, y, 'REASON');
  y = drawReasonRow(pdf, y, 'Details', permission.reason_details);
  y += 4;

  // POLICY REMINDER — bullets pulled from constant
  y = drawSectionHeader(pdf, y, 'POLICY REMINDER');
  y = drawPolicyBullets(pdf, y, PERMISSION_POLICY);

  // Signatures anchored to bottom
  const sigH = 32;
  const sigY = PAGE_H - MARGIN_T - sigH;
  drawSignatures(pdf, sigY, [
    { label: 'EMPLOYEE',          name: employee.name || '',     subtitle: 'Signature & Date' },
    { label: 'DEPARTMENT HEAD',   name: manager?.name || '',     subtitle: 'Approve & Date' },
    { label: 'ESAU HR',           name: hrName,                  subtitle: 'Process & Stamp' },
    { label: 'MANAGEMENT',        name: CEO_NAME,                subtitle: CEO_TITLE_EN },
  ]);

  drawGeneratedStamp(pdf, hrName);
  return pdf.output('blob');
}

export default generatePermissionRequestPdfBlob;
