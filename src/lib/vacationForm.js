// Vacation (leave) form — bilingual A4 form, Leave Desk brand styling.
//
// Style mirrors permissionLetter.js exactly (cream paper, copper italic
// accents, brand-green section banners, Tahoma EVERGREEN LINE wordmark,
// QR footer, ✓ APPROVED stamp, 4-column main signature grid). Helpers
// are duplicated in this file rather than imported from permissionLetter
// so that future changes to one form can't accidentally break the other.
//
// CRITICAL RENDERING RULES (mirrored from permissionLetter.js):
//   • Every Table and TableCell uses WidthType.DXA — never PERCENTAGE.
//     Mixing them confuses Word's renderer and produces dark fallback
//     fills.
//   • columnWidths array is set on every Table and sums to the cell
//     widths exactly.
//   • Borders use SINGLE only — no DASHED/DOTTED on table cells.
//   • Cell margins always specified (top/bottom/left/right).
//   • ShadingType.CLEAR not SOLID — SOLID renders as black in Word.

import {
  Document, Packer, Paragraph, TextRun, ImageRun,
  Table, TableRow, TableCell,
  Header, Footer,
  AlignmentType, WidthType, BorderStyle, HeightRule,
  VerticalAlign, ShadingType,
} from 'docx';
import QRCode from 'qrcode';

const VERIFY_BASE_URL = (typeof window !== 'undefined' && window.location?.origin)
  ? window.location.origin
  : 'https://esauhr.netlify.app';

// ─── lookups ──────────────────────────────────────────────────────────────────
const DEPT_NAMES = {
  BIZ: 'Business',
  CSD: 'Customer Service',
  FIN: 'Finance',
  LOG: 'Logistics',
  SUP: 'Supervisory',
  'RYD OFFICE': 'Riyadh Office',
};
const LOCATION_NAMES = { DMM: 'Dammam', JED: 'Jeddah', RYD: 'Riyadh' };

// Bilingual leave types — used for the type-checkbox row and the title strip.
// Must include every leave_type_id the app may set.
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
// Subset shown as inline checkboxes on the form. Kept short enough to
// fit on one row without wrapping awkwardly. "Other" is the catch-all
// for any type not listed.
const TYPE_CHECKBOX_ORDER = ['annual', 'sick', 'emergency', 'hajj', 'maternity', 'paternity', 'marriage', 'bereavement', 'unpaid', 'other'];

const CEO_NAME      = 'JOHN HO';
const CEO_TITLE_EN  = 'Country Head / CEO';
const CEO_EMAIL          = 'johnho@evergreen-shipping.com.sa';
const COUNTRY_HEAD_EMAIL = 'jamesliu@evergreen-shipping.com.sa';

const HR_SIGNATURE = {
  name:    'BASHAIER ALI',
  company: 'Evergreen Shipping Agency Saudi Co.,(L.L.C)',
  unit:    'ESAU - SADMN SUP/ HR DEPT',
  address: 'P.O.Box : 1008,  DAMMAM – 31431, K.S.A',
  whatsapp:'966-54 320 9694',
  tel:     '966-013 813 8563 – Ext 8543',
  email:   'bashaier.alsubaie@evergreen-shipping.com.sa',
};

// KSA Labor Law summary — printed in the policy table at the bottom of
// the form so anyone reviewing the printed copy has the rules at hand.
const POLICY_BULLETS = [
  {
    en: 'Annual leave: 21 calendar days per year after 1 year of service; 30 days after 5 years.',
    ar: 'الإجازة السنوية: 21 يومًا في السنة بعد سنة من الخدمة، و30 يومًا بعد 5 سنوات.',
  },
  {
    en: 'Annual leave should be requested at least 14 days in advance.',
    ar: 'تُقدَّم طلبات الإجازة السنوية قبل 14 يومًا على الأقل.',
  },
  {
    en: 'Sick leave requires a valid medical certificate from an approved facility.',
    ar: 'تتطلب الإجازة المرضية شهادة طبية معتمدة من جهة معتمدة.',
  },
];

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

// ─── A4 page geometry ────────────────────────────────────────────────────────
// A4: 11906 × 16838 DXA. With 540 DXA margins all sides, usable width =
// 11906 - 1080 = 10826 DXA. Every table sums to this exact width.

const PAGE_W      = 10826;

const LABEL_W     = 2400;
const VALUE_W     = PAGE_W - LABEL_W;       // 8426

const HALF_W      = Math.floor(PAGE_W / 2); // 5413

const SIG_W       = Math.floor(PAGE_W / 4); // 2706
const SIG_W_LAST  = PAGE_W - (SIG_W * 3);   // remainder absorber

// Header: 4-column strip — logo | wordmark | date+ref | QR. QR moved
// here from the footer so verification is visible at-a-glance up top.
const HEADER_LOGO  = 1100;
const HEADER_QR    = 1500;
const HEADER_REF   = 2000;
const HEADER_TXT   = PAGE_W - HEADER_LOGO - HEADER_QR - HEADER_REF;

