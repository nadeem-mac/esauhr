// Permission letter — bilingual A4 form, Leave Desk brand styling.
//
// Produces a PDF Blob using pdfmake (browser-side, no server). Same
// design as the previous docx version: cream paper, copper accents,
// Tahoma EVERGREEN LINE wordmark, brand colors, QR verify code,
// ✓ APPROVED stamp top-right, 4-column signature grid, KSA leave
// policy bullets, bilingual EN/AR throughout.
//
// Public exports (unchanged signatures so callers don't break):
//   • generatePermissionLetterBlob(...)   → PDF Blob
//   • resolveExecCcEmails(...)
//   • buildPermissionEmailDraft(...)
//   • downloadPermissionLetter(...)        → triggers .pdf download

import QRCode from 'qrcode';
import pdfMake, { ensureFontsLoaded } from './pdfFontLoader.js';
import { downloadBlob } from './vacationForm.js';

// Verification URL base — staff scan the QR in the printed letter to
// hit a public read-only page that confirms the request status.
const VERIFY_BASE_URL = (typeof window !== 'undefined' && window.location?.origin)
  ? window.location.origin
  : 'https://esauhr.netlify.app';

// QR generator — returns a data URL. pdfmake accepts data URLs in
// `image` fields directly.
async function generateQrDataUrl(text, sizePx = 220) {
  try {
    return await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: sizePx,
      color: { dark: '#1F4530', light: '#FFFFFF' },
    });
  } catch (err) {
    console.warn('[permission letter] QR generation failed:', err);
    return null;
  }
}

