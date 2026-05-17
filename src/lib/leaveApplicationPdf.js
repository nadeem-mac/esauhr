// =============================================================================
// leaveApplicationPdf.js — universal leave application form
//
// Replaces and extends vacationFormPdf.js. Handles every leave type the
// portal supports, with TYPE-SPECIFIC enriched sections inserted between
// the standard Leave Details and the policy:
//
//   annual       → no extra section (standard form is enough)
//   sick         → Medical Certificate (cert ref, doctor, facility, fit-date)
//   maternity    → Maternity Details (expected delivery, hospital, prenatal/
//                  postnatal split, breastfeeding extension)
//   paternity    → Paternity Details (spouse name, expected delivery, hospital)
//   hajj         → Hajj Details (season year, first-time / repeat, return date)
//   marriage     → Marriage Details (spouse name, wedding date, location)
//   bereavement  → Bereavement Details (relationship, funeral location)
//   emergency    → Emergency Details (nature, contact person & phone)
//   study        → Study Details (institution, course, format, duration)
//   unpaid       → Unpaid Details (reason, return commitment)
//   iddah        → Iddah Details (trigger event date, location)
//   other        → Other Details (free-form reason)
//
// Each type-specific section adds 1–3 rows so the page still fits in A4
// without overflowing the bottom-anchored signature grid.
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

// ─── leave type vocabulary ─────────────────────────────────────────────────

export const LEAVE_TYPE_LABEL = {
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

const TYPE_CHECKBOX_ORDER = [
  'annual', 'sick', 'emergency', 'hajj', 'maternity',
  'paternity', 'marriage', 'bereavement', 'unpaid', 'study', 'iddah', 'other',
];

// Type-specific policy bullets. Kept short — each form is one page.
const POLICY_BY_TYPE = {
  annual: [
    'Annual leave: 21 calendar days per year after 1 year of service; 30 days after 5 years.',
    'Annual leave must be requested at least 14 days in advance.',
    'Approved annual leave cannot be cancelled unilaterally once HR has processed it.',
  ],
  sick: [
    'Sick leave requires a valid medical certificate from an approved medical facility (Sehhaty / Ministry of Health affiliated).',
    'Full pay: first 30 days. Three-quarter pay: next 60 days. No pay: subsequent 30 days. Per KSA Labor Law Article 117.',
    'Sick leave certificates must be submitted within 7 days of the absence start.',
  ],
  maternity: [
    'Maternity leave: 10 weeks of paid leave, split flexibly between prenatal and postnatal periods. Per KSA Labor Law Article 151.',
    'A medical certificate confirming the expected delivery date is required at submission.',
    'Nursing-mother privileges (1-hour daily reduction) apply for up to 24 months after birth.',
  ],
  paternity: [
    'Paternity leave: 3 days of paid leave at the time of childbirth. Per KSA Labor Law Article 113.',
    'A copy of the birth certificate or hospital discharge must be submitted within 7 days.',
  ],
  hajj: [
    'Hajj leave: up to 10 days paid, once during the employee\'s career, after 2 years of service. Per KSA Labor Law Article 114.',
    'Hajj leave must be requested at least 30 days before the Hajj season.',
    'Proof of pilgrimage (Tasreeh) must be submitted within 14 days of return.',
  ],
  marriage: [
    'Marriage leave: 5 days of paid leave on the occasion of marriage. Per KSA Labor Law Article 113.',
    'A copy of the marriage contract must be submitted to HR within 14 days.',
  ],
  bereavement: [
    'Bereavement leave: 5 days for a death in the immediate family (spouse, parent, child, sibling). Per KSA Labor Law Article 113.',
    'Iddah leave (4 months and 10 days) applies separately for Muslim widows.',
    'Documentation (death certificate or family-book entry) must be submitted within 7 days.',
  ],
  emergency: [
    'Emergency leave: short-notice absence for urgent, unforeseeable personal matters.',
    'Verbal notice must be given to the direct manager on the day of the emergency; written submission within 48 hours.',
    'Repeated use without valid cause may be deducted from annual leave entitlement.',
  ],
  unpaid: [
    'Unpaid leave: no salary, no allowances paid during the leave period.',
    'Continuous service is preserved; benefits accrual is suspended during the leave.',
    'Maximum 90 days per calendar year without affecting end-of-service entitlement.',
  ],
  study: [
    'Study leave: requires prior approval, valid acceptance letter, and a study plan endorsed by the line manager.',
    'Paid study leave is at company discretion based on relevance to the role.',
    'Employee commits to remain with the company for an agreed period after returning.',
  ],
  iddah: [
    'Iddah leave: 4 months and 10 days of paid leave following the death of a Muslim woman\'s husband. Per KSA Labor Law Article 113.',
    'Documentation (death certificate) and a confirmation of marital status are required.',
  ],
  other: [
    'Other leave: any leave type not covered above. Full justification must be provided in the reason section.',
    'Approval is at HR and management discretion based on circumstances.',
  ],
};

// ─── leave-type checkbox row ──────────────────────────────────────────────

function drawLeaveTypeRow(pdf, y, ltKey) {
  const labelW = 42;
  const lineH  = 5.2;
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });
  drawText(pdf, 'Leave type', MARGIN_X + 1, y + 5.5, {
    size: 8.5, color: C.muted, style: 'bold',
  });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  const leftBound  = MARGIN_X + labelW + 2;
  const rightBound = MARGIN_X + CONTENT_W - 3;
  let cx = leftBound, cy = y + 5.5;
  for (const k of TYPE_CHECKBOX_ORDER) {
    const label = LEAVE_TYPE_LABEL[k];
    const itemW = pdf.getTextWidth(label) + 8;
    if (cx + itemW > rightBound) { cx = leftBound; cy += lineH; }
    drawTickbox(pdf, cx, cy + 0.4, k === ltKey);
    pdf.setTextColor(...C.text);
    pdf.text(label, cx + 4, cy);
    cx += itemW;
  }
  const rowH = (cy - y) + 9;
  drawLine(pdf, MARGIN_X, y + rowH, MARGIN_X + CONTENT_W, y + rowH,
    { color: C.border, width: 0.15 });
  return y + rowH;
}

