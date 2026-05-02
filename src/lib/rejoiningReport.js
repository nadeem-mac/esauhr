// Rejoining Report — bilingual A4 document, same brand styling as
// vacationForm.js. Generated when a manager or HR confirms an employee
// has returned from approved leave. Captures the actual return date
// versus the originally-planned end date so the company has an audit
// trail for HR records.
//
// Helpers are duplicated from vacationForm.js (rather than imported)
// for the same reason vacationForm duplicates from permissionLetter:
// keeps the three forms decoupled so future edits to one can't break
// another silently.

import {
  Document, Packer, Paragraph, TextRun, ImageRun,
  Table, TableRow, TableCell,
  Header,
  AlignmentType, WidthType, BorderStyle, HeightRule,
  VerticalAlign, ShadingType,
} from 'docx';
import QRCode from 'qrcode';

const VERIFY_BASE_URL = (typeof window !== 'undefined' && window.location?.origin)
  ? window.location.origin
  : 'https://esauhr.netlify.app';

// ─── lookups (mirrored from vacationForm) ─────────────────────────────────────
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

const HR_SIGNATURE_NAME = 'BASHAIER ALI';

// HR signature block — identical to vacation form so the email looks
// like the same desk it always comes from.
const HR_SIGNATURE = {
  name:    'BASHAIER ALI',
  company: 'Evergreen Shipping Agency Saudi Co.,(L.L.C)',
  unit:    'ESAU - SADMN SUP/ HR DEPT',
  address: 'P.O.Box : 1008,  DAMMAM – 31431, K.S.A',
  whatsapp:'966-54 320 9694',
  tel:     '966-013 813 8563 – Ext 8543',
  email:   'bashaier.alsubaie@evergreen-shipping.com.sa',
};
const CEO_EMAIL          = 'johnho@evergreen-shipping.com.sa';
const COUNTRY_HEAD_EMAIL = 'jamesliu@evergreen-shipping.com.sa';

// ─── brand palette ────────────────────────────────────────────────────────────
const C_TEXT      = '1F1B16';
const C_MUTED     = '5C4406';
const C_COPPER    = '9D6B53';
const C_BRAND     = '2D5F3F';
const C_BORDER    = 'C9B894';
const C_BANNER    = 'F4EEDF';
const C_LABEL_BG  = 'FBF6E9';

const FONT_BRAND = 'Tahoma';
const FONT_BODY  = 'Calibri';
const FONT_AR    = 'Arial';

// ─── page geometry ────────────────────────────────────────────────────────────
// A4: 11906 × 16838 DXA. With 540 DXA margins, usable width = 10826 DXA.
const PAGE_W      = 10826;
const LABEL_W     = 2400;
const VALUE_W     = PAGE_W - LABEL_W;
const HALF_W      = Math.floor(PAGE_W / 2);

// 3-column signature grid (Employee | Dept Mgr | ESAU SUP) — sums to PAGE_W
const SIG3_W      = Math.floor(PAGE_W / 3); // 3608
const SIG3_W_LAST = PAGE_W - (SIG3_W * 2);  // remainder absorber

// 4-col header — Logo | Wordmark | Date+Ref | QR
const HEADER_LOGO = 1100;
const HEADER_QR   = 1500;
const HEADER_REF  = 2000;
const HEADER_TXT  = PAGE_W - HEADER_LOGO - HEADER_QR - HEADER_REF;

// ─── formatters ──────────────────────────────────────────────────────────────
const fmtDateMed = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const fmtDateLong = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};
const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}  ·  ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};
const fmtStampCompact = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

// Diff between actual return and originally-planned return. Negative
// means returned early, 0 means returned on time, positive means late.
function returnDiffLabel(actualISO, plannedEndISO) {
  if (!actualISO || !plannedEndISO) return '—';
  const a = new Date(actualISO);
  const e = new Date(plannedEndISO);
  // Expected return = end_date + 1 (the day after leave ends).
  e.setDate(e.getDate() + 1);
  const diff = Math.round((a - e) / 86_400_000);
  if (diff === 0) return 'Returned on schedule';
  if (diff < 0)   return `Returned ${Math.abs(diff)} day${Math.abs(diff) === 1 ? '' : 's'} early`;
  return `Returned ${diff} day${diff === 1 ? '' : 's'} late`;
}

