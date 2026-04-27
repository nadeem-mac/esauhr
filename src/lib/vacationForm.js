// Generates the bilingual EN/AR Vacation Form as a .docx Blob, plus the matching
// approval email draft. Uses the 'docx' npm library (added to package.json).
// Modeled on ESAU's existing VACATION_FORM.docx structure but redrafted as a
// polished, professional, bilingual document.

import {
  Document, Packer, Paragraph, TextRun,
  Table, TableRow, TableCell,
  AlignmentType, WidthType, BorderStyle, ShadingType,
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
  exam:        'Exam Leave',
  unpaid:      'Unpaid Leave',
};

// ─── colors (Evergreen brand) ─────────────────────────────────────────────────
const C_DARK    = '1F4530';
const C_TEXT    = '2A2620';
const C_MUTED   = '6B6356';
const C_BORDER  = 'D8D5C8';
const C_PANEL   = 'F5F2E8';
const C_ACCENT  = '2D5F3F';

// ─── helpers ──────────────────────────────────────────────────────────────────
function fmtDate(s) {
  if (!s) return '—';
  const d = s instanceof Date ? s : new Date(s);
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function yearsOfService(joinDate) {
  if (!joinDate) return '—';
  const start = new Date(joinDate);
  if (isNaN(start.getTime())) return '—';
  const now = new Date();
  const months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (m === 0) return `${y} year${y === 1 ? '' : 's'}`;
  return `${y}y ${m}m`;
}

const BORDER_THIN = { style: BorderStyle.SINGLE, size: 4, color: C_BORDER };
const BORDERS_BOX = { top: BORDER_THIN, bottom: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN };
const BORDER_NONE_ALL = (() => {
  const n = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  return { top: n, bottom: n, left: n, right: n, insideHorizontal: n, insideVertical: n };
})();

// Bilingual label cell — EN bold on top, AR italic underneath, light panel background
const labelCell = (en, ar) => new TableCell({
  width: { size: 38, type: WidthType.PERCENTAGE },
  shading: { type: ShadingType.CLEAR, color: 'auto', fill: C_PANEL },
  borders: BORDERS_BOX,
  children: [
    new Paragraph({
      spacing: { before: 80, after: 0 },
      children: [new TextRun({ text: en, bold: true, color: C_DARK, size: 18 })],
    }),
    new Paragraph({
      spacing: { before: 0, after: 80 },
      bidirectional: true,
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: ar, color: C_MUTED, size: 16, rightToLeft: true })],
    }),
  ],
});

const valueCell = (text) => new TableCell({
  width: { size: 62, type: WidthType.PERCENTAGE },
  borders: BORDERS_BOX,
  children: [new Paragraph({
    spacing: { before: 100, after: 100 },
    children: [new TextRun({ text: String(text == null || text === '' ? '—' : text), size: 22, color: C_TEXT })],
  })],
});

const sectionHeading = (en, ar) => new Paragraph({
  spacing: { before: 320, after: 140 },
  border: { bottom: { color: C_DARK, space: 1, style: BorderStyle.SINGLE, size: 6 } },
  children: [
    new TextRun({ text: en, bold: true, color: C_DARK, size: 24 }),
    new TextRun({ text: '          ', size: 18 }),
    new TextRun({ text: ar, color: C_DARK, size: 22, rightToLeft: true }),
  ],
});

