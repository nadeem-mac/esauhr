// Vacation (leave) letter — bilingual A4 form, Leave Desk brand styling.
//
// Produces a PDF Blob using pdfmake (browser-side, no server). Same
// design as the permission letter: cream paper, copper accents,
// Tahoma EVERGREEN LINE wordmark, brand colors, QR verify code,
// ✓ APPROVED stamp top-right, 4-column signature grid, KSA labor
// law policy bullets, bilingual EN/AR throughout.
//
// Same exports as the previous docx version so all callers keep working:
//   • generateVacationFormBlob(...)        → PDF Blob
//   • buildEmailDraft(...)
//   • downloadBlob(...)
//   • downloadVacationFormForRequest(...)  → triggers .pdf download

import QRCode from 'qrcode';
import pdfMake, { ensureFontsLoaded } from './pdfFontLoader.js';

const VERIFY_BASE_URL = (typeof window !== 'undefined' && window.location?.origin)
  ? window.location.origin
  : 'https://esauhr.netlify.app';

async function generateQrDataUrl(text, sizePx = 220) {
  try {
    return await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: sizePx,
      color: { dark: '#1F4530', light: '#FFFFFF' },
    });
  } catch (err) {
    console.warn('[vacation letter] QR generation failed:', err);
    return null;
  }
}

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

const LEAVE_TYPE = {
  annual:      { en: 'Annual Leave',      ar: 'إجازة سنوية' },
  sick:        { en: 'Sick Leave',        ar: 'إجازة مرضية' },
  emergency:   { en: 'Emergency Leave',   ar: 'إجازة طارئة' },
  hajj:        { en: 'Hajj Leave',        ar: 'إجازة حج' },
  maternity:   { en: 'Maternity Leave',   ar: 'إجازة وضع' },
  paternity:   { en: 'Paternity Leave',   ar: 'إجازة أبوة' },
  marriage:    { en: 'Marriage Leave',    ar: 'إجازة زواج' },
  bereavement: { en: 'Bereavement Leave', ar: 'إجازة وفاة' },
  iddah:       { en: 'Iddah Leave',       ar: 'إجازة عدة' },
  unpaid:      { en: 'Unpaid Leave',      ar: 'إجازة بدون راتب' },
  other:       { en: 'Other Leave',       ar: 'إجازة أخرى' },
};

const CEO_NAME      = 'JOHN HO';
const CEO_TITLE_EN  = 'Country Head / CEO';
const CEO_EMAIL          = 'johnho@evergreen-shipping.com.sa';
const COUNTRY_HEAD_EMAIL = 'jamesliu@evergreen-shipping.com.sa';

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
    en: 'Employees with 1+ year of service are entitled to 21 calendar days of paid annual leave; 30 days after 5 years.',
    ar: 'يستحق الموظف بعد سنة من الخدمة 21 يومًا إجازة سنوية مدفوعة، و30 يومًا بعد 5 سنوات خدمة.',
  },
  {
    en: 'Annual leave should be requested 14 days in advance; sick leave requires a valid medical certificate.',
    ar: 'تقدم طلبات الإجازة السنوية قبل 14 يومًا؛ وتتطلب الإجازة المرضية شهادة طبية معتمدة.',
  },
  {
    en: 'Substitute coverage must be arranged and accepted before the leave start date.',
    ar: 'يجب ترتيب وقبول البديل المعتمد قبل تاريخ بدء الإجازة.',
  },
];

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
const fmtStampCompact = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

const yearsOfService = (joinDate) => {
  if (!joinDate) return '—';
  const join = new Date(joinDate);
  const now = new Date();
  let y = now.getFullYear() - join.getFullYear();
  let m = now.getMonth() - join.getMonth();
  if (m < 0) { y--; m += 12; }
  if (y === 0 && m === 0) return 'Less than a month';
  if (y === 0) return `${m} month${m === 1 ? '' : 's'}`;
  return `${y} year${y === 1 ? '' : 's'}${m > 0 ? `, ${m} month${m === 1 ? '' : 's'}` : ''}`;
};

// ─── pdfmake building blocks ─────────────────────────────────────────────────

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

function valueCell(text, opts = {}) {
  return {
    text: String(text ?? '—'),
    fontSize: 11,
    bold: !!opts.bold,
    color: opts.color || C_TEXT,
    margin: [10, 6, 8, 6],
  };
}

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
      vLineWidth: (i) => i === 0 ? 4 : 0,
      hLineColor: () => C_BORDER,
      vLineColor: (i) => i === 0 ? C_BRAND : C_BORDER,
      paddingLeft:   () => 0, paddingRight:  () => 0,
      paddingTop:    () => 0, paddingBottom: () => 0,
    },
    margin: [0, 0, 0, 0],
  };
}

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
      paddingLeft:   () => 0, paddingRight: () => 0,
      paddingTop:    () => 0, paddingBottom: () => 0,
    },
  };
}

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
      paddingLeft:   () => 0, paddingRight: () => 0,
      paddingTop:    () => 0, paddingBottom: () => 0,
    },
  };
}