function shortRef(id) {
  const s = String(id ?? '');
  const hex = s.replace(/-/g, '');
  if (hex.length > 8 && /^[0-9a-f]+$/i.test(hex)) {
    return `RJ-${hex.slice(0, 8).toUpperCase()}`;
  }
  return `RJ-${s.padStart(5, '0')}`;
}

// ─── docx primitives ─────────────────────────────────────────────────────────
const run = (text, opts = {}) => new TextRun({
  text: String(text ?? ''),
  font: opts.font || FONT_BODY,
  size: opts.size ?? 20,
  color: opts.color ?? C_TEXT,
  bold: !!opts.bold,
  italics: !!opts.italics,
});

const arRun = (text, opts = {}) => new TextRun({
  text: String(text ?? ''),
  font: { name: FONT_AR, cs: FONT_AR },
  size: opts.size ?? 18,
  color: opts.color ?? C_MUTED,
  bold: !!opts.bold,
  rightToLeft: true,
});

const FORM_BORDER = {
  top:    { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
  left:   { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
  right:  { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
};
const NO_BORDER = {
  top:    { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right:  { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
};
const shading = (fill) => ({ type: ShadingType.CLEAR, fill, color: 'auto' });
const spacer = (after = 100) => new Paragraph({ children: [run('')], spacing: { after } });

// ─── section banner ──────────────────────────────────────────────────────────
function sectionBanner(en, ar) {
  return new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [HALF_W, PAGE_W - HALF_W],
    rows: [new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph({ children: [run(en, { bold: true, size: 18 })] })],
          width: { size: HALF_W, type: WidthType.DXA },
          margins: { top: 50, bottom: 50, left: 200, right: 100 },
          shading: shading(C_BANNER),
          borders: {
            top:    { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
            bottom: { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
            left:   { style: BorderStyle.SINGLE, size: 24, color: C_BRAND },
            right:  { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          },
        }),
        new TableCell({
          children: [new Paragraph({
            children: [arRun(ar, { bold: true, size: 18, color: C_COPPER })],
            alignment: AlignmentType.RIGHT,
            bidirectional: true,
          })],
          width: { size: PAGE_W - HALF_W, type: WidthType.DXA },
          margins: { top: 50, bottom: 50, left: 100, right: 200 },
          shading: shading(C_BANNER),
          borders: {
            top:    { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
            bottom: { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
            left:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
            right:  { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
          },
        }),
      ],
    })],
  });
}

// ─── form table cells ────────────────────────────────────────────────────────
function labelCell(en, ar) {
  return new TableCell({
    children: [
      new Paragraph({ children: [run(en, { bold: true, size: 17 })], spacing: { after: 20 } }),
      new Paragraph({ children: [arRun(ar, { size: 14, color: C_COPPER })] }),
    ],
    width: { size: LABEL_W, type: WidthType.DXA },
    margins: { top: 20, bottom: 20, left: 180, right: 100 },
    shading: shading(C_LABEL_BG),
    borders: FORM_BORDER,
    verticalAlign: VerticalAlign.CENTER,
  });
}
function valueCell(text, opts = {}) {
  return new TableCell({
    children: [new Paragraph({
      children: [run(text, { size: 21, bold: !!opts.bold, color: opts.color || C_TEXT })],
    })],
    width: { size: VALUE_W, type: WidthType.DXA },
    margins: { top: 20, bottom: 20, left: 200, right: 160 },
    borders: FORM_BORDER,
    verticalAlign: VerticalAlign.CENTER,
  });
}
function valueCellRuns(children) {
  return new TableCell({
    children: [new Paragraph({ children })],
    width: { size: VALUE_W, type: WidthType.DXA },
    margins: { top: 20, bottom: 20, left: 200, right: 160 },
    borders: FORM_BORDER,
    verticalAlign: VerticalAlign.CENTER,
  });
}
function formRow(en, ar, value, opts = {}) {
  return new TableRow({
    children: [
      labelCell(en, ar),
      typeof value === 'string' ? valueCell(value, opts) : valueCellRuns(value),
    ],
  });
}

// ─── 3-column atomic signature cell ──────────────────────────────────────────
// ─── 3-column atomic signature grid ──────────────────────────────────────────
// Two-row table, each column treated as one logical sig box:
//   Row 1 — cream BANNER strip with EN + AR title (small height)
//   Row 2 — BODY at exactly 3.54 cm (2007 dxa), content bottom-aligned
//          (printed name, then divider, then footer with timestamp + label)
// Bottom alignment is what gives us the legacy form's signature-line look:
// the wet-ink space sits above the printed name, exactly like a paper form.
function sigBannerCell(en, ar, width) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: { top: 50, bottom: 50, left: 140, right: 140 },
    borders: FORM_BORDER,
    shading: shading(C_BANNER),
    children: [new Paragraph({
      children: [
        run(en + '   ', { bold: true, size: 13 }),
        arRun(ar, { size: 13, color: C_COPPER }),
      ],
      spacing: { before: 0, after: 0 },
    })],
  });
}