// ─── main API ─────────────────────────────────────────────────────────────────
export async function generateVacationFormBlob({ request, employee, manager, hrApprover, substitutes }) {
  const designation = `${employee.department || ''} - ${employee.location || ''}`.replace(/^- | -$/g, '');
  const dept = DEPT_NAMES[employee.department] || employee.department || '';
  const loc  = LOCATION_NAMES[employee.location] || employee.location || '';
  const leaveTypeLabel = LEAVE_TYPE_NAMES[request.leave_type_id] || request.leave_type_id || 'Leave';

  const today = new Date();
  const refNum = `ESAU-HR-${today.getFullYear()}-${String(request.id || '').slice(0, 8).toUpperCase()}`;

  // Letterhead block
  const letterhead = [
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 0, after: 60 },
      children: [new TextRun({ text: 'EVERGREEN SHIPPING AGENCY SAUDI', bold: true, size: 28, color: C_DARK })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
      bidirectional: true,
      children: [new TextRun({ text: 'وكالة إيفرغرين للملاحة السعودية', size: 22, color: C_DARK, rightToLeft: true })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 240, after: 60 },
      children: [new TextRun({ text: 'EMPLOYEE LEAVE APPLICATION', bold: true, size: 32, color: C_TEXT })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 0, after: 240 },
      bidirectional: true,
      children: [new TextRun({ text: 'طلب إجازة موظف', bold: true, size: 26, color: C_TEXT, rightToLeft: true })],
    }),
  ];

  // Date / reference row (no borders)
  const dateRefRow = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: BORDER_NONE_ALL,
    rows: [new TableRow({ children: [
      new TableCell({
        borders: BORDER_NONE_ALL,
        children: [new Paragraph({ children: [
          new TextRun({ text: 'Date / التاريخ: ', bold: true, size: 18, color: C_MUTED }),
          new TextRun({ text: fmtDate(today), size: 20, color: C_TEXT }),
        ]})],
      }),
      new TableCell({
        borders: BORDER_NONE_ALL,
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [
          new TextRun({ text: 'Reference / المرجع: ', bold: true, size: 18, color: C_MUTED }),
          new TextRun({ text: refNum, size: 20, color: C_TEXT }),
        ]})],
      }),
    ]})],
  });

  // Applicant table
  const applicantTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [labelCell('Full Name',        'الاسم الكامل'),     valueCell(employee.name)] }),
      new TableRow({ children: [labelCell('Employee ID',      'الرقم الوظيفي'),    valueCell(employee.id)] }),
      new TableRow({ children: [labelCell('Designation',      'المسمى الوظيفي'),    valueCell(designation)] }),
      new TableRow({ children: [labelCell('Department',       'القسم'),           valueCell(dept)] }),
      new TableRow({ children: [labelCell('Location',         'الموقع'),          valueCell(loc)] }),
      new TableRow({ children: [labelCell('Date of Joining',  'تاريخ الالتحاق'),   valueCell(fmtDate(employee.join_date))] }),
      new TableRow({ children: [labelCell('Years of Service', 'سنوات الخدمة'),     valueCell(yearsOfService(employee.join_date))] }),
    ],
  });

  // Leave details table
  const daysLabel = `${request.days} day${request.days === 1 ? '' : 's'}${request.is_half_day ? ' (half day)' : ''}`;
  const leaveTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [labelCell('Type of Leave', 'نوع الإجازة'),   valueCell(leaveTypeLabel)] }),
      new TableRow({ children: [labelCell('Start Date',    'تاريخ البداية'),  valueCell(fmtDate(request.start_date))] }),
      new TableRow({ children: [labelCell('End Date',      'تاريخ النهاية'),  valueCell(fmtDate(request.end_date))] }),
      new TableRow({ children: [labelCell('Total Days',    'إجمالي الأيام'),  valueCell(daysLabel)] }),
      new TableRow({ children: [labelCell('Reason',        'السبب'),         valueCell(request.reason || '—')] }),
    ],
  });

  // Substitutes table — header row + one row per substitute
  const subHeaderCell = (text) => new TableCell({
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: C_DARK },
    borders: BORDERS_BOX,
    children: [new Paragraph({
      spacing: { before: 100, after: 100 },
      children: [new TextRun({ text, bold: true, color: 'FFFFFF', size: 18 })],
    })],
  });
  const subBodyCell = (text, isSignature) => new TableCell({
    borders: BORDERS_BOX,
    children: [new Paragraph({
      spacing: { before: isSignature ? 280 : 100, after: isSignature ? 280 : 100 },
      children: [new TextRun({ text: text || '', size: 20, color: C_TEXT })],
    })],
  });

  const subRows = (substitutes || []).map(s => new TableRow({
    children: [
      subBodyCell(s.id),
      subBodyCell(s.name),
      subBodyCell(DEPT_NAMES[s.department] || s.department || ''),
      subBodyCell('', true),
    ],
  }));
  if (subRows.length === 0) {
    subRows.push(new TableRow({ children: [
      new TableCell({ columnSpan: 4, borders: BORDERS_BOX, children: [new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { before: 100, after: 100 },
        children: [new TextRun({ text: 'No substitute coverage required', italics: true, color: C_MUTED, size: 18 })],
      })]}),
    ]}));
  }

  const substitutesTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: ['PSN', 'Name / الاسم', 'Department / القسم', 'Signature / التوقيع'].map(subHeaderCell) }),
      ...subRows,
    ],
  });

  // 3-column signature block
  const signatureCell = (en, ar, name, dateStr, status) => new TableCell({
    borders: BORDERS_BOX,
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { before: 120, after: 0 },
        children: [new TextRun({ text: en, bold: true, color: C_DARK, size: 18 })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { before: 0, after: 240 },
        bidirectional: true,
        children: [new TextRun({ text: ar, color: C_DARK, size: 16, rightToLeft: true })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { before: 0, after: 60 },
        children: [new TextRun({ text: name || ' ', size: 18, color: C_TEXT })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { before: 0, after: 60 },
        children: [new TextRun({ text: dateStr || ' ', italics: true, color: C_MUTED, size: 14 })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { before: 0, after: 200 },
        children: [new TextRun({
          text: status,
          italics: true,
          color: status === 'Pending' ? C_MUTED : C_ACCENT,
          size: 16
        })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { before: 60, after: 40 },
        children: [new TextRun({ text: '_______________________', size: 18, color: C_BORDER })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { before: 0, after: 80 },
        children: [new TextRun({ text: 'Signature / التوقيع', italics: true, color: C_MUTED, size: 14 })],
      }),
    ],
  });

  const signatureTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: [
      signatureCell(
        'Department Manager', 'رئيس القسم',
        manager?.name || '',
        request.manager_decided_at ? `Approved ${fmtDate(request.manager_decided_at)}` : '',
        manager ? 'Approved' : 'Pending'
      ),
      signatureCell(
        'HR Department', 'إدارة الموارد البشرية',
        hrApprover?.name || '',
        request.hr_decided_at ? `Approved ${fmtDate(request.hr_decided_at)}` : `Approved ${fmtDate(today)}`,
        'Approved'
      ),
      signatureCell(
        'General Manager', 'المدير العام',
        '', '',
        'Pending'
      ),
    ]})],
  });

  // Footer
  const footer = [
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 360, after: 60 },
      children: [new TextRun({
        text: 'This leave is granted subject to ESAU policy and operational requirements.',
        italics: true, color: C_MUTED, size: 16,
      })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
      bidirectional: true,
      children: [new TextRun({
        text: 'تمنح هذه الإجازة وفقاً لسياسة الشركة ومتطلبات العمل.',
        italics: true, color: C_MUTED, size: 16, rightToLeft: true,
      })],
    }),
  ];

  const doc = new Document({
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22, color: C_TEXT } } },
    },
    sections: [{
      properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
      children: [
        ...letterhead,
        dateRefRow,
        sectionHeading('APPLICANT INFORMATION', 'معلومات الموظف'),
        applicantTable,
        sectionHeading('LEAVE DETAILS', 'تفاصيل الإجازة'),
        leaveTable,
        sectionHeading('COVERAGE DURING ABSENCE', 'الاستبدال أثناء الغياب'),
        substitutesTable,
        sectionHeading('AUTHORIZATIONS', 'الموافقات'),
        signatureTable,
        ...footer,
      ],
    }],
  });

  return await Packer.toBlob(doc);
}

