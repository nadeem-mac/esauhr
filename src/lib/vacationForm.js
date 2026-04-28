// Generates the bilingual EN/AR Vacation Form as a single-page A4 .docx Blob,
// plus the matching approval email draft. Uses the 'docx' npm library.
// Layout fits ONE A4 page when printed. Arabic text uses Arial (cs/complex-script
// font set explicitly) so it renders consistently across Word/LibreOffice/Pages.

import {
  Document, Packer, Paragraph, TextRun,
  Table, TableRow, TableCell,
  AlignmentType, WidthType, BorderStyle,
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

// CEO / Country Head — fixed signatories on every approved form
const CEO_NAME = 'JOHN HO';
const CEO_TITLE_EN = 'Country Head / CEO';
const CEO_TITLE_AR = 'الرئيس التنفيذي';

// ─── colour palette ───────────────────────────────────────────────────────────
const C_DARK   = '2D5F3F';
const C_TEXT   = '1F2937';
const C_MUTED  = '6B7280';
const C_BORDER = 'D1D5DB';
const C_ACCENT = '15803D';

// ─── font configuration — fixes Arabic rendering ──────────────────────────────
// English: Calibri ascii/hAnsi. Arabic (complex-script): Arial cs.
// Setting font.cs explicitly is what stops Word/LibreOffice from substituting
// random fonts for Arabic glyphs at print time.
const FONT_EN = { ascii: 'Calibri', hAnsi: 'Calibri', cs: 'Arial' };
const FONT_AR = { ascii: 'Arial',   hAnsi: 'Arial',   cs: 'Arial' };

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

// Compact key/value cells used in the info tables
const lbl = (en, ar) => new TableCell({
  width: { size: 18, type: WidthType.PERCENTAGE },
  borders: thinAll(),
  margins: { top: 40, bottom: 40, left: 80, right: 80 },
  children: [new Paragraph({
    spacing: { before: 0, after: 0 },
    children: [
      new TextRun({ text: en, bold: true, color: C_DARK, size: 16, font: FONT_EN }),
      new TextRun({ text: '  ' + ar, color: C_DARK, size: 14, rightToLeft: true, font: FONT_AR }),
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
      size: 18, color: C_TEXT, font: FONT_EN,
    })],
  })],
});

