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
  drawHeader, drawTitle, drawSectionHeader, drawSingleRow, drawTwoColTable,
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
    case 'sick': {
      // MEDICAL CERTIFICATE — compact 2-column layout so the whole leave
      // application fits on a single A4 page. Pairs short fields side-by-
      // side; uses full-width rows for long fields (Facility name,
      // Diagnosis text) that would otherwise wrap awkwardly in a half-
      // width cell. Pulls every relevant field LeaveApprovedModal /
      // HrApprovalModal extract from the Sehhaty PDF the staff uploaded.
      // Nadeem 2026-05-18: 'All application form should appear in one
      // A4 size page, the sick leave is going second page, compact it
      // to fit in 1 page only.'
      y = drawSectionHeader(pdf, y, 'MEDICAL CERTIFICATE');

      // Format the sick-period date range cleanly.
      let periodCovered = null;
      if (d.seen_start && d.seen_end) {
        periodCovered = d.seen_start === d.seen_end
          ? fmtDateShort(d.seen_start)
          : `${fmtDateShort(d.seen_start)} — ${fmtDateShort(d.seen_end)}`;
        if (d.seen_days) periodCovered += ` · ${d.seen_days}d`;
      } else if (d.seen_days) {
        periodCovered = `${d.seen_days} day${Number(d.seen_days) === 1 ? '' : 's'}`;
      }

      // Doctor + specialty inline.
      const doctorLine = d.doctor_name
        ? (d.specialty ? `${d.doctor_name} · ${d.specialty}` : d.doctor_name)
        : null;

      // Certificate code — prefer GS code (the verification handle).
      // Keep this row terse so it pairs neatly with Issued.
      const certRefLine = d.cert_code || d.cert_ref || null;

      // Issued timestamp — DD MMM HH:MM (no seconds in compact layout
      // to keep it inside a half-width cell). Seconds still go onto the
      // substitute table where the audit stamp matters most.
      let issuedLine = null;
      if (d.cert_date) {
        const dt = new Date(d.cert_date);
        if (!isNaN(dt.getTime())) {
          const hasTime = dt.getHours() || dt.getMinutes() || dt.getSeconds();
          issuedLine = hasTime
            ? `${fmtDateShort(d.cert_date)} · ${
                dt.toLocaleTimeString('en-GB', {
                  hour: '2-digit', minute: '2-digit', hour12: false,
                })}`
            : fmtDateShort(d.cert_date);
        }
      }

      // Verification stamp — compact, name + date.
      const verifiedLine = d.verified_at
        ? (d.verified_by
            ? `${d.verified_by} · ${fmtDateShort(d.verified_at)}`
            : fmtDateShort(d.verified_at))
        : null;

      // Patient cross-check, compact.
      const patientLine = (d.seen_patient_name || d.seen_patient_id)
        ? [d.seen_patient_name, d.seen_patient_id].filter(Boolean).join(' · ')
        : null;

      // 2-column rows — pair short fields, leave a side null when the
      // partner field is absent (drawTwoColTable handles half-empty rows).
      // Long fields (facility, diagnosis) go full-width via single-row
      // calls between the two-col blocks.
      const certRows = [];
      // Row 1: Cert code | Issued
      if (certRefLine || issuedLine) {
        certRows.push([
          certRefLine ? ['Cert code', certRefLine] : null,
          issuedLine  ? ['Issued',    issuedLine]  : null,
        ]);
      }
      // Row 2: Doctor (with specialty) | Fit-to-return
      if (doctorLine || d.fit_to_return) {
        certRows.push([
          doctorLine        ? ['Doctor',        doctorLine] : null,
          d.fit_to_return   ? ['Fit-to-return', fmtDateShort(d.fit_to_return)] : null,
        ]);
      }
      // Row 3: Period covered | Patient
      if (periodCovered || patientLine) {
        certRows.push([
          periodCovered ? ['Period covered', periodCovered] : null,
          patientLine   ? ['Patient',        patientLine]   : null,
        ]);
      }
      // Row 4: HR verified | (null) - only when verified
      if (verifiedLine) {
        certRows.push([['HR verified', verifiedLine], null]);
      }
      if (certRows.length > 0) {
        y = drawTwoColTable(pdf, y, certRows);
      }

      // Facility — full-width row since the name is often long.
      if (d.facility) {
        y = drawSingleRow(pdf, y, 'Facility', d.facility);
      }
      // Diagnosis — full-width row, prominent. ICD code typically
      // included in the value already (e.g. 'Viral URI (J06.9)').
      y = drawSingleRow(pdf, y, 'Diagnosis', d.diagnosis || 'Not disclosed');
      return y;
    }

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

