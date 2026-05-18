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
  drawCheckbox, drawCheckboxRow, drawBilingualSectionHeader,
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
//
// Every substitute row now gets a visible signature BOX (not just a line)
// so the printed form has a clear physical-signing target regardless of
// whether the substitute accepted online. When accepted online, the
// 'Accepted online' stamp sits at the top of the box but the space
// below is still available for a wet-ink signature — some line managers
// require both. Nadeem 2026-05-17.

function drawSubstitutes(pdf, y, subs = []) {
  y = drawBilingualSectionHeader(pdf, y, 'SUBSTITUTE COVERAGE', 'البديل أثناء الغياب');
  const colW = [10, 80, 60, 32];   // # · Name · Signature · Date
  const headers = ['#', 'SUBSTITUTE', 'SIGNATURE', 'DATE'];
  const rowH = 18;  // taller row so the signature box is genuinely usable
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
    // Row separator
    drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
      { color: C.border, width: 0.15 });
    let cx = MARGIN_X;

    // # column
    drawText(pdf, String(i + 1), cx + 2, y + (rowH / 2) + 1.5, {
      size: 9, color: C.text, style: 'bold',
    });
    cx += colW[0];

    // Substitute name + PSN
    drawText(pdf, s.name || '', cx + 2, y + 7, { size: 9, color: C.text });
    if (s.psn) drawText(pdf, s.psn, cx + 2, y + 11, { size: 7, color: C.muted });
    cx += colW[1];

    // SIGNATURE BOX — drawn for every row, always. When accepted online,
    // the stamp sits inside the box at the top; physical signing space
    // remains below. The box has subtle padding so the printed form
    // looks like a proper form field, not a blank line.
    const sigBoxX = cx + 2;
    const sigBoxY = y + 2;
    const sigBoxW = colW[2] - 4;
    const sigBoxH = rowH - 4;
    drawRect(pdf, sigBoxX, sigBoxY, sigBoxW, sigBoxH, {
      stroke: C.border, strokeWidth: 0.3,
    });
    if (s.signature === 'accepted_online') {
      // Stamp at top of the box
      drawText(pdf, '✓ Accepted online', sigBoxX + 2, sigBoxY + 4.5, {
        size: 7.5, color: C.brand, style: 'bold',
      });
      // Faint dotted hint that physical signing space is also available
      drawText(pdf, '— or sign physically below —', sigBoxX + 2, sigBoxY + 8.5, {
        size: 5.5, color: C.muted, style: 'italic',
      });
    } else {
      drawText(pdf, 'Sign here', sigBoxX + 2, sigBoxY + 4, {
        size: 6.5, color: C.muted, style: 'italic',
      });
    }
    cx += colW[2];

    // Date column
    drawText(pdf, fmtDateShort(s.date), cx + 2, y + (rowH / 2) + 1.5, {
      size: 8.5, color: C.text,
    });

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

  // Employee Information — 5 rows matching the Vacation_Sample.docx
  // template exactly. Combined fields where the sample does so:
  //   Department  = '{dept name} · {location}'   (e.g. 'Business · Dammam')
  //   Joined/Tenure = '{join date}  ·  {tenure}' (e.g. '01 Aug 2021 · 4 years 9 months')
  // Email, phone, reports-to, and stage are intentionally NOT in the
  // sample — they live elsewhere in the system (Employee detail modal,
  // attendance views) and including them on the leave application
  // would clutter the form. Bilingual headers via
  // drawBilingualSectionHeader (Arabic glyphs deferred — see formCore).
  y = drawBilingualSectionHeader(pdf, y, 'EMPLOYEE INFORMATION', 'معلومات الموظف');

  // Combined dept + location string. Department name expansion uses
  // DEPT_NAMES (e.g. SUP → Supervisory). Location uses the long form
  // (e.g. DMM → Dammam). Falls back gracefully when either is missing.
  const deptExpanded = position.department
    ? (DEPT_NAMES[position.department] || position.department)
    : '';
  const locExpanded = position.location
    ? (LOC_NAMES[position.location] || position.location)
    : '';
  const deptLocLabel = [deptExpanded, locExpanded].filter(Boolean).join('  ·  ') || '—';

  // Service tenure — always computed at PDF-gen time from join_date
  // so it's never stale. Combined with the join date in one cell to
  // match the sample's 'Joined / Tenure' row.
  let joinedTenureLabel = '—';
  if (employee.join_date) {
    const ms = Date.now() - new Date(employee.join_date).getTime();
    const yrs = Math.floor(ms / (1000 * 60 * 60 * 24 * 365.25));
    const mos = Math.floor((ms / (1000 * 60 * 60 * 24 * 30.44)) % 12);
    const tenure = `${yrs} year${yrs === 1 ? '' : 's'}${mos > 0 ? `, ${mos} month${mos === 1 ? '' : 's'}` : ''}`;
    joinedTenureLabel = `${fmtDateShort(employee.join_date)}   ·   ${tenure}`;
  }

  // Use the existing drawLabelValueTable (single column, label on left,
  // value taking full width on right) since the sample's employee info
  // rows are full-width with a single bold value, not two-column. This
  // matches the sample layout better than the two-col table did.
  y = drawLabelValueTable(pdf, y, [
    ['Employee name',     employee.name || '—'],
    ['PSN ID',            employee.id   || '—'],
    ['Department',        deptLocLabel],
    ['Designation',       position.designation || employee.designation || '—'],
    ['Joined / Tenure',   joinedTenureLabel],
  ]);
  y += 3;

  // ─── Leave Details ──────────────────────────────────────────────────
  // Sample format:
  //   Leave type → checkbox row showing ALL 10 types with ☑ for selected
  //   Period    → 'Wednesday, 13 May 2026' (long format for single day,
  //               date range for multi-day)
  //   Duration  → 'N day' + half-day checkbox inline
  //   Notice    → ☑/☐ Planned (≥14 days)  ☑/☐ Urgent (<14 days)
  //   Reason    → free text or '—'
  //   Submitted → 'DD MMM YYYY · HH:MM' (no stage field on the sample)
  y = drawBilingualSectionHeader(pdf, y, 'LEAVE DETAILS', 'تفاصيل الإجازة');

  // Leave type checkbox row — render every leave type, check only the
  // active one. Order matches the sample (Annual first, Other last).
  // Pre-build the row outside the table so we can use the wider
  // checkbox row primitive. Anchor at the standard label column.
  const LEAVE_TYPE_LIST = [
    { id: 'annual',      label: 'Annual' },
    { id: 'sick',        label: 'Sick' },
    { id: 'emergency',   label: 'Emergency' },
    { id: 'hajj',        label: 'Hajj' },
    { id: 'maternity',   label: 'Maternity' },
    { id: 'paternity',   label: 'Paternity' },
    { id: 'marriage',    label: 'Marriage' },
    { id: 'bereavement', label: 'Bereavement' },
    { id: 'unpaid',      label: 'Unpaid' },
    { id: 'other',       label: 'Other' },
  ];
  // Reserve a label column (42mm wide like drawLabelValueTable) so the
  // checkbox row aligns visually with the other field rows.
  const labelColW = 42;
  // Outer container row — bordered top + bottom so it reads as one row
  // of the field table. Height is dynamic since the checkbox row wraps.
  const rowStartY = y;
  drawText(pdf, 'Leave type', MARGIN_X + 1, y + 5, {
    size: 8.5, color: C.muted, style: 'bold',
  });
  const cbResult = drawCheckboxRow(pdf,
    MARGIN_X + labelColW + 2,
    y + 1.5,
    LEAVE_TYPE_LIST.map(t => ({
      label: t.label,
      checked: ltKey === t.id,
    })),
    { size: 2.8, labelSize: 8.5, gap: 2.5, lineGap: 4.5 }
  );
  // Row height = checkbox lines * line height + padding
  const cbRowH = Math.max(7, cbResult.lineCount * 4.5 + 2);
  y = rowStartY + cbRowH;
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });

  // Period row — long format for single-day leaves matches the sample;
  // multi-day shows the inclusive range.
  const periodLabel = request.start_date && request.end_date
    ? (request.start_date === request.end_date
        ? fmtDateLong(request.start_date)
        : `${fmtDateShort(request.start_date)}  —  ${fmtDateShort(request.end_date)}`)
    : '—';

  // Duration + half-day checkbox combined into one cell to match the
  // sample's '1 day · ☐ Half day' layout.
  const durationY = y;
  drawText(pdf, 'Duration', MARGIN_X + 1, durationY + 5, {
    size: 8.5, color: C.muted, style: 'bold',
  });
  const durLabel = request.days
    ? `${request.days} day${Number(request.days) === 1 ? '' : 's'}`
    : '—';
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9.5);
  pdf.setTextColor(...C.text);
  pdf.text(durLabel, MARGIN_X + labelColW + 2, durationY + 5);
  // Half-day checkbox inline, ~25mm to the right of the duration value
  const halfDayX = MARGIN_X + labelColW + 2 +
    (pdf.getStringUnitWidth(durLabel) * 9.5 / pdf.internal.scaleFactor) + 6;
  drawText(pdf, '·', halfDayX - 3, durationY + 5,
    { size: 9, color: C.muted });
  drawCheckbox(pdf, halfDayX, durationY + 2.2,
    `Half day${request.is_half_day && request.half_day_period ? ` (${request.half_day_period})` : ''}`,
    !!request.is_half_day,
    { size: 2.8, labelSize: 8.5 });
  y = durationY + 7;
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });

  // Period row (single-line value, full-width)
  const periodY = y;
  drawText(pdf, 'Period', MARGIN_X + 1, periodY + 5, {
    size: 8.5, color: C.muted, style: 'bold',
  });
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9.5);
  pdf.setTextColor(...C.text);
  pdf.text(periodLabel, MARGIN_X + labelColW + 2, periodY + 5);
  y = periodY + 7;
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });

  // Notice — checkbox pair (Planned vs Urgent). Derived from the
  // notice window between requested_at and start_date since there's
  // no separate `urgency` column.
  let isPlanned = false;
  let isUrgent  = false;
  if (request.requested_at && request.start_date) {
    const noticeDays = Math.round(
      (new Date(request.start_date) - new Date(request.requested_at)) / 86400000
    );
    isPlanned = noticeDays >= 14;
    isUrgent  = !isPlanned;
  }
  const noticeY = y;
  drawText(pdf, 'Notice', MARGIN_X + 1, noticeY + 5, {
    size: 8.5, color: C.muted, style: 'bold',
  });
  let nx = MARGIN_X + labelColW + 2;
  nx = drawCheckbox(pdf, nx, noticeY + 2.2, 'Planned (≥14 days)',
    isPlanned, { size: 2.8, labelSize: 8.5, gap: 4 });
  drawCheckbox(pdf, nx, noticeY + 2.2, 'Urgent (<14 days)',
    isUrgent, { size: 2.8, labelSize: 8.5 });
  y = noticeY + 7;
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });

  // Reason — multi-line, full-width value
  y = drawLabelValueTable(pdf, y, [
    ['Reason / details', request.reason || '—'],
  ]);

  // Submitted — last row, stamps the request creation time
  const submittedLabel = request.requested_at
    ? `${fmtDateShort(request.requested_at)}  ·  ${
        new Date(request.requested_at).toLocaleTimeString('en-GB', {
          hour: '2-digit', minute: '2-digit', hour12: false,
        })}`
    : '—';
  y = drawLabelValueTable(pdf, y, [
    ['Submitted', submittedLabel],
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
  y = drawBilingualSectionHeader(pdf, y, 'POLICY · KSA LABOR LAW', 'سياسة الإجازات · نظام العمل السعودي');
  const policy = POLICY_BY_TYPE[ltKey] || POLICY_BY_TYPE.other;
  y = drawPolicyBullets(pdf, y, policy);

  // 4-cell signature grid matching the Vacation_Sample.docx template:
  // EMPLOYEE / DEPT MGR / ESAU SUP / ESAU MGT — short labels with the
  // person's name + their status (Submitted / Approved date · time).
  // Subtitles convey the workflow stage so the printed form reads as
  // a full audit trail without HR having to annotate it.
  const sigH = 35.4;
  const sigY = PAGE_H - MARGIN_T - sigH;

  // Stamp subtitles — show when each role acted, in the same compact
  // 'DD MMM · HH:MM' format the sample uses. Falls back to 'Signature
  // & Date' when the role hasn't acted yet.
  const fmtCompactStamp = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = d.toLocaleString('en-GB', { month: 'short' });
    const hh = String(d.getHours()).padStart(2, '0');
    const mn = String(d.getMinutes()).padStart(2, '0');
    return `${dd} ${mm}  ·  ${hh}:${mn}`;
  };
  const submittedStamp = fmtCompactStamp(request.requested_at);
  const managerStamp   = fmtCompactStamp(request.manager_decided_at);
  const hrStamp        = fmtCompactStamp(request.hr_decided_at);

  drawSignatures(pdf, sigY, [
    { label: 'EMPLOYEE',  name: employee.name || '',
      subtitle: submittedStamp ? `Submitted ${submittedStamp}` : 'Signature & Date' },
    { label: 'DEPT MGR',  name: manager?.name || '',
      subtitle: managerStamp ? `Approved ${managerStamp}` : 'Approve & Date' },
    { label: 'ESAU SUP',  name: hrName,
      subtitle: hrStamp ? `Approved ${hrStamp}` : 'Process & Stamp' },
    { label: 'ESAU MGT',  name: CEO_NAME,
      subtitle: CEO_TITLE_EN },
  ]);

  drawGeneratedStamp(pdf, hrName);
  return pdf.output('blob');
}

export default generateLeaveApplicationPdfBlob;