const hd = (en, ar) => new Paragraph({
  spacing: { before: 140, after: 60 },
  border: { bottom: { color: C_DARK, space: 1, style: BorderStyle.SINGLE, size: 6 } },
  children: [
    new TextRun({ text: en, bold: true, color: C_DARK, size: 18, font: FONT_EN }),
    new TextRun({ text: '   ', size: 14, font: FONT_EN }),
    new TextRun({ text: ar, color: C_DARK, size: 16, rightToLeft: true, font: FONT_AR }),
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
        new TextRun({ text: 'EVERGREEN SHIPPING AGENCY SAUDI', bold: true, size: 24, color: C_DARK, font: FONT_EN }),
        new TextRun({ text: '   ', size: 18, font: FONT_EN }),
        new TextRun({ text: 'وكالة إيفرغرين للملاحة السعودية', size: 18, color: C_DARK, rightToLeft: true, font: FONT_AR }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 100 },
      children: [
        new TextRun({ text: 'EMPLOYEE LEAVE APPLICATION', bold: true, size: 22, color: C_TEXT, font: FONT_EN }),
        new TextRun({ text: '   ', size: 18, font: FONT_EN }),
        new TextRun({ text: 'طلب إجازة موظف', bold: true, size: 18, color: C_TEXT, rightToLeft: true, font: FONT_AR }),
      ],
    }),
  ];

  // ── Date / Reference row ──
  const dateRefRow = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        new TableCell({
          borders: noBorders,
          children: [new Paragraph({
            spacing: { before: 0, after: 0 },
            children: [
              new TextRun({ text: 'Date / ', bold: true, size: 14, color: C_MUTED, font: FONT_EN }),
              new TextRun({ text: 'التاريخ', bold: true, size: 14, color: C_MUTED, rightToLeft: true, font: FONT_AR }),
              new TextRun({ text: ': ', bold: true, size: 14, color: C_MUTED, font: FONT_EN }),
              new TextRun({ text: fmtDate(today), size: 16, color: C_TEXT, font: FONT_EN }),
            ],
          })],
        }),
        new TableCell({
          borders: noBorders,
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { before: 0, after: 0 },
            children: [
              new TextRun({ text: 'Reference / ', bold: true, size: 14, color: C_MUTED, font: FONT_EN }),
              new TextRun({ text: 'المرجع', bold: true, size: 14, color: C_MUTED, rightToLeft: true, font: FONT_AR }),
              new TextRun({ text: ': ', bold: true, size: 14, color: C_MUTED, font: FONT_EN }),
              new TextRun({ text: refNum, size: 16, color: C_TEXT, font: FONT_EN }),
            ],
          })],
        }),
      ],
    })],
  });

  // ── Applicant table — 2-column compact layout ──
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
            children: [new TextRun({ text: request.reason || '—', size: 18, color: C_TEXT, font: FONT_EN })],
          })],
        }),
      ]}),
    ],
  });

  // ── Coverage table ──
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
              children: [new TextRun({ text: String(idx + 1), bold: true, color: C_MUTED, size: 16, font: FONT_EN })],
            })],
          }),
          new TableCell({
            width: { size: 92, type: WidthType.PERCENTAGE },
            borders: thinAll(),
            margins: { top: 30, bottom: 30, left: 80, right: 80 },
            children: [new Paragraph({
              spacing: { before: 0, after: 0 },
              children: [
                new TextRun({ text: s.name || '', size: 18, color: C_TEXT, font: FONT_EN }),
                new TextRun({ text: `   ${s.id || ''}`, size: 14, color: C_MUTED, font: FONT_EN }),
                new TextRun({ text: '   ✓ Confirmed', size: 14, color: C_ACCENT, font: FONT_EN }),
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
          children: [new TextRun({ text: 'No substitutes designated.', italics: true, size: 16, color: C_MUTED, font: FONT_EN })],
        })],
      })]})];
  const substitutesTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: subRows,
  });

  // ── Authorisations: 3 cells side-by-side — Manager | HR | CEO ──
  const sigCell = (titleEn, titleAr, name, when, status) => new TableCell({
    width: { size: 33, type: WidthType.PERCENTAGE },
    borders: thinAll(),
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    children: [
      new Paragraph({
        spacing: { before: 0, after: 30 },
        children: [
          new TextRun({ text: titleEn, bold: true, color: C_DARK, size: 14, font: FONT_EN }),
          new TextRun({ text: '   ' + titleAr, color: C_DARK, size: 12, rightToLeft: true, font: FONT_AR }),
        ],
      }),
      new Paragraph({
        spacing: { before: 0, after: 20 },
        children: [new TextRun({ text: name || '—', size: 16, color: C_TEXT, bold: true, font: FONT_EN })],
      }),
      new Paragraph({
        spacing: { before: 0, after: 30 },
        children: [
          new TextRun({
            text: status === 'Approved' ? '✓ ' + (when || 'Approved') : (when || 'Pending'),
            color: status === 'Approved' ? C_ACCENT : C_MUTED,
            size: 12, font: FONT_EN,
          }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 30, after: 0 },
        children: [new TextRun({ text: '_____________________', size: 14, color: C_BORDER, font: FONT_EN })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 0 },
        children: [
          new TextRun({ text: 'Signature / ', italics: true, color: C_MUTED, size: 11, font: FONT_EN }),
          new TextRun({ text: 'التوقيع', italics: true, color: C_MUTED, size: 11, rightToLeft: true, font: FONT_AR }),
        ],
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
        request.manager_decided_at ? 'Approved' : 'Pending'
      ),
      sigCell(
        'HR Department', 'إدارة الموارد البشرية',
        hrApprover?.name || '',
        request.hr_decided_at ? `Approved ${fmtDate(request.hr_decided_at)}` : '',
        request.hr_decided_at ? 'Approved' : 'Pending'
      ),
      sigCell(
        CEO_TITLE_EN, CEO_TITLE_AR,
        CEO_NAME,
        '',
        'Pending'
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
          italics: true, color: C_MUTED, size: 12, font: FONT_EN,
        }),
        new TextRun({
          text: 'تمنح هذه الإجازة وفقاً لسياسة الشركة ومتطلبات العمل.',
          italics: true, color: C_MUTED, size: 12, rightToLeft: true, font: FONT_AR,
        }),
      ],
    }),
  ];

  // ── Document with explicit A4 size and tight margins ──
  const doc = new Document({
    styles: {
      default: { document: { run: { font: FONT_EN, size: 18, color: C_TEXT } } },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838, orientation: 'portrait' },
          margin: { top: 540, right: 540, bottom: 540, left: 540 },
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
  const dateRange = `${fmtDate(request.start_date)} - ${fmtDate(request.end_date)}`;

  const to = [employee.email].filter(Boolean).join(',');
  const ccList = [
    manager?.email,
    hrApprover?.email,
    CEO_EMAIL,
    COUNTRY_HEAD_EMAIL,
  ].filter(Boolean);
  const cc = ccList.join(',');

  const subject = `Leave Approved - ${employee.name} - ${dateRange}`;

  const body = [
    `Dear ${employee.name?.split(' ')[0] || 'Colleague'},`,
    '',
    `Your ${leaveTypeLabel.toLowerCase()} request has been approved.`,
    '',
    `Period: ${dateRange}`,
    `Days:   ${request.days} day${request.days === 1 ? '' : 's'}${request.is_half_day ? ' (half day)' : ''}`,
    `Reason: ${request.reason || '-'}`,
    '',
    `Coverage during your absence:`,
    ...(substitutes && substitutes.length > 0
      ? substitutes.map(s => `  - ${s.name} (${s.id})`)
      : ['  - -']),
    '',
    `Please find the signed vacation form attached.`,
    `The Arabic translation is included alongside the English text in the form.`,
    '',
    `If you have any questions, please contact HR.`,
    '',
    `Best regards,`,
    `${hrApprover?.name || 'HR Department'}`,
    `Evergreen Shipping Agency Saudi - HR Department`,
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

// ─── helper: regenerate + download for any approved request ───────────────────
// Looks up employee/manager/HR approver/substitutes from the supplied empMap and
// delegates to generateVacationFormBlob. Used to re-download the form for any
// past application from anywhere in the app (personal dashboard, requests view,
// employee history modal, etc).
export async function downloadVacationFormForRequest(request, empMap) {
  if (!request) throw new Error('No request supplied');
  if (!empMap)  throw new Error('Employee directory unavailable');
  const employee = empMap[request.employee_id];
  if (!employee) throw new Error('Employee not found in directory');
  const manager     = request.manager_decided_by ? (empMap[request.manager_decided_by] || null) : null;
  const hrApprover  = request.hr_decided_by      ? (empMap[request.hr_decided_by]      || null) : null;
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
