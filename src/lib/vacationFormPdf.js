// =============================================================================
// vacationFormPdf.js
//
// Generates the bilingual vacation form as a PDF (not DOCX) so the
// recipient cannot edit the approved document. Same external shape as
// vacationForm.js's generator — drop-in replacement.
//
// HOW IT WORKS
//   1. Build the form as an HTML document fragment offscreen
//      (position: absolute; left: -9999px) so it doesn't affect layout
//      but DOES participate in the document for font metrics.
//   2. Use html2canvas-pro to rasterise the fragment to a canvas at
//      high resolution (2x device pixel ratio for crisp output).
//   3. Use jsPDF to wrap the canvas into a single A4 page (or multi-
//      page if content overflows).
//   4. Return the PDF as a Blob — same return type as the docx
//      generator was producing, so downstream `downloadBlob` works
//      without changes.
//
// WHY NOT DIRECT jsPDF.text() CALLS?
//   - Bilingual layout with right-to-left Arabic, complex tables,
//     signature grids and branded styling are tedious to draw line-
//     by-line in jsPDF.
//   - HTML lets us keep the form as a readable template, easy to
//     maintain by anyone who reads HTML/CSS.
//   - Output quality is acceptable for printing and emailing.
//
// WHY html2canvas-pro NOT html2canvas?
//   - The 'pro' fork handles modern CSS (flex, grid, oklch colors)
//     correctly. The original chokes on properties newer than ~2019.
//
// TRADE-OFFS
//   - The PDF is a rasterised image, so text isn't selectable in
//     viewers. For an APPROVED & LOCKED document this is the point —
//     no one can copy paste/edit individual fields.
//   - File size is larger than docx (~200 KB vs ~30 KB) because of
//     the embedded canvas.
//   - QR code is embedded as a data URL inside the HTML, which the
//     canvas captures faithfully.
// =============================================================================

import jsPDF from 'jspdf';
import html2canvas from 'html2canvas-pro';
import QRCode from 'qrcode';

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
const LOCATION_NAMES = { DMM: 'Dammam', JED: 'Jeddah', RYD: 'Riyadh' };

const LEAVE_TYPE = {
  annual:      { en: 'Annual',      ar: 'سنوية' },
  sick:        { en: 'Sick',        ar: 'مرضية' },
  emergency:   { en: 'Emergency',   ar: 'طارئة' },
  hajj:        { en: 'Hajj',        ar: 'حج' },
  maternity:   { en: 'Maternity',   ar: 'وضع' },
  paternity:   { en: 'Paternity',   ar: 'أبوة' },
  marriage:    { en: 'Marriage',    ar: 'زواج' },
  bereavement: { en: 'Bereavement', ar: 'وفاة' },
  iddah:       { en: 'Iddah',       ar: 'عدة' },
  unpaid:      { en: 'Unpaid',      ar: 'بدون راتب' },
  other:       { en: 'Other',       ar: 'أخرى' },
};

const TYPE_CHECKBOX_ORDER = [
  'annual', 'sick', 'emergency', 'hajj', 'maternity',
  'paternity', 'marriage', 'bereavement', 'unpaid', 'other',
];

const HR_SIGNATURE = {
  name:    'BASHAIER ALI',
  unit:    'ESAU - SADMN SUP/ HR DEPT',
  email:   'bashaier.alsubaie@evergreen-shipping.com.sa',
};

// Brand palette — mirrors the docx version so the PDF reads as part
// of the same form family.
const C = {
  text:    '#1F1B16',
  muted:   '#5C4406',
  copper:  '#9D6B53',
  brand:   '#2D5F3F',
  border:  '#C9B894',
  banner:  '#F4EEDF',
  labelBg: '#FBF6E9',
  paper:   '#FFFEF9',
};

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
    day: 'numeric', month: 'short', year: 'numeric',
  });
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
  return `${y}y ${m > 0 ? `${m}m` : ''}`.trim();
}

// ─── HTML template ─────────────────────────────────────────────────────────

