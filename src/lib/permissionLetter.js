// Permission letter — generates a single-page A4 .docx that documents an
// approved late-arrival or early-leave permission request, plus the matching
// email draft Bashaier sends to the staff member with manager + executive CC.
//
// Mirrors the structure of vacationForm.js so the two flows feel consistent
// when printed side-by-side.

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

// CC roster for the approval email. Lookup is by lowercase name substring
// against employees.name + employees.email. Update this list when the org
// chart changes — the resolver handles partial matches and silently skips
// anyone who doesn't have an email on file.
const EXEC_CC_NAMES = ['john', 'james', 'fahad hussain', 'badria', 'jaffar'];

// ─── colour palette ───────────────────────────────────────────────────────────
const C_DARK   = '2D5F3F';
const C_TEXT   = '1F2937';
const C_MUTED  = '6B7280';
const C_BORDER = 'D1D5DB';
const C_ACCENT = '15803D';

// ─── helpers ──────────────────────────────────────────────────────────────────
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
};
const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

// Standard cell with consistent padding + borders
const cell = (children, opts = {}) => new TableCell({
  children: Array.isArray(children) ? children : [children],
  width: opts.width || { size: 50, type: WidthType.PERCENTAGE },
  margins: { top: 120, bottom: 120, left: 160, right: 160 },
  shading: opts.shading,
  borders: {
    top:    { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
    left:   { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
    right:  { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
  },
});

const labelPara = (text) => new Paragraph({
  children: [new TextRun({
    text, color: C_MUTED, size: 16, font: 'Calibri',
    bold: true, characterSpacing: 40,
  })],
});
const valuePara = (text, opts = {}) => new Paragraph({
  children: [new TextRun({
    text: String(text || '—'), color: C_TEXT, size: opts.size || 22, font: 'Calibri',
    bold: !!opts.bold,
  })],
  spacing: { before: 60 },
});

// ─── main generator ───────────────────────────────────────────────────────────

export async function generatePermissionLetterBlob({ employee, manager, hrApprover, request }) {
  const typeLabel = TYPE_LABEL[request.type] || request.type;
  const dept      = DEPT_NAMES[employee?.department] || employee?.department || '—';
  const loc       = LOCATION_NAMES[employee?.location] || employee?.location || '—';

  // ── HEADER ────────────────────────────────────────────────────────────────
  const headerTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        new TableCell({
          children: [
            new Paragraph({
              children: [new TextRun({ text: 'EVERGREEN SHIPPING', bold: true, size: 32, color: C_DARK, font: 'Calibri' })],
              spacing: { after: 60 },
            }),
            new Paragraph({
              children: [new TextRun({ text: 'Saudi Arabia · KSA', color: C_MUTED, size: 18, font: 'Calibri' })],
            }),
          ],
          width: { size: 70, type: WidthType.PERCENTAGE },
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          borders: noBorder(),
        }),
        new TableCell({
          children: [
            new Paragraph({
              children: [new TextRun({ text: 'PERMISSION APPROVAL', bold: true, size: 22, color: C_ACCENT, characterSpacing: 60, font: 'Calibri' })],
              alignment: AlignmentType.RIGHT,
              spacing: { after: 40 },
            }),
            new Paragraph({
              children: [new TextRun({ text: `Issued ${fmtDate(new Date().toISOString())}`, color: C_MUTED, size: 16, font: 'Calibri' })],
              alignment: AlignmentType.RIGHT,
            }),
            new Paragraph({
              children: [new TextRun({ text: `Ref · PR-${String(request.id).padStart(5, '0')}`, color: C_MUTED, size: 16, font: 'Calibri' })],
              alignment: AlignmentType.RIGHT,
            }),
          ],
          width: { size: 30, type: WidthType.PERCENTAGE },
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          borders: noBorder(),
        }),
      ],
    })],
  });

  // ── EMPLOYEE BLOCK ────────────────────────────────────────────────────────
  const empTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          cell([labelPara('EMPLOYEE'),  valuePara(employee?.name || '—', { bold: true, size: 24 })]),
          cell([labelPara('PSN'),       valuePara(employee?.id || '—',   { bold: true })]),
          cell([labelPara('DEPT · LOC'),valuePara(`${dept} · ${loc}`)]),
        ],
      }),
      new TableRow({
        children: [
          cell([labelPara('PERMISSION TYPE'), valuePara(typeLabel, { bold: true })]),
          cell([labelPara('DATE'),            valuePara(fmtDate(request.permission_date), { bold: true })]),
          cell([labelPara('HOURS'),           valuePara(`${Number(request.hours)} hour${Number(request.hours) === 1 ? '' : 's'}`, { bold: true })]),
        ],
      }),
    ],
  });

  // ── REASON ────────────────────────────────────────────────────────────────
  const reasonTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [cell(
        [labelPara('REASON GIVEN BY EMPLOYEE'), valuePara(request.reason || '—')],
        { width: { size: 100, type: WidthType.PERCENTAGE }, shading: { fill: 'FAFAF7' } },
      )],
    })],
  });

  // ── APPROVAL CHAIN ────────────────────────────────────────────────────────
  const approvalTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          cell([labelPara('STAFF SUBMISSION'),
                valuePara(employee?.name || '—', { bold: true }),
                valuePara(fmtDateTime(request.requested_at))]),
          cell([labelPara('MANAGER APPROVAL'),
                valuePara(manager?.name || '—', { bold: true }),
                valuePara(fmtDateTime(request.manager_decided_at))]),
          cell([labelPara('HR FINAL APPROVAL'),
                valuePara(hrApprover?.name || '—', { bold: true }),
                valuePara(fmtDateTime(request.hr_decided_at))]),
        ],
      }),
    ],
  });

  // ── SIGNATURE STRIP ───────────────────────────────────────────────────────
  const sigTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          sigCell('Employee acknowledgment', employee?.name),
          sigCell('Direct manager',          manager?.name),
          sigCell('HR (SUP)',                hrApprover?.name),
        ],
      }),
    ],
  });

  // ── FOOTER NOTE ───────────────────────────────────────────────────────────
  const footerPara = new Paragraph({
    children: [new TextRun({
      text: 'This permission has been recorded against the employee\'s monthly bucket (3 hours / 3 occurrences combined late + early). Generated automatically by Leave Desk on final HR approval.',
      color: C_MUTED, size: 16, italics: true, font: 'Calibri',
    })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 200 },
  });

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
        headerTable,
        spacer(160),
        empTable,
        spacer(120),
        reasonTable,
        spacer(120),
        approvalTable,
        spacer(220),
        sigTable,
        footerPara,
      ],
    }],
  });

  return await Packer.toBlob(doc);
}