function sigCell({ en, ar, name, footerLeft, footerRight }) {
  return {
    stack: [
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
export async function generateVacationFormBlob({ employee, request, manager, hrApprover, substitutes = [] }) {
  await ensureFontsLoaded();

  const ltKey = LEAVE_TYPE[request.leave_type_id] ? request.leave_type_id : 'annual';
  const leaveType = LEAVE_TYPE[ltKey];

  const dept = DEPT_NAMES[employee?.department] || employee?.department || '—';
  const loc  = LOCATION_NAMES[employee?.location] || employee?.location || '—';
  const designation = employee?.designation || 'Department Member';
  const today = new Date().toISOString();
  const isApproved = request.stage === 'approved';

  const startStr = fmtDateLong(request.start_date);
  const endStr   = fmtDateLong(request.end_date);
  const isSameDay = request.start_date === request.end_date;
  const dayCount = Number(request.days || 0);
  const daysLabel = `${dayCount} day${dayCount === 1 ? '' : 's'}${request.is_half_day ? ' (half day)' : ''}`;
  const periodValue = isSameDay ? startStr : `${startStr}  →  ${endStr}`;

  const subsLabel = (substitutes && substitutes.length > 0)
    ? substitutes.map(s => `${s.name} (${s.id})`).join(', ')
    : '—';

  const verifyUrl = `${VERIFY_BASE_URL}/verify-leave/${request.id}`;
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
          { text: [{ text: 'Ref:  ', bold: true, color: C_MUTED }, { text: `LV-${String(request.id).padStart(5, '0')}`, bold: true }], alignment: 'right', fontSize: 8, margin: [0, 2, 0, 0] },
        ],
        margin: [0, 4, 0, 0],
      },
    ],
    columnGap: 8,
  });

  content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.4, lineColor: C_BRAND }], margin: [0, 6, 0, 0] });
  content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.4, lineColor: C_COPPER }], margin: [0, 2, 0, 6] });

  content.push({
    text: [
      { text: 'Leave Application — ', bold: true, fontSize: 13, color: C_TEXT },
      { text: leaveType.en, bold: true, italics: true, fontSize: 13, color: C_COPPER },
    ],
    margin: [0, 4, 0, 2],
  });
  content.push({
    text: `طلب إجازة · ${leaveType.ar}`,
    font: 'Amiri',
    bold: true,
    fontSize: 9,
    color: C_BRAND,
    margin: [0, 0, 0, 8],
  });

  // EMPLOYEE INFORMATION
  content.push(sectionBanner('EMPLOYEE INFORMATION', 'معلومات الموظف'));
  content.push(formTable([
    [labelCell('Employee name',   'اسم الموظف'),     valueCell(employee?.name, { bold: true })],
    [labelCell('PSN ID',           'الرقم الوظيفي'),  valueCell(employee?.id)],
    [labelCell('Department',       'القسم'),         valueCell(`${dept}  ·  ${loc}`)],
    [labelCell('Designation',      'المسمى الوظيفي'), valueCell(designation)],
    [labelCell('Date of joining',  'تاريخ الالتحاق'), valueCell(fmtDateMed(employee?.join_date))],
    [labelCell('Years of service', 'مدة الخدمة'),    valueCell(yearsOfService(employee?.join_date))],
  ]));

  content.push({ text: ' ', fontSize: 4 });

  // LEAVE DETAILS
  content.push(sectionBanner('LEAVE DETAILS', 'تفاصيل الإجازة'));
  content.push(formTable([
    [labelCell('Leave type',          'نوع الإجازة'),       valueCell(leaveType.en, { bold: true, color: C_BRAND })],
    [labelCell('Period',              'الفترة'),           valueCell(periodValue, { bold: true, color: C_BRAND })],
    [labelCell('Duration',            'المدة'),            valueCell(daysLabel, { bold: true })],
    [labelCell('Reason / details',    'السبب / التفاصيل'), valueCell(request.reason || '—')],
    [labelCell('Substitute coverage', 'البديل أثناء الغياب'), valueCell(subsLabel)],
    [labelCell('Submitted',           'تاريخ التقديم'),    valueCell(fmtStampCompact(request.requested_at) || '—')],
  ]));

  content.push({ text: ' ', fontSize: 4 });

  // POLICY
  content.push(policyTable(
    'LEAVE POLICY · KSA LABOR LAW',
    'سياسة الإجازات · نظام العمل السعودي',
    POLICY_BULLETS,
  ));

  content.push({ text: ' ', fontSize: 6 });

  // SIGNATURES
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
      en: 'ESAU MGT',  ar: 'الإدارة',
      name: CEO_NAME,
      footerLeft:  CEO_TITLE_EN,
      footerRight: 'HQ Stamp',
    },
  ]));

  // ── Document definition ──
  const docDef = {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 80],
    info: {
      title: `Vacation Form ${employee?.name || ''} ${request.start_date}`,
      author: 'ESAU HR · Leave Desk',
    },
    defaultStyle: { font: 'Roboto', fontSize: 10, color: C_TEXT },
    background: () => ({
      canvas: [{ type: 'rect', x: 0, y: 0, w: 595.28, h: 841.89, color: C_PAPER }],
    }),

    header: () => isApproved
      ? { text: '✓ APPROVED', bold: true, fontSize: 12, color: C_BRAND, alignment: 'right', margin: [0, 18, 40, 0] }
      : null,

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

  return await new Promise((resolve, reject) => {
    try {
      pdfMake.createPdf(docDef).getBlob((blob) => resolve(blob));
    } catch (err) {
      reject(err);
    }
  });
}

