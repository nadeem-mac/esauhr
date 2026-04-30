// Permission letter — bilingual EN / KSA-Arabic A4 form that mirrors the
// company's standard ESAU permission request form. Generated client-side
// after final HR approval. Embeds the Evergreen Line logo, includes the
// 4-point company policy reminder verbatim from the existing paper form,
// and auto-ticks the appropriate reason category based on the dropdown
// value the staff member selected at submission.
//
// The Arabic strings here are KSA HR style — the policy section is the
// exact wording from the existing ESAU paper form, the field labels are
// the standard formal-register equivalents.

import {
  Document, Packer, Paragraph, TextRun, ImageRun,
  Table, TableRow, TableCell,
  AlignmentType, WidthType, BorderStyle,
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

// CC roster for the approval email — see resolveExecCcEmails below.
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
// EN/AR pairs render side-by-side. The Arabic text is the official wording
// already approved by ESAU HR; do not paraphrase.
const POLICY_BULLETS = [
  {
    en: 'As per Evergreen Line HR Policy, each employee is entitled to a maximum of 3 permissions (Late Arrival or Early Departure) per calendar month.',
    ar: 'حسب سياسة الموارد البشرية في شركة إيفرغرين لاين، يحق لكل موظف الحصول على 3 استئذانات كحد أقصى في الشهر (تأخير أو انصراف مبكر).',
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

// Reason categories on the printed form (matches ESAU paper template).
// Each entry: id used for matching, EN + AR labels rendered as the
// checkbox row.
const REASON_CATEGORIES = [
  { id: 'medical',    en: 'Medical',           ar: 'طبي' },
  { id: 'gov_bank',   en: 'Government / Bank', ar: 'جهة حكومية / بنك' },
  { id: 'family',     en: 'Family / Emergency',ar: 'عائلية / طارئة' },
  { id: 'school',     en: 'School / Childcare',ar: 'مدرسة / رعاية أطفال' },
  { id: 'traffic',    en: 'Traffic / Transport',ar: 'مرور / مواصلات' },
  { id: 'other',      en: 'Other',             ar: 'أخرى' },
];

// Map the dropdown reason string → category id. Falls through to 'other'
// if nothing matches. Lowercased substring match keeps the mapping
// resilient to small wording changes.
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
const C_BANNER   = 'F4EEDF';
const C_LABEL_BG = 'FAFAF7';
const C_BRAND    = '2D5F3F';   // Evergreen green

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
const fmtJoinDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
};
const durationMins = (request) => {
  if (request.time_from && request.time_to) {
    const toMin = (s) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
      return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
    };
    const a = toMin(request.time_from), b = toMin(request.time_to);
    if (!Number.isNaN(a) && !Number.isNaN(b)) return Math.max(0, b - a);
  }
  return Math.round(Number(request.hours || 0) * 60);
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
  ...(opts.rtl ? { rightToLeft: true } : {}),
});
// Arabic run — Arial complex-script font set explicitly so Word/LibreOffice
// don't substitute random Arabic glyphs. Same pattern as vacationForm.js.
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
  ...(opts.rtl ? { bidirectional: true } : {}),
});
const arPara = (text, opts = {}) => new Paragraph({
  children: [arRun(text, opts.run || {})],
  alignment: opts.align || AlignmentType.RIGHT,
  bidirectional: true,
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
        margins: { top: 80, bottom: 80, left: 160, right: 100 },
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
        margins: { top: 80, bottom: 80, left: 100, right: 160 },
        shading: { fill: C_BANNER },
        borders: formBorder(),
      }),
    ],
  })],
});

// Bilingual label cell — EN line + AR line stacked. Used for left column
// of every form row so each label is understandable in both languages.
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
  margins: { top: 100, bottom: 100, left: 160, right: 100 },
  shading: { fill: C_LABEL_BG },
  borders: formBorder(),
});

// Plain value cell with a single TextRun.
const valueCell = (text, opts = {}) => new TableCell({
  children: [new Paragraph({
    children: [run(text, { size: 20, bold: !!opts.bold, color: opts.color || C_TEXT })],
  })],
  width: { size: 68, type: WidthType.PERCENTAGE },
  margins: { top: 100, bottom: 100, left: 160, right: 100 },
  borders: formBorder(),
});