function sigBodyCell(name, footerLeft, footerRight, width) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: { top: 80, bottom: 60, left: 140, right: 140 },
    borders: FORM_BORDER,
    // Bottom-align so the printed name + timestamp footer stick to
    // the bottom of the 3.54 cm box. The blank space ABOVE them is
    // where the wet ink signature goes.
    verticalAlign: VerticalAlign.BOTTOM,
    children: [
      // Printed name — sits just above the divider rule.
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [run(name || '', { size: 18, bold: true })],
        spacing: { before: 0, after: 60 },
      }),
      // Footer line — italic timestamp + bold 'Signature' label,
      // separated by a thin top rule which serves as the visual
      // baseline of the signature.
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          run(footerLeft || ' ', { size: 12, italics: true, color: C_COPPER }),
          run('     ', { size: 12 }),
          run(footerRight, { size: 12, bold: true }),
        ],
        spacing: { before: 0, after: 0 },
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: C_BORDER, space: 6 } },
      }),
    ],
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────
async function loadLogoBytes() {
  try {
    const res = await fetch('/evergreen-logo.jpg');
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch { return null; }
}

async function generateQrPng(text, sizePx = 220) {
  try {
    const dataUrl = await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: sizePx,
      color: { dark: '#1F4530', light: '#FFFFFF' },
    });
    const base64 = dataUrl.split(',')[1];
    if (typeof atob !== 'undefined') {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    }
    return Buffer.from(base64, 'base64');
  } catch (err) {
    console.warn('[rejoining report] QR generation failed:', err);
    return null;
  }
}

const yearsOfService = (joinDate) => {
  if (!joinDate) return '—';
  const join = new Date(joinDate);
  const now = new Date();
  let y = now.getFullYear() - join.getFullYear();
  let m = now.getMonth() - join.getMonth();
  if (m < 0) { y--; m += 12; }
  if (y === 0 && m === 0) return 'Less than a month';
  if (y === 0) return `${m} month${m === 1 ? '' : 's'}`;
  return `${y} year${y === 1 ? '' : 's'}${m > 0 ? `, ${m} month${m === 1 ? '' : 's'}` : ''}`;
};

