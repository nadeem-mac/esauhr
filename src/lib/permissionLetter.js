// Permission letter — bilingual EN / KSA-Arabic A4 form, fits single page.
// Header has the embedded Evergreen Line logo. Title bar puts EN + AR on
// one row to save vertical space. Four signature columns at the bottom
// (Employee · Dept Manager · ESAU SUP · ESAU MGT) each with a 3-region
// layout: top shaded band with role title, middle free space for the
// wet signature, bottom shaded band with timestamp + 'Signature & Date'
// or 'HQ Stamp / Date' as appropriate.
//
// Generated client-side after final HR approval. Footer shows the
// generation timestamp and HR approver name.

import {
  Document, Packer, Paragraph, TextRun, ImageRun,
  Table, TableRow, TableCell,
  AlignmentType, WidthType, BorderStyle, HeightRule,
  VerticalAlign,
} from 'docx';
import { downloadBlob } from './vacationForm.js';

// ─── lookups ──────────────────────────────────────────────────────────────────
const DEPT_NAMES = {
  BIZ: 'Business',
  CSD: 'Customer Service',
  FIN: 'Finance',
  LOG: 'Logistics',
  SUP: 'Support',
  'RYD OFFICE': 'Riyadh Office',
};
const LOCATION_NAMES = { DMM: 'Dammam', JED: 'Jeddah', RYD: 'Riyadh' };
const TYPE = {
  late_arrival: { en: 'Late Arrival',    ar: 'تأخير في الحضور' },
  early_leave:  { en: 'Early Departure', ar: 'انصراف مبكر' },
};

// CC roster for the approval email.
const EXEC_CC = [
  { name: 'john ho' },
  { name: 'james' },
  { name: 'fahad hussain' },
  { name: 'fahad', dept: 'SUP' },
  { name: 'badria' },
  { name: 'jaffar' },
];

// HR signature block — single source of truth for both docx + email.
const HR_SIGNATURE = {
  name:    'BASHAIER ALI',
  company: 'Evergreen Shipping Agency Saudi Co.,(L.L.C)',
  unit:    'ESAU - SADMN SUP/ HR DEPT',
  address: 'P.O.Box : 1008,  DAMMAM – 31431, K.S.A',
  whatsapp:'966-54 320 9694',
  tel:     '966-013 813 8563 – Ext 8543',
  email:   'bashaier.alsubaie@evergreen-shipping.com.sa',
};

// Company policy reminder — verbatim from the existing ESAU paper form.
const POLICY_BULLETS = [
  {
    en: 'Each employee is entitled to a maximum of 3 permissions per calendar month (Late Arrival or Early Departure).',
    ar: 'حسب سياسة الموارد البشرية، يحق لكل موظف 3 استئذانات كحد أقصى في الشهر (تأخير أو انصراف مبكر).',
  },
  {
    en: 'Each individual request must not exceed 60 minutes under any circumstance.',
    ar: 'ولا يُسمح بأن تتجاوز مدة كل استئذان 60 دقيقة تحت أي ظرف.',
  },
  {
    en: 'Exceeding this limit may be subject to review by the HR department.',
    ar: 'تجاوز هذا الحد قد يستوجب المراجعة مع إدارة الموارد البشرية.',
  },
  {
    en: "It is the employee's responsibility to ensure adherence to this policy.",
    ar: 'ويتحمل الموظف مسؤولية الالتزام بهذه السياسة.',
  },
];

// Reason categories on the printed form.
const REASON_CATEGORIES = [
  { id: 'medical',    en: 'Medical',           ar: 'طبي' },
  { id: 'gov_bank',   en: 'Government / Bank', ar: 'جهة حكومية / بنك' },
  { id: 'family',     en: 'Family / Emergency',ar: 'عائلية / طارئة' },
  { id: 'school',     en: 'School / Childcare',ar: 'مدرسة / رعاية أطفال' },
  { id: 'traffic',    en: 'Traffic / Transport',ar: 'مرور / مواصلات' },
  { id: 'other',      en: 'Other',             ar: 'أخرى' },
];