// Substitute signature row: index | name | sign-line | date-line
// Sums to PAGE_W exactly.
const SUB_W_IDX   = 700;
const SUB_W_NAME  = 3500;
const SUB_W_SIGN  = 4500;
const SUB_W_DATE  = PAGE_W - SUB_W_IDX - SUB_W_NAME - SUB_W_SIGN; // 2126

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
const fmtDateShort = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
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

// Short, human-readable reference for the printed letter. Handles both
// UUID-style ids (long hex+dashes) — uses the first 8 hex chars, since
// that's collision-safe within a single tenant — and legacy numeric ids
// (zero-padded to 5 digits like 'LV-00012').
//   UUID  '79dc3f36-4b16-46bd-9e71-5d0931b86e2b'  →  'LV-79DC3F36'
//   nbr   12                                       →  'LV-00012'
function shortRef(id) {
  const s = String(id ?? '');
  // Strip dashes so UUIDs read as solid hex, then take the first 8 chars.
  const hex = s.replace(/-/g, '');
  if (hex.length > 8 && /^[0-9a-f]+$/i.test(hex)) {
    return `LV-${hex.slice(0, 8).toUpperCase()}`;
  }
  return `LV-${s.padStart(5, '0')}`;
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

// CRITICAL: ShadingType.CLEAR not SOLID — SOLID renders as black in Word.
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
          children: [new Paragraph({
            children: [run(en, { bold: true, size: 18 })],
          })],
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
      new Paragraph({
        children: [run(en, { bold: true, size: 17 })],
        spacing: { after: 20 },
      }),
      new Paragraph({
        children: [arRun(ar, { size: 14, color: C_COPPER })],
      }),
    ],
    width: { size: LABEL_W, type: WidthType.DXA },
    margins: { top: 30, bottom: 30, left: 180, right: 100 },
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
    margins: { top: 30, bottom: 30, left: 200, right: 160 },
    borders: FORM_BORDER,
    verticalAlign: VerticalAlign.CENTER,
  });
}

function valueCellRuns(children) {
  return new TableCell({
    children: [new Paragraph({ children })],
    width: { size: VALUE_W, type: WidthType.DXA },
    margins: { top: 30, bottom: 30, left: 200, right: 160 },
    borders: FORM_BORDER,
    verticalAlign: VerticalAlign.CENTER,
  });
}

function formRow(en, ar, value, opts = {}) {
  return new TableRow({
    children: [
      labelCell(en, ar),
      typeof value === 'string'
        ? valueCell(value, opts)
        : valueCellRuns(value),
    ],
  });
}

const cbRun = (checked, label) => [
  run(checked ? '☑ ' : '☐ ', { size: 22, bold: true }),
  run(label + '     ', { size: 19 }),
];

// ─── signature cells: 2-row pattern (header band + body) so the name +
//      timestamp footer anchor to the BOTTOM of each box. Mirrors the
//      permission-letter pattern exactly. cantSplit on each row keeps the
//      band locked to its body, and the body's verticalAlign:BOTTOM
//      pushes the printed name + timestamp + 'Signature' line to the
//      bottom edge regardless of cell height.
function sigHeaderCell(en, ar, width) {
  return new TableCell({
    children: [new Paragraph({
      children: [
        run(en + '   ', { bold: true, size: 13 }),
        arRun(ar, { size: 13, color: C_COPPER }),
      ],
    })],
    width: { size: width, type: WidthType.DXA },
    margins: { top: 60, bottom: 60, left: 140, right: 140 },
    shading: shading(C_BANNER),
    borders: FORM_BORDER,
    verticalAlign: VerticalAlign.CENTER,
  });
}

function sigBodyCell(name, footerLeft, footerRight, width) {
  return new TableCell({
    children: [
      // Printed name — sits at the bottom of the cell because the cell
      // is verticalAlign:BOTTOM. The empty space above is the wet
      // signature area.
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [run(name || '', { size: 18, bold: true })],
        spacing: { before: 0, after: 60 },
      }),
      // Footer line — italic timestamp on the left, bold label on the
      // right, separated from the name by a thin top border.
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          run(footerLeft || ' ', { size: 12, italics: true, color: C_COPPER }),
          run('     ', { size: 12 }),
          run(footerRight, { size: 12, bold: true }),
        ],
        spacing: { before: 60, after: 0 },
        border: {
          top: { style: BorderStyle.SINGLE, size: 4, color: C_BORDER, space: 6 },
        },
      }),
    ],
    width: { size: width, type: WidthType.DXA },
    margins: { top: 50, bottom: 50, left: 140, right: 140 },
    borders: FORM_BORDER,
    verticalAlign: VerticalAlign.BOTTOM,
  });
}

