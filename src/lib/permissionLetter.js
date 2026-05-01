// Permission letter — bilingual A4 form, Leave Desk brand styling.
//
// CRITICAL RENDERING RULES (learned from earlier dark-background bugs):
//   • Every Table and TableCell uses WidthType.DXA — never PERCENTAGE.
//     Mixing the two confuses Word's renderer and produces dark
//     fallback fills.
//   • columnWidths array is set on every Table and sums to the cell
//     widths exactly.
//   • Borders use SINGLE only — no DASHED/DOTTED on table cells, those
//     occasionally render solid black in Word.
//   • Cell margins always specified (top/bottom/left/right).
//   • No nested tables in tight-width cells. Inline runs only.

import {
  Document, Packer, Paragraph, TextRun, ImageRun,
  Table, TableRow, TableCell,
  Header, Footer,
  AlignmentType, WidthType, BorderStyle, HeightRule,
  VerticalAlign, ShadingType,
} from 'docx';
import QRCode from 'qrcode';
import { downloadBlob } from './vacationForm.js';

// Verification URL base — staff scan the QR in the printed letter to
// hit a public read-only page that confirms the request status from
// the live database. Rendered as a small ImageRun beside the footer.
const VERIFY_BASE_URL = (typeof window !== 'undefined' && window.location?.origin)
  ? window.location.origin
  : 'https://esauhr.netlify.app';

async function generateQrPng(text, sizePx = 220) {
  try {
    const dataUrl = await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: sizePx,
      color: { dark: '#1F4530', light: '#FFFFFF' },
    });
    // Strip data URL prefix and convert to ArrayBuffer for ImageRun.
    const base64 = dataUrl.split(',')[1];
    if (typeof atob !== 'undefined') {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    }
    // Node fallback
    return Buffer.from(base64, 'base64');
  } catch (err) {
    console.warn('[permission letter] QR generation failed:', err);
    return null;
  }
}

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
const TYPE = {
  late_arrival: { en: 'Late Arrival',    ar: 'تأخير في الحضور' },
  early_leave:  { en: 'Early Departure', ar: 'انصراف مبكر' },
};

const EXEC_CC = [
  // Direct email — bypasses employees-table lookup. Used for execs
  // whose names may not match the employees roster reliably (or who
  // are not in the roster at all).
  { name: 'john ho', email: 'johnho@evergreen-shipping.com.sa' },
  { name: 'james' },
  { name: 'fahad hussain' },
  { name: 'fahad', dept: 'SUP' },
  { name: 'badria' },
  { name: 'jaffar' },
];

const HR_SIGNATURE = {
  name:    'BASHAIER ALI',
  company: 'Evergreen Shipping Agency Saudi Co.,(L.L.C)',
  unit:    'ESAU - SADMN SUP/ HR DEPT',
  address: 'P.O.Box : 1008,  DAMMAM – 31431, K.S.A',
  whatsapp:'966-54 320 9694',
  tel:     '966-013 813 8563 – Ext 8543',
  email:   'bashaier.alsubaie@evergreen-shipping.com.sa',
};

const POLICY_BULLETS = [
  {
    en: 'Maximum 3 permissions per calendar month — Late Arrival or Early Departure.',
    ar: '3 استئذانات كحد أقصى في الشهر، تأخير أو انصراف مبكر.',
  },
  {
    en: 'Each request may not exceed 60 minutes.',
    ar: 'لا تتجاوز مدة كل استئذان 60 دقيقة.',
  },
  {
    en: 'Exceeding the limit may be subject to HR review.',
    ar: 'أي موظف يتجاوز هذا الحد يخضع للإجراء.',
  },
];

const REASON_CATEGORIES = [
  { id: 'medical',  en: 'Medical' },
  { id: 'gov_bank', en: 'Government / Bank' },
  { id: 'family',   en: 'Family / Emergency' },
  { id: 'school',   en: 'School / Childcare' },
  { id: 'traffic',  en: 'Traffic / Transport' },
  { id: 'other',    en: 'Other' },
];

function categoryFor(reason) {
  const r = (reason || '').toLowerCase();
  if (/medical|doctor|clinic|hospital|sick/.test(r))                return 'medical';
  if (/government|iqama|bank|financial|paperwork|official/.test(r)) return 'gov_bank';
  if (/family|emergency|urgent|personal/.test(r))                    return 'family';
  if (/school|child|pickup|drop[\s-]?off/.test(r))                   return 'school';
  if (/traffic|transport|road|commute/.test(r))                      return 'traffic';
  return 'other';
}

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
const SIG_W       = Math.floor(PAGE_W / 4); // 2706 ; 4 cells × 2706 = 10824 (close enough)
// Re-balance: 4 sig cells should sum exactly to PAGE_W
const SIG_W_LAST  = PAGE_W - (SIG_W * 3);   // absorbs the remainder