// Logo loader — fetches /evergreen-logo.jpg and returns a data URL
// suitable for pdfmake's `image` field.
async function loadLogoDataUrl() {
  try {
    const res = await fetch('/evergreen-logo.jpg');
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

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

const EXEC_CC = [
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
const C_TEXT      = '#1F1B16';
const C_MUTED     = '#5C4406';
const C_COPPER    = '#9D6B53';
const C_BRAND     = '#2D5F3F';
const C_BRAND_DK  = '#1F4530';
const C_BORDER    = '#C9B894';
const C_BANNER    = '#F4EEDF';
const C_LABEL_BG  = '#FBF6E9';
const C_PAPER     = '#FFFDF7';

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

// ─── pdfmake building blocks ─────────────────────────────────────────────────

// A label cell (left column of form rows) — bilingual EN above AR.
function labelCell(en, ar) {
  return {
    stack: [
      { text: en, bold: true, fontSize: 9, color: C_TEXT },
      { text: ar, font: 'Amiri', fontSize: 9, color: C_COPPER, alignment: 'left', margin: [0, 2, 0, 0] },
    ],
    fillColor: C_LABEL_BG,
    margin: [8, 6, 6, 6],
  };
}

// A value cell (right column).
function valueCell(text, opts = {}) {
  return {
    text: String(text ?? '—'),
    fontSize: 11,
    bold: !!opts.bold,
    color: opts.color || C_TEXT,
    margin: [10, 6, 8, 6],
  };
}

// A value cell with mixed runs (for things like APPROVED + timestamp).
function valueCellRich(content) {
  return { stack: content, margin: [10, 6, 8, 6] };
}

// Section banner — copper text on cream, with green left rail.
function sectionBanner(en, ar) {
  return {
    table: {
      widths: ['*', '*'],
      body: [[
        {
          text: en,
          bold: true, fontSize: 9, color: C_TEXT,
          fillColor: C_BANNER,
          margin: [10, 6, 6, 6],
          // left border comes from the outer layout function
        },
        {
          text: ar,
          font: 'Amiri', bold: true, fontSize: 10, color: C_COPPER,
          fillColor: C_BANNER,
          alignment: 'right',
          margin: [6, 6, 10, 6],
        },
      ]],
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: (i) => i === 0 ? 4 : 0,  // 4pt green left rail
      hLineColor: () => C_BORDER,
      vLineColor: (i) => i === 0 ? C_BRAND : C_BORDER,
      paddingLeft:   () => 0,
      paddingRight:  () => 0,
      paddingTop:    () => 0,
      paddingBottom: () => 0,
    },
    margin: [0, 0, 0, 0],
  };
}

// Form table (label + value rows). Pass an array of [labelCell, valueCell] pairs.
function formTable(rows) {
  return {
    table: {
      widths: [110, '*'],
      body: rows,
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => C_BORDER,
      vLineColor: () => C_BORDER,
      paddingLeft:   () => 0,
      paddingRight:  () => 0,
      paddingTop:    () => 0,
      paddingBottom: () => 0,
    },
  };
}

// Policy table — bilingual bullets in cream-bg cells.
function policyTable(headerEn, headerAr, bullets) {
  return {
    table: {
      widths: ['*', '*'],
      body: [
        [
          { text: headerEn, bold: true, fontSize: 7.5, color: C_MUTED, fillColor: C_LABEL_BG, margin: [10, 5, 5, 5] },
          { text: headerAr, font: 'Amiri', bold: true, fontSize: 8, color: C_MUTED, fillColor: C_LABEL_BG, alignment: 'right', margin: [5, 5, 10, 5] },
        ],
        ...bullets.map((b, i) => [
          {
            text: [
              { text: `${String(i + 1).padStart(2, '0')}.   `, bold: true, fontSize: 8, color: C_COPPER },
              { text: b.en, fontSize: 8.5, color: C_TEXT },
            ],
            fillColor: C_LABEL_BG,
            margin: [10, 5, 5, 5],
          },
          {
            text: b.ar,
            font: 'Amiri', fontSize: 9.5, color: C_MUTED,
            fillColor: C_LABEL_BG,
            alignment: 'right',
            margin: [5, 5, 10, 5],
          },
        ]),
      ],
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => C_BORDER,
      vLineColor: () => C_BORDER,
      paddingLeft:   () => 0,
      paddingRight:  () => 0,
      paddingTop:    () => 0,
      paddingBottom: () => 0,
    },
  };
}

// Signature column cell — combines header + name + footer in a single
// cell so pdfmake doesn't split across rows.
function sigCell({ en, ar, name, footerLeft, footerRight }) {
  return {
    stack: [
      // Header band
      {
        table: {
          widths: ['*'],
          body: [[
            {
              text: [
                { text: en + '   ', bold: true, fontSize: 7.5, color: C_TEXT },
                { text: ar, font: 'Amiri', fontSize: 8, color: C_COPPER },
              ],
              fillColor: C_BANNER,
              margin: [6, 5, 6, 5],
            },
          ]],
        },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
          hLineColor: () => C_BORDER,
          vLineColor: () => C_BORDER,
          paddingLeft:   () => 0, paddingRight: () => 0,
          paddingTop:    () => 0, paddingBottom: () => 0,
        },
      },
      // Body — name centered with breathing room, then a thin top
      // border separating the footer line.
      {
        table: {
          widths: ['*'],
          body: [[
            {
              stack: [
                { text: ' ', fontSize: 9 },
                { text: ' ', fontSize: 9 },
                { text: name || ' ', alignment: 'center', bold: true, fontSize: 10, color: C_TEXT, margin: [0, 0, 0, 4] },
                {
                  canvas: [{ type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, lineWidth: 0.5, lineColor: C_BORDER }],
                  alignment: 'center',
                  margin: [0, 6, 0, 4],
                },
                {
                  alignment: 'center',
                  text: [
                    { text: footerLeft || ' ', italics: true, fontSize: 7, color: C_COPPER },
                    { text: '     ', fontSize: 7 },
                    { text: footerRight, bold: true, fontSize: 7, color: C_TEXT },
                  ],
                },
              ],
              fillColor: C_PAPER,
              margin: [4, 4, 4, 4],
            },
          ]],
        },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
          hLineColor: () => C_BORDER,
          vLineColor: () => C_BORDER,
          paddingLeft:   () => 0, paddingRight: () => 0,
          paddingTop:    () => 0, paddingBottom: () => 0,
        },
      },
    ],
    unbreakable: true,
  };
}

// 4-column signature grid.
function signatureGrid(cols) {
  return {
    table: {
      widths: ['*', '*', '*', '*'],
      body: [cols.map(c => sigCell(c))],
    },
    layout: 'noBorders',
  };
}

// ─── main generator ──────────────────────────────────────────────────────────
export async function generatePermissionLetterBlob({ employee, manager, hrApprover, request }) {
  await ensureFontsLoaded();

  const typeKey  = TYPE[request.type] ? request.type : 'late_arrival';
  const typeBoth = TYPE[typeKey];

  const dept = DEPT_NAMES[employee?.department] || employee?.department || '—';
  const loc  = LOCATION_NAMES[employee?.location] || employee?.location || '—';
  const today = new Date().toISOString();
  const isApproved = request.stage === 'approved';

  // Duration in minutes — derived from time_from/time_to if present, else hours
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
  const durLabel = `${dur} min${dur === 1 ? '' : 's'}`;

  const cat = categoryFor(request.reason);
  const catLabel = REASON_CATEGORIES.find(c => c.id === cat)?.en || 'Other';

  const submittedSoon = request.requested_at && request.permission_date
    ? (new Date(request.permission_date).getTime() - new Date(request.requested_at).getTime()) >= 24 * 3600 * 1000
    : null;
  const noticePlanned = submittedSoon === true;
  const noticeLabel = noticePlanned ? 'Planned (≥24h notice)' : (submittedSoon === false ? 'Urgent (<24h notice)' : '—');

  const verifyUrl = `${VERIFY_BASE_URL}/verify/${request.id}`;
  const [logoDataUrl, qrDataUrl] = await Promise.all([
    loadLogoDataUrl(),
    generateQrDataUrl(verifyUrl, 220),
  ]);

  const generatedAt = new Date().toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  // ── Build content array ──
  const content = [];

  // HEADER ROW: logo + EVERGREEN LINE wordmark + Date/Ref
  content.push({
    columns: [
      logoDataUrl
        ? { image: logoDataUrl, width: 42, margin: [0, 0, 0, 0] }
        : { text: 'EVR', bold: true, fontSize: 16, color: C_BRAND, width: 42 },
      {
        stack: [
          { text: 'EVERGREEN LINE', bold: true, fontSize: 19, color: C_BRAND },
          { text: 'Evergreen Shipping Agency Saudi Co. (L.L.C)  ·  ESAU SADMN SUP / HR Dept', fontSize: 7.5, color: C_MUTED, margin: [0, 2, 0, 0] },
        ],
        margin: [4, 4, 0, 0],
      },
      {
        width: 130,
        stack: [
          { text: [{ text: 'Date: ', bold: true, color: C_MUTED }, { text: fmtDateMed(today) }], alignment: 'right', fontSize: 8 },
          { text: [{ text: 'Ref:  ', bold: true, color: C_MUTED }, { text: `PR-${String(request.id).padStart(5, '0')}`, bold: true }], alignment: 'right', fontSize: 8, margin: [0, 2, 0, 0] },
        ],
        margin: [0, 4, 0, 0],
      },
    ],
    columnGap: 8,
  });

  // Green double rule
  content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.4, lineColor: C_BRAND }], margin: [0, 6, 0, 0] });
  content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.4, lineColor: C_COPPER }], margin: [0, 2, 0, 6] });

  // TITLE
  content.push({
    text: [
      { text: 'Permission Request — ', bold: true, fontSize: 13, color: C_TEXT },
      { text: typeBoth.en, bold: true, italics: true, fontSize: 13, color: C_COPPER },
    ],
    margin: [0, 4, 0, 2],
  });
  content.push({
    text: `طلب استئذان · ${typeBoth.ar}`,
    font: 'Amiri',
    bold: true,
    fontSize: 9,
    color: C_BRAND,
    margin: [0, 0, 0, 8],
  });

  // EMPLOYEE INFORMATION banner + table
  content.push(sectionBanner('EMPLOYEE INFORMATION', 'معلومات الموظف'));
  content.push(formTable([
    [labelCell('Employee name',  'اسم الموظف'),     valueCell(employee?.name, { bold: true })],
    [labelCell('PSN ID',          'الرقم الوظيفي'),  valueCell(employee?.id)],
    [labelCell('Department',      'القسم'),         valueCell(`${dept}  ·  ${loc}`)],
    [labelCell('Designation',     'المسمى الوظيفي'), valueCell(employee?.designation || 'Department Member')],
  ]));

  content.push({ text: ' ', fontSize: 4 });

  // PERMISSION DETAILS banner + table
  content.push(sectionBanner('PERMISSION DETAILS', 'تفاصيل الاستئذان'));
  const timeLine = (request.time_from && request.time_to)
    ? `${request.time_from} → ${request.time_to}  ·  ${durLabel}`
    : durLabel;
  content.push(formTable([
    [labelCell('Type',     'النوع'),         valueCell(typeBoth.en, { bold: true, color: C_BRAND })],
    [labelCell('Date',     'التاريخ'),       valueCell(fmtDateLong(request.permission_date), { bold: true, color: C_BRAND })],
    [labelCell('Time',     'الوقت'),         valueCell(timeLine, { bold: true })],
    [labelCell('Category', 'الفئة'),         valueCell(catLabel)],
    [labelCell('Reason',   'السبب'),         valueCell(request.reason || '—')],
    [labelCell('Notice',   'الإشعار'),       valueCell(noticeLabel)],
    [labelCell('Submitted','تاريخ التقديم',), valueCell(fmtStampCompact(request.requested_at) || '—')],
  ]));

  content.push({ text: ' ', fontSize: 4 });

  // POLICY
  content.push(policyTable(
    'COMPANY POLICY · 3 PERMISSIONS / MONTH',
    'سياسة الشركة · 3 استئذانات / شهر',
    POLICY_BULLETS,
  ));

  content.push({ text: ' ', fontSize: 6 });

  // SIGNATURE GRID
  content.push(signatureGrid([
    {
      en: 'EMPLOYEE',  ar: 'الموظف',
      name: employee?.name || '—',
      footerLeft:  request.requested_at ? `Submitted ${fmtStampCompact(request.requested_at)}` : '',
      footerRight: 'Signature',
    },
    {
      en: 'DEPT MGR', ar: 'مدير القسم',
      name: manager?.name || '—',
      footerLeft:  request.manager_decided_at ? `Approved ${fmtStampCompact(request.manager_decided_at)}` : '',
      footerRight: 'Signature',
    },
    {
      en: 'ESAU SUP',  ar: 'الموارد البشرية',
      name: hrApprover?.name || HR_SIGNATURE.name,
      footerLeft:  request.hr_decided_at ? `Approved ${fmtStampCompact(request.hr_decided_at)}` : '',
      footerRight: 'Signature',
    },
    {
      en: 'EXEC CC',  ar: 'الإدارة التنفيذية',
      name: 'JOHN HO',
      footerLeft:  'Country Head / CEO',
      footerRight: 'HQ Stamp',
    },
  ]));

  // ── Build document definition ──
  const docDef = {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 80], // bottom space for footer
    info: {
      title: `Permission Letter ${employee?.name || ''} ${request.permission_date}`,
      author: 'ESAU HR · Leave Desk',
    },
    defaultStyle: { font: 'Roboto', fontSize: 10, color: C_TEXT },
    background: () => ({
      canvas: [{ type: 'rect', x: 0, y: 0, w: 595.28, h: 841.89, color: C_PAPER }],
    }),

    // Header — APPROVED stamp top-right when approved
    header: () => isApproved
      ? { text: '✓ APPROVED', bold: true, fontSize: 12, color: C_BRAND, alignment: 'right', margin: [0, 18, 40, 0] }
      : null,

    // Footer — generated stamp + verify URL on left, QR + label on right
    footer: () => ({
      columns: [
        {
          stack: [
            { text: `Generated on ${generatedAt} GMT+3  ·  ${hrApprover?.name || HR_SIGNATURE.name}`, italics: true, fontSize: 7, color: C_COPPER },
            { text: [
                { text: 'Verify online: ', fontSize: 6.5, color: C_MUTED },
                { text: verifyUrl, fontSize: 6.5, color: C_BRAND },
              ], margin: [0, 2, 0, 0] },
          ],
          margin: [40, 8, 0, 0],
        },
        {
          width: 70,
          stack: qrDataUrl ? [
            { image: qrDataUrl, width: 36, alignment: 'center' },
            { text: 'SCAN TO VERIFY', alignment: 'center', bold: true, fontSize: 5.5, color: C_COPPER, margin: [0, 2, 0, 0] },
          ] : [{ text: '' }],
          margin: [0, 4, 30, 0],
        },
      ],
    }),

    content,
  };

  // Generate PDF blob
  return await new Promise((resolve, reject) => {
    try {
      pdfMake.createPdf(docDef).getBlob((blob) => resolve(blob));
    } catch (err) {
      reject(err);
    }
  });
}

// ─── email draft ─────────────────────────────────────────────────────────────
export function resolveExecCcEmails(employees = []) {
  const emails = new Set();
  for (const entry of EXEC_CC) {
    if (entry.email) emails.add(entry.email);
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

// ─── download ────────────────────────────────────────────────────────────────
export async function downloadPermissionLetter({ employee, manager, hrApprover, request }) {
  const blob = await generatePermissionLetterBlob({ employee, manager, hrApprover, request });
  const fname = `Permission_${(employee?.name || 'staff').replace(/\s+/g, '_')}_${request.permission_date}.pdf`;
  downloadBlob(blob, fname);
}