// ─── email draft ──────────────────────────────────────────────────────────────
const CEO_EMAIL = 'johnho@evergreen-shipping.com.sa';
const COUNTRY_HEAD_EMAIL = 'jamesliu@evergreen-shipping.com.sa';

export function buildEmailDraft({ request, employee, manager, hrApprover, substitutes }) {
  const dateRange = `${fmtDate(request.start_date)} – ${fmtDate(request.end_date)}`;
  const subject = `Leave Approved — ${employee.name} — ${dateRange}`;
  const subList = (substitutes || []).map(s => s.name).filter(Boolean);
  const subText = subList.length === 0
    ? '(no substitute coverage required)'
    : subList.length === 1
      ? subList[0]
      : subList.slice(0, -1).join(', ') + ' and ' + subList[subList.length - 1];

  const firstName = (employee.name || '').split(/\s+/).find(p => p.length > 1) || employee.name;

  const body = [
    `Dear ${firstName},`,
    '',
    `Your ${(LEAVE_TYPE_NAMES[request.leave_type_id] || 'leave').toLowerCase()} request for ${dateRange} (${request.days} day${request.days === 1 ? '' : 's'}) has been approved.`,
    '',
    'Please find the signed Vacation Form attached. Kindly print, sign, and return a copy to HR for your file.',
    '',
    `Coverage during your absence will be provided by ${subText}`+ (subList.length > 0 ? ', who have confirmed their availability.' : '.'),
    '',
    `Reason on file: ${request.reason || '—'}`,
    '',
    'Please ensure all pending tasks are properly handed over to your designated cover before your leave begins.',
    '',
    'Best regards,',
    hrApprover?.name || 'Bashaier Ali Alsubaie',
    'HR Department',
    'Evergreen Shipping Agency Saudi',
  ].join('\r\n');

  const to = employee.email || '';
  const ccList = [
    manager?.email,
    hrApprover?.email,
    CEO_EMAIL,
    COUNTRY_HEAD_EMAIL,
  ].filter(e => e && e !== to);
  const cc = ccList.join(',');

  // mailto wants %20 etc; many clients dislike + so use encodeURIComponent
  const url = `mailto:${encodeURIComponent(to)}?cc=${encodeURIComponent(cc)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return { to, cc, ccList, subject, body, url };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