const HEADER_LOGO = 1400;
const HEADER_TXT  = PAGE_W - HEADER_LOGO - 2400;  // text takes most of the bar
const HEADER_REF  = 2400;

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

// Standard form border — every cell uses this. SINGLE style only,
// 4 twip width, soft warm color.
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
          margins: { top: 80, bottom: 80, left: 200, right: 100 },
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
          margins: { top: 80, bottom: 80, left: 100, right: 200 },
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
    margins: { top: 50, bottom: 50, left: 180, right: 100 },
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
    margins: { top: 50, bottom: 50, left: 200, right: 160 },
    borders: FORM_BORDER,
    verticalAlign: VerticalAlign.CENTER,
  });
}

function valueCellRuns(children) {
  return new TableCell({
    children: [new Paragraph({ children })],
    width: { size: VALUE_W, type: WidthType.DXA },
    margins: { top: 50, bottom: 50, left: 200, right: 160 },
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

// ─── signature cells ─────────────────────────────────────────────────────────
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

// Combined body + footer cell — printed name on top, timestamp + label
// at the bottom of the SAME cell. Replaces the old separate body and
// footer cells. The advantage: Word can't split a cell mid-content
// across pages, so the sig table becomes a 2-row block (header band +
// combined body) that always renders as a unit.
function sigCombinedBodyCell(name, footerLeft, footerRight, width) {
  return new TableCell({
    children: [
      // Printed name — centered. Sits just above the timestamp/label
      // line at the bottom of the cell. Wet signature goes in the
      // empty space ABOVE the name.
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [run(name || '', { size: 18, bold: true })],
        spacing: { before: 0, after: 80 },
      }),
      // Timestamp + label — also centered, with a thin top border
      // separating it from the name.
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          run(footerLeft || ' ', { size: 12, italics: true, color: C_COPPER }),
          run('     ', { size: 12 }),
          run(footerRight, { size: 12, bold: true }),
        ],
        spacing: { before: 80, after: 0 },
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

// ─── logo loader ─────────────────────────────────────────────────────────────
async function loadLogoBytes() {
  try {
    const res = await fetch('/evergreen-logo.jpg');
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

// ─── main generator ──────────────────────────────────────────────────────────
export async function generatePermissionLetterBlob({ employee, manager, hrApprover, request }) {
  const typeKey  = TYPE[request.type] ? request.type : 'late_arrival';
  const typeBoth = TYPE[typeKey];

  const dept = DEPT_NAMES[employee?.department] || employee?.department || '—';
  const loc  = LOCATION_NAMES[employee?.location] || employee?.location || '—';
  const today = new Date().toISOString();
  const dur  = (() => {
    if (request.time_from && request.time_to) {
      const toMin = (s) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
        return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
      };
      const a = toMin(request.time_from), b = toMin(request.time_to);
      if (!Number.isNaN(a) && !Number.isNaN(b)) return Math.max(0, b - a);
    }
    return Math.round(Number(request.hours || 0) * 60);
  })();
  const cat = categoryFor(request.reason);
  const submittedSoon = request.requested_at && request.permission_date
    ? (new Date(request.permission_date).getTime() - new Date(request.requested_at).getTime()) >= 24 * 3600 * 1000
    : null;
  const noticePlanned = submittedSoon === true;
  const noticeUrgent  = submittedSoon === false;

  const logoBytes = await loadLogoBytes();

  // ── HEADER ────────────────────────────────────────────────────────────────
  const headerRow = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [HEADER_LOGO, HEADER_TXT, HEADER_REF],
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
                run(`PR-${String(request.id).padStart(5, '0')}`, { bold: true, size: 14 }),
              ],
              alignment: AlignmentType.RIGHT,
              spacing: { before: 40 },
            }),
          ],
          width: { size: HEADER_REF, type: WidthType.DXA },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
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
      run('Permission Request — ', { bold: true, size: 24, color: C_TEXT }),
      run(typeBoth.en, { bold: true, italics: true, size: 24, color: C_COPPER }),
    ],
    spacing: { before: 80, after: 30 },
  });
  const titleStripAr = new Paragraph({
    children: [arRun(`طلب استئذان · ${typeBoth.ar}`, { bold: true, size: 16, color: C_BRAND })],
    bidirectional: true,
    alignment: AlignmentType.LEFT,
    spacing: { before: 0, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C_BORDER, space: 4 } },
  });

  // ── EMPLOYEE INFORMATION ──────────────────────────────────────────────────
  const empTable = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [LABEL_W, VALUE_W],
    rows: [
      formRow('Employee name',  'اسم الموظف',   employee?.name || '—', { bold: true }),
      formRow('PSN ID',         'الرقم الوظيفي', employee?.id || '—'),
      formRow('Department',     'القسم',         `${dept}  ·  ${loc}`),
      formRow('Submitted',      'تاريخ التقديم', fmtDateTime(request.requested_at || today)),
    ],
  });

  // ── PERMISSION DETAILS ────────────────────────────────────────────────────
  const typeChecks = [
    ...cbRun(typeKey === 'late_arrival', 'Late Arrival'),
    ...cbRun(typeKey === 'early_leave',  'Early Departure'),
  ];
  const noticeChecks = [
    ...cbRun(noticePlanned, 'Planned (≥24h)'),
    ...cbRun(noticeUrgent,  'Urgent (<24h)'),
  ];
  const reasonChecks = REASON_CATEGORIES.map(c =>
    cbRun(cat === c.id, c.en)
  ).flat();

  const timeRuns = [
    run(`${request.time_from || '—'}  →  ${request.time_to || '—'}`, { bold: true, size: 21, color: C_BRAND }),
    run('   ·   ', { size: 21, color: C_MUTED }),
    run(`Duration: ${dur} mins`, { size: 21 }),
  ];

  const summaryHours = Number(request.hours || 0);
  const usageQuantity = `${summaryHours} hour${summaryHours === 1 ? '' : 's'} of 3 allowed`;
  const usageStatus   = request.exceeds_quota ? 'Quota exceeded' : 'within monthly quota';
  const usageRuns = [
    run(usageQuantity, { size: 21, bold: true, color: 'B83A2E' }),
    run('   ·   ', { size: 21, color: C_MUTED }),
    run(usageStatus, { size: 21 }),
  ];

  const detailsTable = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [LABEL_W, VALUE_W],
    rows: [
      formRow('Type',             'النوع',           typeChecks),
      formRow('Permission date',  'تاريخ الاستئذان', fmtDateLong(request.permission_date), { bold: true, color: C_BRAND }),
      formRow('Time window',      'الوقت',           timeRuns),
      formRow('Monthly usage',    'الاستخدام الشهري', usageRuns),
      formRow('Notice',           'الإشعار',         noticeChecks),
      formRow('Reason category',  'فئة السبب',       reasonChecks),
      formRow('Reason details',   'السبب',           request.reason || '—'),
    ],
  });

  // ── POLICY ────────────────────────────────────────────────────────────────
  const policyTable = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [HALF_W, PAGE_W - HALF_W],
    rows: [
      // Policy header row
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({
              children: [run('COMPANY POLICY · MONTHLY QUOTA', { bold: true, size: 13, color: C_COPPER })],
            })],
            width: { size: HALF_W, type: WidthType.DXA },
            margins: { top: 80, bottom: 60, left: 180, right: 100 },
            shading: shading(C_LABEL_BG),
            borders: FORM_BORDER,
          }),
          new TableCell({
            children: [new Paragraph({
              children: [arRun('سياسة الشركة · الحصة الشهرية', { bold: true, size: 14, color: C_MUTED })],
              alignment: AlignmentType.RIGHT,
              bidirectional: true,
            })],
            width: { size: PAGE_W - HALF_W, type: WidthType.DXA },
            margins: { top: 80, bottom: 60, left: 100, right: 180 },
            shading: shading(C_LABEL_BG),
            borders: FORM_BORDER,
          }),
        ],
      }),
      // Policy bullet rows
      ...POLICY_BULLETS.map((b, i) => new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({
              children: [
                run(`${String(i + 1).padStart(2, '0')}.   `, { bold: true, size: 14, color: C_COPPER }),
                run(b.en, { size: 17 }),
              ],
            })],
            width: { size: HALF_W, type: WidthType.DXA },
            margins: { top: 50, bottom: 50, left: 180, right: 100 },
            shading: shading(C_LABEL_BG),
            borders: FORM_BORDER,
            verticalAlign: VerticalAlign.CENTER,
          }),
          new TableCell({
            children: [new Paragraph({
              children: [arRun(b.ar, { size: 16, color: C_MUTED })],
              alignment: AlignmentType.RIGHT,
              bidirectional: true,
            })],
            width: { size: PAGE_W - HALF_W, type: WidthType.DXA },
            margins: { top: 50, bottom: 50, left: 100, right: 180 },
            shading: shading(C_LABEL_BG),
            borders: FORM_BORDER,
            verticalAlign: VerticalAlign.CENTER,
          }),
        ],
      })),
    ],
  });

  // ── SIGNATURES ────────────────────────────────────────────────────────────
  const sigCols = [
    { en: 'EMPLOYEE',  ar: 'الموظف',          name: employee?.name || '',
      footerLeft:  request.requested_at ? `Submitted ${fmtStampCompact(request.requested_at)}` : '',
      footerRight: 'Signature' },
    { en: 'DEPT MGR',  ar: 'مدير القسم',       name: manager?.name || '',
      footerLeft:  request.manager_decided_at ? `Approved ${fmtStampCompact(request.manager_decided_at)}` : '',
      footerRight: 'HQ Stamp' },
    { en: 'ESAU SUP',  ar: 'الموارد البشرية',   name: hrApprover?.name || HR_SIGNATURE.name,
      footerLeft:  request.hr_decided_at ? `Approved ${fmtStampCompact(request.hr_decided_at)}` : '',
      footerRight: 'Signature' },
    { en: 'ESAU MGT',  ar: 'الإدارة',          name: '',
      footerLeft:  '', footerRight: 'HQ Stamp' },
  ];

  // 4 cell widths summing to PAGE_W exactly.
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
        height: { value: 2007, rule: HeightRule.ATLEAST },
        children: sigCols.map((c, i) =>
          sigCombinedBodyCell(c.name, c.footerLeft, c.footerRight, sigWidths[i])),
      }),
    ],
  });

  // ── FOOTER ────────────────────────────────────────────────────────────────
  // Two-column footer:
  //   Left  — generated-on stamp + approver name (italic copper)
  //   Right — QR code + 'Verify online' caption pointing to the public
  //           verification page for this request
  // The QR encodes the verify URL: <origin>/verify/<request_id>. Anyone
  // with the printed letter can scan it to confirm the request is real
  // and current.
  const generatedAt = new Date().toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const verifyUrl = `${VERIFY_BASE_URL}/verify/${request.id}`;
  const qrBytes = await generateQrPng(verifyUrl, 220);

  const footerBlock = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [PAGE_W - 1100, 1100],
    rows: [new TableRow({
      children: [
        // Left — generation stamp + verify URL on one line each
        new TableCell({
          children: [
            new Paragraph({
              children: [
                run(`Generated on ${generatedAt} GMT+3  ·  ${hrApprover?.name || HR_SIGNATURE.name}`,
                    { size: 12, italics: true, color: C_COPPER }),
              ],
              alignment: AlignmentType.LEFT,
              spacing: { before: 60, after: 20 },
            }),
            new Paragraph({
              children: [
                run('Verify online: ', { size: 11, color: C_MUTED }),
                run(verifyUrl, { size: 11, color: C_BRAND }),
              ],
              alignment: AlignmentType.LEFT,
              spacing: { before: 0, after: 0 },
            }),
          ],
          width: { size: PAGE_W - 1100, type: WidthType.DXA },
          borders: NO_BORDER,
          margins: { top: 0, bottom: 0, left: 0, right: 100 },
          verticalAlign: VerticalAlign.CENTER,
        }),
        // Right — QR + caption (compact)
        new TableCell({
          children: qrBytes
            ? [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [new ImageRun({
                    data: qrBytes,
                    transformation: { width: 52, height: 52 },
                    type: 'png',
                  })],
                  spacing: { before: 0, after: 10 },
                }),
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [run('SCAN TO VERIFY', { size: 9, bold: true, color: C_COPPER })],
                  spacing: { before: 0, after: 0 },
                }),
              ]
            : [new Paragraph({ children: [run('', { size: 10 })] })],
          width: { size: 1100, type: WidthType.DXA },
          borders: NO_BORDER,
          margins: { top: 0, bottom: 0, left: 100, right: 0 },
          verticalAlign: VerticalAlign.CENTER,
        }),
      ],
    })],
  });

  // ── DOCUMENT ──────────────────────────────────────────────────────────────
  // ── APPROVED STAMP ───────────────────────────────────────────────────────
  // Small "APPROVED" stamp pinned to top-right corner via section header.
  // Sized to fit within the existing top margin so it does not displace
  // body content. Border + brand colour make it read as an approval
  // mark rather than a giant watermark across the page.
  const approvedStamp = new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({
            text: '✓ APPROVED',
            font: FONT_BRAND,
            size: 24,           // 12pt
            bold: true,
            color: '2D5F3F',    // brand green
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
      footers: { default: new Footer({ children: [footerBlock] }) },
      children: [
        headerRow,
        headerRule,
        headerRuleCopper,
        titleStrip,
        titleStripAr,
        spacer(40),
        sectionBanner('EMPLOYEE INFORMATION', 'معلومات الموظف'),
        empTable,
        spacer(60),
        sectionBanner('PERMISSION DETAILS', 'تفاصيل الاستئذان'),
        detailsTable,
        spacer(60),
        policyTable,
        spacer(40),
        sigTable,
      ],
    }],
  });

  return await Packer.toBlob(doc);
}