// ─── type-specific extra section ──────────────────────────────────────────
//
// Renders the additional fields that matter for each leave type. Returns
// the new y position; callers append it after the standard leave-details
// section. Each variant aims for 2–4 rows to keep the page fitting A4.
function drawTypeSpecificSection(pdf, y, request, employee = {}) {
  const t = request.leave_type_id;
  const d = request.type_details || {};
  switch (t) {
    case 'sick':
      y = drawSectionHeader(pdf, y, 'MEDICAL CERTIFICATE');
      return drawTwoColTable(pdf, y, [
        [['Certificate ref',    d.cert_ref],
         ['Issue date',         fmtDateShort(d.cert_date)]],
        [['Treating doctor',    d.doctor_name],
         ['Medical facility',   d.facility]],
        [['Diagnosis',          d.diagnosis || 'Not disclosed'],
         ['Fit-to-return date', fmtDateShort(d.fit_to_return)]],
      ]);

    case 'maternity': {
      y = drawSectionHeader(pdf, y, 'MATERNITY DETAILS');
      // Compute pay rate basis per KSA Labour Law Art. 151:
      //   • Service ≥ 3 years          → 100% paid
      //   • Service ≥ 1 yr, < 3 yrs    → 50% paid
      //   • Service < 1 year           → unpaid (entitled to leave; not to pay)
      const empJoin = employee?.join_date || null;
      let payRateLabel = '—';
      if (empJoin) {
        const monthsSince = Math.max(0,
          Math.round((new Date() - new Date(empJoin)) / (1000 * 60 * 60 * 24 * 30.44)));
        const yrs = Math.floor(monthsSince / 12);
        payRateLabel = yrs >= 3 ? '100% paid · ≥3 yrs service'
                     : yrs >= 1 ? '50% paid · 1–3 yrs service'
                     :            'unpaid · <1 yr service';
      }
      return drawTwoColTable(pdf, y, [
        [['Expected delivery',     fmtDateShort(d.expected_delivery)],
         ['Hospital / clinic',     d.hospital]],
        [['Medical certificate ref', d.cert_ref],
         ['Pregnancy number',      d.pregnancy_number]],
        [['Prenatal portion',      d.prenatal_days  != null ? `${d.prenatal_days} days`  : '—'],
         ['Postnatal portion',     d.postnatal_days != null ? `${d.postnatal_days} days` : '—']],
        [['Actual delivery date',  d.already_delivered && d.actual_delivery
                                     ? fmtDateShort(d.actual_delivery)
                                     : (d.already_delivered ? 'Yes — date TBC' : 'Not yet delivered')],
         ['Pay rate basis',        payRateLabel]],
        [['Nursing-hour request',  d.nursing_hours
                                     ? 'Yes — 1 paid hour/day for 24 months (Art. 153)'
                                     : 'Not requested'],
         ['Total entitlement',     '10 weeks (70 days) — Art. 151']],
      ]);
    }

    case 'paternity':
      y = drawSectionHeader(pdf, y, 'PATERNITY DETAILS');
      return drawTwoColTable(pdf, y, [
        [['Spouse name',           d.spouse_name],
         ['Expected delivery',     fmtDateShort(d.expected_delivery)]],
        [['Hospital / clinic',     d.hospital],
         ['Actual delivery date',  fmtDateShort(d.actual_delivery)]],
      ]);

    case 'hajj':
      y = drawSectionHeader(pdf, y, 'HAJJ DETAILS');
      return drawTwoColTable(pdf, y, [
        [['Hajj season (Hijri)',   d.season_year],
         ['Pilgrimage group',      d.group]],
        [['Departure date',        fmtDateShort(d.departure_date)],
         ['Return date',           fmtDateShort(d.return_date)]],
        [['First-time hajj',       d.first_time ? 'Yes' : 'No (repeat)'],
         ['Service years on date', d.service_years]],
      ]);

    case 'marriage':
      y = drawSectionHeader(pdf, y, 'MARRIAGE DETAILS');
      return drawTwoColTable(pdf, y, [
        [['Spouse name',           d.spouse_name],
         ['Wedding date',          fmtDateShort(d.wedding_date)]],
        [['Location',              d.location],
         ['Marriage contract no.', d.contract_no]],
      ]);

    case 'bereavement':
      y = drawSectionHeader(pdf, y, 'BEREAVEMENT DETAILS');
      return drawTwoColTable(pdf, y, [
        [['Deceased name',         d.deceased_name],
         ['Relationship',          d.relationship]],
        [['Date of passing',       fmtDateShort(d.date_of_passing)],
         ['Funeral location',      d.funeral_location]],
      ]);

    case 'emergency':
      y = drawSectionHeader(pdf, y, 'EMERGENCY DETAILS');
      return drawTwoColTable(pdf, y, [
        [['Nature of emergency',   d.nature],
         ['Contact person',        d.contact_person]],
        [['Contact phone',         d.contact_phone],
         ['Location',              d.location]],
      ]);

    case 'study':
      y = drawSectionHeader(pdf, y, 'STUDY DETAILS');
      return drawTwoColTable(pdf, y, [
        [['Institution',           d.institution],
         ['Course / program',      d.course]],
        [['Study format',          d.format || 'Full-time'],
         ['Total duration',        d.total_duration]],
        [['Field of study',        d.field],
         ['Relevance to role',     d.relevance || '—']],
      ]);

    case 'unpaid':
      y = drawSectionHeader(pdf, y, 'UNPAID LEAVE DETAILS');
      return drawLabelValueTable(pdf, y, [
        ['Reason',                  d.reason],
        ['Return commitment',       d.return_commitment],
      ]);

    case 'iddah':
      y = drawSectionHeader(pdf, y, 'IDDAH DETAILS');
      return drawTwoColTable(pdf, y, [
        [['Date of bereavement',   fmtDateShort(d.bereavement_date)],
         ['Location',              d.location]],
        [['Death certificate ref', d.cert_ref],
         ['Expected end date',     fmtDateShort(d.expected_end)]],
      ]);

    case 'other':
      y = drawSectionHeader(pdf, y, 'OTHER LEAVE DETAILS');
      return drawLabelValueTable(pdf, y, [
        ['Full justification',     d.justification],
      ]);

    case 'annual':
    default:
      return y;  // no extra section needed
  }
}