async function buildFormHtml({ employee, request, manager, hrApprover, substitutes }) {
  const ltKey  = LEAVE_TYPE[request.leave_type_id] ? request.leave_type_id : 'annual';
  const dept   = DEPT_NAMES[employee?.department] || employee?.department || '—';
  const loc    = LOCATION_NAMES[employee?.location] || employee?.location || '—';
  const isApproved = request.stage === 'approved';

  const submitted14d = request.requested_at && request.start_date
    ? (new Date(request.start_date).getTime() - new Date(request.requested_at).getTime()) >= 14 * 24 * 3600 * 1000
    : null;
  const noticePlanned = submitted14d === true;

  const dayCount  = Number(request.days || 0);
  const daysLabel = `${dayCount} day${dayCount === 1 ? '' : 's'}${request.is_half_day ? ' (half day)' : ''}`;
  const periodValue = request.start_date === request.end_date
    ? fmtDateLong(request.start_date)
    : `${fmtDateLong(request.start_date)}  →  ${fmtDateLong(request.end_date)}`;

  const verifyUrl = `${VERIFY_BASE_URL}/verify-leave/${request.id}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 180,
    color: { dark: '#1F4530', light: '#FFFFFF' },
  });

  const tickbox = (sel) =>
    sel ? '<span style="display:inline-block;width:11px;height:11px;border:1.2px solid #2D5F3F;background:#2D5F3F;margin-right:5px;vertical-align:-1px;text-align:center;line-height:9px;color:#fff;font-size:9px;font-weight:bold;">✓</span>'
        : '<span style="display:inline-block;width:11px;height:11px;border:1.2px solid #C9B894;margin-right:5px;vertical-align:-1px;"></span>';

  const checkboxRow = TYPE_CHECKBOX_ORDER.map(k => `
    <span style="display:inline-block;margin-right:14px;font-size:10.5px;color:${C.text};white-space:nowrap;">
      ${tickbox(k === ltKey)}${LEAVE_TYPE[k].en} <span style="color:${C.muted};font-size:9.5px;">/ ${LEAVE_TYPE[k].ar}</span>
    </span>
  `).join('');

  // Sick-specific Sehhaty block — only renders for sick leaves where
  // a cert was uploaded and verified. Includes the cross-checked
  // details so the printed PDF carries the Sehhaty audit trail.
  const sehhatyBlock = (request.leave_type_id === 'sick' && request.sehhaty_code) ? `
    <div style="margin-top:10px;border:1.2px solid ${C.border};border-radius:4px;background:${C.labelBg};padding:8px 10px;">
      <div style="font-size:10px;color:${C.brand};font-weight:bold;letter-spacing:0.08em;margin-bottom:5px;">
        SEHHATY CERTIFICATE / شهادة صحتي
      </div>
      <table style="width:100%;font-size:10.5px;border-collapse:collapse;">
        <tr>
          <td style="padding:2px 0;color:${C.muted};width:32%;">Service code</td>
          <td style="padding:2px 0;color:${C.text};font-family:monospace;font-weight:bold;">${request.sehhaty_code}</td>
          <td style="padding:2px 0;color:${C.muted};width:18%;">Verified</td>
          <td style="padding:2px 0;color:${C.text};">${request.sehhaty_verified_at ? fmtDateShort(request.sehhaty_verified_at) : '—'}</td>
        </tr>
        ${request.sehhaty_seen_doctor ? `
        <tr>
          <td style="padding:2px 0;color:${C.muted};">Doctor</td>
          <td style="padding:2px 0;color:${C.text};">${request.sehhaty_seen_doctor}</td>
          <td style="padding:2px 0;color:${C.muted};">Specialty</td>
          <td style="padding:2px 0;color:${C.text};">${request.sehhaty_seen_specialty || '—'}</td>
        </tr>` : ''}
        ${request.sehhaty_seen_start ? `
        <tr>
          <td style="padding:2px 0;color:${C.muted};">Cert period</td>
          <td colspan="3" style="padding:2px 0;color:${C.text};">${request.sehhaty_seen_start} → ${request.sehhaty_seen_end || '—'} · ${request.sehhaty_seen_days || '—'} day${request.sehhaty_seen_days === 1 ? '' : 's'}</td>
        </tr>` : ''}
      </table>
    </div>
  ` : '';

  const subsBlock = (substitutes?.length > 0) ? `
    <div style="margin-top:10px;">
      <div style="font-size:10px;color:${C.brand};font-weight:bold;letter-spacing:0.08em;margin-bottom:5px;">
        SUBSTITUTE COVERAGE / تغطية البديل
      </div>
      <table style="width:100%;font-size:10.5px;border-collapse:collapse;border:1px solid ${C.border};">
        <thead>
          <tr style="background:${C.labelBg};">
            <th style="text-align:left;padding:5px 8px;border-bottom:1px solid ${C.border};color:${C.brand};">Name</th>
            <th style="text-align:left;padding:5px 8px;border-bottom:1px solid ${C.border};color:${C.brand};width:18%;">PSN</th>
            <th style="text-align:left;padding:5px 8px;border-bottom:1px solid ${C.border};color:${C.brand};width:25%;">Decision</th>
          </tr>
        </thead>
        <tbody>
          ${substitutes.map(s => `
            <tr>
              <td style="padding:5px 8px;border-bottom:1px solid ${C.border};color:${C.text};">${s.name || '—'}</td>
              <td style="padding:5px 8px;border-bottom:1px solid ${C.border};color:${C.text};font-family:monospace;">${s.psn || s.employee_id || '—'}</td>
              <td style="padding:5px 8px;border-bottom:1px solid ${C.border};color:${s.decision === 'accepted' ? C.brand : (s.decision === 'declined' ? '#B91C1C' : C.muted)};">
                ${(s.decision || 'pending').toUpperCase()}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '';

  // The APPROVED stamp — only shows when the row is in final approved
  // state. Positioned to the side of the title strip so it draws the
  // eye to the locked status of the document.
  const approvedStamp = isApproved ? `
    <div style="position:absolute;top:160px;right:30px;transform:rotate(-8deg);border:2.5px solid ${C.brand};border-radius:6px;padding:6px 14px;background:rgba(45,95,63,0.05);">
      <div style="color:${C.brand};font-size:18px;font-weight:bold;letter-spacing:0.1em;">✓ APPROVED</div>
      <div style="color:${C.brand};font-size:9px;text-align:center;letter-spacing:0.05em;">معتمد</div>
    </div>
  ` : '';

  return `
    <div style="position:relative;width:794px;min-height:1123px;background:${C.paper};color:${C.text};font-family:Calibri,'Segoe UI',Arial,sans-serif;padding:24px 28px;box-sizing:border-box;">

      <!-- HEADER -->
      <div style="display:flex;align-items:center;gap:14px;padding-bottom:10px;border-bottom:2px solid ${C.brand};">
        <div style="width:60px;height:60px;flex-shrink:0;">
          <img src="/evergreen-logo.jpg" alt="" style="width:100%;height:100%;object-fit:contain;" onerror="this.style.display='none'"/>
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-family:Tahoma,sans-serif;color:${C.brand};font-size:18px;font-weight:bold;letter-spacing:0.18em;">EVERGREEN LINE</div>
          <div style="color:${C.muted};font-size:10px;font-style:italic;">Evergreen Shipping Agency Saudi Co., (L.L.C)</div>
          <div style="color:${C.muted};font-size:9.5px;font-style:italic;direction:rtl;text-align:right;">شركة وكالة إفرقرين السعودية للشحن (ل.ل.س)</div>
        </div>
        <div style="text-align:right;font-size:10px;color:${C.muted};">
          <div>Ref: <span style="color:${C.text};font-weight:bold;font-family:monospace;">${shortRef(request.id)}</span></div>
          <div>Issued: ${fmtDateShort(new Date().toISOString())}</div>
        </div>
        <div style="width:70px;height:70px;flex-shrink:0;">
          <img src="${qrDataUrl}" alt="" style="width:100%;height:100%;"/>
        </div>
      </div>

      <!-- TITLE -->
      <div style="text-align:center;margin:14px 0 16px;">
        <div style="display:inline-block;background:${C.banner};border:1.5px solid ${C.brand};border-radius:4px;padding:6px 28px;">
          <div style="color:${C.brand};font-size:18px;font-weight:bold;letter-spacing:0.22em;">VACATION FORM</div>
          <div style="color:${C.muted};font-size:13px;font-family:Arial;">نموذج إجازة</div>
        </div>
      </div>

      ${approvedStamp}

      <!-- EMPLOYEE BLOCK -->
      <div style="font-size:10px;color:${C.brand};font-weight:bold;letter-spacing:0.08em;margin:0 0 5px 0;">
        APPLICANT / مقدم الطلب
      </div>
      <table style="width:100%;font-size:11px;border-collapse:collapse;border:1px solid ${C.border};">
        <tr>
          <td style="background:${C.labelBg};padding:5px 8px;color:${C.muted};width:18%;border-right:1px solid ${C.border};">Name / الاسم</td>
          <td style="padding:5px 8px;color:${C.text};font-weight:bold;width:48%;border-right:1px solid ${C.border};">${employee?.name || '—'}</td>
          <td style="background:${C.labelBg};padding:5px 8px;color:${C.muted};width:14%;border-right:1px solid ${C.border};">PSN ID</td>
          <td style="padding:5px 8px;color:${C.text};font-family:monospace;font-weight:bold;">${employee?.id || '—'}</td>
        </tr>
        <tr>
          <td style="background:${C.labelBg};padding:5px 8px;color:${C.muted};border-right:1px solid ${C.border};border-top:1px solid ${C.border};">Department</td>
          <td style="padding:5px 8px;color:${C.text};border-right:1px solid ${C.border};border-top:1px solid ${C.border};">${employee?.department || '—'} <span style="color:${C.muted};font-size:10px;">(${dept})</span></td>
          <td style="background:${C.labelBg};padding:5px 8px;color:${C.muted};border-right:1px solid ${C.border};border-top:1px solid ${C.border};">Location</td>
          <td style="padding:5px 8px;color:${C.text};border-top:1px solid ${C.border};">${employee?.location || '—'} <span style="color:${C.muted};font-size:10px;">(${loc})</span></td>
        </tr>
        <tr>
          <td style="background:${C.labelBg};padding:5px 8px;color:${C.muted};border-right:1px solid ${C.border};border-top:1px solid ${C.border};">Designation</td>
          <td style="padding:5px 8px;color:${C.text};border-right:1px solid ${C.border};border-top:1px solid ${C.border};">${employee?.designation || 'Department Member'}</td>
          <td style="background:${C.labelBg};padding:5px 8px;color:${C.muted};border-right:1px solid ${C.border};border-top:1px solid ${C.border};">Service</td>
          <td style="padding:5px 8px;color:${C.text};border-top:1px solid ${C.border};">${yearsOfService(employee?.join_date)}</td>
        </tr>
      </table>

      <!-- LEAVE TYPE CHECKBOXES -->
      <div style="font-size:10px;color:${C.brand};font-weight:bold;letter-spacing:0.08em;margin:12px 0 5px 0;">
        TYPE OF LEAVE / نوع الإجازة
      </div>
      <div style="border:1px solid ${C.border};border-radius:3px;padding:7px 10px;background:#fff;line-height:1.9;">
        ${checkboxRow}
      </div>

      <!-- LEAVE DETAILS -->
      <div style="font-size:10px;color:${C.brand};font-weight:bold;letter-spacing:0.08em;margin:12px 0 5px 0;">
        LEAVE DETAILS / تفاصيل الإجازة
      </div>
      <table style="width:100%;font-size:11px;border-collapse:collapse;border:1px solid ${C.border};">
        <tr>
          <td style="background:${C.labelBg};padding:5px 8px;color:${C.muted};width:18%;border-right:1px solid ${C.border};">Period / الفترة</td>
          <td style="padding:5px 8px;color:${C.text};">${periodValue}</td>
        </tr>
        <tr>
          <td style="background:${C.labelBg};padding:5px 8px;color:${C.muted};border-right:1px solid ${C.border};border-top:1px solid ${C.border};">Days / الأيام</td>
          <td style="padding:5px 8px;color:${C.text};font-weight:bold;border-top:1px solid ${C.border};">${daysLabel}</td>
        </tr>
        <tr>
          <td style="background:${C.labelBg};padding:5px 8px;color:${C.muted};border-right:1px solid ${C.border};border-top:1px solid ${C.border};">Notice / الإشعار</td>
          <td style="padding:5px 8px;color:${C.text};border-top:1px solid ${C.border};">
            ${tickbox(noticePlanned)} Planned (≥14d) <span style="margin-left:20px;">${tickbox(!noticePlanned)} Urgent (&lt;14d)</span>
          </td>
        </tr>
        <tr>
          <td style="background:${C.labelBg};padding:5px 8px;color:${C.muted};border-right:1px solid ${C.border};border-top:1px solid ${C.border};vertical-align:top;">Reason / السبب</td>
          <td style="padding:5px 8px;color:${C.text};border-top:1px solid ${C.border};min-height:36px;">${request.reason || '—'}</td>
        </tr>
      </table>

      ${sehhatyBlock}
      ${subsBlock}

      <!-- APPROVAL SIGNATURES -->
      <div style="font-size:10px;color:${C.brand};font-weight:bold;letter-spacing:0.08em;margin:14px 0 5px 0;">
        APPROVALS / الاعتمادات
      </div>
      <table style="width:100%;font-size:10.5px;border-collapse:collapse;border:1px solid ${C.border};">
        <thead>
          <tr style="background:${C.labelBg};">
            <th style="text-align:left;padding:6px 8px;border-right:1px solid ${C.border};color:${C.brand};width:50%;">Manager / المدير</th>
            <th style="text-align:left;padding:6px 8px;color:${C.brand};">HR (SUP) / الموارد البشرية</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:8px;border-right:1px solid ${C.border};border-top:1px solid ${C.border};vertical-align:top;height:62px;">
              <div style="color:${C.text};font-weight:bold;">${manager?.name || '—'}</div>
              <div style="color:${C.muted};font-size:10px;">${manager?.id ? `${manager.id} · ` : ''}${manager?.department || ''}</div>
              <div style="color:${C.copper};font-size:10px;font-style:italic;margin-top:4px;">
                ${request.manager_decided_at ? `Approved ${fmtDateShort(request.manager_decided_at)}` : 'Awaiting decision'}
              </div>
            </td>
            <td style="padding:8px;border-top:1px solid ${C.border};vertical-align:top;height:62px;">
              <div style="color:${C.text};font-weight:bold;">${hrApprover?.name || HR_SIGNATURE.name}</div>
              <div style="color:${C.muted};font-size:10px;">${HR_SIGNATURE.unit}</div>
              <div style="color:${C.copper};font-size:10px;font-style:italic;margin-top:4px;">
                ${request.hr_decided_at ? `Approved ${fmtDateShort(request.hr_decided_at)}` : 'Awaiting decision'}
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- FOOTER -->
      <div style="margin-top:18px;border-top:1.5px solid ${C.border};padding-top:8px;">
        <table style="width:100%;font-size:9px;color:${C.muted};">
          <tr>
            <td style="vertical-align:top;width:60%;">
              Evergreen Shipping Agency Saudi Co. (L.L.C) · ESAU HR Department<br/>
              ${HR_SIGNATURE.email} · esauhr.netlify.app<br/>
              <span style="color:${C.copper};font-style:italic;">Verify this leave at: ${verifyUrl}</span>
            </td>
            <td style="vertical-align:top;text-align:right;color:${C.copper};font-style:italic;">
              This document is system-generated and tamper-evident.<br/>
              Any unauthorised alteration voids its validity.<br/>
              <span style="font-family:Arial;direction:rtl;">هذا المستند مُنشأ آليًا وغير قابل للتعديل.</span>
            </td>
          </tr>
        </table>
      </div>
    </div>
  `;
}

// ─── main export ───────────────────────────────────────────────────────────

/**
 * Build the bilingual vacation form as a PDF Blob.
 *
 * @param {object} args
 * @param {object} args.employee     — { id, name, department, location, designation, join_date }
 * @param {object} args.request      — leave_requests row
 * @param {object} args.manager      — manager employee row (optional)
 * @param {object} args.hrApprover   — current HR approver employee row (optional)
 * @param {Array}  args.substitutes  — array of substitute decisions (optional)
 * @returns {Promise<Blob>} PDF blob with type 'application/pdf'
 */
export async function generateVacationFormPdfBlob(args) {
  const html = await buildFormHtml({
    substitutes: [],
    ...args,
  });

  // Build an offscreen container — left:-9999px keeps it out of view
  // while still letting the browser lay it out for font metrics.
  // We don't use display:none because canvas capture would record
  // zero-sized elements.
  const container = document.createElement('div');
  container.style.cssText = `
    position: absolute;
    left: -9999px;
    top: 0;
    width: 794px;
    background: #fff;
  `;
  container.innerHTML = html;
  document.body.appendChild(container);

  try {
    // Wait one tick so any <img> tags (logo, QR) finish loading.
    // html2canvas can capture mid-load images as blank otherwise.
    await new Promise((resolve) => {
      const imgs = container.querySelectorAll('img');
      if (!imgs.length) return resolve();
      let pending = imgs.length;
      const done = () => { if (--pending <= 0) resolve(); };
      imgs.forEach((img) => {
        if (img.complete) return done();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      });
      // Hard timeout — if an image hangs forever (logo 404), we
      // proceed without it rather than blocking the user.
      setTimeout(resolve, 1500);
    });

    const canvas = await html2canvas(container.firstElementChild, {
      scale: 2,                          // 2x for crisp print quality
      backgroundColor: C.paper,
      useCORS: true,                     // allow logo/qr from same origin
      logging: false,
      windowWidth: 794,
    });

    // A4 in mm: 210 × 297. jsPDF defaults to mm units.
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    const pageWidthMm  = 210;
    const pageHeightMm = 297;
    const imgWidthMm   = pageWidthMm;
    const imgHeightMm  = (canvas.height * imgWidthMm) / canvas.width;

    const imgData = canvas.toDataURL('image/jpeg', 0.92);

    if (imgHeightMm <= pageHeightMm) {
      // Fits on one page.
      pdf.addImage(imgData, 'JPEG', 0, 0, imgWidthMm, imgHeightMm, undefined, 'FAST');
    } else {
      // Multi-page: slice the canvas at page boundaries. Each
      // subsequent page is rendered by offsetting the image's y
      // coordinate — jsPDF clips to the page so the result is one
      // continuous form across multiple pages.
      let renderedHeight = 0;
      let isFirstPage = true;
      while (renderedHeight < imgHeightMm) {
        if (!isFirstPage) pdf.addPage();
        pdf.addImage(
          imgData,
          'JPEG',
          0,
          -renderedHeight,
          imgWidthMm,
          imgHeightMm,
          undefined,
          'FAST',
        );
        renderedHeight += pageHeightMm;
        isFirstPage = false;
      }
    }

    // Document metadata — useful when the PDF is opened in any viewer.
    pdf.setProperties({
      title:    `Vacation Form ${shortRef(args.request.id)}`,
      subject:  `Approved leave for ${args.employee?.name || args.request.employee_id}`,
      author:   'ESAU HR · esauhr.netlify.app',
      creator:  'ESAU HR Portal',
      keywords: 'vacation,leave,esau,evergreen,hr',
    });

    return pdf.output('blob');
  } finally {
    // Always clean up the offscreen node, even on errors.
    document.body.removeChild(container);
  }
}

// Small helper kept here so callers don't need to import a second
// module just to trigger a download.
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
