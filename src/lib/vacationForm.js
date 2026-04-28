// Generates the bilingual EN/AR Vacation Form as a single-page A4 .docx Blob,
// plus the matching approval email draft. Uses the 'docx' npm library.
// Layout is compressed to fit on ONE A4 page when printed.

import {
  Document, Packer, Paragraph, TextRun,
  Table, TableRow, TableCell,
  AlignmentType, WidthType, BorderStyle, HeightRule,
} from 'docx';

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
const LEAVE_TYPE_NAMES = {
  annual:      'Annual Leave',
  sick:        'Sick Leave',
  emergency:   'Emergency Leave',
  hajj:        'Hajj Leave',
  maternity:   'Maternity Leave',
  paternity:   'Paternity Leave',
  marriage:    'Marriage Leave',
  bereavement: 'Bereavement Leave',
  iddah:       'Iddah Leave',
  unpaid:      'Unpaid Leave',
  other:       'Other',
};

// ─── colour palette ───────────────────────────────────────────────────────────
const C_DARK   = '2D5F3F';
const C_TEXT   = '1F2937';
const C_MUTED  = '6B7280';
const C_BORDER = 'D1D5DB';
const C_ACCENT = '15803D';
const C_BG     = 'F8F8F2';

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const yearsOfService = (joinDate) => {
  if (!joinDate) return '';
  const join = new Date(joinDate);
  const now = new Date();
  let y = now.getFullYear() - join.getFullYear();
  let m = now.getMonth() - join.getMonth();
  if (m < 0) { y--; m += 12; }
  return `${y} year${y === 1 ? '' : 's'} ${m} month${m === 1 ? '' : 's'}`;
};