// ─── substitutes table — clean structure (Nadeem 2026-05-18) ──────────────
//
// Layout request from Nadeem: signature box is EMPTY with a border so
// the substitute can physically sign inside. The DATE column carries
// the online-acceptance info — a green check + 'Accepted online' label
// + the date and time WITH SECONDS so HR has a precise audit stamp.
//
// Column widths chosen so the DATE column is wide enough for two
// stacked lines ('✓ Accepted online' on top, 'DD MMM YYYY HH:MM:SS'
// underneath) without wrapping.

function drawSubstitutes(pdf, y, subs = [], { isManualEntry = false } = {}) {
  y = drawSectionHeader(pdf, y, 'SUBSTITUTE COVERAGE');
  const colW = [10, 70, 50, 52];   // # · Name · Signature box · Date+accept
  const headers = ['#', 'SUBSTITUTE', 'SIGNATURE', 'DATE'];
  const rowH = 15;

  // Header row
  drawRect(pdf, MARGIN_X, y, CONTENT_W, 6, { fill: C.labelBg });
  let cx = MARGIN_X;
  for (let i = 0; i < headers.length; i++) {
    drawText(pdf, headers[i], cx + 2, y + 4.2, {
      size: 7.5, color: C.muted, style: 'bold',
    });
    cx += colW[i];
  }
  y += 6;

  // Format helper — DD MMM YYYY HH:MM:SS so the audit stamp is unambiguous.
  // Falls back to '' if no date provided so the cell renders blank rather
  // than showing 'Invalid Date'.
  const fmtFullStamp = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = d.toLocaleString('en-GB', { month: 'short' });
    const yy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const mn = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${dd} ${mm} ${yy}  ${hh}:${mn}:${ss}`;
  };

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

    // Substitute name + PSN. Keep the original single-line layout
    // (y+7 name, y+11 PSN) so spacing matches the rest of the form,
    // but auto-shrink the font when a name like 'SYED NOMAN SADAQAT
    // SYED SADAQAT ALI' would overflow the 70mm column. Tries 9pt
    // → 8 → 7 → 6 in 0.5mm-tolerance increments, falling back to
    // the smallest readable size. Nadeem 2026-05-21.
    const nameMaxW = colW[1] - 4;
    const nameStr = s.name || '';
    let nameSize = 9;
    pdf.setFont('helvetica', 'bold');
    for (const candidate of [9, 8, 7, 6]) {
      pdf.setFontSize(candidate);
      if (pdf.getTextWidth(nameStr) <= nameMaxW) { nameSize = candidate; break; }
      nameSize = candidate;  // worst case stays at 6
    }
    drawText(pdf, nameStr, cx + 2, y + 7, {
      size: nameSize, color: C.text, style: 'bold',
    });
    if (s.psn) drawText(pdf, s.psn, cx + 2, y + 11, { size: 7, color: C.muted });
    cx += colW[1];

    // SIGNATURE BOX — bordered rectangle, EMPTY. The user explicitly asked
    // for the box to be empty so staff can sign inside. The online-accept
    // stamp lives in the DATE column on the right. The 'Sign here' hint
    // appears only when not accepted yet; once accepted, the box stays
    // empty so the substitute can additionally sign physically if needed.
    const sigBoxX = cx + 2;
    const sigBoxY = y + 2;
    const sigBoxW = colW[2] - 4;
    const sigBoxH = rowH - 4;
    drawRect(pdf, sigBoxX, sigBoxY, sigBoxW, sigBoxH, {
      stroke: C.border, strokeWidth: 0.3,
    });
    if (s.signature !== 'accepted_online') {
      // Only show the placeholder hint when there's no online accept.
      drawText(pdf, 'Sign here', sigBoxX + 2, sigBoxY + 4, {
        size: 6.5, color: C.muted, style: 'italic',
      });
    }
    cx += colW[2];

    // DATE column — when accepted online, two stacked lines:
    //   line 1: small drawn check mark + 'Accepted online' (bold brand-green)
    //   line 2: 'DD MMM YYYY  HH:MM:SS' (text color)
    // When not accepted: just the date if available, else blank.
    // The check is drawn with two short lines rather than the Unicode
    // glyph (U+2713) because standard Helvetica's encoding doesn't
    // include it — the glyph renders as an apostrophe.
    const dateCellX = cx + 2;
    if (s.signature === 'accepted_online') {
      // Drawn check mark — short rising stroke + longer descending stroke
      const chkX = dateCellX;
      const chkY = y + 7;
      drawLine(pdf, chkX, chkY - 0.4, chkX + 1.2, chkY + 0.8,
        { color: C.brand, width: 0.7 });
      drawLine(pdf, chkX + 1.2, chkY + 0.8, chkX + 3.2, chkY - 2.2,
        { color: C.brand, width: 0.7 });
      drawText(pdf, 'Accepted online', dateCellX + 5, y + 7, {
        size: 8, color: C.brand, style: 'bold',
      });
      // Timestamp sits in grey (muted) underneath the bold green stamp
      // so the eye reads the 'accepted' assertion first, then the
      // precise audit time as a secondary detail. Italic helps it
      // visually recede further. Nadeem 2026-05-18.
      // Skipped for manual Logbook entries — paper applications don't
      // carry the precise online-acceptance timestamp. Nadeem 2026-05-21.
      if (!isManualEntry) {
        drawText(pdf, fmtFullStamp(s.date), dateCellX, y + 12, {
          size: 7.5, color: C.muted, style: 'italic',
        });
      }
    } else if (s.date) {
      drawText(pdf, fmtFullStamp(s.date), dateCellX, y + (rowH / 2) + 1.5, {
        size: 8, color: C.text,
      });
    }

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

  // Logbook entries (paper/email applications recorded by Bashaier)
  // get a STRIPPED-DOWN form — no QR code, no Accepted-online
  // timestamps, no generated-on stamp — because they represent
  // physical paper trails that don't have online verification
  // signals. Detected by the 'Manual entry · …' reason prefix that
  // Logbook writes on every insert. Nadeem 2026-05-21.
  const isManualEntry = (request.reason || '').startsWith('Manual entry');

  // QR encodes the public verify URL — must match the /verify-leave/:uuid
  // route in App.jsx. Skipped for manual entries.
  const qrDataUrl = isManualEntry
    ? null
    : await generateQRCode(`/verify-leave/${request.id}`);

  const ltKey = request.leave_type_id || 'annual';
  const typeLabel = LEAVE_TYPE_LABEL[ltKey] || 'Leave';

  let y = MARGIN_T;
  y = drawHeader(pdf, y, { logoUrl, qrDataUrl, request, refPrefix: 'LV' });
  y += 2;
  y = drawTitle(pdf, y, `Leave Application — ${typeLabel}`);
  y += 2;

  // (Pre-flight checkbox row removed — the pill selector inside the
  // LEAVE DETAILS section below now serves that purpose. Showing it
  // twice was the noisy stripe at the top of the page.)

  // ═══════════════════════════════════════════════════════════════════
  // EMPLOYEE INFORMATION
  //
  // Layout branches on leave type:
  //   • Sick    → compact 2-column drawTwoColTable (3 paired rows) so
  //               the rich MEDICAL CERTIFICATE section + everything
  //               else fits on a single A4 page.
  //   • Others  → full layout with one drawSingleRow per field (the
  //               clean Permission Request — Late Arrival style Nadeem
  //               approved for annual and the rest).
  // Nadeem 2026-05-18: 'I only want the sick leave to be in one page,
  // annual was perfect before, roll back annual.'
  // ═══════════════════════════════════════════════════════════════════
  const isCompact = ltKey === 'sick';

  y = drawSectionHeader(pdf, y, 'EMPLOYEE INFORMATION');

  // Combined dept + location string. Department name expansion uses
  // DEPT_NAMES (e.g. SUP → Supervisory). Location uses the long form
  // (e.g. DMM → Dammam). Falls back to '—' when both are missing.
  const deptExpanded = position.department
    ? (DEPT_NAMES[position.department] || position.department)
    : '';
  const locExpanded = position.location
    ? (LOC_NAMES[position.location] || position.location)
    : '';
  const deptLocLabel = [deptExpanded, locExpanded].filter(Boolean).join('  ·  ') || '—';

  // Service tenure — always computed at PDF-gen time. Long form for the
  // standard full layout ('4 years, 9 months'); compact for sick
  // where it's a half-width cell ('4y 9m').
  let joinedTenureLabel = '—';
  if (employee.join_date) {
    const ms = Date.now() - new Date(employee.join_date).getTime();
    const yrs = Math.floor(ms / (1000 * 60 * 60 * 24 * 365.25));
    const mos = Math.floor((ms / (1000 * 60 * 60 * 24 * 30.44)) % 12);
    const tenure = isCompact
      ? `${yrs}y${mos > 0 ? ` ${mos}m` : ''}`
      : `${yrs} year${yrs === 1 ? '' : 's'}${mos > 0 ? `, ${mos} month${mos === 1 ? '' : 's'}` : ''}`;
    joinedTenureLabel = `${fmtDateShort(employee.join_date)}${isCompact ? ' · ' : '   ·   '}${tenure}`;
  }

  if (isCompact) {
    // 2-col paired layout — only used for sick leave.
    y = drawTwoColTable(pdf, y, [
      [['Full name',   employee.name || '—'],
       ['PSN ID',      employee.id   || '—']],
      [['Designation', position.designation || employee.designation || '—'],
       ['Department',  deptLocLabel]],
      [['Joined',      joinedTenureLabel],
       ['Reports to',  manager?.name || '—']],
    ]);
  } else {
    // Full single-row layout — annual, paternity, maternity, hajj,
    // marriage, bereavement, study, unpaid, iddah, other, emergency.
    y = drawSingleRow(pdf, y, 'Full name',       employee.name || '—', { emphasis: true });
    y = drawSingleRow(pdf, y, 'PSN ID',          employee.id   || '—');
    y = drawSingleRow(pdf, y, 'Designation',     position.designation || employee.designation || '—');
    y = drawSingleRow(pdf, y, 'Department',      deptLocLabel);
    y = drawSingleRow(pdf, y, 'Joined / Tenure', joinedTenureLabel);
    y = drawSingleRow(pdf, y, 'Reports to',      manager?.name || '—');
  }
  y += isCompact ? 1 : 1.5;

  // ═══════════════════════════════════════════════════════════════════
  // LEAVE DETAILS — same branching pattern.
  // ═══════════════════════════════════════════════════════════════════
  y = drawSectionHeader(pdf, y, 'LEAVE DETAILS');

  const periodLabel = request.start_date && request.end_date
    ? (request.start_date === request.end_date
        ? fmtDateLong(request.start_date)
        : `${fmtDateShort(request.start_date)}${isCompact ? ' — ' : '  —  '}${fmtDateShort(request.end_date)}`)
    : '—';

  const durLabel = request.days
    ? `${request.days} day${Number(request.days) === 1 ? '' : 's'}${
        request.is_half_day ? ` · half day${request.half_day_period ? ` (${request.half_day_period})` : ''}` : ''
      }`
    : '—';

  // Notice math — calendar-date difference, not datetime (avoids
  // '-1 days notice' for same-day requests).
  let isPlanned = false;
  let noticeDays = null;
  if (request.requested_at && request.start_date) {
    const startDay = new Date(request.start_date);
    startDay.setHours(0, 0, 0, 0);
    const reqDay = new Date(request.requested_at);
    reqDay.setHours(0, 0, 0, 0);
    noticeDays = Math.round((startDay - reqDay) / 86400000);
    if (noticeDays < 0) noticeDays = 0;
    isPlanned = noticeDays >= 14;
  }
  // Notice label — short form for compact layout (fits in a half-width
  // cell), long form for the standard layout.
  const noticeLabel = noticeDays == null
    ? '—'
    : isCompact
      ? (isPlanned
          ? `Planned (${noticeDays}d advance)`
          : (noticeDays === 0 ? 'Urgent (same-day)' : `Urgent (${noticeDays}d notice)`))
      : (isPlanned
          ? `Planned  (${noticeDays} day${noticeDays === 1 ? '' : 's'} advance notice)`
          : (noticeDays === 0
              ? 'Urgent  (same-day notice)'
              : `Urgent  (${noticeDays} day${noticeDays === 1 ? '' : 's'} notice — less than 14)`));

  // Submitted — DD MMM YYYY · HH:MM:SS for a precise audit stamp.
  const submittedLabel = request.requested_at
    ? `${fmtDateShort(request.requested_at)}${isCompact ? ' · ' : '  ·  '}${
        new Date(request.requested_at).toLocaleTimeString('en-GB', {
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        })}`
    : '—';

  if (isCompact) {
    y = drawTwoColTable(pdf, y, [
      [['Leave type', typeLabel],
       ['Period',     periodLabel]],
      [['Duration',   durLabel],
       ['Notice',     noticeLabel]],
      [['Submitted',  submittedLabel],
       null],
    ]);
  } else {
    y = drawSingleRow(pdf, y, 'Leave type', typeLabel, { emphasis: true });
    y = drawSingleRow(pdf, y, 'Period',     periodLabel);
    y = drawSingleRow(pdf, y, 'Duration',   durLabel,    { emphasis: true });
    y = drawSingleRow(pdf, y, 'Notice',     noticeLabel);
    y = drawSingleRow(pdf, y, 'Submitted',  submittedLabel);
  }
  y += isCompact ? 1 : 1.5;

  // ═══════════════════════════════════════════════════════════════════
  // REASON — skipped for sick leave (MEDICAL CERTIFICATE diagnosis
  // covers it); also skipped when the reason field is blank (would
  // just show '—' and waste a section). Always shown when the user
  // actually wrote something so HR sees the stated reason.
  // ═══════════════════════════════════════════════════════════════════
  if (!isCompact && (request.reason || '').trim()) {
    y = drawSectionHeader(pdf, y, 'REASON');
    y = drawSingleRow(pdf, y, 'Details', request.reason.trim());
    y += 1.5;
  }

  // ── TYPE-SPECIFIC SECTION (the enriched bit per leave type) ──
  const yBefore = y;
  y = drawTypeSpecificSection(pdf, y, request, employee);
  if (y > yBefore) y += isCompact ? 1 : 1.5;

  // Substitutes — only for leave types that need coverage during absence.
  if (!['emergency'].includes(ltKey)) {
    y = drawSubstitutes(pdf, y, substitutes, { isManualEntry });
    y += isCompact ? 1 : 1.5;
  }

  // Policy specific to this leave type
  y = drawSectionHeader(pdf, y, 'POLICY · KSA LABOR LAW');
  const policy = POLICY_BY_TYPE[ltKey] || POLICY_BY_TYPE.other;
  y = drawPolicyBullets(pdf, y, policy);

  // 4-cell signature grid matching the Vacation_Sample.docx template:
  // EMPLOYEE / DEPT MGR / ESAU SUP / ESAU MGT — short labels with the
  // person's name + their status (Submitted / Approved date · time).
  //
  // sigY anchored to bottom of page, BUT pushed lower if the policy
  // bullets flowed past it (long policy lists overlap the signatures
  // otherwise). Nadeem 2026-05-18: '21/30/cancel rule + signature row
  // wrapped on top of each other'.
  const sigH = 35.4;
  const sigYFixed = PAGE_H - MARGIN_T - sigH;
  const sigY = Math.max(sigYFixed, y + 4);

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

  // Manual Logbook entries hide every server-side timestamp in the
  // signature row so the printed form reads like a clean physical
  // document. Subtitles fall back to the generic 'Signature & Date',
  // 'Approve & Date', 'Process & Stamp' hints — Bashaier writes the
  // real dates by hand once the form is signed. Nadeem 2026-05-21.
  drawSignatures(pdf, sigY, [
    { label: 'EMPLOYEE',  name: employee.name || '',
      subtitle: (!isManualEntry && submittedStamp)
        ? `Submitted ${submittedStamp}` : 'Signature & Date' },
    { label: 'DEPT MGR',  name: manager?.name || '',
      subtitle: (!isManualEntry && managerStamp)
        ? `Approved ${managerStamp}` : 'Approve & Date' },
    { label: 'ESAU SUP',  name: hrName,
      subtitle: (!isManualEntry && hrStamp)
        ? `Approved ${hrStamp}` : 'Process & Stamp' },
    { label: 'ESAU MGT',  name: CEO_NAME,
      subtitle: CEO_TITLE_EN },
  ]);

  // Generated-on stamp also skipped for manual entries — same
  // rationale, no server timestamps on paper-equivalent forms.
  if (!isManualEntry) {
    drawGeneratedStamp(pdf, hrName);
  }
  return pdf.output('blob');
}

export default generateLeaveApplicationPdfBlob;
