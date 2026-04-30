// Permission letter — generates a single-page A4 .docx that documents an
// approved late-arrival or early-leave permission request. Format follows
// professional HR correspondence style: letterhead, date/ref, addressee,
// subject line, body paragraphs, structured tables, signature block.
//
// Mirrors the visual hierarchy of vacationForm.js but reads as a formal
// HR letter rather than a data form.

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
  late_arrival: 'Late Arrival',
  early_leave:  'Early Leave',
};

// CC roster for the approval email — see resolveExecCcEmails below.
const EXEC_CC_NAMES = ['john', 'james', 'fahad hussain', 'badria', 'jaffar'];

// HR signature block — used in BOTH the docx and the email body. Single
// source of truth so future updates only touch one place. Per user
// direction this is the official HR signature for permission approval
// correspondence and stays the same regardless of which HR reviewer
// approves (they all sign as the SUP / HR DEPT).
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
const C_DARK   = '0F2818';   // very dark green — headings
const C_TEXT   = '1F1B16';   // body
const C_MUTED  = '6B7280';   // captions
const C_BORDER = 'D1D5DB';
const C_ACCENT = '2D5F3F';   // brand evergreen for letterhead

// ─── formatters ───────────────────────────────────────────────────────────────
const fmtDateLong = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};
const fmtDateMed = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};
const fmtDateShort = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
};
const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
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
const para = (text, opts = {}) => new Paragraph({
  children: Array.isArray(text) ? text : [run(text, opts.run || {})],
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
const thinBorder = () => ({
  top:    { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
  left:   { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
  right:  { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
});

// ─── main generator ───────────────────────────────────────────────────────────

export async function generatePermissionLetterBlob({ employee, manager, hrApprover, request }) {
  const typeLabel = TYPE_LABEL[request.type] || request.type;
  const dept      = DEPT_NAMES[employee?.department] || employee?.department || '—';
  const loc       = LOCATION_NAMES[employee?.location] || employee?.location || '—';
  const today     = new Date().toISOString();

  // ── LETTERHEAD ────────────────────────────────────────────────────────────
  const letterhead = [
    new Paragraph({
      children: [run(HR_SIGNATURE.company.toUpperCase(), {
        bold: true, size: 28, color: C_ACCENT, spacing: 30,
      })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
    }),
    new Paragraph({
      children: [run(HR_SIGNATURE.unit, { size: 18, color: C_MUTED })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
    }),
    new Paragraph({
      children: [run(`${HR_SIGNATURE.address}  ·  Tel ${HR_SIGNATURE.tel}`, { size: 16, color: C_MUTED })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 0 },
    }),
    // Divider line
    new Paragraph({
      children: [run('')],
      border: { bottom: { color: C_ACCENT, space: 4, style: BorderStyle.SINGLE, size: 8 } },
      spacing: { before: 120, after: 200 },
    }),
  ];

  // ── DATE + REF ROW ────────────────────────────────────────────────────────
  const dateRefRow = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph({
            children: [run('Date:  ', { bold: true, color: C_MUTED, size: 18 }), run(fmtDateMed(today), { size: 20 })],
          })],
          width: { size: 60, type: WidthType.PERCENTAGE },
          borders: noBorder(),
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
        }),
        new TableCell({
          children: [new Paragraph({
            children: [run('Ref:  ', { bold: true, color: C_MUTED, size: 18 }), run(`PR-${String(request.id).padStart(5, '0')}`, { size: 20, bold: true })],
            alignment: AlignmentType.RIGHT,
          })],
          width: { size: 40, type: WidthType.PERCENTAGE },
          borders: noBorder(),
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
        }),
      ],
    })],
  });

  // ── ADDRESSEE BLOCK ───────────────────────────────────────────────────────
  const addresseeBlock = [
    spacer(160),
    para([run('To:  ', { bold: true, color: C_MUTED, size: 18 }), run(employee?.name || '—', { bold: true, size: 22 })]),
    para([
      run('Employee ID: ', { color: C_MUTED, size: 18 }),
      run(employee?.id || '—', { size: 18 }),
      run('     ·     ', { color: C_MUTED, size: 18 }),
      run('Department: ', { color: C_MUTED, size: 18 }),
      run(`${dept} (${employee?.department || '—'})`, { size: 18 }),
      run('     ·     ', { color: C_MUTED, size: 18 }),
      run('Location: ', { color: C_MUTED, size: 18 }),
      run(loc, { size: 18 }),
    ]),
  ];

  // ── SUBJECT LINE ──────────────────────────────────────────────────────────
  const subjectBlock = [
    spacer(200),
    para([
      run('Subject:  ', { bold: true, color: C_MUTED, size: 18 }),
      run(`Approval — ${typeLabel} Permission`, { bold: true, size: 22, color: C_DARK }),
    ]),
  ];

  // ── SALUTATION + OPENING ──────────────────────────────────────────────────
  const firstName = (employee?.name || '').split(' ')[0] || 'Colleague';
  const opening = [
    spacer(200),
    para(`Dear ${firstName},`, { run: { size: 22 } }),
    spacer(100),
    para(
      `This letter confirms that your request for ${typeLabel.toLowerCase()} permission on ${fmtDateLong(request.permission_date)} has been formally approved by the Human Resources Department.`,
      { run: { size: 22 } },
    ),
  ];

  // ── PERMISSION DETAILS / APPROVAL CHAIN ROWS ──────────────────────────────
  const detailRow = (label, value, opts = {}) => new TableRow({
    children: [
      new TableCell({
        children: [new Paragraph({
          children: [run(label.toUpperCase(), { bold: true, color: C_MUTED, size: 16, spacing: 30 })],
        })],
        width: { size: 32, type: WidthType.PERCENTAGE },
        margins: { top: 100, bottom: 100, left: 160, right: 100 },
        shading: { fill: 'FAFAF7' },
        borders: thinBorder(),
      }),
      new TableCell({
        children: [new Paragraph({
          children: [run(value, { size: 22, bold: !!opts.bold, color: opts.color || C_TEXT })],
        })],
        width: { size: 68, type: WidthType.PERCENTAGE },
        margins: { top: 100, bottom: 100, left: 160, right: 100 },
        borders: thinBorder(),
      }),
    ],
  });

  const detailsHeader = [
    spacer(160),
    para('Permission details', { run: { size: 18, bold: true, color: C_MUTED, spacing: 30 } }),
  ];
  const detailsTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      detailRow('Type',           typeLabel,                                                               { bold: true, color: C_DARK }),
      detailRow('Date',           fmtDateLong(request.permission_date),                                    { bold: true }),
      detailRow('Approved hours', `${Number(request.hours)} hour${Number(request.hours) === 1 ? '' : 's'}`, { bold: true }),
      detailRow('Reason',         request.reason || '—'),
    ],
  });

  const chainHeader = [
    spacer(160),
    para('Approval chain', { run: { size: 18, bold: true, color: C_MUTED, spacing: 30 } }),
  ];
  const chainTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      detailRow('Submitted by',     `${employee?.name || '—'}  ·  ${fmtDateTime(request.requested_at)}`),
      detailRow('Approved by manager', `${manager?.name || '—'}  ·  ${fmtDateTime(request.manager_decided_at)}`),
      detailRow('Approved by HR',   `${hrApprover?.name || HR_SIGNATURE.name}  ·  ${fmtDateTime(request.hr_decided_at)}`, { bold: true, color: C_ACCENT }),
    ],
  });

  // ── INSTRUCTIONS PARAGRAPH ────────────────────────────────────────────────
  const instructions = [
    spacer(200),
    para(
      `Kindly print this letter, obtain your direct manager\u2019s signature in the designated area below, and submit the hard copy to the HR Department for filing.`,
      { run: { size: 22 } },
    ),
    spacer(80),
    para(
      `This permission counts toward your monthly bucket of 3 hours / 3 occurrences (combined late arrival + early leaving).`,
      { run: { size: 20, italics: true, color: C_MUTED } },
    ),
  ];

  // ── SIGNATURE STRIP ───────────────────────────────────────────────────────
  const sigCell = (title, name) => new TableCell({
    children: [
      new Paragraph({
        children: [run(title.toUpperCase(), { bold: true, color: C_MUTED, size: 14, spacing: 60 })],
      }),
      new Paragraph({
        children: [run(name || '—', { size: 18 })],
        spacing: { before: 60 },
      }),
      new Paragraph({
        children: [run('________________________', { color: C_MUTED, size: 18 })],
        spacing: { before: 320 },
      }),
      new Paragraph({
        children: [run('Signature & date', { italics: true, color: C_MUTED, size: 14 })],
      }),
    ],
    margins: { top: 160, bottom: 160, left: 160, right: 160 },
    borders: thinBorder(),
  });

  const sigStrip = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        sigCell('Employee', employee?.name),
        sigCell('Direct manager', manager?.name),
        sigCell('HR (SUP)', hrApprover?.name || HR_SIGNATURE.name),
      ],
    })],
  });

  // ── HR SIGNATURE BLOCK (Bashaier's full signature) ────────────────────────
  const hrSig = [
    spacer(280),
    para('Thanks and regards,', { run: { size: 22 } }),
    spacer(60),
    para(HR_SIGNATURE.name,    { run: { size: 22, bold: true, color: C_DARK } }),
    para(HR_SIGNATURE.company, { run: { size: 18, color: C_MUTED } }),
    para(HR_SIGNATURE.unit,    { run: { size: 18, color: C_MUTED } }),
    para(HR_SIGNATURE.address, { run: { size: 18, color: C_MUTED } }),
    para(`WhatsApp: ${HR_SIGNATURE.whatsapp}     ·     Tel: ${HR_SIGNATURE.tel}`, { run: { size: 16, color: C_MUTED } }),
    para(`Email: ${HR_SIGNATURE.email}`, { run: { size: 16, color: C_MUTED } }),
  ];

  // ── FOOTER ────────────────────────────────────────────────────────────────
  const footer = [
    spacer(180),
    para(
      `Issued by Leave Desk on ${fmtDateMed(today)} · This is an officially generated HR document.`,
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
        ...letterhead,
        dateRefRow,
        ...addresseeBlock,
        ...subjectBlock,
        ...opening,
        ...detailsHeader,
        detailsTable,
        ...chainHeader,
        chainTable,
        ...instructions,
        spacer(200),
        sigStrip,
        ...hrSig,
        ...footer,
      ],
    }],
  });

  return await Packer.toBlob(doc);
}