// Cell border styles
const thinAll = (color = C_BORDER) => ({
  top:    { style: BorderStyle.SINGLE, size: 4, color },
  bottom: { style: BorderStyle.SINGLE, size: 4, color },
  left:   { style: BorderStyle.SINGLE, size: 4, color },
  right:  { style: BorderStyle.SINGLE, size: 4, color },
});
const noBorders = {
  top:    { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right:  { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
};

// Compact label cell for the info tables (key/value pairs)
const lbl = (en, ar) => new TableCell({
  width: { size: 18, type: WidthType.PERCENTAGE },
  borders: thinAll(),
  margins: { top: 40, bottom: 40, left: 80, right: 80 },
  children: [new Paragraph({
    spacing: { before: 0, after: 0 },
    children: [
      new TextRun({ text: en, bold: true, color: C_DARK, size: 16 }),
      new TextRun({ text: '  ' + ar, color: C_DARK, size: 14, rightToLeft: true }),
    ],
  })],
});

const val = (text) => new TableCell({
  width: { size: 32, type: WidthType.PERCENTAGE },
  borders: thinAll(),
  margins: { top: 40, bottom: 40, left: 80, right: 80 },
  children: [new Paragraph({
    spacing: { before: 0, after: 0 },
    children: [new TextRun({
      text: String(text == null || text === '' ? '—' : text),
      size: 18, color: C_TEXT,
    })],
  })],
});

// Tight section heading (single bottom rule, minimal spacing)
const hd = (en, ar) => new Paragraph({
  spacing: { before: 140, after: 60 },
  border: { bottom: { color: C_DARK, space: 1, style: BorderStyle.SINGLE, size: 6 } },
  children: [
    new TextRun({ text: en, bold: true, color: C_DARK, size: 18 }),
    new TextRun({ text: '   ', size: 14 }),
    new TextRun({ text: ar, color: C_DARK, size: 16, rightToLeft: true }),
  ],
});

// ─── main API ─────────────────────────────────────────────────────────────────
export async function generateVacationFormBlob({ employee, request, manager, hrApprover, substitutes = [] }) {
  const today = new Date().toISOString().split('T')[0];
  const refNum = `LEAVE-${today}-${employee.id}`;
  const dept = DEPT_NAMES[employee.department] || employee.department || '';
  const loc  = LOCATION_NAMES[employee.location]  || employee.location  || '';
  const leaveTypeLabel = LEAVE_TYPE_NAMES[request.leave_type_id] || request.leave_type_id || 'Annual Leave';
  const designation = employee.designation || 'Department Member';
  const daysLabel = `${request.days} day${request.days === 1 ? '' : 's'}${request.is_half_day ? ' (half day)' : ''}`;

  // ── Letterhead — 2 lines ──
  const letterhead = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 40 },
      children: [
        new TextRun({ text: 'EVERGREEN SHIPPING AGENCY SAUDI', bold: true, size: 24, color: C_DARK }),
        new TextRun({ text: '   ', size: 18 }),
        new TextRun({ text: 'وكالة إيفرغرين للملاحة السعودية', size: 18, color: C_DARK, rightToLeft: true }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 100 },
      children: [
        new TextRun({ text: 'EMPLOYEE LEAVE APPLICATION', bold: true, size: 22, color: C_TEXT }),
        new TextRun({ text: '   ', size: 18 }),
        new TextRun({ text: 'طلب إجازة موظف', bold: true, size: 18, color: C_TEXT, rightToLeft: true }),
      ],
    }),
  ];

  // ── Date / Reference row (no borders, single line) ──
  const dateRefRow = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        new TableCell({
          borders: noBorders,
          children: [new Paragraph({
            spacing: { before: 0, after: 0 },
            children: [
              new TextRun({ text: 'Date / التاريخ: ', bold: true, size: 14, color: C_MUTED }),
              new TextRun({ text: fmtDate(today), size: 16, color: C_TEXT }),
            ],
          })],
        }),
        new TableCell({
          borders: noBorders,
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { before: 0, after: 0 },
            children: [
              new TextRun({ text: 'Reference / المرجع: ', bold: true, size: 14, color: C_MUTED }),
              new TextRun({ text: refNum, size: 16, color: C_TEXT }),
            ],
          })],
        }),
      ],
    })],
  });

  // ── Applicant table — 2-column compact layout ──
  // Three rows of four cells: Name|PSN, Dept|Location, Joining|YOS
  const applicantTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [
        lbl('Full Name', 'الاسم الكامل'), val(employee.name),
        lbl('PSN',       'الرقم الوظيفي'), val(employee.id),
      ]}),
      new TableRow({ children: [
        lbl('Department','القسم'),       val(dept),
        lbl('Location',  'الموقع'),       val(loc),
      ]}),
      new TableRow({ children: [
        lbl('Designation','المسمى الوظيفي'), val(designation),
        lbl('Years of Service', 'سنوات الخدمة'), val(yearsOfService(employee.join_date)),
      ]}),
    ],
  });

  // ── Leave details table ──
  // Type|Days, Start|End, then Reason spans full width
  const leaveTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [
        lbl('Type of Leave', 'نوع الإجازة'), val(leaveTypeLabel),
        lbl('Number of Days','عدد الأيام'),    val(daysLabel),
      ]}),
      new TableRow({ children: [
        lbl('Start Date',  'تاريخ البداية'), val(fmtDate(request.start_date)),
        lbl('End Date',    'تاريخ النهاية'), val(fmtDate(request.end_date)),
      ]}),
      new TableRow({ children: [
        lbl('Reason / Notes', 'السبب'),
        new TableCell({
          width: { size: 82, type: WidthType.PERCENTAGE },
          columnSpan: 3,
          borders: thinAll(),
          margins: { top: 40, bottom: 40, left: 80, right: 80 },
          children: [new Paragraph({
            spacing: { before: 0, after: 0 },
            children: [new TextRun({ text: request.reason || '—', size: 18, color: C_TEXT })],
          })],
        }),
      ]}),
    ],
  });

  // ── Coverage table — substitutes in compact list ──
  const subRows = (substitutes && substitutes.length > 0)
    ? substitutes.map((s, idx) => new TableRow({
        children: [
          new TableCell({
            width: { size: 8, type: WidthType.PERCENTAGE },
            borders: thinAll(),
            margins: { top: 30, bottom: 30, left: 60, right: 60 },
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: 0, after: 0 },
              children: [new TextRun({ text: String(idx + 1), bold: true, color: C_MUTED, size: 16 })],
            })],
          }),
          new TableCell({
            width: { size: 92, type: WidthType.PERCENTAGE },
            borders: thinAll(),
            margins: { top: 30, bottom: 30, left: 80, right: 80 },
            children: [new Paragraph({
              spacing: { before: 0, after: 0 },
              children: [
                new TextRun({ text: s.name || '', size: 18, color: C_TEXT }),
                new TextRun({ text: `   ${s.id || ''}`, size: 14, color: C_MUTED }),
                new TextRun({ text: '   ✓ Confirmed', size: 14, color: C_ACCENT }),
              ],
            })],
          }),
        ],
      }))
    : [new TableRow({ children: [new TableCell({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: thinAll(),
        margins: { top: 40, bottom: 40, left: 80, right: 80 },
        children: [new Paragraph({
          spacing: { before: 0, after: 0 },
          children: [new TextRun({ text: 'No substitutes designated.', italics: true, size: 16, color: C_MUTED })],
        })],
      })]})];
  const substitutesTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: subRows,
  });

  // ── Authorisations — manager and HR side by side ──
  const sigCell = (titleEn, titleAr, name, when, status) => new TableCell({
    width: { size: 50, type: WidthType.PERCENTAGE },
    borders: thinAll(),
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [
      new Paragraph({
        spacing: { before: 0, after: 30 },
        children: [
          new TextRun({ text: titleEn, bold: true, color: C_DARK, size: 16 }),
          new TextRun({ text: '   ' + titleAr, color: C_DARK, size: 14, rightToLeft: true }),
        ],
      }),
      new Paragraph({
        spacing: { before: 0, after: 20 },
        children: [new TextRun({ text: name || '—', size: 18, color: C_TEXT, bold: true })],
      }),
      new Paragraph({
        spacing: { before: 0, after: 30 },
        children: [
          new TextRun({
            text: status === 'Approved' ? '✓ ' + (when || 'Approved') : (when || 'Pending'),
            color: status === 'Approved' ? C_ACCENT : C_MUTED,
            size: 14,
          }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 30, after: 0 },
        children: [new TextRun({ text: '_____________________', size: 16, color: C_BORDER })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 0 },
        children: [new TextRun({ text: 'Signature / التوقيع', italics: true, color: C_MUTED, size: 12 })],
      }),
    ],
  });
  const signatureTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: [
      sigCell(
        'Department Manager', 'رئيس القسم',
        manager?.name || '',
        request.manager_decided_at ? `Approved ${fmtDate(request.manager_decided_at)}` : '',
        manager ? 'Approved' : 'Pending'
      ),
      sigCell(
        'HR Department', 'إدارة الموارد البشرية',
        hrApprover?.name || '',
        request.hr_decided_at ? `Approved ${fmtDate(request.hr_decided_at)}` : '',
        request.hr_decided_at ? 'Approved' : 'Pending'
      ),
    ]})],
  });

  // ── Footer — single italic line ──
  const footer = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 160, after: 0 },
      children: [
        new TextRun({
          text: 'This leave is granted subject to ESAU policy and operational requirements.   ',
          italics: true, color: C_MUTED, size: 12,
        }),
        new TextRun({
          text: 'تمنح هذه الإجازة وفقاً لسياسة الشركة ومتطلبات العمل.',
          italics: true, color: C_MUTED, size: 12, rightToLeft: true,
        }),
      ],
    }),
  ];

  // ── Document with explicit A4 size and tight margins ──
  const doc = new Document({
    styles: {
      default: { document: { run: { font: 'Calibri', size: 18, color: C_TEXT } } },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838, orientation: 'portrait' }, // A4
          margin: { top: 540, right: 540, bottom: 540, left: 540 },        // ~0.375 inch
        },
      },
      children: [
        ...letterhead,
        dateRefRow,
        hd('APPLICANT INFORMATION', 'معلومات الموظف'),
        applicantTable,
        hd('LEAVE DETAILS', 'تفاصيل الإجازة'),
        leaveTable,
        hd('COVERAGE DURING ABSENCE', 'الاستبدال أثناء الغياب'),
        substitutesTable,
        hd('AUTHORIZATIONS', 'الموافقات'),
        signatureTable,
        ...footer,
      ],
    }],
  });

  return await Packer.toBlob(doc);
}