// ─── substitute coverage row ─────────────────────────────────────────────────
// Each substitute row reads request.substitute_decisions[psn] and pre-
// fills the sign + date cells with the digital-acceptance proof:
//   sign cell:  "✓ Accepted online" (brand green)
//   date cell:  "29 Apr 2026 · 14:23"
// If the substitute hasn't accepted yet, the cells fall back to blank
// signature + date lines so they can still be signed by hand.
function substituteSigRow(idx, name, psn, decision) {
  const accepted = decision && (typeof decision === 'object' ? decision.decision === 'accepted' : decision === 'accepted');
  const declined = decision && (typeof decision === 'object' ? decision.decision === 'declined' : decision === 'declined');
  const acceptedAt = (decision && typeof decision === 'object' && decision.at) ? decision.at : null;

  const idxCell = new TableCell({
    width: { size: SUB_W_IDX, type: WidthType.DXA },
    borders: FORM_BORDER,
    margins: { top: 50, bottom: 50, left: 100, right: 100 },
    shading: shading(C_LABEL_BG),
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [run(String(idx), { bold: true, color: C_COPPER, size: 20 })],
    })],
  });

  const nameRuns = [run(name || '—', { bold: true, size: 19 })];
  if (psn) nameRuns.push(run(`   ${psn}`, { size: 14, color: C_MUTED }));
  const nameCell = new TableCell({
    width: { size: SUB_W_NAME, type: WidthType.DXA },
    borders: FORM_BORDER,
    margins: { top: 50, bottom: 50, left: 200, right: 100 },
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ children: nameRuns })],
  });

  // Signature cell — pre-filled with the online-acceptance status when
  // available. Falls back to a wet-signature line if the substitute has
  // not yet acted on the request.
  let signCellChildren;
  if (accepted) {
    signCellChildren = [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [run('✓ Accepted online', { bold: true, size: 16, color: C_BRAND })],
        spacing: { before: 0, after: 20 },
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          run('Signature  ', { size: 11, italics: true, color: C_COPPER }),
          arRun('التوقيع', { size: 11, color: C_COPPER }),
        ],
        spacing: { before: 0, after: 0 },
      }),
    ];
  } else if (declined) {
    signCellChildren = [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [run('✗ Declined', { bold: true, size: 16, color: 'B83A2E' })],
        spacing: { before: 0, after: 20 },
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          run('Signature  ', { size: 11, italics: true, color: C_COPPER }),
          arRun('التوقيع', { size: 11, color: C_COPPER }),
        ],
        spacing: { before: 0, after: 0 },
      }),
    ];
  } else {
    signCellChildren = [
      new Paragraph({
        children: [run(' ', { size: 14 })],
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C_BORDER, space: 4 } },
      }),
      new Paragraph({
        children: [
          run('Signature  ', { size: 11, italics: true, color: C_COPPER }),
          arRun('التوقيع', { size: 11, color: C_COPPER }),
        ],
        spacing: { before: 20, after: 0 },
      }),
    ];
  }

  const signCell = new TableCell({
    width: { size: SUB_W_SIGN, type: WidthType.DXA },
    borders: FORM_BORDER,
    margins: { top: 50, bottom: 30, left: 160, right: 160 },
    verticalAlign: VerticalAlign.CENTER,
    children: signCellChildren,
  });

  // Date cell — pre-filled with the acceptance timestamp when available.
  let dateCellChildren;
  if (acceptedAt) {
    dateCellChildren = [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [run(fmtDateTime(acceptedAt), { bold: true, size: 14, color: C_TEXT })],
        spacing: { before: 0, after: 20 },
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          run('Accepted online  ', { size: 11, italics: true, color: C_COPPER }),
          arRun('قُبل إلكترونياً', { size: 11, color: C_COPPER }),
        ],
        spacing: { before: 0, after: 0 },
      }),
    ];
  } else {
    dateCellChildren = [
      new Paragraph({
        children: [run(' ', { size: 14 })],
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C_BORDER, space: 4 } },
      }),
      new Paragraph({
        children: [
          run('Date  ', { size: 11, italics: true, color: C_COPPER }),
          arRun('التاريخ', { size: 11, color: C_COPPER }),
        ],
        spacing: { before: 20, after: 0 },
      }),
    ];
  }

  const dateCell = new TableCell({
    width: { size: SUB_W_DATE, type: WidthType.DXA },
    borders: FORM_BORDER,
    margins: { top: 50, bottom: 30, left: 160, right: 160 },
    verticalAlign: VerticalAlign.CENTER,
    children: dateCellChildren,
  });

  return new TableRow({
    cantSplit: true,
    children: [idxCell, nameCell, signCell, dateCell],
  });
}