// ─── email draft ──────────────────────────────────────────────────────────────

// Match list against employees by lowercase name substring; returns deduped
// emails. Logs a warning for any name without an email match — that's a
// data issue (not a bug) and the user can fix it in Settings.
export function resolveExecCcEmails(employees = []) {
  const emails = new Set();
  for (const needle of EXEC_CC_NAMES) {
    const matches = employees.filter(e =>
      e?.email && (e.name || '').toLowerCase().includes(needle)
    );
    if (matches.length === 0) {
      console.warn(`[permission letter] No employee matched CC name "${needle}" with an email on file`);
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
  // De-dupe + remove the To address from CC
  const cc = Array.from(new Set(ccRaw.filter(e => e !== to)));

  const firstName = (employee?.name || '').split(' ')[0] || 'Colleague';
  const subject   = `Permission approved · ${typeLabel} · ${fmtDateShort(request.permission_date)}`;

  // Body matches the HR-approved copy verbatim. Bullet markers are real
  // bullet glyphs because most desktop mail clients render them as plain
  // text and the bullet look is part of the formal feel.
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
  // URLSearchParams encodes spaces as '+' which most mail clients treat as
  // literal '+'. Replace with %20 so the body reads correctly in Outlook,
  // Apple Mail, and Gmail web.
  return `mailto:${encodeURIComponent(to)}?${params.toString().replace(/\+/g, '%20')}`;
}

// ─── one-shot helper ──────────────────────────────────────────────────────────

export async function downloadPermissionLetter({ employee, manager, hrApprover, request }) {
  const blob = await generatePermissionLetterBlob({ employee, manager, hrApprover, request });
  const fname = `Permission_${(employee?.name || 'staff').replace(/\s+/g, '_')}_${request.permission_date}.docx`;
  downloadBlob(blob, fname);
}