// ─── email draft ──────────────────────────────────────────────────────────────
const CEO_EMAIL          = 'johnho@evergreen-shipping.com.sa';
const COUNTRY_HEAD_EMAIL = 'jamesliu@evergreen-shipping.com.sa';

export function buildEmailDraft({ employee, request, manager, hrApprover, substitutes = [] }) {
  const leaveTypeLabel = LEAVE_TYPE_NAMES[request.leave_type_id] || 'Annual Leave';
  const dateRange = `${fmtDate(request.start_date)} – ${fmtDate(request.end_date)}`;

  const to = [employee.email].filter(Boolean).join(',');
  const ccList = [
    manager?.email,
    hrApprover?.email,
    CEO_EMAIL,
    COUNTRY_HEAD_EMAIL,
  ].filter(Boolean);
  const cc = ccList.join(',');

  const subject = `Leave Approved — ${employee.name} — ${dateRange}`;

  const body = [
    `Dear ${employee.name?.split(' ')[0] || 'Colleague'},`,
    '',
    `Your ${leaveTypeLabel.toLowerCase()} request has been approved.`,
    '',
    `Period: ${dateRange}`,
    `Days:   ${request.days} day${request.days === 1 ? '' : 's'}${request.is_half_day ? ' (half day)' : ''}`,
    `Reason: ${request.reason || '—'}`,
    '',
    `Coverage during your absence:`,
    ...(substitutes && substitutes.length > 0
      ? substitutes.map(s => `  • ${s.name} (${s.id})`)
      : ['  • —']),
    '',
    `Please find the signed vacation form attached.`,
    `The Arabic translation is included alongside the English text in the form.`,
    '',
    `If you have any questions, please contact HR.`,
    '',
    `Best regards,`,
    `${hrApprover?.name || 'HR Department'}`,
    `Evergreen Shipping Agency Saudi · HR Department`,
  ].join('\n');

  const mailto = `mailto:${to}?cc=${encodeURIComponent(cc)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  return { to, cc, subject, body, mailto };
}

// ─── helper: download a Blob as a file ────────────────────────────────────────
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