function substituteHeaderRow() {
  const cell = (text, ar, width) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: FORM_BORDER,
    margins: { top: 50, bottom: 50, left: 140, right: 140 },
    shading: shading(C_LABEL_BG),
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({
      children: [
        run(text + '  ', { bold: true, size: 13, color: C_COPPER }),
        arRun(ar, { size: 13, color: C_MUTED, bold: true }),
      ],
    })],
  });
  return new TableRow({
    children: [
      cell('#', '', SUB_W_IDX),
      cell('SUBSTITUTE', 'البديل', SUB_W_NAME),
      cell('SIGNATURE', 'التوقيع', SUB_W_SIGN),
      cell('DATE', 'التاريخ', SUB_W_DATE),
    ],
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────
async function loadLogoBytes() {
  try {
    const res = await fetch('/evergreen-logo.jpg');
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
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
    console.warn('[vacation form] QR generation failed:', err);
    return null;
  }
}

// ─── main generator ──────────────────────────────────────────────────────────
export async function generateVacationFormBlob({ employee, request, manager, hrApprover, substitutes = [] }) {
  const ltKey  = LEAVE_TYPE[request.leave_type_id] ? request.leave_type_id : 'annual';
  const ltBoth = LEAVE_TYPE[ltKey];

  const dept = DEPT_NAMES[employee?.department] || employee?.department || '—';
  const loc  = LOCATION_NAMES[employee?.location] || employee?.location || '—';
  const designation = employee?.designation || 'Department Member';
  const today = new Date().toISOString();
  const isApproved = request.stage === 'approved';

  // Notice classification — Planned ≥14 days advance, Urgent <14.
  const submitted14d = request.requested_at && request.start_date
    ? (new Date(request.start_date).getTime() - new Date(request.requested_at).getTime()) >= 14 * 24 * 3600 * 1000
    : null;
  const noticePlanned = submitted14d === true;
  const noticeUrgent  = submitted14d === false;

  const dayCount = Number(request.days || 0);
  const daysLabel = `${dayCount} day${dayCount === 1 ? '' : 's'}${request.is_half_day ? '   (half day)' : ''}`;

  const periodValue = request.start_date === request.end_date
    ? fmtDateLong(request.start_date)
    : `${fmtDateLong(request.start_date)}  →  ${fmtDateLong(request.end_date)}`;

  const logoBytes = await loadLogoBytes();

  // Verify URL + QR are now in the top header (was footer in the previous
  // version). Generated up front so the header table can embed the QR
  // image directly.
  const verifyUrl = `${VERIFY_BASE_URL}/verify-leave/${request.id}`;
  const qrBytes = await generateQrPng(verifyUrl, 220);

  // ── HEADER ────────────────────────────────────────────────────────────────
  const headerRow = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [HEADER_LOGO, HEADER_TXT, HEADER_REF, HEADER_QR],
    rows: [new TableRow({
      children: [
        new TableCell({
          children: [
            logoBytes
              ? new Paragraph({
                  children: [new ImageRun({
                    data: logoBytes,
                    transformation: { width: 56, height: 56 },
                    type: 'jpg',
                  })],
                })
              : new Paragraph({
                  children: [run('EVR', { bold: true, size: 28, color: C_BRAND, font: FONT_BRAND })],
                }),
          ],
          width: { size: HEADER_LOGO, type: WidthType.DXA },
          margins: { top: 0, bottom: 0, left: 0, right: 100 },
          borders: NO_BORDER,
          verticalAlign: VerticalAlign.CENTER,
        }),
        new TableCell({
          children: [
            new Paragraph({
              children: [run('EVERGREEN LINE', { bold: true, size: 32, color: C_BRAND, font: FONT_BRAND })],
            }),
            new Paragraph({
              children: [run(
                'Evergreen Shipping Agency Saudi Co. (L.L.C)  ·  ESAU SADMN SUP / HR Dept',
                { size: 14, color: C_MUTED },
              )],
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
              children: [
                run('Date: ', { bold: true, color: C_MUTED, size: 14 }),
                run(fmtDateMed(today), { size: 14 }),
              ],
              alignment: AlignmentType.RIGHT,
            }),
            new Paragraph({
              children: [
                run('Ref:  ', { bold: true, color: C_MUTED, size: 14 }),
                run(shortRef(request.id), { bold: true, size: 14 }),
              ],
              alignment: AlignmentType.RIGHT,
              spacing: { before: 40 },
            }),
          ],
          width: { size: HEADER_REF, type: WidthType.DXA },
          margins: { top: 0, bottom: 0, left: 0, right: 100 },
          borders: NO_BORDER,
          verticalAlign: VerticalAlign.CENTER,
        }),
        // QR cell — top-right of header. Caption stays inside the cell
        // so the QR + label read as a single unit.
        new TableCell({
          children: qrBytes
            ? [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [new ImageRun({
                    data: qrBytes,
                    transformation: { width: 54, height: 54 },
                    type: 'png',
                  })],
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
  const titleStrip = new Paragraph({
    children: [
      run('Leave Application — ', { bold: true, size: 24, color: C_TEXT }),
      run(`${ltBoth.en} Leave`, { bold: true, italics: true, size: 24, color: C_COPPER }),
    ],
    spacing: { before: 80, after: 30 },
  });
  const titleStripAr = new Paragraph({
    children: [arRun(`طلب إجازة · إجازة ${ltBoth.ar}`, { bold: true, size: 16, color: C_BRAND })],
    bidirectional: true,
    alignment: AlignmentType.LEFT,
    spacing: { before: 0, after: 60 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C_BORDER, space: 4 } },
  });

  // ── EMPLOYEE INFORMATION ──────────────────────────────────────────────────
  const empTable = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [LABEL_W, VALUE_W],
    rows: [
      formRow('Employee name',  'اسم الموظف',     employee?.name || '—', { bold: true }),
      formRow('PSN ID',          'الرقم الوظيفي',  employee?.id || '—'),
      formRow('Department',      'القسم',          `${dept}  ·  ${loc}`),
      formRow('Designation',     'المسمى الوظيفي', designation),
      formRow('Joined / Tenure', 'الالتحاق / المدة', `${fmtDateMed(employee?.join_date)}   ·   ${yearsOfService(employee?.join_date)}`),
    ],
  });

  // ── LEAVE DETAILS ─────────────────────────────────────────────────────────
  const typeChecks = TYPE_CHECKBOX_ORDER.flatMap(k =>
    cbRun(ltKey === k, LEAVE_TYPE[k].en)
  );
  const noticeChecks = [
    ...cbRun(noticePlanned, 'Planned (≥14 days)'),
    ...cbRun(noticeUrgent,  'Urgent (<14 days)'),
  ];
  const halfDayChecks = [
    run(daysLabel, { size: 21, bold: true, color: C_BRAND }),
    run('     ·     ', { size: 21, color: C_MUTED }),
    ...cbRun(!!request.is_half_day, 'Half day'),
  ];

  const detailsTable = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [LABEL_W, VALUE_W],
    rows: [
      formRow('Leave type',      'نوع الإجازة',       typeChecks),
      formRow('Period',          'الفترة',            periodValue, { bold: true, color: C_BRAND }),
      formRow('Duration',        'المدة',             halfDayChecks),
      formRow('Notice',          'الإشعار',           noticeChecks),
      formRow('Reason / details','السبب / التفاصيل',  request.reason || '—'),
      formRow('Submitted',       'تاريخ التقديم',     fmtDateTime(request.requested_at || today)),
    ],
  });

  // ── SUBSTITUTE COVERAGE ───────────────────────────────────────────────────
  // Each substitute gets a row with name + wet-signature line + date line.
  // If the portal already captured digital confirmation (substitute_ids on
  // the request), we tag the row with "✓ Confirmed online" to indicate the
  // wet signature is the second factor, not the first.
  const subDecisions = request.substitute_decisions || {};
  const subRows = (substitutes && substitutes.length > 0)
    ? substitutes.map((s, idx) => substituteSigRow(idx + 1, s.name, s.id, subDecisions[s.id]))
    : [
        new TableRow({
          children: [new TableCell({
            columnSpan: 4,
            width: { size: PAGE_W, type: WidthType.DXA },
            borders: FORM_BORDER,
            margins: { top: 80, bottom: 80, left: 200, right: 200 },
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [run('No substitutes designated for this leave.', { italics: true, size: 17, color: C_MUTED })],
            })],
          })],
        }),
      ];

  const substitutesTable = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [SUB_W_IDX, SUB_W_NAME, SUB_W_SIGN, SUB_W_DATE],
    rows: substitutes && substitutes.length > 0
      ? [substituteHeaderRow(), ...subRows]
      : subRows,
  });

  // ── POLICY ────────────────────────────────────────────────────────────────
  const policyTable = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [HALF_W, PAGE_W - HALF_W],
    rows: [
      // Header row
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({
              children: [run('LEAVE POLICY · KSA LABOR LAW', { bold: true, size: 12, color: C_COPPER })],
            })],
            width: { size: HALF_W, type: WidthType.DXA },
            margins: { top: 40, bottom: 30, left: 180, right: 100 },
            shading: shading(C_LABEL_BG),
            borders: FORM_BORDER,
          }),
          new TableCell({
            children: [new Paragraph({
              children: [arRun('سياسة الإجازات · نظام العمل السعودي', { bold: true, size: 12, color: C_MUTED })],
              alignment: AlignmentType.RIGHT,
              bidirectional: true,
            })],
            width: { size: PAGE_W - HALF_W, type: WidthType.DXA },
            margins: { top: 40, bottom: 30, left: 100, right: 180 },
            shading: shading(C_LABEL_BG),
            borders: FORM_BORDER,
          }),
        ],
      }),
      // Bullet rows — body text 5.5pt (size: 11) per request, kept tight
      ...POLICY_BULLETS.map((b, i) => new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({
              children: [
                run(`${String(i + 1).padStart(2, '0')}.   `, { bold: true, size: 11, color: C_COPPER }),
                run(b.en, { size: 11 }),
              ],
            })],
            width: { size: HALF_W, type: WidthType.DXA },
            margins: { top: 20, bottom: 20, left: 180, right: 100 },
            shading: shading(C_LABEL_BG),
            borders: FORM_BORDER,
            verticalAlign: VerticalAlign.CENTER,
          }),
          new TableCell({
            children: [new Paragraph({
              children: [arRun(b.ar, { size: 12, color: C_MUTED })],
              alignment: AlignmentType.RIGHT,
              bidirectional: true,
            })],
            width: { size: PAGE_W - HALF_W, type: WidthType.DXA },
            margins: { top: 20, bottom: 20, left: 100, right: 180 },
            shading: shading(C_LABEL_BG),
            borders: FORM_BORDER,
            verticalAlign: VerticalAlign.CENTER,
          }),
        ],
      })),
    ],
  });

  // ── APPROVAL SIGNATURES (4-column main grid) ──────────────────────────────
  const sigCols = [
    { en: 'EMPLOYEE',  ar: 'الموظف',          name: employee?.name || '',
      footerLeft:  request.requested_at ? `Submitted ${fmtStampCompact(request.requested_at)}` : '',
      footerRight: 'Signature' },
    { en: 'DEPT MGR',  ar: 'مدير القسم',       name: manager?.name || '',
      footerLeft:  request.manager_decided_at ? `Approved ${fmtStampCompact(request.manager_decided_at)}` : '',
      footerRight: 'Signature' },
    { en: 'ESAU SUP',  ar: 'الموارد البشرية',   name: hrApprover?.name || HR_SIGNATURE.name,
      footerLeft:  request.hr_decided_at ? `Approved ${fmtStampCompact(request.hr_decided_at)}` : '',
      footerRight: 'Signature' },
    { en: 'ESAU MGT',  ar: 'الإدارة',          name: CEO_NAME,
      footerLeft:  CEO_TITLE_EN, footerRight: 'HQ Stamp' },
  ];

  const sigWidths = [SIG_W, SIG_W, SIG_W, SIG_W_LAST];

  const sigTable = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: sigWidths,
    rows: [
      new TableRow({
        cantSplit: true,
        children: sigCols.map((c, i) => sigHeaderCell(c.en, c.ar, sigWidths[i])),
      }),
      new TableRow({
        cantSplit: true,
        // 3.54 cm body row (2007 dxa) — generous space for ink
        // signatures + HQ stamp. Body cell verticalAlign:BOTTOM
        // anchors the printed name + timestamp to the bottom edge.
        height: { value: 2007, rule: HeightRule.ATLEAST },
        children: sigCols.map((c, i) =>
          sigBodyCell(c.name, c.footerLeft, c.footerRight, sigWidths[i])),
      }),
    ],
  });

  // ── FOOTER ────────────────────────────────────────────────────────────────
  // QR moved to the top header — footer is now just the generation
  // stamp and verify URL on two lines.
  const generatedAt = new Date().toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const footerBlock = new Paragraph({
    children: [
      run(`Generated on ${generatedAt} GMT+3  ·  ${hrApprover?.name || HR_SIGNATURE.name}`,
          { size: 12, italics: true, color: C_COPPER }),
    ],
    alignment: AlignmentType.LEFT,
    spacing: { before: 40, after: 0 },
  });

  // ── APPROVED STAMP ───────────────────────────────────────────────────────
  // Only shown when the request has reached final-approved stage. Pinned
  // to top-right via section header so it doesn't displace body content.
  const approvedStamp = new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({
            text: isApproved ? '✓ APPROVED' : '',
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
      headers: { default: approvedStamp },
      children: [
        headerRow,
        headerRule,
        headerRuleCopper,
        titleStrip,
        titleStripAr,
        spacer(40),
        sectionBanner('EMPLOYEE INFORMATION', 'معلومات الموظف'),
        empTable,
        spacer(30),
        sectionBanner('LEAVE DETAILS', 'تفاصيل الإجازة'),
        detailsTable,
        spacer(30),
        sectionBanner('SUBSTITUTE COVERAGE', 'البديل أثناء الغياب'),
        substitutesTable,
        spacer(30),
        policyTable,
        spacer(30),
        sigTable,
        footerBlock,
      ],
    }],
  });

  return await Packer.toBlob(doc);
}