// ─── email draft ─────────────────────────────────────────────────────────────
export function resolveExecCcEmails(employees = []) {
  const emails = new Set();
  for (const entry of EXEC_CC) {
    // Direct email always added — bypasses any roster lookup.
    if (entry.email) emails.add(entry.email);

    // Roster fuzzy match as a supplement (covers cases where the
    // person is in the employees table with a different email format,
    // or where additional matches are valid).
    const matches = (employees || []).filter(e => {
      if (!e?.email) return false;
      const nameOK = (e.name || '').toLowerCase().includes(entry.name);
      const deptOK = entry.dept ? (e.department === entry.dept) : true;
      return nameOK && deptOK;
    });
    if (matches.length === 0 && !entry.email) {
      const tag = entry.dept ? `${entry.name} (${entry.dept})` : entry.name;
      console.warn(`[permission letter] No employee matched CC entry "${tag}" with email on file`);
      continue;
    }
    matches.forEach(m => emails.add(m.email));
  }
  return Array.from(emails);
}

export function buildPermissionEmailDraft({ employee, manager, hrApprover, request, employees = [] }) {
  const typeBoth = TYPE[request.type] || TYPE.late_arrival;
  const to       = employee?.email || '';
  const ccRaw    = [manager?.email, ...resolveExecCcEmails(employees)].filter(Boolean);
  const cc = Array.from(new Set(ccRaw.filter(e => e !== to)));

  const firstName = (employee?.name || '').split(' ')[0] || 'Colleague';
  const subject   = `Permission approved · ${typeBoth.en} · ${fmtDateShort(request.permission_date)}`;
  const dur = (() => {
    if (request.time_from && request.time_to) {
      const toMin = (s) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
        return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
      };
      const a = toMin(request.time_from), b = toMin(request.time_to);
      if (!Number.isNaN(a) && !Number.isNaN(b)) return Math.max(0, b - a);
    }
    return Math.round(Number(request.hours || 0) * 60);
  })();
  const win = (request.time_from && request.time_to)
    ? ` (${request.time_from}–${request.time_to}, ${dur} mins)`
    : ` (${dur} mins)`;

  const body = [
    `Dear ${firstName},`,
    ``,
    `Your request for ${typeBoth.en.toLowerCase()} permission on ${fmtDateShort(request.permission_date)}${win} has been approved.`,
    ``,
    `Reason on file: ${request.reason || '—'}`,
    ``,
    `Approval chain:`,
    `  • Submitted: ${fmtDateTime(request.requested_at)}`,
    `  • Manager (${manager?.name || '—'}): ${fmtDateTime(request.manager_decided_at)}`,
    `  • HR (${hrApprover?.name || HR_SIGNATURE.name}): ${fmtDateTime(request.hr_decided_at)}`,
    ``,
    `The signed permission letter is attached for your records, kindly print it and get it signed by your manager and submit hard copy to HR office.`,
    ``,
    `— Company Policy Reminder | تنبيه بسياسة الشركة —`,
    ...POLICY_BULLETS.map(b => `  • ${b.en}`),
    ``,
    `Thanks and regards,`,
    ``,
    HR_SIGNATURE.name,
    HR_SIGNATURE.company,
    HR_SIGNATURE.unit,
    HR_SIGNATURE.address,
    `WhatsApp: ${HR_SIGNATURE.whatsapp}`,
    `Tel: ${HR_SIGNATURE.tel}`,
    `Email: ${HR_SIGNATURE.email}`,
  ].join('\n');

  return {
    to, cc, subject, body,
    mailto: buildMailto({ to, cc, subject, body }),
  };
}

function buildMailto({ to, cc, subject, body }) {
  const params = new URLSearchParams();
  if (cc.length) params.set('cc', cc.join(','));
  params.set('subject', subject);
  params.set('body', body);
  return `mailto:${encodeURIComponent(to)}?${params.toString().replace(/\+/g, '%20')}`;
}

export async function downloadPermissionLetter({ employee, manager, hrApprover, request }) {
  const blob = await generatePermissionLetterBlob({ employee, manager, hrApprover, request });
  const fname = `Permission_${(employee?.name || 'staff').replace(/\s+/g, '_')}_${request.permission_date}.docx`;
  downloadBlob(blob, fname);
}
