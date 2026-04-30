// Permission letter — generates a single-page A4 .docx that mirrors the
// company's standard 'APPLICATION FOR LEAVE' form (see VACATION_FORM.docx
// in the repo). The document presents itself as the staff member's
// application submitted to the ESAU SUP / HR Department, with the
// approval chain pre-filled from the system once HR has signed off.
// Staff prints it, the direct manager signs alongside, and the hard copy
// goes to HR for filing.

import {
  Document, Packer, Paragraph, TextRun,
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
const TYPE_LABEL = {
  late_arrival: 'LATE ARRIVAL',
  early_leave:  'EARLY LEAVE',
};

// CC roster for the approval email. Entries are matched against the live
// employees array — `name` is a lowercase substring on employees.name and
// `dept` (optional) narrows by exact employees.department match. The dept
// guard exists because the org has multiple Fahads — Fahad Hussain in one
// dept and Fahad in SUP — and a plain name match would either over-CC or
// resolve to the wrong person.
const EXEC_CC = [
  { name: 'john ho' },                 // CEO / Country Head
  { name: 'james' },
  { name: 'fahad hussain' },
  { name: 'fahad', dept: 'SUP' },      // distinct from Fahad Hussain
  { name: 'badria' },
  { name: 'jaffar' },
];

// HR signature block for the email body — single source of truth so
// future updates only touch one place.
const HR_SIGNATURE = {
  name:    'BASHAIER ALI',
  company: 'Evergreen Shipping Agency Saudi Co.,(L.L.C)',
  unit:    'ESAU - SADMN SUP/ HR DEPT',
  address: 'P.O.Box : 1008,  DAMMAM – 31431, K.S.A',
  whatsapp:'966-54 320 9694',
  tel:     '966-013 813 8563 – Ext 8543',
  email:   'bashaier.alsubaie@evergreen-shipping.com.sa',
};

// ─── colour palette ───────────────────────────────────────────────────────────
const C_TEXT   = '1F1B16';   // body
const C_MUTED  = '6B7280';   // captions / labels
const C_BORDER = '7A6D58';   // form border (warm dark — matches paper feel)
const C_LABEL  = 'F4EEDF';   // label cell shading

// ─── formatters ───────────────────────────────────────────────────────────────
const fmtDateMed = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
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

// ─── docx primitives ──────────────────────────────────────────────────────────
const run = (text, opts = {}) => new TextRun({
  text: String(text ?? ''),
  font: 'Calibri',
  size: opts.size ?? 22,
  color: opts.color ?? C_TEXT,
  bold: !!opts.bold,
  italics: !!opts.italics,
  ...(opts.spacing != null ? { characterSpacing: opts.spacing } : {}),
});
const para = (children, opts = {}) => new Paragraph({
  children: Array.isArray(children) ? children : [run(children, opts.run || {})],
  alignment: opts.align || AlignmentType.LEFT,
  spacing: { before: opts.before ?? 0, after: opts.after ?? 80 },
});
const spacer = (after = 120) => new Paragraph({ children: [run('')], spacing: { after } });
const noBorder = () => ({
  top:    { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right:  { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
});
const formBorder = () => ({
  top:    { style: BorderStyle.SINGLE, size: 6, color: C_BORDER },
  bottom: { style: BorderStyle.SINGLE, size: 6, color: C_BORDER },
  left:   { style: BorderStyle.SINGLE, size: 6, color: C_BORDER },
  right:  { style: BorderStyle.SINGLE, size: 6, color: C_BORDER },
});

// Form row: bold label cell shaded + plain value cell. Mirrors the
// VACATION_FORM.docx applicant table style exactly.
const formRow = (label, value, opts = {}) => new TableRow({
  children: [
    new TableCell({
      children: [new Paragraph({
        children: [run(label.toUpperCase(), { bold: true, size: 18 })],
      })],
      width: { size: opts.labelWidth ?? 38, type: WidthType.PERCENTAGE },
      margins: { top: 100, bottom: 100, left: 160, right: 100 },
      shading: { fill: C_LABEL },
      borders: formBorder(),
    }),
    new TableCell({
      children: [new Paragraph({
        children: [run(value || '', { size: 22, bold: !!opts.bold })],
      })],
      width: { size: opts.valueWidth ?? 62, type: WidthType.PERCENTAGE },
      margins: { top: 100, bottom: 100, left: 160, right: 100 },
      borders: formBorder(),
    }),
  ],
});

// Section banner — used to break form into 'FOR HR USE ONLY' etc.
const sectionBanner = (text) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: [new TableRow({
    children: [new TableCell({
      children: [new Paragraph({
        children: [run(text.toUpperCase(), { bold: true, size: 18, spacing: 60 })],
        alignment: AlignmentType.CENTER,
      })],
      width: { size: 100, type: WidthType.PERCENTAGE },
      margins: { top: 80, bottom: 80, left: 160, right: 160 },
      shading: { fill: C_LABEL },
      borders: formBorder(),
    })],
  })],
});

// ─── main generator ───────────────────────────────────────────────────────────

export async function generatePermissionLetterBlob({ employee, manager, hrApprover, request }) {
  const typeLabel = TYPE_LABEL[request.type] || request.type;
  const deptName  = DEPT_NAMES[employee?.department] || employee?.department || '—';
  const loc       = LOCATION_NAMES[employee?.location] || employee?.location || '—';
  const designation = `${employee?.department || '—'} - ${employee?.location || '—'}`;
  const today     = new Date().toISOString();

  // ── TITLE BAR ─────────────────────────────────────────────────────────────
  // Two-column: 'APPLICATION FOR PERMISSION' on the left, 'DATE:' on the
  // right. Matches the masthead of VACATION_FORM.docx exactly.
  const titleBar = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph({
            children: [run('APPLICATION FOR PERMISSION', { bold: true, size: 30, spacing: 30 })],
          })],
          width: { size: 70, type: WidthType.PERCENTAGE },
          borders: noBorder(),
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
        }),
        new TableCell({
          children: [new Paragraph({
            children: [run('DATE:  ', { bold: true, size: 20 }), run(fmtDateMed(today), { size: 20 })],
            alignment: AlignmentType.RIGHT,
          })],
          width: { size: 30, type: WidthType.PERCENTAGE },
          borders: noBorder(),
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
        }),
      ],
    })],
  });

  // ── APPLICANT TABLE ───────────────────────────────────────────────────────
  const applicantTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      formRow('Name of the applicant', employee?.name || '—', { bold: true }),
      formRow('Employee ID',           employee?.id || '—'),
      formRow('Designation',           designation),
      formRow('Department',            `${deptName}  ·  ${loc}`),
      formRow('Date of joining',       fmtJoinDate(employee?.join_date)),
      formRow('Type of permission',    typeLabel, { bold: true }),
      formRow('Date of permission',    fmtDateShort(request.permission_date), { bold: true }),
      formRow('Hours requested',       `${Number(request.hours)} hour${Number(request.hours) === 1 ? '' : 's'}`, { bold: true }),
      formRow('Reason',                request.reason || '—'),
      formRow('Signature of applicant',''),  // empty cell — staff signs here
    ],
  });

  // ── HR USE ONLY SECTION ───────────────────────────────────────────────────
  const hrUseTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      formRow('Reference no.',       `PR-${String(request.id).padStart(5, '0')}`),
      formRow('Submitted (system)',  fmtDateTime(request.requested_at)),
      formRow('Approved by manager', `${manager?.name || '—'}  ·  ${fmtDateTime(request.manager_decided_at)}`),
      formRow('Approved by HR',      `${hrApprover?.name || HR_SIGNATURE.name}  ·  ${fmtDateTime(request.hr_decided_at)}`, { bold: true }),
      formRow('Exceeds monthly quota', request.exceeds_quota ? 'YES — flagged for evaluation' : 'NO'),
    ],
  });

  // ── 3-COL APPROVAL FOOTER (HOD / HR / GM) ─────────────────────────────────
  // Mirrors the bottom row of VACATION_FORM.docx: HEAD OF DEPARTMENT |
  // HR DEPARTMENT | GENERAL MANAGER. Pre-filled with the approver's name
  // where known; the GM column stays blank for physical sign-off.
  const sigCell = (title, name, when) => new TableCell({
    children: [
      new Paragraph({
        children: [run(title.toUpperCase(), { bold: true, size: 16, spacing: 60 })],
        alignment: AlignmentType.CENTER,
      }),
      new Paragraph({
        children: [run(name || '', { size: 18 })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 80 },
      }),
      new Paragraph({
        children: [run(when || '', { size: 14, color: C_MUTED, italics: true })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 30 },
      }),
      new Paragraph({
        children: [run('', {})],
        spacing: { before: 280 },
      }),
      new Paragraph({
        children: [run('Signature & date', { italics: true, color: C_MUTED, size: 14 })],
        alignment: AlignmentType.CENTER,
      }),
    ],
    margins: { top: 140, bottom: 140, left: 100, right: 100 },
    borders: formBorder(),
  });

  const approvalFooter = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        sigCell('Head of department', manager?.name,    fmtDateMed(request.manager_decided_at)),
        sigCell('HR department',      hrApprover?.name || HR_SIGNATURE.name, fmtDateMed(request.hr_decided_at)),
        sigCell('General manager',    '',               ''),
      ],
    })],
  });

  // ── REMARKS BOX ───────────────────────────────────────────────────────────
  const remarksTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [new TableCell({
        children: [
          new Paragraph({ children: [run('REMARKS:', { bold: true, size: 18 })] }),
          new Paragraph({ children: [run('', {})], spacing: { before: 100 } }),
          new Paragraph({ children: [run('', {})], spacing: { before: 100 } }),
        ],
        margins: { top: 100, bottom: 100, left: 160, right: 160 },
        borders: formBorder(),
      })],
    })],
  });

  // ── FOOTER ────────────────────────────────────────────────────────────────
  const footer = [
    spacer(160),
    para(
      `Generated by Leave Desk · ESAU SADMN SUP / HR DEPT · Ref PR-${String(request.id).padStart(5, '0')}`,
      { run: { size: 14, italics: true, color: C_MUTED }, align: AlignmentType.CENTER },
    ),
  ];

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri' } } } },
    sections: [{
      properties: {
        page: {
          size:    { width: 11906, height: 16838 }, // A4
          margin:  { top: 720, right: 900, bottom: 720, left: 900 },
        },
      },
      children: [
        titleBar,
        spacer(160),
        applicantTable,
        spacer(160),
        sectionBanner('For HR use only'),
        hrUseTable,
        spacer(160),
        approvalFooter,
        spacer(160),
        remarksTable,
        ...footer,
      ],
    }],
  });

  return await Packer.toBlob(doc);
}

// ─── email draft ──────────────────────────────────────────────────────────────

// Match EXEC_CC entries against the live employees array. An entry matches
// when employees.name contains the lowercase `name` AND, if `dept` is set,
// employees.department equals it. Returns deduped emails.
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
  const typeLabel = TYPE_LABEL[request.type] || request.type;
  const to        = employee?.email || '';
  const ccRaw     = [
    manager?.email,
    ...resolveExecCcEmails(employees),
  ].filter(Boolean);
  const cc = Array.from(new Set(ccRaw.filter(e => e !== to)));

  const firstName = (employee?.name || '').split(' ')[0] || 'Colleague';
  const subject   = `Permission approved · ${typeLabel} · ${fmtDateShort(request.permission_date)}`;

  const body = [
    `Dear ${firstName},`,
    ``,
    `Your request for ${typeLabel.toLowerCase()} permission on ${fmtDateShort(request.permission_date)} (${Number(request.hours)} hour${Number(request.hours) === 1 ? '' : 's'}) has been approved.`,
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
    `This permission counts toward your monthly bucket of 3 hours / 3 occurrences combined late + early.`,
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