// ─── email draft ──────────────────────────────────────────────────────────────
export function buildEmailDraft({ employee, request, manager, hrApprover, substitutes = [] }) {
  const ltKey = LEAVE_TYPE[request.leave_type_id] ? request.leave_type_id : 'annual';
  const leaveTypeLabel = `${LEAVE_TYPE[ltKey].en} Leave`;
  const dateRange = `${fmtDateMed(request.start_date)} - ${fmtDateMed(request.end_date)}`;

  const to = [employee?.email].filter(Boolean).join(',');
  const ccList = [
    manager?.email,
    CEO_EMAIL,
    COUNTRY_HEAD_EMAIL,
  ].filter(Boolean);
  const cc = Array.from(new Set(ccList.filter(e => e !== to))).join(',');

  const subject = `Leave approved · ${employee?.name || ''} · ${dateRange}`;

  const body = [
    `Dear ${(employee?.name || '').split(' ')[0] || 'Colleague'},`,
    '',
    `Your ${leaveTypeLabel.toLowerCase()} request from ${dateRange} (${request.days} day${request.days === 1 ? '' : 's'}${request.is_half_day ? ' — half day' : ''}) has been approved.`,
    '',
    `Reason on file: ${request.reason || '—'}`,
    '',
    `Coverage during your absence:`,
    ...(substitutes && substitutes.length > 0
      ? substitutes.map(s => `  • ${s.name} (${s.id})`)
      : ['  • —']),
    '',
    `The signed vacation form is attached for your records — kindly print, get it signed by your manager and substitute(s), and submit a hard copy to the HR office.`,
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
  ].join('\n');

  const params = new URLSearchParams();
  if (cc) params.set('cc', cc);
  params.set('subject', subject);
  params.set('body', body);
  const mailto = `mailto:${encodeURIComponent(to)}?${params.toString().replace(/\+/g, '%20')}`;

  return { to, cc, subject, body, mailto };
}

