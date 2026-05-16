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
  y += 2;
  // Title is type-specific so HR / the recipient can identify what
  // they're looking at without reading the body. Falls back to plain
  // 'Permission Request' if type is missing.
  const typeLabel = PERMISSION_TYPES.find(t => t.key === permission.type)?.label;
  const titleText = typeLabel ? `Permission Request — ${typeLabel}` : 'Permission Request';
  y = drawTitle(pdf, y, titleText);
  y += 2;

  // Employee Information
  y = drawSectionHeader(pdf, y, 'EMPLOYEE INFORMATION');
  const deptLabel = position.department
    ? `${position.department}${DEPT_NAMES[position.department] ? ' — ' + DEPT_NAMES[position.department] : ''}`
    : '—';
  const locLabel = position.location
    ? `${position.location}${LOC_NAMES[position.location] ? ' — ' + LOC_NAMES[position.location] : ''}`
    : '—';
  // Designation falls back to 'Department Member' the same way the
  // vacation and rejoining forms do — that's the default non-supervisory
  // title at ESAU. Avoids showing '—' for staff whose record doesn't
  // carry the field explicitly.
  const designation = position.designation
                   || employee.designation
                   || 'Department Member';
  y = drawTwoColTable(pdf, y, [
    [['Full name',   employee.name],    ['PSN ID',     employee.id]],
    [['Designation', designation],      ['Department', deptLabel]],
    [['Location',    locLabel],         ['Reports to', manager?.name]],
  ]);
  y += 3;

  // Permission Details — render from the permission bag. Field renderers
  // already swallow nulls (drawTwoColTable shows '—'); duration prefers
  // minutes value when available.
  y = drawSectionHeader(pdf, y, 'PERMISSION DETAILS');
  y = drawTwoColTable(pdf, y, [
    [['Date',           permission.date ? fmtDateLong(permission.date) : '—'],
     ['Duration',       permission.duration_min ? `${permission.duration_min} minutes` : '—']],
    [['From',           permission.from_time || '—'],
     ['To',             permission.to_time || '—']],
    [['Notice',         permission.urgency === 'urgent' ? 'Urgent (<24h)' : 'Planned (at least 24h)'],
     ['Permission type', typeLabel || '—']],
  ]);
  y += 3;

  // Reason (single full-width field; permission_requests doesn't carry
  // structured categories, just the free-text reason the staff typed).
  y = drawSectionHeader(pdf, y, 'REASON');
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