// Mixed value cell — multiple runs in one paragraph (e.g. checkboxes).
const valueCellRuns = (children) => new TableCell({
  children: [new Paragraph({ children })],
  width: { size: 68, type: WidthType.PERCENTAGE },
  margins: { top: 100, bottom: 100, left: 160, right: 100 },
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

// Checkbox glyph — ☑ checked / ☐ unchecked. Calibri renders both at
// expected widths; tested in Word, LibreOffice, Pages.
const cbRun = (checked, label, ar) => [
  run(checked ? '☑ ' : '☐ ', { size: 22, bold: true }),
  run(label + (ar ? '  ' : ''), { size: 18 }),
  ...(ar ? [arRun(ar, { size: 16, color: C_MUTED }), run('   ', { size: 18 })] : [run('   ', { size: 18 })]),
];

// ─── logo loader ──────────────────────────────────────────────────────────────

// Fetches the public logo and returns an ArrayBuffer for ImageRun. Returns
// null on failure (e.g. dev server not serving public/, network blocked) so
// the docx still generates without the logo rather than failing the whole
// download.
async function loadLogoBytes() {
  try {
    const res = await fetch('/evergreen-logo.jpg');
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

// ─── main generator ───────────────────────────────────────────────────────────

export async function generatePermissionLetterBlob({ employee, manager, hrApprover, request }) {
  const typeKey   = TYPE[request.type] ? request.type : 'late_arrival';
  const typeBoth  = TYPE[typeKey];
  const otherKey  = typeKey === 'late_arrival' ? 'early_leave' : 'late_arrival';
  const otherBoth = TYPE[otherKey];

  const dept      = DEPT_NAMES[employee?.department] || employee?.department || '—';
  const loc       = LOCATION_NAMES[employee?.location] || employee?.location || '—';
  const today     = new Date().toISOString();
  const dur       = durationMins(request);
  const cat       = categoryFor(request.reason);
  const submittedSoon = request.requested_at && request.permission_date
    ? (new Date(request.permission_date).getTime() - new Date(request.requested_at).getTime()) >= 24 * 3600 * 1000
    : null; // null = unknown
  const noticePlanned = submittedSoon === true;
  const noticeUrgent  = submittedSoon === false;

  const logoBytes = await loadLogoBytes();

  // ── HEADER ────────────────────────────────────────────────────────────────
  // Logo (left) + brand text (right). 2-col borderless table so the image
  // and text sit on the same baseline.
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
                    transformation: { width: 70, height: 70 },
                    type: 'jpg',
                  })],
                })
              : new Paragraph({ children: [run('EVERGREEN', { bold: true, size: 24, color: C_BRAND })] }),
          ],
          width: { size: 22, type: WidthType.PERCENTAGE },
          borders: noBorder(),
          margins: { top: 0, bottom: 0, left: 0, right: 100 },
        }),
        new TableCell({
          children: [
            new Paragraph({ children: [run('EVERGREEN LINE', { bold: true, size: 30, color: C_BRAND, spacing: 60 })] }),
            new Paragraph({
              children: [run(HR_SIGNATURE.company, { size: 18, color: C_MUTED })],
              spacing: { before: 40 },
            }),
            new Paragraph({
              children: [run(`${HR_SIGNATURE.unit}  ·  Dammam, K.S.A`, { size: 16, color: C_MUTED })],
            }),
          ],
          width: { size: 78, type: WidthType.PERCENTAGE },
          borders: noBorder(),
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
        }),
      ],
    })],
  });

  // Green divider rule under the header
  const divider = new Paragraph({
    children: [run('')],
    border: { bottom: { color: C_BRAND, space: 4, style: BorderStyle.SINGLE, size: 12 } },
    spacing: { before: 80, after: 160 },
  });

  // ── TITLE BAR ─────────────────────────────────────────────────────────────
  // PERMISSION REQUEST FORM (EN) + نموذج طلب استئذان (AR) on the left,
  // Date / Ref top-right.
  const titleBar = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        new TableCell({
          children: [
            new Paragraph({
              children: [run('PERMISSION REQUEST FORM', { bold: true, size: 26, spacing: 60 })],
            }),
            new Paragraph({
              children: [arRun('نموذج طلب استئذان', { bold: true, size: 22, color: C_BRAND })],
              alignment: AlignmentType.LEFT,
              bidirectional: true,
              spacing: { before: 40 },
            }),
          ],
          width: { size: 65, type: WidthType.PERCENTAGE },
          borders: noBorder(),
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
        }),
        new TableCell({
          children: [
            new Paragraph({
              children: [run('Date:  ', { bold: true, color: C_MUTED, size: 18 }), run(fmtDateMed(today), { size: 18 })],
              alignment: AlignmentType.RIGHT,
            }),
            new Paragraph({
              children: [run('Ref:  ', { bold: true, color: C_MUTED, size: 18 }), run(`PR-${String(request.id).padStart(5, '0')}`, { bold: true, size: 18 })],
              alignment: AlignmentType.RIGHT,
              spacing: { before: 40 },
            }),
          ],
          width: { size: 35, type: WidthType.PERCENTAGE },
          borders: noBorder(),
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
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
  // Type-of-permission row uses checkbox runs.
  const typeChecks = [
    ...cbRun(typeKey === 'late_arrival',  typeBoth.en === 'Late Arrival' ? typeBoth.en : 'Late Arrival',
                                          typeKey === 'late_arrival' ? typeBoth.ar : 'تأخير في الحضور'),
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
  // 2-col bilingual table: each bullet has its EN cell on the left and AR
  // cell on the right, RTL-aligned. Verbatim from the existing ESAU paper
  // form.
  const policyTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: POLICY_BULLETS.map(b => new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph({
            children: [run('•  ', { bold: true, size: 18 }), run(b.en, { size: 18 })],
          })],
          width: { size: 50, type: WidthType.PERCENTAGE },
          margins: { top: 80, bottom: 80, left: 160, right: 100 },
          borders: formBorder(),
        }),
        new TableCell({
          children: [new Paragraph({
            children: [arRun(b.ar + '  •', { size: 18, color: C_TEXT })],
            alignment: AlignmentType.RIGHT,
            bidirectional: true,
          })],
          width: { size: 50, type: WidthType.PERCENTAGE },
          margins: { top: 80, bottom: 80, left: 100, right: 160 },
          borders: formBorder(),
        }),
      ],
    })),
  });

  // ── SIGNATURES ────────────────────────────────────────────────────────────
  const sigCell = (titleEn, titleAr, name, when) => new TableCell({
    children: [
      new Paragraph({
        children: [run(titleEn.toUpperCase(), { bold: true, size: 14, spacing: 60 })],
      }),
      new Paragraph({
        children: [arRun(titleAr, { size: 12, color: C_MUTED })],
        alignment: AlignmentType.RIGHT,
        bidirectional: true,
        spacing: { before: 20 },
      }),
      new Paragraph({
        children: [run(name || '—', { size: 18 })],
        spacing: { before: 80 },
      }),
      ...(when ? [new Paragraph({
        children: [run(when, { size: 12, italics: true, color: C_MUTED })],
        spacing: { before: 20 },
      })] : []),
      new Paragraph({
        children: [run('________________________', { color: C_MUTED, size: 18 })],
        spacing: { before: 240 },
      }),
      new Paragraph({
        children: [run('Signature & date', { italics: true, color: C_MUTED, size: 12 })],
      }),
    ],
    margins: { top: 140, bottom: 140, left: 140, right: 140 },
    borders: formBorder(),
  });
  const sigStrip = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        sigCell('Employee', 'الموظف', employee?.name, ''),
        sigCell('Department manager', 'مدير القسم', manager?.name,
                request.manager_decided_at ? `Approved ${fmtDateTime(request.manager_decided_at)}` : ''),
        sigCell('ESAU management (HR)', 'إدارة الموارد البشرية', hrApprover?.name || HR_SIGNATURE.name,
                request.hr_decided_at ? `Approved ${fmtDateTime(request.hr_decided_at)}` : ''),
      ],
    })],
  });

  // ── FOOTER ────────────────────────────────────────────────────────────────
  const footer = [
    spacer(160),
    para(
      `Generated by Leave Desk · ESAU SADMN SUP / HR DEPT · Ref PR-${String(request.id).padStart(5, '0')}  ·  Page 1 of 1`,
      { run: { size: 12, italics: true, color: C_MUTED }, align: AlignmentType.CENTER },
    ),
  ];

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri' } } } },
    sections: [{
      properties: {
        page: {
          size:    { width: 11906, height: 16838 }, // A4
          margin:  { top: 720, right: 720, bottom: 720, left: 720 },
        },
      },
      children: [
        headerRow,
        divider,
        titleBar,
        spacer(160),
        sectionBanner('Employee Information', 'معلومات الموظف'),
        empTable,
        spacer(120),
        sectionBanner('Permission Details', 'تفاصيل الاستئذان'),
        detailsTable,
        spacer(120),
        sectionBanner('Company Policy Reminder', 'تنبيه بسياسة الشركة'),
        policyTable,
        spacer(160),
        sigStrip,
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
  const dur       = durationMins(request);
  const window    = (request.time_from && request.time_to)
    ? ` (${request.time_from}–${request.time_to}, ${dur} mins)`
    : ` (${dur} mins)`;

  const body = [
    `Dear ${firstName},`,
    ``,
    `Your request for ${typeBoth.en.toLowerCase()} permission on ${fmtDateShort(request.permission_date)}${window} has been approved.`,
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