// ─── substitutes table ────────────────────────────────────────────────────

function drawSubstitutes(pdf, y, subs = []) {
  y = drawSectionHeader(pdf, y, 'SUBSTITUTE COVERAGE');
  const colW = [10, 80, 60, 32];   // # · Name · Signature · Date
  const headers = ['#', 'SUBSTITUTE', 'SIGNATURE', 'DATE'];
  const rowH = 11;
  // Header row
  drawRect(pdf, MARGIN_X, y, CONTENT_W, 7, { fill: C.labelBg });
  let cx = MARGIN_X;
  for (let i = 0; i < headers.length; i++) {
    drawText(pdf, headers[i], cx + 2, y + 4.8, {
      size: 8, color: C.muted, style: 'bold',
    });
    cx += colW[i];
  }
  y += 7;
  // Body rows — minimum 1, up to 3 substitutes
  const list = subs.length > 0 ? subs.slice(0, 3) : [{ name: '', signature: '', date: '' }];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
      { color: C.border, width: 0.15 });
    let cx = MARGIN_X;
    drawText(pdf, String(i + 1), cx + 2, y + 7, { size: 9, color: C.text, style: 'bold' });
    cx += colW[0];
    drawText(pdf, s.name || '', cx + 2, y + 7, { size: 9, color: C.text });
    if (s.psn) drawText(pdf, s.psn, cx + 2, y + 10.5, { size: 7, color: C.muted });
    cx += colW[1];
    if (s.signature === 'accepted_online') {
      drawText(pdf, 'Accepted online', cx + 2, y + 5, { size: 8, color: C.brand, style: 'bold' });
      drawText(pdf, 'Signature', cx + 2, y + 9, { size: 7, color: C.muted, style: 'italic' });
    } else {
      drawLine(pdf, cx + 2, y + 8, cx + colW[2] - 2, y + 8,
        { color: C.text, width: 0.3 });
    }
    cx += colW[2];
    drawText(pdf, fmtDateShort(s.date), cx + 2, y + 7, { size: 8.5, color: C.text });
    y += rowH;
  }
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });
  return y;
}