function spacer(after = 100) {
  return new Paragraph({ children: [new TextRun({ text: '' })], spacing: { after } });
}
function noBorder() {
  return {
    top:    { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    left:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    right:  { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  };
}
function sigCell(label, name) {
  return new TableCell({
    children: [
      new Paragraph({
        children: [new TextRun({ text: label.toUpperCase(), color: C_MUTED, size: 14, bold: true, characterSpacing: 60, font: 'Calibri' })],
      }),
      new Paragraph({
        children: [new TextRun({ text: name || '—', color: C_TEXT, size: 18, font: 'Calibri' })],
        spacing: { before: 80 },
      }),
      // Signature line
      new Paragraph({
        children: [new TextRun({ text: '__________________________', color: C_MUTED, size: 18, font: 'Calibri' })],
        spacing: { before: 320 },
      }),
      new Paragraph({
        children: [new TextRun({ text: 'Signature & date', color: C_MUTED, size: 14, italics: true, font: 'Calibri' })],
      }),
    ],
    margins: { top: 160, bottom: 160, left: 160, right: 160 },
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
      left:   { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
      right:  { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
    },
  });
}

// ─── email draft ──────────────────────────────────────────────────────────────

// Resolve the executive CC list from the live employees array. Matches by
// lowercase substring against employees.name; returns deduped list of emails.
// Logs a warning for any name in EXEC_CC_NAMES that has no email match —
// that's a data issue, not a bug, and the user can fix it in Settings.
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
  const cc        = [
    manager?.email,
    ...resolveExecCcEmails(employees),
  ].filter(Boolean);
  // De-dupe in case the manager is also in the exec CC list
  const ccDeduped = Array.from(new Set(cc.filter(e => e !== to)));

  const subject = `Permission approved · ${typeLabel} · ${fmtDate(request.permission_date)}`;
  const body =
    `Dear ${(employee?.name || '').split(' ')[0] || 'Colleague'},\n\n` +
    `Your request for ${typeLabel.toLowerCase()} permission on ${fmtDate(request.permission_date)} (${Number(request.hours)} hour${Number(request.hours) === 1 ? '' : 's'}) has been approved.\n\n` +
    `Reason on file: ${request.reason || '—'}\n\n` +
    `Approval chain:\n` +
    `  • Submitted: ${fmtDateTime(request.requested_at)}\n` +
    `  • Manager (${manager?.name || '—'}): ${fmtDateTime(request.manager_decided_at)}\n` +
    `  • HR (${hrApprover?.name || '—'}): ${fmtDateTime(request.hr_decided_at)}\n\n` +
    `The signed permission letter is attached for your records.\n\n` +
    `This permission counts toward your monthly bucket of 3 hours / 3 occurrences combined late + early.\n\n` +
    `Kind regards,\n` +
    `${hrApprover?.name || 'HR'}\n` +
    `Evergreen Shipping HR`;

  return {
    to,
    cc: ccDeduped,
    subject,
    body,
    // mailto: link suitable for opening in the user's default mail client.
    // Pre-fills to/cc/subject/body. Attachment must be added manually after
    // the user downloads the .docx — mailto: doesn't support attachments.
    mailto: buildMailto({ to, cc: ccDeduped, subject, body }),
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