// ─── main generator ──────────────────────────────────────────────────────────
export async function generateRejoiningReportBlob({ employee, request, manager, hrApprover, returnConfirmer }) {
  const ltKey  = LEAVE_TYPE[request.leave_type_id] ? request.leave_type_id : 'annual';
  const ltBoth = LEAVE_TYPE[ltKey];

  const dept = DEPT_NAMES[employee?.department] || employee?.department || '—';
  const loc  = LOCATION_NAMES[employee?.location] || employee?.location || '—';
  const designation = employee?.designation || 'Department Member';
  const today = new Date().toISOString();

  const dayCount = Number(request.days || 0);
  const daysLabel = `${dayCount} day${dayCount === 1 ? '' : 's'}${request.is_half_day ? '   (half day)' : ''}`;
  const periodValue = request.start_date === request.end_date
    ? fmtDateLong(request.start_date)
    : `${fmtDateLong(request.start_date)}  →  ${fmtDateLong(request.end_date)}`;

  const actualReturn = request.actual_return_date || null;
  const returnedAt   = request.returned_at || null;
  const diffLabel    = returnDiffLabel(actualReturn, request.end_date);
  const returnStatus = (request.return_status || 'pending').toUpperCase();

  const logoBytes = await loadLogoBytes();
  const verifyUrl = `${VERIFY_BASE_URL}/verify-leave/${request.id}`;
  // QR only generated after HR final approval. Until then, a scan would
  // hit a verify page that says "not approved yet" — confusing on a
  // form anyone could be carrying around. Skipping the QR makes the
  // pre-approval state visually obvious (no QR + no REJOINED stamp).
  const qrBytes = request.return_stage === 'approved'
    ? await generateQrPng(verifyUrl, 220)
    : null;

  // ── HEADER (Logo | Wordmark | Date+Ref | QR) ─────────────────────────────
  const headerRow = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [HEADER_LOGO, HEADER_TXT, HEADER_REF, HEADER_QR],
    rows: [new TableRow({
      children: [
        new TableCell({
          children: [
            logoBytes
              ? new Paragraph({ children: [new ImageRun({
                  data: logoBytes, transformation: { width: 56, height: 56 }, type: 'jpg',
                })] })
              : new Paragraph({ children: [run('EVR', { bold: true, size: 28, color: C_BRAND, font: FONT_BRAND })] }),
          ],
          width: { size: HEADER_LOGO, type: WidthType.DXA },
          margins: { top: 0, bottom: 0, left: 0, right: 100 },
          borders: NO_BORDER,
          verticalAlign: VerticalAlign.CENTER,
        }),
        new TableCell({
          children: [
            new Paragraph({ children: [run('EVERGREEN LINE', { bold: true, size: 32, color: C_BRAND, font: FONT_BRAND })] }),
            new Paragraph({
              children: [run('Evergreen Shipping Agency Saudi Co. (L.L.C)  ·  ESAU SADMN SUP / HR Dept', { size: 14, color: C_MUTED })],
              spacing: { before: 50 },
            }),
          ],
          width: { size: HEADER_TXT, type: WidthType.DXA },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          borders: NO_BORDER,
          verticalAlign: VerticalAlign.CENTER,
        }),
        new TableCell({
          children: [
            new Paragraph({
              children: [run('Date: ', { bold: true, color: C_MUTED, size: 14 }), run(fmtDateMed(today), { size: 14 })],
              alignment: AlignmentType.RIGHT,
            }),
            new Paragraph({
              children: [run('Ref:  ', { bold: true, color: C_MUTED, size: 14 }), run(shortRef(request.id), { bold: true, size: 14 })],
              alignment: AlignmentType.RIGHT,
              spacing: { before: 40 },
            }),
          ],
          width: { size: HEADER_REF, type: WidthType.DXA },
          margins: { top: 0, bottom: 0, left: 0, right: 100 },
          borders: NO_BORDER,
          verticalAlign: VerticalAlign.CENTER,
        }),
        new TableCell({
          children: qrBytes
            ? [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [new ImageRun({ data: qrBytes, transformation: { width: 54, height: 54 }, type: 'png' })],
                  spacing: { before: 0, after: 30 },
                }),
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [run('SCAN TO VERIFY', { size: 9, bold: true, color: C_COPPER })],
                  spacing: { before: 0, after: 0 },
                }),
              ]
            : [new Paragraph({ children: [run('', { size: 10 })] })],
          width: { size: HEADER_QR, type: WidthType.DXA },
          margins: { top: 0, bottom: 0, left: 100, right: 0 },
          borders: NO_BORDER,
          verticalAlign: VerticalAlign.CENTER,
        }),
      ],
    })],
  });

  const headerRule = new Paragraph({
    children: [run('')],
    border: { bottom: { style: BorderStyle.SINGLE, size: 14, color: C_BRAND, space: 1 } },
    spacing: { before: 80, after: 0 },
  });
  const headerRuleCopper = new Paragraph({
    children: [run('')],
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C_COPPER, space: 1 } },
    spacing: { before: 30, after: 80 },
  });

  // ── TITLE ─────────────────────────────────────────────────────────────────
  // Echoes the legacy "REJOINING REPORT (From Vacation)" headline used
  // by Evergreen for decades — keeping the corporate phrasing the
  // department heads recognise.
  const titleStrip = new Paragraph({
    children: [
      run('REJOINING REPORT ', { bold: true, size: 28, color: C_TEXT, font: FONT_BRAND }),
      run(`(From ${ltBoth.en} Leave)`, { bold: true, italics: true, size: 24, color: C_COPPER, font: FONT_BRAND }),
    ],
    spacing: { before: 80, after: 30 },
  });
  const titleStripAr = new Paragraph({
    children: [arRun(`تقرير العودة من الإجازة · إجازة ${ltBoth.ar}`, { bold: true, size: 16, color: C_BRAND })],
    bidirectional: true,
    alignment: AlignmentType.LEFT,
    spacing: { before: 0, after: 30 },
  });

  // "TO: Departmental Head" addressing block — direct lift from the
  // legacy template. Adds the formal correspondence framing the old form
  // had which the previous version of this report missed entirely.
  const toBlock = new Paragraph({
    children: [
      run('TO:  ', { bold: true, size: 18, color: C_MUTED }),
      run('Departmental Head', { bold: true, size: 18, color: C_TEXT }),
      run('   ·   ', { size: 16, color: C_BORDER }),
      arRun('إلى: رئيس القسم', { size: 16, color: C_MUTED }),
      run('         ', { size: 16 }),
      run('FROM:  ', { bold: true, size: 18, color: C_MUTED }),
      run(employee?.name || '—', { bold: true, size: 18, color: C_TEXT }),
    ],
    alignment: AlignmentType.LEFT,
    spacing: { before: 0, after: 60 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C_BORDER, space: 4 } },
  });

  // ── EMPLOYEE INFORMATION ──────────────────────────────────────────────────
  const empTable = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [LABEL_W, VALUE_W],
    rows: [
      formRow('Employee name',   'اسم الموظف',     employee?.name || '—', { bold: true }),
      formRow('PSN ID',          'الرقم الوظيفي',  employee?.id || '—'),
      formRow('Department',      'القسم',          `${dept}  ·  ${loc}`),
      formRow('Designation',     'المسمى الوظيفي', designation),
      formRow('Joined / Tenure', 'الالتحاق / المدة', `${fmtDateMed(employee?.join_date)}   ·   ${yearsOfService(employee?.join_date)}`),
    ],
  });

  // ── ORIGINAL LEAVE ────────────────────────────────────────────────────────
  const origLeaveTable = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [LABEL_W, VALUE_W],
    rows: [
      formRow('Leave type',         'نوع الإجازة',     `${ltBoth.en} Leave`, { bold: true, color: C_BRAND }),
      formRow('Original period',    'الفترة الأصلية',  periodValue),
      formRow('Duration (approved)','المدة المعتمدة',   daysLabel, { bold: true }),
      formRow('Manager approved',   'اعتماد المدير',   request.manager_decided_at ? fmtDateTime(request.manager_decided_at) : '—'),
      formRow('HR approved',        'اعتماد الموارد', request.hr_decided_at ? fmtDateTime(request.hr_decided_at) : '—'),
    ],
  });

  // ── DECLARATION (Statement of Rejoining) ─────────────────────────────────
  // First-person formal declaration block — direct echo of the legacy
  // template's "I confirm that I went on my <leave-type> leave from X to Y…
  // I shall be obliged if you can put me on the payroll with effect from Z"
  // language. The phrasing is what department heads and accounts have
  // expected on this form for years; auto-filling it from the request
  // saves the staff member typing it but preserves the exact wording.
  const reportingBackDate = actualReturn || (() => {
    const d = new Date(request.end_date); d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  })();

  const declarationStripEn = new Paragraph({
    children: [
      run('I confirm that I went on my ', { size: 19, color: C_TEXT }),
      run(`${ltBoth.en.toLowerCase()} `, { size: 19, italics: true, bold: true, color: C_COPPER }),
      run('leave from ', { size: 19, color: C_TEXT }),
      run(fmtDateMed(request.start_date), { size: 19, bold: true, color: C_BRAND }),
      run(' to ', { size: 19, color: C_TEXT }),
      run(fmtDateMed(request.end_date), { size: 19, bold: true, color: C_BRAND }),
      run(`, totalling ${dayCount} day${dayCount === 1 ? '' : 's'}. I am reporting back on duty on `, { size: 19, color: C_TEXT }),
      run(fmtDateMed(reportingBackDate), { size: 19, bold: true, color: C_BRAND }),
      run('. I shall be obliged if you can place me on the payroll with effect from ', { size: 19, color: C_TEXT }),
      run(fmtDateMed(reportingBackDate), { size: 19, bold: true, color: C_BRAND }),
      run('.', { size: 19, color: C_TEXT }),
    ],
    spacing: { before: 30, after: 30, line: 240 },
    alignment: AlignmentType.JUSTIFIED,
  });

  const declarationStripAr = new Paragraph({
    children: [
      arRun(`أؤكد أنني كنت في إجازة ${ltBoth.ar} من ${fmtDateMed(request.start_date)} إلى ${fmtDateMed(request.end_date)}، بإجمالي ${dayCount} يوم. عائد إلى العمل بتاريخ ${fmtDateMed(reportingBackDate)}.`, { size: 16, color: C_MUTED }),
    ],
    bidirectional: true,
    alignment: AlignmentType.RIGHT,
    spacing: { before: 0, after: 30, line: 240 },
  });

  // ── ADMIN / PAYROLL INSTRUCTION BLOCK ─────────────────────────────────────
  // Second half of the legacy template — "TO: Admin Manager. Please put
  // <name> on payroll from <date>." Kept as a small framed block after the
  // declaration so the accounts team has the explicit instruction.
  const adminBlock = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [PAGE_W],
    rows: [
      new TableRow({
        children: [new TableCell({
          width: { size: PAGE_W, type: WidthType.DXA },
          margins: { top: 50, bottom: 50, left: 200, right: 200 },
          shading: shading(C_BANNER),
          borders: {
            top:    { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
            bottom: { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
            left:   { style: BorderStyle.SINGLE, size: 24, color: C_COPPER },
            right:  { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
          },
          children: [
            new Paragraph({
              children: [
                run('TO:  ', { bold: true, size: 14, color: C_MUTED }),
                run('ESAU Admin Manager', { bold: true, size: 14, color: C_TEXT }),
                run('     ·     ', { size: 13, color: C_BORDER }),
                run('FROM:  ', { bold: true, size: 14, color: C_MUTED }),
                run('Departmental Head', { bold: true, size: 14, color: C_TEXT }),
              ],
              spacing: { after: 40 },
            }),
            new Paragraph({
              children: [
                run('Kindly place ', { size: 17 }),
                run(employee?.name || '—', { bold: true, size: 17 }),
                run(`  (PSN ${employee?.id || '—'}, ${dept})`, { size: 15, color: C_MUTED }),
                run(' on the active payroll with effect from ', { size: 17 }),
                run(fmtDateMed(reportingBackDate), { size: 17, bold: true, color: C_BRAND }),
                run('.', { size: 17 }),
              ],
              spacing: { after: 0, line: 260 },
            }),
          ],
        })],
      }),
    ],
  });

  // ── RETURN DETAILS ────────────────────────────────────────────────────────
  // Structured field-by-field record of the return — the data Bashaier and
  // the auditor will scan. Sits below the narrative so the human story
  // ("I went, I'm back") is read first and the audit log second.
  const statusColor = returnStatus === 'RETURNED' ? C_BRAND
                    : returnStatus === 'EXTENDED' ? '8B6914'
                    : returnStatus === 'NO_SHOW'  ? 'B83A2E'
                    : C_MUTED;

  const daysAbsent = (() => {
    if (!actualReturn) return '—';
    const start = new Date(request.start_date);
    const ret   = new Date(actualReturn);
    const diff  = Math.floor((ret - start) / 86_400_000);
    return `${diff} day${diff === 1 ? '' : 's'}`;
  })();

  const returnTable = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [LABEL_W, VALUE_W],
    rows: [
      formRow('Actual return date', 'تاريخ العودة الفعلي', actualReturn ? fmtDateLong(actualReturn) : '—', { bold: true, color: C_BRAND }),
      formRow('Punctuality',         'الالتزام بالموعد',    diffLabel),
      formRow('Return status',       'حالة العودة',         returnStatus.replace('_', ' '), { bold: true, color: statusColor }),
      // Balance reconciliation — only render when there's a credit to
      // report. Early return → unused days credited back to leave_balances
      // adjustment. The numeric is set by PendingReturnsCard at HR
      // approval time.
      ...(typeof request.balance_after === 'number' && request.balance_after > 0
        ? [formRow(
            'Balance credited',
            'الرصيد المُعاد',
            `+${request.balance_after} day${request.balance_after === 1 ? '' : 's'}  (early return — credited back to leave balance)`,
            { bold: true, color: C_BRAND },
          )]
        : []
      ),
      formRow('Notes from staff',    'ملاحظات الموظف',      request.return_notes || '—'),
    ],
  });

  // ── 3-COLUMN APPROVAL SIGNATURES ──────────────────────────────────────────
  // Stamps reflect each step of the 3-step rejoining workflow:
  //   Employee  →  return_submitted_at  ('Submitted DD MMM · HH:MM')
  //   Dept Mgr  →  return_manager_decided_at  ('Approved DD MMM · HH:MM')
  //   ESAU SUP  →  return_hr_decided_at  ('Approved DD MMM · HH:MM')
  const sigCols = [
    { en: 'EMPLOYEE', ar: 'الموظف',         name: employee?.name || '',
      footerLeft: request.return_submitted_at
                  ? `Submitted ${fmtStampCompact(request.return_submitted_at)}`
                  : (returnedAt ? `Returned ${fmtStampCompact(returnedAt)}` : ''),
      footerRight: 'Signature' },
    { en: 'DEPT MGR', ar: 'مدير القسم',     name: manager?.name || '',
      footerLeft: request.return_manager_decided_at
                  ? `Approved ${fmtStampCompact(request.return_manager_decided_at)}`
                  : '',
      footerRight: 'Signature' },
    { en: 'ESAU SUP', ar: 'الموارد البشرية', name: hrApprover?.name || HR_SIGNATURE_NAME,
      footerLeft: request.return_hr_decided_at
                  ? `Approved ${fmtStampCompact(request.return_hr_decided_at)}`
                  : '',
      footerRight: 'Signature' },
  ];
  const sigWidths = [SIG3_W, SIG3_W, SIG3_W_LAST];

  const sigTable = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: sigWidths,
    rows: [
      // Banner row — small, just the cream EN+AR title strip
      new TableRow({
        cantSplit: true,
        children: sigCols.map((c, i) =>
          sigBannerCell(c.en, c.ar, sigWidths[i])),
      }),
      // Body row — exactly 3.54 cm tall (2007 dxa). Contents
      // bottom-aligned so the printed name + footer line stick
      // to the bottom of the box, with empty space above for
      // wet ink signature.
      new TableRow({
        cantSplit: true,
        height: { value: 2007, rule: HeightRule.EXACT },
        children: sigCols.map((c, i) =>
          sigBodyCell(c.name, c.footerLeft, c.footerRight, sigWidths[i])),
      }),
    ],
  });

  // ── FOOTER ────────────────────────────────────────────────────────────────
  const generatedAt = new Date().toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const footerBlock = new Paragraph({
    children: [
      run(`Generated on ${generatedAt} GMT+3  ·  ${returnConfirmer?.name || hrApprover?.name || HR_SIGNATURE_NAME}`,
          { size: 12, italics: true, color: C_COPPER }),
      run('     ·     ', { size: 11, color: C_MUTED }),
      run('Verify online: ', { size: 11, color: C_MUTED }),
      run(verifyUrl, { size: 11, color: C_BRAND }),
    ],
    alignment: AlignmentType.LEFT,
    spacing: { before: 40, after: 0 },
  });

  // ── REJOINED STAMP ────────────────────────────────────────────────────────
  // Shows only when the 3-step workflow has reached HR final approval.
  const isReturned = request.return_stage === 'approved';
  const stampHeader = new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({
            text: isReturned ? '✓ REJOINED' : '',
            font: FONT_BRAND,
            size: 24,
            bold: true,
            color: '2D5F3F',
          }),
        ],
        spacing: { before: 0, after: 0 },
      }),
    ],
  });

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT_BODY } } } },
    sections: [{
      properties: {
        page: {
          size:    { width: 11906, height: 16838 },
          margin:  { top: 540, right: 540, bottom: 540, left: 540 },
        },
      },
      headers: { default: stampHeader },
      children: [
        headerRow,
        headerRule,
        headerRuleCopper,
        titleStrip,
        titleStripAr,
        toBlock,
        sectionBanner('EMPLOYEE INFORMATION', 'معلومات الموظف'),
        empTable,
        spacer(20),
        sectionBanner('ORIGINAL LEAVE', 'تفاصيل الإجازة الأصلية'),
        origLeaveTable,
        spacer(20),
        // Narrative declaration — first-person formal statement, the
        // soul of the legacy template.
        declarationStripEn,
        declarationStripAr,
        // Admin/payroll instruction — explicit memo to accounts.
        adminBlock,
        spacer(20),
        sectionBanner('RETURN DETAILS', 'تفاصيل العودة'),
        returnTable,
        spacer(20),
        sigTable,
        footerBlock,
      ],
    }],
  });

  return await Packer.toBlob(doc);
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function resolveApprover(decidedBy, empMap) {
  if (!decidedBy) return null;
  if (empMap[decidedBy]) return empMap[decidedBy];
  const directory = Object.values(empMap);
  return directory.find((e) => e.auth_user_id === decidedBy) || null;
}