// ─── main export ───────────────────────────────────────────────────────────

export async function generateLeaveApplicationPdfBlob({
  request = {},
  employee = {},
  position = {},
  substitutes = [],
  manager = {},
  hrName = HR_DEFAULT,
} = {}) {
  const pdf = newPdf();
  const logoUrl = await loadLogoDataUrl();
  // QR encodes the public verify URL — must match the /verify-leave/:uuid
  // route in App.jsx. Earlier versions encoded the display ref ('LV-XXX...')
  // which didn't match any route, so the QR scan went nowhere.
  const qrDataUrl = await generateQRCode(`/verify-leave/${request.id}`);

  const ltKey = request.leave_type_id || 'annual';
  const typeLabel = LEAVE_TYPE_LABEL[ltKey] || 'Leave';

  let y = MARGIN_T;
  y = drawHeader(pdf, y, { logoUrl, qrDataUrl, request, refPrefix: 'LV' });
  y += 2;
  y = drawTitle(pdf, y, `Leave Application — ${typeLabel}`);
  y += 2;

  // Leave-type checkbox row (preserves the visual cue from the paper form)
  y = drawLeaveTypeRow(pdf, y, ltKey);
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
    [['Full name',     employee.name],         ['PSN ID',         employee.id]],
    [['Designation',   position.designation],  ['Department',     deptLabel]],
    [['Location',      locLabel],              ['Reports to',     manager?.name]],
    [['Joined',        fmtDateShort(employee.joined)],
     ['Service years', employee.service_years || '—']],
  ]);
  y += 3;

  // Leave Details
  y = drawSectionHeader(pdf, y, 'LEAVE DETAILS');
  const periodLabel = request.start_date && request.end_date
    ? (request.start_date === request.end_date
        ? fmtDateLong(request.start_date)
        : `${fmtDateShort(request.start_date)}  —  ${fmtDateShort(request.end_date)}`)
    : '—';
  y = drawTwoColTable(pdf, y, [
    [['Period',         periodLabel],
     ['Duration',       request.duration_days ? `${request.duration_days} day${request.duration_days === 1 ? '' : 's'}` : '—']],
    [['Notice',         request.urgency === 'urgent' ? 'Urgent (<14 days)' : 'Planned (at least 14 days)'],
     ['Half day',       request.is_half_day ? `Yes (${request.half_day_period || 'Morning'})` : 'No']],
    [['Submitted',      fmtDateShort(request.submitted_at)],
     ['Stage',          request.stage || 'pending_manager']],
  ]);
  y = drawLabelValueTable(pdf, y, [
    ['Reason / details', request.reason],
  ]);
  y += 3;

  // ── TYPE-SPECIFIC SECTION (the enriched bit per leave type) ──
  const yBefore = y;
  y = drawTypeSpecificSection(pdf, y, request, employee);
  if (y > yBefore) y += 3;

  // Substitutes — only for leave types that need coverage during absence
  if (!['emergency'].includes(ltKey)) {
    y = drawSubstitutes(pdf, y, substitutes);
    y += 3;
  }

  // Policy specific to this leave type
  y = drawSectionHeader(pdf, y, 'POLICY · KSA LABOR LAW');
  const policy = POLICY_BY_TYPE[ltKey] || POLICY_BY_TYPE.other;
  y = drawPolicyBullets(pdf, y, policy);

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

export default generateLeaveApplicationPdfBlob;