// ─── EMAIL DRAFT ─────────────────────────────────────────────────────────────
export function buildEmailDraft({ employee, request, manager, hrApprover, substitutes = [] }) {
  const leaveType = LEAVE_TYPE[request.leave_type_id] || LEAVE_TYPE.annual;
  const dateRange = `${fmtDateMed(request.start_date)} - ${fmtDateMed(request.end_date)}`;

  const to = [employee.email].filter(Boolean).join(',');
  const ccList = [
    manager?.email,
    CEO_EMAIL,
    COUNTRY_HEAD_EMAIL,
  ].filter(Boolean);
  const cc = ccList.join(',');

  const subject = `Leave approved · ${employee.name} · ${dateRange}`;

  const body = [
    `Dear ${employee.name?.split(' ')[0] || 'Colleague'},`,
    '',
    `Your ${leaveType.en.toLowerCase()} request from ${dateRange} (${request.days} day${request.days === 1 ? '' : 's'}${request.is_half_day ? ' — half day' : ''}) has been approved.`,
    '',
    `Reason on file: ${request.reason || '—'}`,
    '',
    `Coverage during your absence:`,
    ...(substitutes && substitutes.length > 0
      ? substitutes.map(s => `  • ${s.name} (${s.id})`)
      : ['  • —']),
    '',
    `The signed vacation form is attached for your records, kindly print it and get it signed by your manager and submit hard copy to HR office.`,
    '',
    `If you have any questions, please contact HR.`,
    '',
    `Thanks and regards,`,
    '',
    HR_SIGNATURE.name,
    HR_SIGNATURE.company,
    HR_SIGNATURE.unit,
    HR_SIGNATURE.address,
    `WhatsApp: ${HR_SIGNATURE.whatsapp}`,
    `Tel: ${HR_SIGNATURE.tel}`,
    `Email: ${HR_SIGNATURE.email}`,
  ].join('\n');

  const params = new URLSearchParams();
  if (cc) params.set('cc', cc);
  params.set('subject', subject);
  params.set('body', body);
  const mailto = `mailto:${encodeURIComponent(to)}?${params.toString().replace(/\+/g, '%20')}`;

  return { to, cc, subject, body, mailto };
}

// ─── helpers ─────────────────────────────────────────────────────────────────
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

function resolveApprover(decidedBy, empMap) {
  if (!decidedBy) return null;
  if (empMap[decidedBy]) return empMap[decidedBy];
  const directory = Object.values(empMap);
  return directory.find((e) => e.auth_user_id === decidedBy) || null;
}

export async function downloadVacationFormForRequest(request, empMap) {
  if (!request) throw new Error('No request supplied');
  if (!empMap)  throw new Error('Employee directory unavailable');
  const employee = empMap[request.employee_id];
  if (!employee) throw new Error('Employee not found in directory');

  const manager     = resolveApprover(request.manager_decided_by, empMap);
  const hrApprover  = resolveApprover(request.hr_decided_by,      empMap);
  const substitutes = (request.substitute_ids || [])
    .map((psn) => empMap[psn])
    .filter(Boolean);

  const blob = await generateVacationFormBlob({
    request, employee, manager, hrApprover, substitutes,
  });
  const safeName = (employee.name || request.employee_id).replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
  const filename = `Vacation_Form_${safeName}_${request.start_date}.pdf`;
  downloadBlob(blob, filename);
  return { blob, filename };
}