function categoryFor(reason) {
  const r = (reason || '').toLowerCase();
  if (/medical|doctor|clinic|hospital|sick/.test(r))            return 'medical';
  if (/government|iqama|bank|financial|paperwork|official/.test(r)) return 'gov_bank';
  if (/family|emergency|urgent|personal/.test(r))                return 'family';
  if (/school|child|pickup|drop[\s-]?off/.test(r))               return 'school';
  if (/traffic|transport|road|commute/.test(r))                  return 'traffic';
  return 'other';
}

// ─── colour palette ───────────────────────────────────────────────────────────
const C_TEXT     = '1F1B16';
const C_MUTED    = '6B7280';
const C_BORDER   = 'D1D5DB';
const C_BORDER_2 = 'E5E0D5';   // softer border between the sig regions
const C_BANNER   = 'F4EEDF';
const C_LABEL_BG = 'FAFAF7';
const C_BRAND    = '2D5F3F';

// ─── formatters ───────────────────────────────────────────────────────────────
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
// Compact 'D MMM · HH:MM' for the cramped signature footer cells.
const fmtStampCompact = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} · ${time}`;
};

// ─── docx primitives ──────────────────────────────────────────────────────────
const run = (text, opts = {}) => new TextRun({
  text: String(text ?? ''),
  font: opts.font || 'Calibri',
  size: opts.size ?? 20,
  color: opts.color ?? C_TEXT,
  bold: !!opts.bold,
  italics: !!opts.italics,
});
const arRun = (text, opts = {}) => new TextRun({
  text: String(text ?? ''),
  font: { name: 'Arial', cs: 'Arial' },
  size: opts.size ?? 18,
  color: opts.color ?? C_MUTED,
  bold: !!opts.bold,
  rightToLeft: true,
});
const para = (children, opts = {}) => new Paragraph({
  children: Array.isArray(children) ? children : [run(children, opts.run || {})],
  alignment: opts.align || AlignmentType.LEFT,
  spacing: { before: opts.before ?? 0, after: opts.after ?? 60 },
});
const spacer = (after = 100) => new Paragraph({ children: [run('')], spacing: { after } });
const noBorder = () => ({
  top:    { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right:  { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
});
const formBorder = () => ({
  top:    { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
  left:   { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
  right:  { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
});

// Bilingual section banner — EN flush left, AR flush right, shaded.
const sectionBanner = (en, ar) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: [new TableRow({
    children: [
      new TableCell({
        children: [new Paragraph({
          children: [run(en, { bold: true, size: 18 })],
        })],
        width: { size: 60, type: WidthType.PERCENTAGE },
        margins: { top: 60, bottom: 60, left: 140, right: 100 },
        shading: { fill: C_BANNER },
        borders: formBorder(),
      }),
      new TableCell({
        children: [new Paragraph({
          children: [arRun(ar, { bold: true, size: 18, color: C_TEXT })],
          alignment: AlignmentType.RIGHT,
          bidirectional: true,
        })],
        width: { size: 40, type: WidthType.PERCENTAGE },
        margins: { top: 60, bottom: 60, left: 100, right: 140 },
        shading: { fill: C_BANNER },
        borders: formBorder(),
      }),
    ],
  })],
});

// Label cell — EN bold flush left, AR muted flush right, one line.
// Uses a borderless 2-column inner table so the alignment is reliable
// regardless of label length (tab stops in narrow cells were unreliable
// before — same issue as the signature bands).
const labelCell = (en, ar) => {
  const inner = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph({ children: [run(en, { bold: true, size: 16 })] })],
          width: { size: 60, type: WidthType.PERCENTAGE },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          borders: noBorder(),
        }),
        new TableCell({
          children: [new Paragraph({
            children: [arRun(ar, { size: 14, color: C_MUTED })],
            alignment: AlignmentType.RIGHT,
            bidirectional: true,
          })],
          width: { size: 40, type: WidthType.PERCENTAGE },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          borders: noBorder(),
        }),
      ],
    })],
  });
  return new TableCell({
    children: [inner],
    width: { size: 30, type: WidthType.PERCENTAGE },
    margins: { top: 70, bottom: 70, left: 120, right: 120 },
    shading: { fill: C_LABEL_BG },
    borders: formBorder(),
    verticalAlign: VerticalAlign.CENTER,
  });
};

const valueCell = (text, opts = {}) => new TableCell({
  children: [new Paragraph({
    children: [run(text, { size: 22, bold: !!opts.bold, color: opts.color || C_TEXT })],
  })],
  width: { size: 70, type: WidthType.PERCENTAGE },
  margins: { top: 70, bottom: 70, left: 140, right: 120 },
  borders: formBorder(),
  verticalAlign: VerticalAlign.CENTER,
});

const valueCellRuns = (children) => new TableCell({
  children: [new Paragraph({ children })],
  width: { size: 70, type: WidthType.PERCENTAGE },
  margins: { top: 70, bottom: 70, left: 140, right: 120 },
  borders: formBorder(),
  verticalAlign: VerticalAlign.CENTER,
});

const formRow = (en, ar, value, opts = {}) => new TableRow({
  children: [
    labelCell(en, ar),
    typeof value === 'string'
      ? valueCell(value, opts)
      : valueCellRuns(value),
  ],
});

const cbRun = (checked, label, ar) => [
  run(checked ? '☑ ' : '☐ ', { size: 22, bold: true }),
  run(label + (ar ? '  ' : ''), { size: 18 }),
  ...(ar ? [arRun(ar, { size: 16, color: C_MUTED }), run('   ', { size: 18 })] : [run('   ', { size: 18 })]),
];

// ─── logo loader ──────────────────────────────────────────────────────────────
async function loadLogoBytes() {
  try {
    const res = await fetch('/evergreen-logo.jpg');
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

// ─── signature row builders ──────────────────────────────────────────────────
//
// The signature footer is built as ONE outer 3-row × 4-column table:
//   Row 1 (header band)  — 4 cells, shaded, role title EN + AR
//   Row 2 (body)         — 4 cells, name + open signing space
//   Row 3 (footer band)  — 4 cells, shaded, timestamp + label
//
// This maps directly to how Word renders tables — no nested tables, no
// tab-stops drifting against narrow column widths, no row-height
// surprises. The HTML draft has the same structure so docx output and
// preview look the same.
//
// Tab stop position: each column is roughly 25% of usable A4 width
// (11906 - 540*2 margin = 10826 twips; 25% = ~2700 twips; minus internal
// cell margin = ~2200 twips usable). Tab stops live at 2200 so the
// right-aligned text sits at the cell's right edge.

const SIG_TAB = 2200;          // right-tab position for left/right layout in a 25% cell
const SIG_BAND_PAD  = { top: 60,  bottom: 60,  left: 100, right: 100 };
const SIG_BODY_PAD  = { top: 100, bottom: 100, left: 100, right: 100 };

function sigHeaderCell(en, ar) {
  // Same 2-column inner-table approach as sigFooterCell — tab stops
  // were unreliable inside the narrow 25% column, so this guarantees
  // the EN title sits flush left and AR sits flush right.
  const innerLayout = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph({
            children: [run(en, { bold: true, size: 14 })],
            alignment: AlignmentType.LEFT,
          })],
          width:   { size: 55, type: WidthType.PERCENTAGE },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          borders: noBorder(),
        }),
        new TableCell({
          children: [new Paragraph({
            children: [arRun(ar, { size: 14, color: C_MUTED })],
            alignment: AlignmentType.RIGHT,
            bidirectional: true,
          })],
          width:   { size: 45, type: WidthType.PERCENTAGE },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          borders: noBorder(),
        }),
      ],
    })],
  });

  return new TableCell({
    children: [innerLayout],
    width:    { size: 25, type: WidthType.PERCENTAGE },
    margins:  SIG_BAND_PAD,
    shading:  { fill: C_BANNER },
    borders:  formBorder(),
    verticalAlign: VerticalAlign.CENTER,
  });
}

function sigBodyCell(name) {
  return new TableCell({
    children: [
      new Paragraph({
        children: [run(name || '', { size: 16 })],
        spacing: { before: 60, after: 0 },
      }),
    ],
    width:    { size: 25, type: WidthType.PERCENTAGE },
    margins:  SIG_BODY_PAD,
    borders:  formBorder(),
    verticalAlign: VerticalAlign.TOP,
  });
}

function sigFooterCell(leftText, rightLabel) {
  // Left/right layout via a borderless 2-column inner table. This is far
  // more reliable in Word than a tab stop in a narrow cell — tab stops
  // were collapsing here, causing 'Submitted 1 May · 13:48Signature &
  // Date' (concatenated, no separator) in the docx output even though
  // the HTML draft renders correctly with flexbox justify-between.
  const innerLayout = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph({
            children: [run(leftText || '', { size: 13, italics: true, color: C_MUTED })],
            alignment: AlignmentType.LEFT,
          })],
          width:   { size: 60, type: WidthType.PERCENTAGE },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          borders: noBorder(),
        }),
        new TableCell({
          children: [new Paragraph({
            children: [run(rightLabel, { size: 13, bold: true })],
            alignment: AlignmentType.RIGHT,
          })],
          width:   { size: 40, type: WidthType.PERCENTAGE },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          borders: noBorder(),
        }),
      ],
    })],
  });

  return new TableCell({
    children: [innerLayout],
    width:    { size: 25, type: WidthType.PERCENTAGE },
    margins:  SIG_BAND_PAD,
    shading:  { fill: C_BANNER },
    borders:  formBorder(),
    verticalAlign: VerticalAlign.CENTER,
  });
}

// ─── main generator ───────────────────────────────────────────────────────────

export async function generatePermissionLetterBlob({ employee, manager, hrApprover, request }) {
  const typeKey   = TYPE[request.type] ? request.type : 'late_arrival';
  const typeBoth  = TYPE[typeKey];

  const dept      = DEPT_NAMES[employee?.department] || employee?.department || '—';
  const loc       = LOCATION_NAMES[employee?.location] || employee?.location || '—';
  const today     = new Date().toISOString();
  const dur       = (() => {
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
  const cat       = categoryFor(request.reason);
  const submittedSoon = request.requested_at && request.permission_date
    ? (new Date(request.permission_date).getTime() - new Date(request.requested_at).getTime()) >= 24 * 3600 * 1000
    : null;
  const noticePlanned = submittedSoon === true;
  const noticeUrgent  = submittedSoon === false;

  const logoBytes = await loadLogoBytes();

  // ── HEADER ────────────────────────────────────────────────────────────────
  const headerRow = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        new TableCell({
          children: [
            logoBytes
              ? new Paragraph({
                  children: [new ImageRun({
                    data: logoBytes,
                    transformation: { width: 60, height: 60 },
                    type: 'jpg',
                  })],
                })
              : new Paragraph({ children: [run('EVERGREEN', { bold: true, size: 24, color: C_BRAND })] }),
          ],
          width: { size: 18, type: WidthType.PERCENTAGE },
          borders: noBorder(),
          margins: { top: 0, bottom: 0, left: 0, right: 80 },
        }),
        new TableCell({
          children: [
            new Paragraph({ children: [run('EVERGREEN LINE', { bold: true, size: 30, color: C_BRAND })] }),
            new Paragraph({
              children: [run(`${HR_SIGNATURE.company}  ·  ${HR_SIGNATURE.unit}  ·  Dammam, K.S.A`, { size: 14, color: C_MUTED })],
              spacing: { before: 30 },
            }),
          ],
          width: { size: 82, type: WidthType.PERCENTAGE },
          borders: noBorder(),
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          verticalAlign: VerticalAlign.CENTER,
        }),
      ],
    })],
  });

  const divider = new Paragraph({
    children: [run('')],
    border: { bottom: { color: C_BRAND, space: 4, style: BorderStyle.SINGLE, size: 12 } },
    spacing: { before: 60, after: 120 },
  });

  // ── TITLE BAR — EN + AR on one row, Date/Ref right-aligned ────────────────
  // Sized to keep both EN + AR on a single line in the title cell, with
  // Date / Ref pushed to a smaller right column. The previous version
  // wrapped because EN at 22pt + the AR phrase exceeded the 65% column
  // width.
  const titleEnMain = `PERMISSION REQUEST — ${typeBoth.en.toUpperCase()}`;
  const titleArMain = `طلب استئذان — ${typeBoth.ar}`;

  const titleBar = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        new TableCell({
          children: [
            new Paragraph({
              children: [
                run(titleEnMain, { bold: true, size: 22 }),
              ],
            }),
            new Paragraph({
              children: [
                arRun(titleArMain, { size: 18, color: C_BRAND, bold: true }),
              ],
              spacing: { before: 30 },
            }),
          ],
          width: { size: 70, type: WidthType.PERCENTAGE },
          borders: noBorder(),
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          verticalAlign: VerticalAlign.CENTER,
        }),
        new TableCell({
          children: [
            new Paragraph({
              children: [
                run('Date: ',  { bold: true, color: C_MUTED, size: 16 }),
                run(fmtDateMed(today), { size: 16 }),
                run('   \u00B7   ', { color: C_MUTED, size: 16 }),
                run('Ref: ',   { bold: true, color: C_MUTED, size: 16 }),
                run(`PR-${String(request.id).padStart(5, '0')}`, { bold: true, size: 16 }),
              ],
              alignment: AlignmentType.RIGHT,
            }),
          ],
          width: { size: 30, type: WidthType.PERCENTAGE },
          borders: noBorder(),
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          verticalAlign: VerticalAlign.CENTER,
        }),
      ],
    })],
  });

  // ── EMPLOYEE INFORMATION ──────────────────────────────────────────────────
  const empTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      formRow('Employee name',    'اسم الموظف',     employee?.name || '—', { bold: true }),
      formRow('Employee PSN ID',  'الرقم الوظيفي',   employee?.id || '—'),
      formRow('Department',       'القسم',           `${dept}  ·  ${loc}`),
      formRow('Application date', 'تاريخ التقديم',   fmtDateMed(today)),
    ],
  });

  // ── PERMISSION DETAILS ────────────────────────────────────────────────────
  const typeChecks = [
    ...cbRun(typeKey === 'late_arrival', 'Late Arrival', 'تأخير في الحضور'),
    run('   ', { size: 18 }),
    ...cbRun(typeKey === 'early_leave',  'Early Departure', 'انصراف مبكر'),
  ];

  const noticeChecks = [
    ...cbRun(noticePlanned, 'Planned (≥24h)', 'مُخطط مسبقًا'),
    run('   ', { size: 18 }),
    ...cbRun(noticeUrgent,  'Urgent (<24h)',  'طارئ'),
  ];

  const reasonChecks = REASON_CATEGORIES.map((c, i) => [
    ...cbRun(cat === c.id, c.en, c.ar),
    ...(i < REASON_CATEGORIES.length - 1 ? [run('  ', { size: 18 })] : []),
  ]).flat();

  const timeText = (request.time_from && request.time_to)
    ? `${request.time_from}  →  ${request.time_to}   ·   Duration: ${dur} mins`
    : `Duration: ${dur} mins`;

  const summaryHours = Number(request.hours || 0);
  const usageText = `${summaryHours} hour${summaryHours === 1 ? '' : 's'} of 3 allowed   ·   ${request.exceeds_quota ? 'Quota exceeded' : 'Within monthly quota'}`;

  const detailsTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      formRow('Type of permission', 'نوع الاستئذان',  typeChecks),
      formRow('Permission date',    'تاريخ الاستئذان', fmtDateLong(request.permission_date), { bold: true }),
      formRow('Time',               'الوقت',           timeText),
      formRow('This month usage',   'الاستخدام الشهري', usageText),
      formRow('Notice',             'نوع الإشعار',     noticeChecks),
      formRow('Reason category',    'فئة السبب',       reasonChecks),
      formRow('Reason details',     'تفاصيل السبب',    request.reason || '—'),
    ],
  });

  // ── COMPANY POLICY REMINDER ───────────────────────────────────────────────
  const policyTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: POLICY_BULLETS.map(b => new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph({
            children: [run('•  ', { bold: true, size: 16 }), run(b.en, { size: 16 })],
          })],
          width: { size: 50, type: WidthType.PERCENTAGE },
          margins: { top: 60, bottom: 60, left: 140, right: 100 },
          borders: formBorder(),
        }),
        new TableCell({
          children: [new Paragraph({
            children: [arRun(b.ar + '  •', { size: 16, color: C_TEXT })],
            alignment: AlignmentType.RIGHT,
            bidirectional: true,
          })],
          width: { size: 50, type: WidthType.PERCENTAGE },
          margins: { top: 60, bottom: 60, left: 100, right: 140 },
          borders: formBorder(),
        }),
      ],
    })),
  });

  // ── SIGNATURES ────────────────────────────────────────────────────────────
  // 4-column × 3-row signature table. Header band on top (shaded), open
  // signing space in the middle, footer band on bottom (shaded). Each
  // band is a real table row of 4 cells — Word renders this exactly as
  // designed, no nested-table surprises.
  const sigCols = [
    {
      en: 'EMPLOYEE',     ar: 'الموظف',
      name: employee?.name || '',
      footerLeft:  request.requested_at ? `Submitted ${fmtStampCompact(request.requested_at)}` : '',
      footerRight: 'Signature & Date',
    },
    {
      en: 'DEPT MANAGER', ar: 'مدير القسم',
      name: manager?.name || '',
      footerLeft:  request.manager_decided_at ? `Approved ${fmtStampCompact(request.manager_decided_at)}` : '',
      footerRight: 'HQ Stamp / Date',
    },
    {
      en: 'ESAU SUP',     ar: 'إدارة الموارد البشرية',
      name: hrApprover?.name || HR_SIGNATURE.name,
      footerLeft:  request.hr_decided_at ? `Approved ${fmtStampCompact(request.hr_decided_at)}` : '',
      footerRight: 'Signature & Date',
    },
    {
      en: 'ESAU MGT',     ar: 'الإدارة',
      name: '',
      footerLeft:  '',
      footerRight: 'HQ Stamp / Date',
    },
  ];

  const sigTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      // Header band — single shaded row of role titles.
      new TableRow({
        children: sigCols.map(c => sigHeaderCell(c.en, c.ar)),
      }),
      // Body — open signing area. HeightRule.ATLEAST 2400 (~120pt /
      // ~4.2cm) gives a generous wet-signature area that uses the empty
      // A4 space below — the previous 1400 left a lot of unused page.
      new TableRow({
        height: { value: 2400, rule: HeightRule.ATLEAST },
        children: sigCols.map(c => sigBodyCell(c.name)),
      }),
      // Footer band — single shaded row with timestamp + role label.
      new TableRow({
        children: sigCols.map(c => sigFooterCell(c.footerLeft, c.footerRight)),
      }),
    ],
  });

  // ── FOOTER ────────────────────────────────────────────────────────────────
  // Generation timestamp + generated-by. Right-aligned muted italic.
  const generatedAt = new Date().toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const footer = [
    spacer(80),
    para(
      `Generated on ${generatedAt} GMT+3  by  ${hrApprover?.name || HR_SIGNATURE.name}`,
      { run: { size: 12, italics: true, color: C_MUTED }, align: AlignmentType.RIGHT },
    ),
  ];

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri' } } } },
    sections: [{
      properties: {
        page: {
          size:    { width: 11906, height: 16838 }, // A4
          // Tight margins so we always fit single page even with the
          // 4-column signature footer.
          margin:  { top: 540, right: 540, bottom: 540, left: 540 },
        },
      },
      children: [
        headerRow,
        divider,
        titleBar,
        spacer(120),
        sectionBanner('Employee Information', 'معلومات الموظف'),
        empTable,
        spacer(80),
        sectionBanner('Permission Details', 'تفاصيل الاستئذان'),
        detailsTable,
        spacer(80),
        sectionBanner('Company Policy Reminder', 'تنبيه بسياسة الشركة'),
        policyTable,
        spacer(120),
        sigTable,
        ...footer,
      ],
    }],
  });

  return await Packer.toBlob(doc);
}

// ─── email draft ──────────────────────────────────────────────────────────────

export function resolveExecCcEmails(employees = []) {
  const emails = new Set();
  for (const entry of EXEC_CC) {
    const matches = (employees || []).filter(e => {
      if (!e?.email) return false;
      const nameOK = (e.name || '').toLowerCase().includes(entry.name);
      const deptOK = entry.dept ? (e.department === entry.dept) : true;
      return nameOK && deptOK;
    });
    if (matches.length === 0) {
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
  const ccRaw    = [
    manager?.email,
    ...resolveExecCcEmails(employees),
  ].filter(Boolean);
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
    to,
    cc,
    subject,
    body,
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

// ─── one-shot helper ──────────────────────────────────────────────────────────

export async function downloadPermissionLetter({ employee, manager, hrApprover, request }) {
  const blob = await generatePermissionLetterBlob({ employee, manager, hrApprover, request });
  const fname = `Permission_${(employee?.name || 'staff').replace(/\s+/g, '_')}_${request.permission_date}.docx`;
  downloadBlob(blob, fname);
}