// ─── Sick-leave-specific email draft ──────────────────────────────────────────
// Used when Bashaier approves a sick-leave request after verifying
// the certificate on Sehhaty. The draft differs from the standard
// vacation-form email in three ways:
//   1. Subject and salutation explicitly call out 'sick leave' and
//      'validated on Sehhaty' so the staff member knows HR has
//      cross-checked the certificate, not just rubber-stamped it.
//   2. Body carries the Sehhaty leave ID and verification timestamp
//      as a paper-trail line — useful if there's ever a payroll
//      query about the certificate later.
//   3. There's no vacation-form attachment (sick leaves don't use
//      the standard form). Instead, a clear instruction asks
//      Bashaier to attach the Sehhaty inquiry screenshot before
//      sending, since mailto: links can't carry attachments.
//
// The Saudi Labour Law pay bracket for the leave is included in
// the body when known — saves a back-and-forth between staff and
// payroll about whether days are at full / 75% / unpaid rate.
//
// Returns the same shape as buildEmailDraft so the caller can
// share the same launch logic (window.location.href = mailto).
export function buildSickLeaveApprovalEmailDraft({
  employee, request, manager, hrApprover, payBracketLabel,
}) {
  const dateRange = `${fmtDateMed(request.start_date)} - ${fmtDateMed(request.end_date)}`;
  const dayCount  = `${request.days} day${request.days === 1 ? '' : 's'}${request.is_half_day ? ' — half day' : ''}`;

  const verifiedAt = request.sehhaty_verified_at
    ? new Date(request.sehhaty_verified_at)
    : null;
  const verifiedAtStr = verifiedAt
    ? `${fmtDateMed(verifiedAt.toISOString())} at ${verifiedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`
    : '—';

  // Cross-check block — these are the values HR typed in from the
  // Sehhaty inquiry result page (sehhaty_seen_*). When present they
  // make the email a self-contained verification record: anyone
  // reading it can see what was certified vs what was requested,
  // without needing to hunt for the screenshot.
  const seenLines = [];
  if (request.sehhaty_seen_name)        seenLines.push(`Patient name (Sehhaty):  ${request.sehhaty_seen_name}`);
  if (request.sehhaty_seen_id_number)   seenLines.push(`National ID / Iqama:     ${request.sehhaty_seen_id_number}`);
  if (request.sehhaty_seen_start)       seenLines.push(`Period (Sehhaty):        ${request.sehhaty_seen_start} → ${request.sehhaty_seen_end || '—'}`);
  if (request.sehhaty_seen_days != null) seenLines.push(`Days certified:          ${request.sehhaty_seen_days}`);
  if (request.sehhaty_seen_issue_date)  seenLines.push(`Cert issued:             ${request.sehhaty_seen_issue_date}`);
  if (request.sehhaty_seen_doctor)      seenLines.push(`Doctor:                  ${request.sehhaty_seen_doctor}`);
  if (request.sehhaty_seen_specialty)   seenLines.push(`Specialty:               ${request.sehhaty_seen_specialty}`);

  const to = [employee?.email].filter(Boolean).join(',');
  const ccList = [
    manager?.email,
    CEO_EMAIL,
    COUNTRY_HEAD_EMAIL,
  ].filter(Boolean);
  const cc = Array.from(new Set(ccList.filter(e => e !== to))).join(',');

  const subject = `Sick leave approved & validated on Sehhaty · ${employee?.name || ''} · ${dateRange}`;

  const body = [
    `Dear ${(employee?.name || '').split(' ')[0] || 'Colleague'},`,
    '',
    `Your sick leave from ${dateRange} (${dayCount}) has been approved.`,
    '',
    `SEHHATY VERIFICATION`,
    `--------------------`,
    `Leave ID:        ${request.sehhaty_code || '—'}`,
    `Verified on:     ${verifiedAtStr}`,
    `Verified by:     ${hrApprover?.name || HR_SIGNATURE.name}`,
    request.sehhaty_verification_note
      ? `Note:            ${request.sehhaty_verification_note}`
      : null,
    payBracketLabel
      ? `Pay bracket:     ${payBracketLabel} (per Saudi Labour Law Art. 117)`
      : null,
    seenLines.length > 0 ? '' : null,
    seenLines.length > 0 ? `CERTIFICATE DETAILS (cross-checked on Sehhaty)` : null,
    seenLines.length > 0 ? `--------------------` : null,
    ...seenLines,
    '',
    `The certificate above has been cross-checked on the Sehhaty/Seha platform`,
    `and the data certified by the doctor matches your leave request on file.`,
    '',
    `Take care, get well soon, and please share an update with your manager once you're back.`,
    '',
    `If you have any questions about pay treatment for these days, please reply to this email.`,
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
  ].filter(Boolean).join('\n');

  const params = new URLSearchParams();
  if (cc) params.set('cc', cc);
  params.set('subject', subject);
  params.set('body', body);
  const mailto = `mailto:${encodeURIComponent(to)}?${params.toString().replace(/\+/g, '%20')}`;

  return { to, cc, subject, body, mailto };
}

