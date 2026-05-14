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
  drawHeader, drawTitle, drawSectionHeader, drawTwoColTable,
  drawLabelValueTable, drawPolicyBullets, drawSignatures, drawGeneratedStamp,
  drawTickbox, drawText, drawLine, drawRect,
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

const REASON_CATEGORIES = [
  { key: 'medical',       label: 'Medical' },
  { key: 'government',    label: 'Government / Bank' },
  { key: 'family',        label: 'Family / Emergency' },
  { key: 'school',        label: 'School / Childcare' },
  { key: 'traffic',       label: 'Traffic / Transport' },
  { key: 'other',         label: 'Other' },
];

// Tickbox row — generic horizontal "label + boxes" renderer.
function drawTickboxRow(pdf, y, label, options, selected) {
  const h = 9;
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });
  drawText(pdf, label, MARGIN_X + 1, y + 5.8, {
    size: 8.5, color: C.muted, style: 'bold',
  });
  let cx = MARGIN_X + 44;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(...C.text);
  for (const o of options) {
    drawTickbox(pdf, cx, y + 6.2, o.key === selected);
    pdf.text(o.label, cx + 4, y + 5.8);
    cx += pdf.getTextWidth(o.label) + 12;
  }
  drawLine(pdf, MARGIN_X, y + h, MARGIN_X + CONTENT_W, y + h,
    { color: C.border, width: 0.15 });
  return y + h;
}

// Multi-select tickbox row — same as drawTickboxRow but with multiple
// boxes filled. Wraps onto multiple lines for long option lists.
function drawMultiTickboxRow(pdf, y, label, options, selectedSet) {
  const labelW = 40;
  const lineH = 5.2;
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });
  drawText(pdf, label, MARGIN_X + 1, y + 5.5, {
    size: 8.5, color: C.muted, style: 'bold',
  });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(...C.text);
  const leftBound  = MARGIN_X + labelW + 2;
  const rightBound = MARGIN_X + CONTENT_W - 3;
  let cx = leftBound, cy = y + 5.5;
  for (const o of options) {
    const itemW = pdf.getTextWidth(o.label) + 10;
    if (cx + itemW > rightBound) { cx = leftBound; cy += lineH; }
    drawTickbox(pdf, cx, cy + 0.4, selectedSet?.has?.(o.key));
    pdf.text(o.label, cx + 4, cy);
    cx += itemW;
  }
  const rowH = (cy - y) + 9;
  drawLine(pdf, MARGIN_X, y + rowH, MARGIN_X + CONTENT_W, y + rowH,
    { color: C.border, width: 0.15 });
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
  const qrDataUrl = await generateQRCode(`/verify/${shortRef(request.id, 'PR')}`);

  let y = MARGIN_T;
  y = drawHeader(pdf, y, { logoUrl, qrDataUrl, request, refPrefix: 'PR' });
  y += 2;
  y = drawTitle(pdf, y, 'Permission Request');
  y += 2;

  // Type — Late Arrival vs Early Departure
  y = drawTickboxRow(pdf, y, 'Permission type',
    PERMISSION_TYPES, permission.type);
  y += 3;

  // Employee Information
  y = drawSectionHeader(pdf, y, 'EMPLOYEE INFORMATION');
  const deptLabel = position.department
    ? `${position.department}${DEPT_NAMES[position.department] ? ' — ' + DEPT_NAMES[position.department] : ''}`
    : '—';
  const locLabel = position.location
    ? `${position.location}${LOC_NAMES[position.location] ? ' — ' + LOC_NAMES[position.location] : ''}`
    : '—';
  y = drawTwoColTable(pdf, y, [
    [['Full name',   employee.name],    ['PSN ID',     employee.id]],
    [['Designation', position.designation], ['Department', deptLabel]],
    [['Location',    locLabel],         ['Reports to', manager?.name]],
  ]);
  y += 3;

  // Permission Details
  y = drawSectionHeader(pdf, y, 'PERMISSION DETAILS');
  y = drawTwoColTable(pdf, y, [
    [['Date',           fmtDateLong(permission.date)],
     ['Duration',       permission.duration_min ? `${permission.duration_min} minutes` : '—']],
    [['From',           permission.from_time],
     ['To',             permission.to_time]],
    [['Notice',         permission.urgency === 'urgent' ? 'Urgent (<24h)' : 'Planned (at least 24h)'],
     ['This month',     permission.month_count != null ? `${permission.month_count} of 3 used` : '—']],
    [['Replacement',    permission.replacement || 'Not required'],
     [null, null]],
  ]);
  y += 3;

  // Reason (full width — may be longer text)
  y = drawSectionHeader(pdf, y, 'REASON');
  const selectedReasons = new Set(permission.reason_categories || []);
  y = drawMultiTickboxRow(pdf, y, 'Category', REASON_CATEGORIES, selectedReasons);
  y = drawLabelValueTable(pdf, y, [
    ['Details', permission.reason_details],
  ]);
  y += 3;

  // Policy reminder
  y = drawSectionHeader(pdf, y, 'POLICY REMINDER');
  y = drawPolicyBullets(pdf, y, PERMISSION_POLICY);
  y += 3;

  // Signatures anchored to bottom
  const sigH = 35.4;
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