export async function downloadRejoiningReportForRequest(request, empMap) {
  if (!request) throw new Error('No request supplied');
  if (!empMap)  throw new Error('Employee directory unavailable');
  const employee = empMap[request.employee_id];
  if (!employee) throw new Error('Employee not found in directory');
  const manager         = resolveApprover(request.manager_decided_by, empMap);
  const hrApprover      = resolveApprover(request.hr_decided_by,      empMap);
  const returnConfirmer = resolveApprover(request.return_confirmed_by, empMap);

  const blob = await generateRejoiningReportBlob({
    request, employee, manager, hrApprover, returnConfirmer,
  });
  const safeName = (employee.name || request.employee_id).replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
  const filename = `Rejoining_Report_${safeName}_${request.end_date}.docx`;
  downloadBlob(blob, filename);
  return { blob, filename };
}

// ─── email draft ─────────────────────────────────────────────────────────────
// Build a prefilled mailto URL for the rejoining report — Bashaier
// clicks Email and her mail client opens with the message ready to
// send. Same shape as buildEmailDraft in vacationForm.js (To: staff,
// Cc: manager + CEO + Country Head, full HR signature) so the staff
// recognises the desk it's coming from.
export function buildRejoiningEmailDraft({ employee, request, manager, hrApprover }) {
  const ltKey = LEAVE_TYPE[request.leave_type_id] ? request.leave_type_id : 'annual';
  const leaveTypeLabel = `${LEAVE_TYPE[ltKey].en} Leave`;
  const dateRange = `${fmtDateMed(request.start_date)} - ${fmtDateMed(request.end_date)}`;
  const returnDate = fmtDateMed(request.actual_return_date);

  const to = [employee?.email].filter(Boolean).join(',');
  const ccList = [
    manager?.email,
    CEO_EMAIL,
    COUNTRY_HEAD_EMAIL,
  ].filter(Boolean);
  const cc = Array.from(new Set(ccList.filter(e => e !== to))).join(',');

  const subject = `Rejoining approved · ${employee?.name || ''} · returned ${returnDate}`;

  const body = [
    `Dear ${(employee?.name || '').split(' ')[0] || 'Colleague'},`,
    '',
    `Welcome back. Your rejoining following the ${leaveTypeLabel.toLowerCase()} from ${dateRange} has been approved by management. Your return on duty is recorded as ${returnDate} and your payroll has been resumed accordingly.`,
    '',
    request.return_notes ? `Notes on file: ${request.return_notes}` : null,
    request.balance_after && Number(request.balance_after) > 0
      ? `Balance reconciliation: +${request.balance_after} day${request.balance_after === 1 ? '' : 's'} have been credited back to your leave balance for the early return.`
      : null,
    '',
    `The signed rejoining report is attached for your records — kindly print it, get it signed by yourself and your department head, and submit a hard copy to the HR office at your earliest convenience.`,
    '',
    `If you have any questions, please contact HR.`,
    '',
    `Thanks and regards,`,
    '',
    HR_SIGNATURE.name,
    HR_SIGNATURE.company,
    HR_SIGNATURE.unit,
    HR_SIGNATURE.address,
    `WhatsApp: ${HR_SIGNATURE.whatsapp}`,
    `Tel: ${HR_SIGNATURE.tel}`,
    `Email: ${HR_SIGNATURE.email}`,
  ].filter(line => line !== null).join('\n');

  const params = new URLSearchParams();
  if (cc) params.set('cc', cc);
  params.set('subject', subject);
  params.set('body', body);
  const mailto = `mailto:${encodeURIComponent(to)}?${params.toString().replace(/\+/g, '%20')}`;

  return { to, cc, subject, body, mailto };
}

// Resolve an entire request to its email draft + open the user's
// mail client. Same shape as the leave/permission email flow.
export function composeRejoiningEmailForRequest(request, empMap) {
  if (!request) throw new Error('No request supplied');
  if (!empMap)  throw new Error('Employee directory unavailable');
  const employee = empMap[request.employee_id];
  if (!employee) throw new Error('Employee not found in directory');
  const manager    = resolveApprover(request.manager_decided_by, empMap);
  const hrApprover = resolveApprover(request.hr_decided_by,      empMap);

  const draft = buildRejoiningEmailDraft({ employee, request, manager, hrApprover });
  if (!draft.to) {
    throw new Error('No email address on file for ' + (employee.name || request.employee_id));
  }
  window.location.href = draft.mailto;
  return draft;
}