// ─── Leave rejection email draft ──────────────────────────────────────────────
// Used when Bashaier or a manager wants to (re-)send the rejection
// notice to the staff member. The body carries the standardised
// rejection reason label, any free-text note the rejector wrote,
// and — for sick leaves — the Sehhaty leave ID so the staff member
// has the reference number when they go correct and resubmit.
//
// Tone is direct but kind: it tells them what was rejected, why,
// what to do next. Not a long apology; not a robotic terse line.
//
// Inputs:
//   employee         — staff who submitted
//   request          — the leave_request row (with rejection_reason_*)
//   manager          — line manager (for CC)
//   hrApprover       — me, the rejector
//   reasonLabel      — human label from REJECTION_REASONS catalog
//                      (passed in because the catalog lives in
//                      leaveLogic.js and we don't want a circular
//                      import here)
//   reasonNote       — free-text note Bashaier added
export function buildLeaveRejectionEmailDraft({
  employee, request, manager, hrApprover, reasonLabel, reasonNote,
}) {
  const ltKey = LEAVE_TYPE[request.leave_type_id] ? request.leave_type_id : 'annual';
  const leaveTypeLabel = `${LEAVE_TYPE[ltKey].en} Leave`;
  const dateRange = `${fmtDateMed(request.start_date)} - ${fmtDateMed(request.end_date)}`;
  const isSick = request.leave_type_id === 'sick';

  const decidedAt = request.hr_decided_at
    ? new Date(request.hr_decided_at)
    : null;
  const decidedAtStr = decidedAt
    ? `${fmtDateMed(decidedAt.toISOString())} at ${decidedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`
    : '—';

  const to = [employee?.email].filter(Boolean).join(',');
  const ccList = [manager?.email].filter(Boolean);
  const cc = Array.from(new Set(ccList.filter(e => e !== to))).join(',');

  const subject = `Leave request not approved · ${employee?.name || ''} · ${dateRange}`;

  const body = [
    `Dear ${(employee?.name || '').split(' ')[0] || 'Colleague'},`,
    '',
    `Your ${leaveTypeLabel.toLowerCase()} request from ${dateRange} (${request.days} day${request.days === 1 ? '' : 's'}${request.is_half_day ? ' — half day' : ''}) has not been approved.`,
    '',
    `REASON`,
    `------`,
    reasonLabel || '—',
    reasonNote ? '' : null,
    reasonNote ? `Note from HR: ${reasonNote}` : null,
    '',
    isSick && request.sehhaty_code
      ? `Sehhaty leave ID on file: ${request.sehhaty_code}`
      : null,
    isSick && request.sehhaty_code ? '' : null,
    `Decision recorded: ${decidedAtStr}`,
    `Decided by:        ${hrApprover?.name || HR_SIGNATURE.name}`,
    '',
    isSick
      ? `If you believe this rejection is in error, please verify the Sehhaty leave ID on the Sehha portal (https://www.seha.sa/#/inquiries/slenquiry) and reply to this email with the corrected reference. You may also resubmit a new request through the portal.`
      : `If you believe this rejection is in error, please reply to this email with any clarifying information. You can also resubmit through the portal once any required corrections are in place.`,
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
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Resolve a stored 'decided_by' value to an employee. The DB stores either
// a PSN (e.g. 'H94076') OR an auth_user_id (UUID), depending on which code
// path wrote it. Try the empMap key lookup first, then fall back to scanning
// the directory for a matching auth_user_id. Returns null if not found.
function resolveApprover(decidedBy, empMap) {
  if (!decidedBy) return null;
  if (empMap[decidedBy]) return empMap[decidedBy];
  const directory = Object.values(empMap);
  return directory.find((e) => e.auth_user_id === decidedBy) || null;
}

export async function downloadVacationFormForRequest(request, empMap) {
  if (!request) throw new Error('No request supplied');
  if (!empMap)  throw new Error('Employee directory unavailable');
  const employee = empMap[request.employee_id];
  if (!employee) throw new Error('Employee not found in directory');
  const manager     = resolveApprover(request.manager_decided_by, empMap);
  const hrApprover  = resolveApprover(request.hr_decided_by,      empMap);
  const substitutes = (request.substitute_ids || [])
    .map((psn) => empMap[psn])
    .filter(Boolean);

  const blob = await generateVacationFormBlob({
    request, employee, manager, hrApprover, substitutes,
  });
  const safeName = (employee.name || request.employee_id).replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
  const filename = `Vacation_Form_${safeName}_${request.start_date}.docx`;
  downloadBlob(blob, filename);
  return { blob, filename };
}
