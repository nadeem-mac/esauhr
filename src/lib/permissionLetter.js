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
    en: 'Any employee exceeding this limit may face disciplinary action.',
    ar: 'أي موظف يتجاوز هذا الحد قد يتعرض لإجراء تأديبي.',
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
  ...(opts.spacing != null ? { characterSpacing: opts.spacing } : {}),
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
          children: [run(en, { bold: true, size: 18, spacing: 60 })],
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

const labelCell = (en, ar) => new TableCell({
  children: [
    new Paragraph({
      children: [run(en, { bold: true, size: 16, spacing: 30 })],
    }),
    new Paragraph({
      children: [arRun(ar, { size: 14, color: C_MUTED })],
      alignment: AlignmentType.RIGHT,
      bidirectional: true,
    }),
  ],
  width: { size: 32, type: WidthType.PERCENTAGE },
  margins: { top: 80, bottom: 80, left: 140, right: 100 },
  shading: { fill: C_LABEL_BG },
  borders: formBorder(),
});

const valueCell = (text, opts = {}) => new TableCell({
  children: [new Paragraph({
    children: [run(text, { size: 20, bold: !!opts.bold, color: opts.color || C_TEXT })],
  })],
  width: { size: 68, type: WidthType.PERCENTAGE },
  margins: { top: 80, bottom: 80, left: 140, right: 100 },
  borders: formBorder(),
});

const valueCellRuns = (children) => new TableCell({
  children: [new Paragraph({ children })],
  width: { size: 68, type: WidthType.PERCENTAGE },
  margins: { top: 80, bottom: 80, left: 140, right: 100 },
  borders: formBorder(),
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

// ─── signature cell ───────────────────────────────────────────────────────────
//
// Builds a 3-row nested table inside one outer cell so we get the
// banner/free-space/banner layout. Outer cell has the form border; the
// inner rows get only top/bottom horizontal rules between sections (no
// double-border doubling on the outer edges).
function signatureColumn({ titleEn, titleAr, name, footerLeft, footerRight }) {
  const innerRow = (children, fill) => new TableRow({
    children: [new TableCell({
      children,
      shading: fill ? { fill } : undefined,
      margins: { top: 40, bottom: 40, left: 120, right: 120 },
      borders: noBorder(),
    })],
  });

  const headerRow = innerRow([
    new Paragraph({
      tabStops: [{ type: 'right', position: 9000 }],
      children: [
        run(titleEn.toUpperCase(), { bold: true, size: 14, spacing: 40 }),
        run('\t', {}),
        arRun(titleAr, { size: 14, color: C_MUTED }),
      ],
    }),
  ], C_BANNER);

  // Middle band — name + open vertical space for the wet signature.
  // We use a paragraph with `before:120` to push it down and create
  // breathing room above where the wet signature lands.
  const bodyRow = innerRow([
    new Paragraph({
      children: [run(name || '', { size: 16 })],
      spacing: { before: 60, after: 240 },
    }),
  ]);

  // Footer band — left-aligned timestamp with right-aligned label, on
  // the same line via a tab stop. White-space stays on one line because
  // we use compact formatters (e.g. '1 May · 12:43').
  const footerRow = innerRow([
    new Paragraph({
      tabStops: [{ type: 'right', position: 9000 }],
      children: [
        run(footerLeft || '', { size: 13, italics: true, color: C_MUTED }),
        run('\t', {}),
        run(footerRight, { size: 13, bold: true, spacing: 30 }),
      ],
    }),
  ], C_BANNER);

  // Wrap the three rows in a borderless inner table; the outer TableCell
  // (created by the caller) provides the 4-col layout border.
  const inner = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, bodyRow, footerRow],
    borders: {
      top:    { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      left:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      right:  { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 3, color: C_BORDER_2 },
      insideVertical:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    },
  });

  return new TableCell({
    children: [inner],
    width: { size: 25, type: WidthType.PERCENTAGE },
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    borders: formBorder(),
    verticalAlign: VerticalAlign.TOP,
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
            new Paragraph({ children: [run('EVERGREEN LINE', { bold: true, size: 30, color: C_BRAND, spacing: 60 })] }),
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
  const titleBar = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        new TableCell({
          children: [
            new Paragraph({
              tabStops: [{ type: 'left', position: 4500 }],
              children: [
                run('PERMISSION REQUEST FORM', { bold: true, size: 22, spacing: 60 }),
                run('\t', {}),
                arRun('نموذج طلب استئذان', { size: 22, color: C_BRAND, bold: true }),
              ],
            }),
          ],
          width: { size: 65, type: WidthType.PERCENTAGE },
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
                run('   ·   ', { color: C_MUTED, size: 16 }),
                run('Ref: ',   { bold: true, color: C_MUTED, size: 16 }),
                run(`PR-${String(request.id).padStart(5, '0')}`, { bold: true, size: 16 }),
              ],
              alignment: AlignmentType.RIGHT,
            }),
          ],
          width: { size: 35, type: WidthType.PERCENTAGE },
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
    ? `From  ${request.time_from}    →    To  ${request.time_to}        Duration:  ${dur} mins  (≤ 60)`
    : `Duration:  ${dur} mins                                             Time window not recorded`;

  const summaryHours = Number(request.hours || 0);
  const usageText = `${summaryHours} hour${summaryHours === 1 ? '' : 's'} of 3 hours allowed  ·  this is occurrence ${request.exceeds_quota ? '4+' : 'within bucket'}`;

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
  // 4-column signature table. Each column built via signatureColumn() which
  // produces a 3-region inner stack: header band, free signature space,
  // footer band with timestamp + label.
  const sigTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      // Force a comfortable signing area height (~80pt). HeightRule.AT_LEAST
      // lets the row grow if a name wraps; in practice all four labels are
      // short enough that this is the floor, not the ceiling.
      height: { value: 1600, rule: HeightRule.ATLEAST },
      children: [
        signatureColumn({
          titleEn: 'EMPLOYEE',
          titleAr: 'الموظف',
          name: employee?.name || '',
          footerLeft: request.requested_at ? `Submitted ${fmtStampCompact(request.requested_at)}` : '',
          footerRight: 'Signature & Date',
        }),
        signatureColumn({
          titleEn: 'DEPT MANAGER',
          titleAr: 'مدير القسم',
          name: manager?.name || '',
          footerLeft: request.manager_decided_at ? `Approved ${fmtStampCompact(request.manager_decided_at)}` : '',
          footerRight: 'HQ Stamp / Date',
        }),
        signatureColumn({
          titleEn: 'ESAU SUP',
          titleAr: 'إدارة الموارد البشرية',
          name: hrApprover?.name || HR_SIGNATURE.name,
          footerLeft: request.hr_decided_at ? `Approved ${fmtStampCompact(request.hr_decided_at)}` : '',
          footerRight: 'Signature & Date',
        }),
        signatureColumn({
          titleEn: 'ESAU MGT',
          titleAr: 'الإدارة',
          name: '',
          footerLeft: '',
          footerRight: 'HQ Stamp / Date',
        }),
      ],
    })],
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
