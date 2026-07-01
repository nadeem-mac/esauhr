import React, { useMemo, useState, useEffect } from 'react';
import {
  CalendarDays, Coffee, Plane, Mail, Copy, ClipboardCheck,
  AlertCircle, CheckCircle2, ChevronRight, Clock, Check, ChevronDown, AlertTriangle,
  TrendingUp, ShieldCheck, X, MessageSquare, Loader2,
} from 'lucide-react';
import { directGet, directPatch, supabase } from '../supabaseClient.js';
import EvaluationReviewModal from './EvaluationReviewModal.jsx';
import ManageIncidentsModal from './ManageIncidentsModal.jsx';
import {
  weightForViolation, summariseViolations,
  REVIEW_THRESHOLD, WATCH_LOWER, BASE_SCORE,
} from '../lib/evaluationWeights.js';
import { salutationFor } from '../lib/salutations.js';
import { calculateBalance, isActiveEmployee } from '../lib/leaveLogic.js';

// =============================================================================
// CONSTANTS
// =============================================================================
const TO_JOHN = 'johnho@evergreen-shipping.com.sa';
const CC_LIST = [
  'fahad.alhussain@evergreen-shipping.com.sa',
  'badria.alhassan@evergreen-shipping.com.sa',
  'jaffar.aldarweash@evergreen-shipping.com.sa',
];
const CC_STR = CC_LIST.join(',');

// HQ-approved headcount budget, per department code (as it appears in the
// employee `department` field). Fill in the numbers HQ provides; the
// headcount report shows a "vs HQ budget" table only when this is set.
// e.g. { BIZ: 12, CSD: 18, FIN: 6, LOG: 20, SUP: 6 }
const HQ_BUDGET = {
  // BIZ: 0, CSD: 0, FIN: 0, LOG: 0, SUP: 0,
};

const MONTH_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const SIGNATURE_PLAIN = [
  '',
  'Thanks and regards,',
  ' ',
  'BASHAIER ALI',
  'Evergreen Shipping Agency Saudi Co.,(L.L.C)',
  'ESAU - SADMN SUP/ HR DEPT',
  'P.O.Box : 1008,  DAMMAM \u2013 31431, K.S.A',
  '966-54 320 9694     966-013 813 8563 \u2013 Ext 8543',
  'Email: bashaier.alsubaie@evergreen-shipping.com.sa',
].join('\n');

const SIGNATURE_HTML = `
<p style="margin:18px 0 0;color:#1F2937;font-family:Calibri,sans-serif;font-size:10pt">Thanks and regards,</p>
<p style="margin:14px 0 0;color:#1F2937;font-family:Calibri,sans-serif;font-size:10pt;line-height:1.45">
  <strong>BASHAIER ALI</strong><br/>
  Evergreen Shipping Agency Saudi Co.,(L.L.C)<br/>
  ESAU - SADMN SUP/ HR DEPT<br/>
  P.O.Box : 1008,  DAMMAM &#8211; 31431, K.S.A<br/>
  966-54 320 9694 &nbsp;&nbsp;&nbsp;&nbsp; 966-013 813 8563 &#8211; Ext 8543<br/>
  <strong>Email:</strong> <a href="mailto:bashaier.alsubaie@evergreen-shipping.com.sa" style="color:#2D5F3F">bashaier.alsubaie@evergreen-shipping.com.sa</a>
</p>`;

// Blank spacer paragraph — Outlook strips <p> margins on paste, so real
// spacing between blocks must be an empty paragraph it will keep.
const PSP = '<p style="margin:0;font-size:10pt;line-height:1;mso-line-height-rule:exactly">&nbsp;</p>';
// Assemble an email body from HTML blocks, separated by blank spacers, with
// the signature appended once (one spacer before it — no extra blank line
// inside the signature itself).
function emailBody(blocks) {
  const inner = blocks.filter(Boolean).join(PSP);
  return `<div style="font-family:Calibri,sans-serif;color:#1F2937;font-size:10pt;line-height:1.4">${inner}${PSP}${SIGNATURE_HTML}</div>`;
}

// =============================================================================
// HELPERS
// =============================================================================
function fmtDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function pad2(n) { return String(n).padStart(2, '0'); }
function todayISO() { return new Date().toISOString().slice(0, 10); }

// Pad string to width with right-padding spaces
function padR(s, n) {
  s = String(s == null ? '' : s);
  if (s.length >= n) return s.slice(0, n - 1) + '\u2026';
  return s + ' '.repeat(n - s.length);
}

// Build a plain-text monospaced table
function plainTable(headers, rows, widths, totalRow = null) {
  const sep = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
  const renderRow = (cols) => '| ' + cols.map((c, i) => padR(c, widths[i])).join(' | ') + ' |';
  return [
    sep,
    renderRow(headers),
    sep,
    ...rows.map(renderRow),
    ...(totalRow ? [sep, renderRow(totalRow)] : []),
    sep,
  ].join('\n');
}

// Build an HTML table for clipboard
function htmlTable(headers, rows, hdr = { bg: '#334155', fg: '#FFFFFF' }, totalRow = null) {
  const th = headers.map(h => `<th style="background:${hdr.bg};color:${hdr.fg};padding:1px 6px;text-align:left;font-family:Calibri,sans-serif;font-weight:700;font-size:10pt;border:1px solid ${hdr.bg};white-space:nowrap">${escapeHtml(h)}</th>`).join('');
  const trs = rows.map((r, i) => {
    const bg = i % 2 === 0 ? '#FFFFFF' : '#F3F4F6';
    const tds = r.map(c => `<td style="padding:0 6px;border:1px solid #D1D5DB;color:#1F2937;font-family:Calibri,sans-serif;font-size:10pt;background:${bg};white-space:nowrap">${escapeHtml(c == null ? '' : String(c))}</td>`).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  const totalTr = totalRow
    ? `<tr>${totalRow.map(c => `<td style="padding:1px 6px;border:1px solid #D1D5DB;color:#0A0A0A;font-family:Calibri,sans-serif;font-size:10pt;font-weight:700;background:#FBEAF0;white-space:nowrap">${escapeHtml(c == null ? '' : String(c))}</td>`).join('')}</tr>`
    : '';
  return `<table cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;font-family:Calibri,sans-serif;margin:0">
    <thead><tr>${th}</tr></thead>
    <tbody>${trs}${totalTr}</tbody>
  </table>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Format a leave-type code as a friendly label
const LEAVE_TYPE_LABELS = {
  annual: 'Annual', sick: 'Sick', emergency: 'Emergency',
  hajj: 'Hajj', maternity: 'Maternity', paternity: 'Paternity',
  marriage: 'Marriage', bereavement: 'Bereavement',
  iddah: 'Iddah', unpaid: 'Unpaid', other: 'Other',
};
function leaveTypeLabel(id) {
  return LEAVE_TYPE_LABELS[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Leave');
}

const PERM_TYPE_LABELS = {
  late_arrival: 'Late arrival',
  early_leave:  'Early leave',
};

// Compute return date = day after end_date, formatted
function returnDateFromEnd(endIso) {
  if (!endIso) return '';
  const d = new Date(endIso);
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// =============================================================================
// EMAIL BUILDERS
// =============================================================================

// Task 1: Mid-month permissions update (1 to today)
function buildMidMonthPermissions({ permissions, employees, year, month, today, hdr }) {
  const ms = pad2(month);
  const todayDay = today.getDate();
  const empMap = {};
  (employees || []).forEach(e => { empMap[e.id] = e; });

  const rows = (permissions || []).filter(p => {
    if (p.status !== 'approved' && p.status !== 'pending') return false;
    if (!p.permission_date?.startsWith(`${year}-${ms}`)) return false;
    const day = Number(p.permission_date.split('-')[2]);
    return day >= 1 && day <= todayDay;
  }).sort((a, b) => new Date(a.permission_date) - new Date(b.permission_date));

  const peopleSet = new Set(rows.map(r => r.employee_id));
  const totalHours = rows.reduce((s, r) => s + Number(r.hours || 0), 0);

  // Per-employee hours used this month (against the 3-hour quota).
  const usedByEmp = {};
  rows.forEach(r => { usedByEmp[r.employee_id] = (usedByEmp[r.employee_id] || 0) + Number(r.hours || 0); });

  const tableRows = rows.map(p => {
    const emp = empMap[p.employee_id];
    const used = usedByEmp[p.employee_id] || 0;
    return [
      fmtDateShort(p.permission_date),
      emp?.name || p.employee_id,
      emp?.department || '',
      PERM_TYPE_LABELS[p.type] || p.type || '',
      Number(p.hours || 0).toFixed(1) + 'h',
      `${used.toFixed(1)} / 3h${used > 3 ? ' ⚠' : ''}`,
      p.status?.charAt(0).toUpperCase() + p.status?.slice(1),
      p.reason || '',
    ];
  });
  const headers = ['Date', 'Employee', 'Dept', 'Type', 'Hours', 'Quota used', 'Status', 'Reason'];
  const widths = [12, 30, 6, 14, 6, 11, 9, 30];
  const tablePlain = rows.length > 0 ? plainTable(headers, tableRows, widths) : '(No permission applications recorded so far this month.)';
  const tableHtml = rows.length > 0 ? htmlTable(headers, tableRows, hdr) : '<p style="color:#6B7280;font-style:italic">No permission applications recorded so far this month.</p>';

  const monthName = MONTH_FULL[month - 1];
  const range = `1\u201315 ${monthName} ${year}`;

  const subject = `Permissions Report - Mid-Month Update - ${monthName} ${year}`;

  const intro = [
    `Dear Mr John,`,
    '',
    `Please find below the mid-month report of permission applications submitted by staff so far this month (${range}). The list covers all late arrivals and early leaves recorded, with hours and approval status against the monthly quota of 3 hours per employee.`,
    '',
  ].join('\n');

  const totalsLine = `Total this period: ${rows.length} application${rows.length === 1 ? '' : 's'}, ${totalHours.toFixed(1)} hours, ${peopleSet.size} unique staff`;

  const closing = [
    '',
    `The full month-end report will follow at month-end.`,
  ].join('\n');

  const bodyPlain = intro + tablePlain + '\n\n' + totalsLine + closing + SIGNATURE_PLAIN;

  const bodyHtml = emailBody([
    `<p style="margin:0">Dear Mr John,</p>`,
    `<p style="margin:0">Please find below the mid-month report of permission applications submitted by staff so far this month (${escapeHtml(range)}). The list covers all late arrivals and early leaves recorded, with hours and approval status against the monthly quota of 3 hours per employee.</p>`,
    tableHtml,
    `<p style="margin:0;font-weight:600;color:#334155">${escapeHtml(totalsLine)}</p>`,
    `<p style="margin:0">The full month-end report will follow at month-end.</p>`,
  ]);

  return { subject, bodyPlain, bodyHtml, count: rows.length };
}

// Task 2: End-of-month permissions report (whole month)
function buildEndOfMonthPermissions({ permissions, employees, year, month, hdr }) {
  const ms = pad2(month);
  const empMap = {};
  (employees || []).forEach(e => { empMap[e.id] = e; });

  const rows = (permissions || []).filter(p => {
    if (p.status !== 'approved' && p.status !== 'pending') return false;
    return p.permission_date?.startsWith(`${year}-${ms}`);
  }).sort((a, b) => new Date(a.permission_date) - new Date(b.permission_date));

  const peopleSet = new Set(rows.map(r => r.employee_id));
  const totalHours = rows.reduce((s, r) => s + Number(r.hours || 0), 0);
  const lateCount  = rows.filter(p => p.type === 'late_arrival').length;
  const earlyCount = rows.filter(p => p.type === 'early_leave').length;

  // Per-employee hours used this month (against the 3-hour quota).
  const usedByEmp = {};
  rows.forEach(r => { usedByEmp[r.employee_id] = (usedByEmp[r.employee_id] || 0) + Number(r.hours || 0); });

  const tableRows = rows.map(p => {
    const emp = empMap[p.employee_id];
    const used = usedByEmp[p.employee_id] || 0;
    return [
      fmtDateShort(p.permission_date),
      emp?.name || p.employee_id,
      emp?.department || '',
      PERM_TYPE_LABELS[p.type] || p.type || '',
      Number(p.hours || 0).toFixed(1) + 'h',
      `${used.toFixed(1)} / 3h${used > 3 ? ' ⚠' : ''}`,
      p.status?.charAt(0).toUpperCase() + p.status?.slice(1),
      p.reason || '',
    ];
  });
  const headers = ['Date', 'Employee', 'Dept', 'Type', 'Hours', 'Quota used', 'Status', 'Reason'];
  const widths = [12, 30, 6, 14, 6, 11, 9, 30];
  const tablePlain = rows.length > 0 ? plainTable(headers, tableRows, widths) : '(No permission applications recorded for this month.)';
  const tableHtml = rows.length > 0 ? htmlTable(headers, tableRows, hdr) : '<p style="color:#6B7280;font-style:italic">No permission applications recorded for this month.</p>';

  const monthName = MONTH_FULL[month - 1];
  const subject = `Permissions Report - Month-End - ${monthName} ${year}`;

  const totalsLine = `Total for ${monthName} ${year}: ${rows.length} application${rows.length === 1 ? '' : 's'}, ${totalHours.toFixed(1)} hours, ${peopleSet.size} unique staff (${lateCount} late arrival${lateCount === 1 ? '' : 's'}, ${earlyCount} early leave${earlyCount === 1 ? '' : 's'})`;

  const intro = [
    `Dear Mr John,`,
    '',
    `Please find below the full month-end report of permission applications submitted by staff during ${monthName} ${year}. The list covers all late arrivals and early leaves recorded for the month, with hours and approval status against the monthly quota of 3 hours per employee.`,
    '',
  ].join('\n');

  const closing = [
    '',
    `Please let me know if you would like any breakdown by department, by type, or by individual employee.`,
  ].join('\n');

  const bodyPlain = intro + tablePlain + '\n\n' + totalsLine + closing + SIGNATURE_PLAIN;

  const bodyHtml = emailBody([
    `<p style="margin:0">Dear Mr John,</p>`,
    `<p style="margin:0">Please find below the full month-end report of permission applications submitted by staff during ${escapeHtml(monthName + ' ' + year)}. The list covers all late arrivals and early leaves recorded for the month, with hours and approval status against the monthly quota of 3 hours per employee.</p>`,
    tableHtml,
    `<p style="margin:0;font-weight:600;color:#334155">${escapeHtml(totalsLine)}</p>`,
    `<p style="margin:0">Please let me know if you would like any breakdown by department, by type, or by individual employee.</p>`,
  ]);

  return { subject, bodyPlain, bodyHtml, count: rows.length };
}

// Task 3: Last month vacation summary (with return dates)
function buildVacationSummary({ requests, employees, year, month, hdr }) {
  const ms = pad2(month);
  const monthStart = `${year}-${ms}-01`;
  const next = new Date(year, month, 0); // last day of month
  const monthEnd = `${year}-${ms}-${pad2(next.getDate())}`;
  const empMap = {};
  (employees || []).forEach(e => { empMap[e.id] = e; });

  // Approved leaves whose date range overlaps the month
  const rows = (requests || []).filter(r => {
    if (r.status !== 'approved' && r.stage !== 'approved') return false;
    if (!r.start_date || !r.end_date) return false;
    return r.start_date <= monthEnd && r.end_date >= monthStart;
  }).sort((a, b) => new Date(a.start_date) - new Date(b.start_date));

  const peopleSet = new Set(rows.map(r => r.employee_id));
  const totalDays = rows.reduce((s, r) => s + Number(r.days || 0), 0);

  const tableRows = rows.map(r => {
    const emp = empMap[r.employee_id];
    return [
      emp?.name || r.employee_id,
      emp?.department || '',
      leaveTypeLabel(r.leave_type_id),
      fmtDateShort(r.start_date),
      fmtDateShort(r.end_date),
      returnDateFromEnd(r.end_date),
      Number(r.days || 0).toFixed(1),
    ];
  });
  const headers = ['Employee', 'Dept', 'Type', 'Start', 'End', 'Return', 'Days'];
  const widths = [30, 6, 12, 12, 12, 12, 5];
  const tablePlain = rows.length > 0 ? plainTable(headers, tableRows, widths) : '(No vacation applications recorded for last month.)';
  const tableHtml = rows.length > 0 ? htmlTable(headers, tableRows, hdr) : '<p style="color:#6B7280;font-style:italic">No vacation applications recorded for last month.</p>';

  const monthName = MONTH_FULL[month - 1];
  const subject = `Vacation Summary - ${monthName} ${year}`;

  const totalsLine = `Total for ${monthName} ${year}: ${rows.length} application${rows.length === 1 ? '' : 's'}, ${totalDays.toFixed(1)} days, ${peopleSet.size} unique staff`;

  const intro = [
    `Dear Mr John,`,
    '',
    `Please find below the summary of vacation applications taken by staff during ${monthName} ${year}, including their return dates. This covers all approved leaves that overlap with the month.`,
    '',
  ].join('\n');

  const closing = [
    '',
    `Please let me know if you would like any further breakdown by department or by individual employee.`,
  ].join('\n');

  const bodyPlain = intro + tablePlain + '\n\n' + totalsLine + closing + SIGNATURE_PLAIN;

  const bodyHtml = `
    <div style="font-family:Calibri,sans-serif;color:#1F2937;font-size:10pt;line-height:1.5">
      <p>Dear Mr John,</p>
      <p>Please find below the summary of vacation applications taken by staff during ${escapeHtml(monthName + ' ' + year)}, including their return dates. This covers all approved leaves that overlap with the month.</p>
      ${tableHtml}
      <p style="font-weight:600;color:#334155">${escapeHtml(totalsLine)}</p>
      <p>Please let me know if you would like any further breakdown by department or by individual employee.</p>
      ${SIGNATURE_HTML}
    </div>`;

  return { subject, bodyPlain, bodyHtml, count: rows.length };
}

// Task: Headcount snapshot — enriched. Active staff with Saudization
// (Saudi vs Non-Saudi) ratio, gender split, and location/department
// breakdowns that each carry the nationality + gender split.
function buildHeadcountSnapshot({ employees, hdr }) {
  const active = (employees || []).filter(e => {
    const s = String(e.employment_status || '').toLowerCase();
    return !['deactivated', 'departed', 'terminated', 'resigned', 'inactive'].includes(s);
  });
  const total = active.length || 0;
  const isSaudi = (e) => /saudi/i.test(String(e.nationality_full || e.nationality || ''));
  const genderOf = (e) => {
    const g = String(e.gender || '').trim().toLowerCase();
    if (g.startsWith('f') || g === 'female' || g === 'w') return 'Female';
    if (g.startsWith('m') || g === 'male') return 'Male';
    return 'Unspecified';
  };
  const pct = (n) => total ? `${Math.round((n / total) * 1000) / 10}%` : '0%';

  // Headline counts
  const saudis = active.filter(isSaudi).length;
  const nonSaudis = total - saudis;
  const females = active.filter(e => genderOf(e) === 'Female').length;
  const males = active.filter(e => genderOf(e) === 'Male').length;
  const unspec = total - females - males;

  // Group helper → { key: {n, saudi, non, f, m} }
  const group = (keyFn) => {
    const map = {};
    active.forEach(e => {
      const k = keyFn(e) || '—';
      const g = map[k] || (map[k] = { n: 0, saudi: 0, non: 0, f: 0, m: 0 });
      g.n += 1;
      if (isSaudi(e)) g.saudi += 1; else g.non += 1;
      const gen = genderOf(e);
      if (gen === 'Female') g.f += 1; else if (gen === 'Male') g.m += 1;
    });
    return map;
  };
  const locG = group(e => e.location);
  const depG = group(e => e.department);
  const toRows = (map) => Object.entries(map)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([k, v]) => [k, String(v.n), pct(v.n), String(v.saudi), String(v.non), String(v.f), String(v.m)]);
  const locRows = toRows(locG);
  const depRows = toRows(depG);

  const natRows = [
    ['Saudi', String(saudis), pct(saudis)],
    ['Non-Saudi', String(nonSaudis), pct(nonSaudis)],
  ];
  const genRows = [
    ['Female', String(females), pct(females)],
    ['Male', String(males), pct(males)],
    ...(unspec ? [['Unspecified', String(unspec), pct(unspec)]] : []),
  ];

  const SPLIT_HEAD = ['', 'Staff', 'Share', 'Saudi', 'Non-Saudi', 'F', 'M'];
  const locHead = ['Location', ...SPLIT_HEAD.slice(1)];
  const depHead = ['Department', ...SPLIT_HEAD.slice(1)];

  const locTotal = ['Total', String(total), '100%', String(saudis), String(nonSaudis), String(females), String(males)];
  const depTotal = ['Total', String(total), '100%', String(saudis), String(nonSaudis), String(females), String(males)];
  const natTotal = ['Total', String(total), '100%'];
  const genTotal = ['Total', String(total), '100%'];

  // Plain-text
  const locPlain = plainTable(locHead, locRows, [16, 7, 7, 7, 10, 5, 5], locTotal);
  const depPlain = plainTable(depHead, depRows, [16, 7, 7, 7, 10, 5, 5], depTotal);
  const natPlain = plainTable(['Nationality', 'Staff', 'Share'], natRows, [16, 8, 8], natTotal);
  const genPlain = plainTable(['Gender', 'Staff', 'Share'], genRows, [16, 8, 8], genTotal);
  // HTML
  const locHtml = htmlTable(locHead, locRows, hdr, locTotal);
  const depHtml = htmlTable(depHead, depRows, hdr, depTotal);
  const natHtml = htmlTable(['Nationality', 'Staff', 'Share'], natRows, hdr, natTotal);
  const genHtml = htmlTable(['Gender', 'Staff', 'Share'], genRows, hdr, genTotal);

  const saudiRatio = total ? Math.round((saudis / total) * 1000) / 10 : 0;

  // Headcount vs HQ budget (by department) — only when HQ_BUDGET is filled.
  const budgetKeys = Object.keys(HQ_BUDGET || {});
  const hasBudget = budgetKeys.length > 0;
  let budgetHtml = '', budgetPlain = '', budgetKpi = '';
  if (hasBudget) {
    const deptKeys = [...new Set([...budgetKeys, ...Object.keys(depG)])].sort();
    let budTot = 0, actTot = 0;
    const bRows = deptKeys.map(d => {
      const bud = Number(HQ_BUDGET[d] || 0);
      const act = depG[d]?.n || 0;
      budTot += bud; actTot += act;
      const variance = act - bud;
      const fill = bud ? `${Math.round((act / bud) * 1000) / 10}%` : '—';
      return [d, String(bud), String(act), (variance > 0 ? '+' : '') + variance, fill];
    });
    const bHead = ['Department', 'Budget', 'Actual', 'Variance', 'Fill %'];
    const bTotal = ['Total', String(budTot), String(actTot), (actTot - budTot > 0 ? '+' : '') + (actTot - budTot), budTot ? `${Math.round((actTot / budTot) * 1000) / 10}%` : '—'];
    budgetPlain = plainTable(bHead, bRows, [16, 8, 8, 9, 8], bTotal);
    budgetHtml = htmlTable(bHead, bRows, hdr, bTotal);
    budgetKpi = `  ·  Budget ${budTot} / Actual ${actTot} (${budTot ? Math.round((actTot / budTot) * 1000) / 10 : 0}% filled)`;
  }

  const subject = `Headcount Snapshot - ${fmtDateShort(todayISO())}`;
  const kpiLine = `Total active staff: ${total}  ·  Saudization ratio: ${saudiRatio}% (Saudi ${saudis} / Non-Saudi ${nonSaudis})  ·  Female ${females} (${pct(females)}) / Male ${males} (${pct(males)})${budgetKpi}`;

  const intro = [`Dear Mr John,`, '',
    `Please find below the current headcount snapshot of active staff, with the Saudization ratio, gender split, and breakdowns by location and department (each showing the nationality and gender split).`, ''].join('\n');
  const bodyPlain = intro
    + kpiLine + '\n\n'
    + (hasBudget ? 'Headcount vs HQ budget (by department):\n' + budgetPlain + '\n\n' : '')
    + 'Saudization (nationality) ratio:\n' + natPlain + '\n\n'
    + 'Gender split:\n' + genPlain + '\n\n'
    + 'By location:\n' + locPlain + '\n\n'
    + 'By department:\n' + depPlain + SIGNATURE_PLAIN;
  const bodyHtml = emailBody([
    `<p style="margin:0">Dear Mr John,</p>`,
    `<p style="margin:0">Please find below the current headcount snapshot of active staff, with the Saudization ratio, gender split, and breakdowns by location and department (each showing the nationality and gender split).</p>`,
    `<p style="margin:0;font-weight:700;color:#334155">${escapeHtml(kpiLine)}</p>`,
    ...(hasBudget ? [`<p style="margin:0;font-weight:600">Headcount vs HQ budget (by department)</p>`, budgetHtml] : []),
    `<p style="margin:0;font-weight:600">Saudization (nationality) ratio</p>`,
    natHtml,
    `<p style="margin:0;font-weight:600">Gender split</p>`,
    genHtml,
    `<p style="margin:0;font-weight:600">By location</p>`,
    locHtml,
    `<p style="margin:0;font-weight:600">By department</p>`,
    depHtml,
  ]);
  return { subject, bodyPlain, bodyHtml, count: total };
}

// Task: Upcoming leaves — approved leaves starting in the next 30 days.
function buildUpcomingLeaves({ requests, employees, today, hdr }) {
  const start = today;
  const end = new Date(new Date(today).getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const empMap = {}; (employees || []).forEach(e => { empMap[e.id] = e; });
  const rows = (requests || []).filter(r => {
    if (r.status !== 'approved' && r.stage !== 'approved') return false;
    if (!r.start_date) return false;
    return r.start_date >= start && r.start_date <= end;
  }).sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
  const tableRows = rows.map(r => {
    const e = empMap[r.employee_id];
    return [e?.name || r.employee_id, e?.department || '', leaveTypeLabel(r.leave_type_id),
            fmtDateShort(r.start_date), fmtDateShort(r.end_date), returnDateFromEnd(r.end_date), Number(r.days || 0).toFixed(1)];
  });
  const headers = ['Employee', 'Dept', 'Type', 'Start', 'End', 'Return', 'Days'];
  const widths = [30, 6, 12, 12, 12, 12, 5];
  const tablePlain = rows.length ? plainTable(headers, tableRows, widths) : '(No leaves scheduled in the next 30 days.)';
  const tableHtml  = rows.length ? htmlTable(headers, tableRows, hdr) : '<p style="color:#6B7280;font-style:italic">No leaves scheduled in the next 30 days.</p>';
  const totalDays = rows.reduce((s, r) => s + Number(r.days || 0), 0);
  const subject = `Upcoming Leaves - Next 30 Days`;
  const totalsLine = `${rows.length} upcoming leave${rows.length === 1 ? '' : 's'}, ${totalDays.toFixed(1)} days, ${new Set(rows.map(r => r.employee_id)).size} staff`;
  const intro = [`Dear Mr John,`, '', `Please find below the staff leaves scheduled to start within the next 30 days, for planning cover.`, ''].join('\n');
  const bodyPlain = intro + tablePlain + '\n\n' + totalsLine + SIGNATURE_PLAIN;
  const bodyHtml = `
    <div style="font-family:Calibri,sans-serif;color:#1F2937;font-size:10pt;line-height:1.5">
      <p>Dear Mr John,</p>
      <p>Please find below the staff leaves scheduled to start within the next 30 days, for planning cover.</p>
      ${tableHtml}
      <p style="font-weight:600;color:#334155">${escapeHtml(totalsLine)}</p>
      ${SIGNATURE_HTML}
    </div>`;
  return { subject, bodyPlain, bodyHtml, count: rows.length };
}

// Task (fan-out): one email per department head with their team's leave
// applications + annual balances (including the manager's own). Each email
// is addressed to that manager only, CC the fixed oversight list + James.
function buildDeptHeadLeaveReports({ employees, requests, balances, leaveTypes, year, jamesEmail, hdr }) {
  const annualType = (leaveTypes || []).find(t => t.id === 'annual') || { id: 'annual', default_days: 21 };
  const active = (employees || []).filter(isActiveEmployee);
  const byId = {}; (employees || []).forEach(e => { byId[e.id] = e; });

  // Managers = anyone who is the manager_id of ≥1 active employee.
  const managerIds = [...new Set(active.map(e => e.manager_id).filter(Boolean))];

  const balOf = (emp) => calculateBalance({
    employee: emp, leaveType: annualType, year, requests,
    adjustments: (balances || []).find(b => b.employee_id === emp.id && b.leave_type_id === 'annual' && b.year === year) || {},
  });
  const leavesOf = (empId) => (requests || [])
    .filter(r => r.employee_id === empId && r.start_date && new Date(r.start_date).getFullYear() === year)
    .sort((a, b) => new Date(a.start_date) - new Date(b.start_date));

  const ccBase = [TO_JOHN, ...CC_LIST, jamesEmail].filter(Boolean);

  const managers = managerIds.map(mid => {
    const manager = byId[mid];
    if (!manager) return null;
    const reports = active.filter(e => e.manager_id === mid);
    // People = the manager + their direct reports (manager's own included).
    const people = [manager, ...reports].filter((p, i, arr) => arr.findIndex(x => x.id === p.id) === i);

    // Balance table rows. Available is shown as Entitled + Carried − Used
    // so it always reconciles with the visible columns (the stored
    // leave_balances 'adjustment' field was double-counting prior usage
    // and pushing Available negative). Pending is omitted per Nadeem.
    const balRows = people.map(p => {
      const b = balOf(p);
      const avail = Number(b.entitlement) + Number(b.carried) - Number(b.used);
      return [p.name || p.id, p.department || '', String(b.entitlement), String(b.carried), String(b.used), String(Math.round(avail * 10) / 10)];
    });
    const balHeaders = ['Employee', 'Dept', 'Entitled', 'Carried', 'Used', 'Available'];
    const balWidths  = [28, 6, 9, 8, 6, 10];

    // Leave-application rows (this year)
    const appRows = [];
    people.forEach(p => {
      leavesOf(p.id).forEach(r => {
        appRows.push([
          p.name || p.id,
          leaveTypeLabel(r.leave_type_id),
          fmtDateShort(r.start_date),
          fmtDateShort(r.end_date),
          returnDateFromEnd(r.end_date),
          Number(r.days || 0).toFixed(1),
          (r.status || r.stage || '').replace(/_/g, ' '),
        ]);
      });
    });
    const appHeaders = ['Employee', 'Type', 'Start', 'End', 'Return', 'Days', 'Status'];
    const appWidths  = [28, 12, 11, 11, 11, 5, 12];

    const balPlain = plainTable(balHeaders, balRows, balWidths);
    const appPlain = appRows.length ? plainTable(appHeaders, appRows, appWidths) : '(No leave applications recorded this year.)';
    const balHtmlT = htmlTable(balHeaders, balRows, hdr);
    const appHtmlT = appRows.length ? htmlTable(appHeaders, appRows, hdr) : '<p style="color:#6B7280;font-style:italic">No leave applications recorded this year.</p>';

    const subject = `Team Leave & Annual Balance — ${manager.name} (${year})`;
    const intro = [
      `Dear ${salutationFor(manager)},`,
      '',
      `Please find below the annual-leave balances and the leave applications recorded this year for your team (including your own), for your review and planning.`,
      '',
    ].join('\n');
    const bodyPlain = intro + 'Annual balances:\n' + balPlain + '\n\nLeave applications this year:\n' + appPlain + '\n' + SIGNATURE_PLAIN;
    const bodyHtml = emailBody([
      `<p style="margin:0">Dear ${escapeHtml(salutationFor(manager))},</p>`,
      `<p style="margin:0">Please find below the annual-leave balances and the leave applications recorded this year for your team (including your own), for your review and planning.</p>`,
      `<p style="margin:0;font-weight:600">Annual balances</p>`,
      balHtmlT,
      `<p style="margin:0;font-weight:600">Leave applications this year</p>`,
      appHtmlT,
    ]);

    // CC oversight list, minus the manager themselves if present.
    const cc = ccBase.filter(addr => addr && addr.toLowerCase() !== String(manager.email || '').toLowerCase());

    return {
      id: manager.id,
      name: manager.name,
      dept: manager.department || '',
      to: manager.email || '',
      cc,
      teamSize: people.length,
      appCount: appRows.length,
      subject, bodyPlain, bodyHtml,
    };
  }).filter(Boolean).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return { fanout: true, managers, count: managers.length };
}

// =============================================================================
// TASK STATUS LOGIC
// =============================================================================
function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function computeTaskStatus(taskKey, today) {
  const day = today.getDate();
  const month = today.getMonth() + 1;
  const year = today.getFullYear();
  const lastDay = lastDayOfMonth(year, month);

  if (taskKey === 'mid_month_perms') {
    // Available 14th onward, due 15th, overdue from 16th to end of month
    if (day < 14) return { state: 'upcoming', due: `Due in ${15 - day} day${15 - day === 1 ? '' : 's'}`, color: '#9CA3AF', bg: '#F3F4F6' };
    if (day === 14) return { state: 'due_tomorrow', due: 'Due tomorrow', color: '#5A8A9A', bg: '#DBEAFE' };
    if (day === 15) return { state: 'due_today',    due: 'Due today',    color: '#15803D', bg: '#DCFCE7' };
    if (day <= lastDay) return { state: 'overdue',  due: `${day - 15} day${day - 15 === 1 ? '' : 's'} overdue`, color: '#B83A2E', bg: '#FEE2E2' };
    return { state: 'idle', due: 'Next on the 15th', color: '#9CA3AF', bg: '#F3F4F6' };
  }

  if (taskKey === 'end_of_month_perms') {
    // Due last day of month
    const daysToEnd = lastDay - day;
    if (daysToEnd > 3) return { state: 'upcoming', due: `Due in ${daysToEnd} days`, color: '#9CA3AF', bg: '#F3F4F6' };
    if (daysToEnd > 0) return { state: 'due_soon', due: `Due in ${daysToEnd} day${daysToEnd === 1 ? '' : 's'}`, color: '#5A8A9A', bg: '#DBEAFE' };
    if (daysToEnd === 0) return { state: 'due_today', due: 'Due today', color: '#15803D', bg: '#DCFCE7' };
    return { state: 'overdue', due: 'Overdue', color: '#B83A2E', bg: '#FEE2E2' };
  }

  if (taskKey === 'last_month_vacation') {
    // Available 1st-7th of new month
    if (day === 1) return { state: 'due_today', due: 'Due today', color: '#15803D', bg: '#DCFCE7' };
    if (day <= 7)  return { state: 'available',  due: `${day - 1} day${day - 1 === 1 ? '' : 's'} since due`, color: '#92400E', bg: '#FEF3C7' };
    if (day < 25)  return { state: 'idle',       due: 'Sent (next on the 1st)', color: '#9CA3AF', bg: '#F3F4F6' };
    return { state: 'upcoming', due: `Due in ${lastDay - day + 1} day${lastDay - day + 1 === 1 ? '' : 's'}`, color: '#9CA3AF', bg: '#F3F4F6' };
  }

  return { state: 'idle', due: '', color: '#9CA3AF', bg: '#F3F4F6' };
}

// Leave & Availability — who's on leave this month (current / upcoming /
// returned), in the Leave Report style Bashaier prefers. (Nadeem 2026-06-08)
function buildLeaveAvailability({ requests, employees, year, month, today, lastPunch = {}, hdr = { bg: '#334155', fg: '#FFFFFF' } }) {
  const ms = pad2(month);
  const monthStart = `${year}-${ms}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const monthEnd = `${year}-${ms}-${pad2(lastDay)}`;
  const todayStr = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
  const empMap = {};
  (employees || []).forEach(e => { empMap[e.id] = e; });

  const rows = (requests || []).filter(r => {
    const stage = r.stage || r.status;
    if (stage !== 'approved') return false;
    if (!r.start_date || !r.end_date) return false;
    return r.start_date <= monthEnd && r.end_date >= monthStart;
  }).map(r => {
    const e = empMap[r.employee_id];
    const status = r.return_stage === 'approved' ? 'returned'
                 : r.start_date > todayStr ? 'upcoming'
                 : r.end_date < todayStr ? (r.leave_type_id === 'sick' ? 'returned' : 'ended')
                 : 'now';
    return {
      psn: r.employee_id, name: e?.name || r.employee_id, dept: e?.department || '', loc: e?.location || '',
      typeId: r.leave_type_id, typeName: leaveTypeLabel(r.leave_type_id), from: r.start_date, to: r.end_date,
      days: Number(r.days || 0), isHalf: !!r.is_half_day, status,
    };
  }).sort((a, b) => a.loc.localeCompare(b.loc) || a.dept.localeCompare(b.dept) || a.name.localeCompare(b.name));

  const monthName = MONTH_FULL[month - 1];
  const peopleSet = new Set(rows.map(r => r.psn));
  const outNow = rows.filter(r => r.status === 'now').length;
  const upcoming = rows.filter(r => r.status === 'upcoming').length;
  const STATUS_TEXT = { now: 'OUT NOW', upcoming: 'UPCOMING', returned: 'RETURNED', ended: 'ENDED' };

  // Last punch (date + time), only when it's on/after the leave end — i.e.
  // genuine return evidence — and only for returned/ended rows.
  const punchFor = (r) => {
    if (r.status !== 'returned' && r.status !== 'ended') return '';
    const lp = lastPunch[r.psn];
    if (!lp || !r.to || lp.date < r.to) return '';
    return `${fmtDateShort(lp.date)} \u00B7 ${String(lp.time).slice(0, 5)}`;
  };

  const headers = ['PSN', 'Name', 'Dept', 'Loc', 'Leave Type', 'From', 'To', 'Days', 'Status', 'Last Punch'];
  const widths  = [8, 28, 6, 5, 12, 11, 11, 6, 9, 14];
  const plainRows = rows.map(r => [r.psn, r.name, r.dept, r.loc, r.typeName, fmtDateShort(r.from), fmtDateShort(r.to), r.days.toFixed(1) + (r.isHalf ? ' \u00BD' : ''), STATUS_TEXT[r.status], punchFor(r) || '-']);
  const tablePlain = rows.length ? plainTable(headers, plainRows, widths) : '(No approved leave overlapping this month.)';

  // HTML in the Leave Report style — status pills kept (the look Bashaier likes).
  const pill = (st) => {
    const m = { now: { bg: '#FEE2E2', fg: '#991B1B', label: 'OUT NOW' }, upcoming: { bg: '#DBEAFE', fg: '#1D4ED8', label: 'UPCOMING' }, returned: { bg: '#D1FAE5', fg: '#065F46', label: 'RETURNED' }, ended: { bg: '#E5E7EB', fg: '#374151', label: 'ENDED' } }[st] || { bg: '#EEE', fg: '#333', label: st };
    return `<span style="background:${m.bg};color:${m.fg};padding:1px 6px;border-radius:3px;font-size:11px;font-weight:700">${m.label}</span>`;
  };
  // Each leave type has its own colour swatch so the kind of leave is
  // readable at a glance (matches the Leave Report palette).
  const LEAVE_TINT = { annual: '#3B82F6', sick: '#EF4444', emergency: '#F59E0B', hajj: '#10B981', maternity: '#EC4899', paternity: '#8B5CF6', marriage: '#14B8A6', bereavement: '#6B7280', unpaid: '#9CA3AF', other: '#84CC16' };
  const swatch = (id) => `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${LEAVE_TINT[id] || '#94A3B8'};margin-right:4px;vertical-align:middle"></span>`;
  const typeColored = (r) => `<span style="color:${LEAVE_TINT[r.typeId] || '#94A3B8'};font-weight:600">${escapeHtml(r.typeName)}</span>`;
  const th = (t, align = 'left') => `<th style="background:${hdr.bg};color:${hdr.fg};padding:1px 6px;text-align:${align};font-family:Calibri,sans-serif;font-size:10pt;font-weight:700;border:1px solid ${hdr.bg};white-space:nowrap">${t}</th>`;
  const headRow = `<tr>${th('PSN')}${th('Name')}${th('Dept')}${th('Loc')}${th('Leave Type')}${th('From')}${th('To')}${th('Days', 'right')}${th('Status')}${th('Last Punch')}</tr>`;
  const bodyRows = rows.map((r, i) => {
    const bg = i % 2 ? '#F3F4F6' : '#FFFFFF';
    const td = (c, align = 'left') => `<td style="padding:0 6px;border:1px solid #D1D5DB;color:#1F2937;font-family:Calibri,sans-serif;font-size:10pt;background:${bg};text-align:${align};white-space:nowrap">${c}</td>`;
    return `<tr>${td(escapeHtml(r.psn))}${td(escapeHtml(r.name))}${td(escapeHtml(r.dept))}${td(escapeHtml(r.loc))}${td(typeColored(r))}${td(escapeHtml(fmtDateShort(r.from)))}${td(escapeHtml(fmtDateShort(r.to)))}${td(r.days.toFixed(1) + (r.isHalf ? ' \u00BD' : ''), 'right')}${td(pill(r.status))}${td(escapeHtml(punchFor(r) || '\u2014'))}</tr>`;
  }).join('');
  const tableHtml = rows.length
    ? `<table cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;font-family:Calibri,sans-serif;margin:0"><thead>${headRow}</thead><tbody>${bodyRows}</tbody></table>`
    : '<p style="margin:0;color:#6B7280;font-style:italic">No approved leave overlapping this month.</p>';

  const subject = `Leave & Availability - ${monthName} ${year}`;
  const totalsLine = `On leave this month: ${peopleSet.size} staff \u00B7 ${rows.length} leave record${rows.length === 1 ? '' : 's'} \u00B7 Out now: ${outNow} \u00B7 Upcoming: ${upcoming}`;
  const intro = [
    `Dear Mr John,`, '',
    `Please find below the staff on leave for ${monthName} ${year}. The list shows current, upcoming and returned leave, with type, dates and duration.`, '',
  ].join('\n');
  const closing = ['', `Please let me know if you would like a breakdown by department or location.`].join('\n');
  const bodyPlain = intro + tablePlain + '\n\n' + totalsLine + closing + SIGNATURE_PLAIN;
  const bodyHtml = emailBody([
    `<p style="margin:0">Dear Mr John,</p>`,
    `<p style="margin:0">Please find below the staff on leave for ${escapeHtml(monthName + ' ' + year)}. The list shows current, upcoming and returned leave, with type, dates and duration.</p>`,
    tableHtml,
    `<p style="margin:0;font-weight:600;color:#334155">${escapeHtml(totalsLine)}</p>`,
    `<p style="margin:0">Please let me know if you would like a breakdown by department or location.</p>`,
  ]);
  return { subject, bodyPlain, bodyHtml, count: rows.length };
}

// Task 4: Monthly shift-staff timing reminder. Reminds dept managers to verify
// or update shift-based working hours for any of their team members. Bashaier
// sees this in her tasks card and clicks to send the reminder email.
function buildShiftStaffReminder({ employees, year, month, jamesEmail }) {
  const monthName = MONTH_FULL[month - 1] + ' ' + year;
  const active = (employees || []).filter(isActiveEmployee);
  const byId = {}; (employees || []).forEach(e => { byId[e.id] = e; });
  const managerIds = [...new Set(active.map(e => e.manager_id).filter(Boolean))];
  const ccBase = [TO_JOHN, ...CC_LIST, jamesEmail].filter(Boolean);

  const managers = managerIds.map(mid => {
    const manager = byId[mid];
    if (!manager) return null;
    // Only managers who actually have shift-based team members.
    const shiftReports = active.filter(e => e.manager_id === mid && e.is_shift_staff === true);
    if (shiftReports.length === 0) return null;

    const listPlain = shiftReports.map(s => '  \u2022 ' + s.name + ' (' + s.id + ')').join('\n');
    const listHtml = '<ul style="margin:4px 0 0 0;padding-left:18px">'
      + shiftReports.map(s => `<li>${escapeHtml(s.name)} (${escapeHtml(s.id)})</li>`).join('') + '</ul>';

    const introP = `This is a reminder from HR to assign the working shifts for ${monthName} for your shift-based team members in the system.`;
    const whyP = 'Attendance is captured against the shift you assign. If a shift is not entered, the system evaluates the person against the standard 08:00 \u2013 17:00 window and may flag them incorrectly, or show them as "Shift not assigned" on the daily report to management.';
    const howP = 'Please open the HR portal, go to Shifts, and assign each person\u2019s shift for the month. Your assignment is final: the staff member does not need to accept it and HR approval is not required. Once you assign it, the system starts capturing their check-in and check-out against that shift, and the staff member must attend accordingly.';
    const subject = `Action needed \u2014 Assign ${monthName} shifts for your shift staff`;

    const bodyPlain =
      `Dear ${salutationFor(manager)},\n\n` +
      introP + '\n\n' + whyP + '\n\n' + howP + '\n\n' +
      'Your shift-based team members:\n' + listPlain + '\n\n' +
      'If all shifts for the month are already assigned and correct, a quick reply confirming that is all I need.\n\n' +
      SIGNATURE_PLAIN;

    const bodyHtml = emailBody([
      `<p style="margin:0">Dear ${escapeHtml(salutationFor(manager))},</p>`,
      `<p style="margin:0">${escapeHtml(introP)}</p>`,
      `<p style="margin:0"><strong>Why this matters:</strong> ${escapeHtml(whyP)}</p>`,
      `<p style="margin:0"><strong>What to do:</strong> ${escapeHtml(howP)}</p>`,
      `<p style="margin:0;font-weight:600">Your shift-based team members</p>`,
      listHtml,
      `<p style="margin:0">If all shifts for the month are already assigned and correct, a quick reply confirming that is all I need.</p>`,
    ]);

    const cc = ccBase.filter(addr => addr && addr.toLowerCase() !== String(manager.email || '').toLowerCase());
    return {
      id: manager.id, name: manager.name, dept: manager.department || '',
      to: manager.email || '', cc,
      teamSize: shiftReports.length, appCount: shiftReports.length,
      subject, bodyPlain, bodyHtml,
    };
  }).filter(Boolean).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return { fanout: true, managers, count: managers.length };
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================
export default function BashaierTasksCard({ me, employees, requests, permissions: passedPerms, leaveTypes = [], balances = [], morningReport = null }) {
  // Baby-pink header = Bashaier's signature on the reports she prepares
  // (black text on pink). Anyone else gets the neutral slate header.
  const hdr = me?.id === 'H94830'
    ? { bg: '#F7C5D0', fg: '#0A0A0A' }
    : { bg: '#334155', fg: '#FFFFFF' };
  const today = new Date();
  const month = today.getMonth() + 1;
  const year  = today.getFullYear();
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;

  const [perms, setPerms] = useState(passedPerms || []);
  const [openTask, setOpenTask] = useState(null);
  const [copied, setCopied] = useState('');

  // Lazy-load permissions if parent didn't pass them
  useEffect(() => {
    if (passedPerms && passedPerms.length >= 0) { setPerms(passedPerms); return; }
    let mounted = true;
    (async () => {
      try {
        const rows = await directGet('permission_requests', 'select=*&order=permission_date.desc', { timeoutMs: 12000 });
        if (mounted) setPerms(rows || []);
      } catch (e) { if (mounted) setPerms([]); }
    })();
    return () => { mounted = false; };
  }, [passedPerms]);

  // Last-punch lookup for staff whose leave has ended this month (returned
  // or ended) — so the Leave & Availability report can show genuine return
  // evidence. (Nadeem 2026-06-12)
  const [leavePunch, setLeavePunch] = useState({});
  const eligiblePunchKey = useMemo(() => {
    const ms = pad2(month);
    const monthStart = `${year}-${ms}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const monthEnd = `${year}-${ms}-${pad2(lastDay)}`;
    const t = new Date();
    const todayStr = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
    return Array.from(new Set((requests || []).filter(r => {
      const stage = r.stage || r.status;
      if (stage !== 'approved' || !r.start_date || !r.end_date) return false;
      if (!(r.start_date <= monthEnd && r.end_date >= monthStart)) return false;
      return r.end_date < todayStr;  // leave has ended (returned or ended)
    }).map(r => r.employee_id))).sort().join(',');
  }, [requests, month, year]);

  useEffect(() => {
    const ids = eligiblePunchKey ? eligiblePunchKey.split(',') : [];
    if (ids.length === 0) { setLeavePunch({}); return; }
    let cancelled = false;
    (async () => {
      try {
        const inList = ids.map(encodeURIComponent).join(',');
        const rows = await directGet(
          'attendance_daily',
          `select=employee_id,attendance_date,first_punch,last_punch&employee_id=in.(${inList})`
          + `&order=attendance_date.desc&limit=1500`,
          { timeoutMs: 12000 },
        );
        const map = {};
        for (const r of (rows || [])) {
          if (map[r.employee_id]) continue;
          const time = r.first_punch || r.last_punch;
          if (!time) continue;
          map[r.employee_id] = { date: r.attendance_date, time };
        }
        if (!cancelled) setLeavePunch(map);
      } catch { if (!cancelled) setLeavePunch({}); }
    })();
    return () => { cancelled = true; };
  }, [eligiblePunchKey]);

  // Pending shift approvals used to render here (state, realtime sub, action
  // handler, and a collapsible panel above the monthly tasks). It's now its
  // own dedicated card on the dashboard — see PendingShiftApprovalsCard.jsx
  // mounted from Dashboard.jsx. The HR-side responsibilities are unchanged;
  // only the surface moved so it sits as a peer of the leave approvals
  // queue rather than buried inside the monthly-report task list.

  // P6: monthly violation aggregation
  // ────────────────────────────────────────────────────────────────────────
  // Fetches every attendance_violations row for the current calendar month,
  // aggregates per employee, and surfaces anyone with > 5 incidents in the
  // "Performance escalation" panel. Clicking review opens
  // EvaluationReviewModal which writes to evaluation_scores.
  const [monthViolations, setMonthViolations] = useState([]);
  // Build 5 — chronic-borderline detection. Tracks the trailing 6
  // months of violations PER employee so the panel can surface staff
  // who never cross the single-month review threshold but consistently
  // sit in the watch zone. 'chronicCandidates' is the rolled-up list
  // of (employeeId → { monthsInWatch, monthsInReview, deductions[] })
  // built in a second useMemo from `historicalViolations`. Nadeem
  // 2026-05-17.
  const [historicalViolations, setHistoricalViolations] = useState([]);
  const [loggedEvalKeys, setLoggedEvalKeys] = useState({});  // 'empId:YYYY-MM' → true
  // Disputes awaiting Bashaier's review — attendance_violations rows
  // where staff filed a dispute_text but no decision has been made
  // yet (cleared_at IS NULL). Build 4 of EVALUATION FLAG rework
  // (Nadeem 2026-05-17). Bashaier sees the staff's explanation and
  // can clear the violation OR dismiss the dispute.
  const [pendingDisputes, setPendingDisputes] = useState([]);
  const [disputeAction,   setDisputeAction]   = useState(null);  // { row, mode: 'accept'|'dismiss' }
  const [disputeNote,     setDisputeNote]     = useState('');
  const [disputeBusy,     setDisputeBusy]     = useState(false);
  const [disputeError,    setDisputeError]    = useState('');
  const [evalPanelOpen, setEvalPanelOpen] = useState(false);
  // Chronic-borderline panel (Build 5) — collapsed by default so it
  // doesn't compete visually with the formal escalation panel above.
  const [chronicPanelOpen, setChronicPanelOpen] = useState(false);
  // Manage-incidents modal (Build 4). When non-null, the modal is open
  // and shows the per-incident excuse / dispute interface for one
  // employee's row. Carries the same shape as the row passed to
  // openReviewFor() — totalCount, deduction, violations[], etc.
  const [manageRow, setManageRow] = useState(null);
  const [reviewModalRow, setReviewModalRow] = useState(null);

  const monthRange = useMemo(() => {
    const y = today.getFullYear();
    const m = today.getMonth();
    const first = new Date(y, m, 1);
    const last  = new Date(y, m + 1, 0);
    const ymd = (d) => {
      const yy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yy}-${mm}-${dd}`;
    };
    return { start: ymd(first), end: ymd(last), monthStart: `${y}-${String(m + 1).padStart(2, '0')}-01` };
  }, [today]);

  // Pull this month's attendance_violations + already-logged evaluation_scores
  // tagged for this month. Realtime channel re-fetches when either changes.
  // ALSO pulls 6 months back for chronic-pattern detection (Build 5).
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const rows = await directGet(
          'attendance_violations',
          `select=id,employee_id,violation_type,violation_date,minutes_off,dispute_text,dispute_at,cleared_at` +
          `&violation_date=gte.${monthRange.start}&violation_date=lte.${monthRange.end}` +
          // Exclude entries cleared by retroactive permissions —
          // otherwise a 7-incident month with 2 cleared by approved
          // permissions would still escalate as if it were 7, and the
          // resulting evaluation_scores row would record the wrong
          // deduction. Same `cleared_at IS NULL` filter every other
          // attendance_violations consumer applies.
          `&cleared_at=is.null` +
          `&order=violation_date`,
          { timeoutMs: 8000 }
        );
        if (mounted) setMonthViolations(Array.isArray(rows) ? rows : []);
      } catch {
        if (mounted) setMonthViolations([]);
      }
      // Trailing 6 months for chronic-borderline detection (Build 5).
      // Same filter as above, just a wider date window. Best-effort —
      // if it fails we just don't surface chronic patterns.
      try {
        // 6 months back from current month-start.
        const [yStr, mStr] = monthRange.monthStart.split('-');
        const startD = new Date(parseInt(yStr,10), parseInt(mStr,10) - 1 - 5, 1);
        const windowStart = `${startD.getFullYear()}-${String(startD.getMonth()+1).padStart(2,'0')}-01`;
        const rows = await directGet(
          'attendance_violations',
          `select=id,employee_id,violation_type,violation_date,minutes_off` +
          `&violation_date=gte.${windowStart}` +
          `&violation_date=lte.${monthRange.end}` +
          `&cleared_at=is.null` +
          `&order=violation_date`,
          { timeoutMs: 10000 }
        );
        if (mounted) setHistoricalViolations(Array.isArray(rows) ? rows : []);
      } catch {
        if (mounted) setHistoricalViolations([]);
      }
      try {
        // Find evaluation_scores rows already created for the current
        // calendar month, keyed by the unique (period_year, period_month).
        // Far simpler and more correct than scanning notes for a tag prefix.
        const [yStr, mStr] = monthRange.monthStart.split('-');
        const periodYear  = parseInt(yStr, 10);
        const periodMonth = parseInt(mStr, 10);
        const rows = await directGet(
          'evaluation_scores',
          `select=employee_id&period_year=eq.${periodYear}&period_month=eq.${periodMonth}`,
          { timeoutMs: 8000 }
        );
        if (mounted) {
          const m = {};
          (rows || []).forEach(r => {
            m[`${r.employee_id}:${monthRange.monthStart.slice(0, 7)}`] = true;
          });
          setLoggedEvalKeys(m);
        }
      } catch {
        if (mounted) setLoggedEvalKeys({});
      }
      try {
        // Pending disputes — any attendance_violations rows where
        // staff filed a dispute_text but Bashaier hasn't decided yet
        // (cleared_at IS NULL, dispute_at IS NOT NULL). Sorted oldest
        // first so disputes don't sit unanswered.
        const drows = await directGet(
          'attendance_violations',
          'select=id,employee_id,violation_type,violation_date,minutes_off,punch_in_time,punch_out_time,dispute_text,dispute_at'
          + '&dispute_at=not.is.null'
          + '&cleared_at=is.null'
          + '&order=dispute_at.asc'
          + '&limit=50',
          { timeoutMs: 8000 },
        );
        if (mounted) setPendingDisputes(Array.isArray(drows) ? drows : []);
      } catch {
        if (mounted) setPendingDisputes([]);
      }
    };
    refresh();
    const ch = supabase.channel('hr-monthly-violations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_violations' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'evaluation_scores' }, refresh)
      .subscribe();
    return () => { mounted = false; supabase.removeChannel(ch); };
  }, [monthRange.start, monthRange.end, monthRange.monthStart]);

  // Aggregate to one row per employee. Threshold flipped from
  // 'totalCount > 5' (flat) to 'deduction ≥ REVIEW_THRESHOLD' (weighted)
  // so a single severe incident (e.g. unauthorized absence + late > 30)
  // surfaces as quickly as several minor lates. Severity weights live
  // in src/lib/evaluationWeights.js (Nadeem 2026-05-17 Build 1).
  const escalations = useMemo(() => {
    const byEmp = new Map();
    monthViolations.forEach(v => {
      if (!v?.employee_id) return;
      let agg = byEmp.get(v.employee_id);
      if (!agg) {
        agg = {
          employeeId:  v.employee_id,
          rows:        [],
          dates:       new Set(),
        };
        byEmp.set(v.employee_id, agg);
      }
      agg.rows.push(v);
      if (v.violation_date) agg.dates.add(v.violation_date);
    });
    return Array.from(byEmp.values())
      .map(a => {
        const summary = summariseViolations(a.rows);
        const emp = (employees || []).find(e => e.id === a.employeeId);
        const monthYM = monthRange.monthStart.slice(0, 7);
        // Count rows the staff has explained — Bashaier should see
        // this signal next to the escalation summary so she doesn't
        // escalate without reading what the staff said.
        const disputedCount = a.rows.filter(r => r?.dispute_text && r.dispute_text.trim()).length;
        return {
          ...summary,
          employeeId:    a.employeeId,
          violations:    a.rows,                   // raw rows for the manage-incidents modal
          violationIds:  a.rows.map(r => r.id).filter(Boolean),  // Build 6 audit linkage
          dates:         Array.from(a.dates).sort(),
          disputedCount,
          monthStart:    monthRange.monthStart,
          employeeName:  emp?.name || a.employeeId,
          alreadyLogged: !!loggedEvalKeys[`${a.employeeId}:${monthYM}`],
        };
      })
      // Only escalate rows whose weighted deduction crosses the policy
      // line. Staff with 4 minor lates (deduction = 8) DON'T escalate
      // yet but DO surface on their own dashboard as 'watch' (Build 2).
      .filter(r => r.deduction >= REVIEW_THRESHOLD)
      // Sort by severity, not by raw count — the more deduction, the
      // more urgent the chase.
      .sort((a, b) => b.deduction - a.deduction);
  }, [monthViolations, employees, loggedEvalKeys, monthRange.monthStart]);

  const escalationsPending = useMemo(
    () => escalations.filter(r => !r.alreadyLogged),
    [escalations]
  );

  // Build 5 — chronic-borderline detection. Surfaces staff who never
  // cross the single-month review threshold (deduction >= 10) BUT have
  // logged 3+ months in the watch zone (deduction >= WATCH_LOWER (5))
  // across the trailing 6 months. The single-month rule misses these
  // 'always-4-points-every-month' patterns — chronic borderline staff
  // are arguably a worse problem than a single bad month because the
  // behaviour is structural, not situational.
  //
  // Excludes anyone already flagged in escalations (this month >= 10)
  // — they'll be handled by the regular panel and we don't want to
  // double-count.
  const chronicCandidates = useMemo(() => {
    if (!Array.isArray(historicalViolations) || historicalViolations.length === 0) return [];
    // Bucket each row into its YYYY-MM month so we can roll up per
    // employee per month.
    const byEmpMonth = new Map();
    for (const v of historicalViolations) {
      if (!v?.employee_id || !v?.violation_date) continue;
      const ym = String(v.violation_date).slice(0, 7);
      const key = `${v.employee_id}|${ym}`;
      if (!byEmpMonth.has(key)) byEmpMonth.set(key, []);
      byEmpMonth.get(key).push(v);
    }
    // Compute per-employee summary across all months.
    const byEmp = new Map();
    for (const [key, rows] of byEmpMonth.entries()) {
      const [empId, ym] = key.split('|');
      const s = summariseViolations(rows);
      let agg = byEmp.get(empId);
      if (!agg) {
        agg = { employeeId: empId, monthsInWatch: 0, monthsInReview: 0, monthlySummaries: [], totalDeduction: 0 };
        byEmp.set(empId, agg);
      }
      agg.monthlySummaries.push({ ym, ...s });
      agg.totalDeduction += s.deduction;
      if (s.deduction >= REVIEW_THRESHOLD)      agg.monthsInReview += 1;
      else if (s.deduction >= WATCH_LOWER)      agg.monthsInWatch  += 1;
    }
    // Excluded set — anyone currently in escalationsPending (this month
    // already at review level) is handled by the regular panel.
    const excluded = new Set(escalationsPending.map(r => r.employeeId));
    // Threshold: 3+ months in the (watch + review) zones in trailing 6.
    return Array.from(byEmp.values())
      .filter(a => !excluded.has(a.employeeId))
      .filter(a => (a.monthsInWatch + a.monthsInReview) >= 3)
      .map(a => {
        const emp = (employees || []).find(e => e.id === a.employeeId);
        // Sort the monthly summaries chronologically (oldest → newest)
        // so the manager email can describe the timeline cleanly.
        a.monthlySummaries.sort((x, y) => x.ym.localeCompare(y.ym));
        return {
          ...a,
          employeeName: emp?.name || a.employeeId,
        };
      })
      // Sort by combined zone-months desc so the worst patterns surface
      // at the top of Bashaier's panel.
      .sort((a, b) => (b.monthsInReview * 10 + b.monthsInWatch) - (a.monthsInReview * 10 + a.monthsInWatch));
  }, [historicalViolations, escalationsPending, employees]);

  const openReviewFor = (row) => {
    const employee = (employees || []).find(e => e.id === row.employeeId) || { id: row.employeeId };
    const manager  = employee?.manager_id
      ? (employees || []).find(e => e.id === employee.manager_id) || null
      : null;
    setReviewModalRow({ row, employee, manager });
  };
  // ────────────────────────────────────────────────────────────────────────

  // James's email (CC on the dept-head leave reports) — resolved from the
  // staff directory by name so it follows any future record update.
  const jamesEmail = useMemo(
    () => ((employees || []).find(e => /james/i.test(e.name || ''))?.email) || '',
    [employees],
  );
  // Fan-out modal data — one prefilled email per department head.
  const [fanout, setFanout] = useState(null);

  const tasks = useMemo(() => [
    {
      key: 'leave_availability',
      title: 'Leave & Availability',
      subtitle: `Who's on leave this month — ${MONTH_FULL[month-1]} ${year}`,
      icon: <Plane className="w-4 h-4" />,
      tone: '#334155',
      build: () => buildLeaveAvailability({ requests, employees, year, month, today, lastPunch: leavePunch, hdr }),
    },
    {
      key: 'mid_month_perms',
      title: 'Mid-month permissions report',
      subtitle: `Send a 1\u201315 ${MONTH_FULL[month-1]} update to Mr John`,
      icon: <Coffee className="w-4 h-4" />,
      tone: '#C97A4F',
      build: () => buildMidMonthPermissions({ permissions: perms, employees, year, month, today, hdr }),
    },
    {
      key: 'end_of_month_perms',
      title: 'End-of-month permissions report',
      subtitle: `Full ${MONTH_FULL[month-1]} ${year} permissions report`,
      icon: <CalendarDays className="w-4 h-4" />,
      tone: '#5A8A9A',
      build: () => buildEndOfMonthPermissions({ permissions: perms, employees, year, month, hdr }),
    },
    {
      key: 'dept_head_leaves',
      title: 'Team leave & balance — to each manager',
      subtitle: 'Send each department head their team\u2019s leaves + balances',
      icon: <Mail className="w-4 h-4" />,
      tone: '#2D5F3F',
      fanout: true,
      build: () => buildDeptHeadLeaveReports({ employees, requests, balances, leaveTypes, year, jamesEmail, hdr }),
    },
    {
      key: 'headcount_snapshot',
      title: 'Headcount snapshot',
      subtitle: 'Active staff by location and department',
      icon: <TrendingUp className="w-4 h-4" />,
      tone: '#1D4ED8',
      build: () => buildHeadcountSnapshot({ employees, hdr }),
    },
    {
      key: 'shift_staff_reminder',
      title: 'Shift staff timing reminder',
      subtitle: 'Remind department managers to assign their team’s shifts in the system',
      icon: <Clock className="w-4 h-4" />,
      tone: '#7E22CE',
      fanout: true,
      build: () => buildShiftStaffReminder({ employees, year, month, jamesEmail }),
    },
  ], [perms, employees, requests, month, year, prevMonth, prevYear, today, leavePunch, hdr, balances, leaveTypes, jamesEmail]);

  const open = (task) => {
    const built = task.build();
    if (task.fanout || built?.fanout) {
      setFanout({ title: task.title, managers: built.managers || [] });
      return;
    }
    setOpenTask({ ...task, ...built });
  };

  const composeMailto = (task) => {
    const mailto = `mailto:${TO_JOHN}?cc=${encodeURIComponent(CC_STR)}&subject=${encodeURIComponent(task.subject)}&body=${encodeURIComponent(task.bodyPlain)}`;
    window.location.href = mailto;
  };

  const copyHtml = async (task) => {
    try {
      const blobHtml  = new Blob([task.bodyHtml],  { type: 'text/html'  });
      const blobPlain = new Blob([task.bodyPlain], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/html': blobHtml, 'text/plain': blobPlain }),
      ]);
      setCopied('html');
      setTimeout(() => setCopied(''), 2500);
    } catch (e) {
      // Fallback: copy plain
      try {
        await navigator.clipboard.writeText(task.bodyPlain);
        setCopied('plain');
        setTimeout(() => setCopied(''), 2500);
      } catch {}
    }
  };

  const copyPlain = async (task) => {
    try {
      await navigator.clipboard.writeText(task.bodyPlain);
      setCopied('plain');
      setTimeout(() => setCopied(''), 2500);
    } catch {}
  };

  return (
    <>
      {/* REPORTS FOR MR JOHN — the three monthly emails. Outer wrapper uses
          the canonical .esau-card chrome (matching <Card> in Dashboard.jsx)
          so it sits cleanly alongside the dashboard cards above it (Out of
          office today / Pending requests / Upcoming leaves) and inherits
          the same hover lift. The shift-approval queue used to live inside
          this card; it now has its own home in PendingShiftApprovalsCard. */}
      <div
        className="rounded-xl border p-5 esau-card"
        style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}
      >
        <div className="flex items-baseline justify-between mb-4 pb-3 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--evergreen-500)' }} />
            <h3 className="serif text-lg" style={{ fontWeight: 500 }}>Reports for Mr John</h3>
          </div>
          <div className="text-xs opacity-60 flex items-center gap-1.5">
            <ClipboardCheck className="w-3 h-3" /> {tasks.length + (morningReport ? 1 : 0)} reports
          </div>
        </div>

        <p className="text-xs mb-4" style={{ color: '#1F1B16' }}>
          Click any report to preview, then send via your mail client or copy to paste into Outlook.
        </p>

        {/* P6: Performance escalation — surfaces staff who exceeded 5
            attendance violations this calendar month. Auto-hides when there
            are no pending escalations. Already-reviewed rows are filtered
            out so they don't keep nagging Bashaier. */}
        {escalationsPending.length > 0 && (
          <div
            className="rounded-xl border mb-3 overflow-hidden transition-colors"
            style={{
              borderColor: '#FFCDD2',
              background: 'linear-gradient(135deg, #FBE9E7 0%, #FBFAF6 100%)',
            }}
          >
            <button
              type="button"
              onClick={() => setEvalPanelOpen(o => !o)}
              className="w-full flex items-center gap-3 px-3 py-3 text-left hover:bg-white/40 transition-colors"
            >
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: '#FFEBEE', color: 'var(--clay)', border: '1px solid #FFCDD2' }}
              >
                <AlertTriangle className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold" style={{ color: '#1F1B16' }}>
                  {escalationsPending.length === 1
                    ? `${salutationFor({ id: escalationsPending[0].employeeId, name: escalationsPending[0].employeeName })} crossed the monthly review threshold`
                    : `${escalationsPending.length} staff crossed the monthly review threshold`}
                </div>
                <div className="text-[11px]" style={{ color: '#1F1B16' }}>
                  {REVIEW_THRESHOLD}+ severity-weighted points this month — review and notify direct manager
                </div>
              </div>
              <span
                className="text-[10px] tracking-[0.2em] px-2 py-0.5 rounded-full flex-shrink-0"
                style={{ background: 'var(--clay)', color: 'white' }}
              >
                ESCALATE
              </span>
              <ChevronDown
                className="w-4 h-4 flex-shrink-0 transition-transform"
                style={{ color: '#1F1B16', transform: evalPanelOpen ? 'rotate(180deg)' : 'none' }}
              />
            </button>

            {evalPanelOpen && (
              <div className="px-3 pb-3 pt-1 fade-in">
                <div className="space-y-1.5 mb-1">
                  {escalationsPending.map(row => {
                    // Display the weighted deduction the aggregator
                    // already computed (Build 1). Older code used
                    // (totalCount - 5) * 2 — replaced.
                    const ded = row.deduction || 0;
                    return (
                      <div
                        key={row.employeeId}
                        className="flex items-center gap-3 rounded border px-3 py-2 bg-white"
                        style={{ borderColor: 'var(--border-soft)' }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium flex items-center gap-2" style={{ color: '#1F1B16' }}>
                            {row.employeeName}
                            {/* Dispute signal — when staff has explained
                                one or more incidents, surface that
                                before Bashaier decides to escalate.
                                Build 4 (Nadeem 2026-05-17). */}
                            {row.disputedCount > 0 && (
                              <span title="Staff has explained one or more incidents"
                                    style={{
                                      background: '#DBEAFE', color: '#1E40AF',
                                      fontWeight: 700, fontSize: 9, padding: '1px 6px',
                                      borderRadius: 999, letterSpacing: '0.04em',
                                      display: 'inline-flex', alignItems: 'center', gap: 3,
                                    }}>
                                <MessageSquare className="w-2.5 h-2.5"/>
                                {row.disputedCount} EXPLAINED
                              </span>
                            )}
                          </div>
                          <div className="text-[11px]" style={{ color: '#1F1B16' }}>
                            {row.totalCount} incident{row.totalCount === 1 ? '' : 's'}
                            {row.absenceCount ? ` · ${row.absenceCount} absence${row.absenceCount === 1 ? '' : 's'}` : ''}
                            {row.lateCount    ? ` · ${row.lateCount} late` : ''}
                            {row.earlyCount   ? ` · ${row.earlyCount} early` : ''}
                            {row.missedCount  ? ` · ${row.missedCount} missed-punch` : ''}
                            {' · '}<strong style={{ color: '#7F1D1D' }}>{ded} pt{ded === 1 ? '' : 's'} deducted</strong>
                            {' · score '}<strong>{Math.max(0, BASE_SCORE - ded)}/{BASE_SCORE}</strong>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setManageRow(row)}
                          title="Review individual incidents · excuse or read disputes"
                          className="px-2.5 py-1.5 rounded text-xs flex items-center gap-1.5 border"
                          style={{ background: '#FFFFFF', color: '#0A0A0A', borderColor: 'var(--border-soft)' }}
                        >
                          <ShieldCheck className="w-3.5 h-3.5"/> Manage
                        </button>
                        <button
                          type="button"
                          onClick={() => openReviewFor(row)}
                          className="px-3 py-1.5 rounded text-xs text-white flex items-center gap-1.5"
                          style={{ background: 'var(--clay)' }}
                        >
                          <ChevronRight className="w-3.5 h-3.5" /> Review
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Pending disputes — staff filed an explanation on a flagged
            incident but Bashaier hasn't decided yet. Surfaces disputes
            from staff NOT in the formal escalation queue (deduction <
            10 pts) — those staff wouldn't otherwise appear in any of
            Bashaier's surfaces, so without this panel their disputes
            sit unanswered. Build 4 (Nadeem 2026-05-17). Auto-hides
            when queue is empty. */}
        {pendingDisputes.length > 0 && (
          <div
            className="rounded-xl border mb-3 overflow-hidden transition-colors"
            style={{
              borderColor: '#FCD34D',
              background: 'linear-gradient(135deg, #FFFBEB 0%, #FBFAF6 100%)',
            }}
          >
            <div className="flex items-center gap-3 px-3 py-3 border-b" style={{ borderColor: 'rgba(146,64,14,0.15)' }}>
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FCD34D' }}
              >
                <MessageSquare className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold" style={{ color: '#1F1B16' }}>
                  {pendingDisputes.length === 1
                    ? '1 dispute awaiting your review'
                    : `${pendingDisputes.length} disputes awaiting your review`}
                </div>
                <div className="text-xs" style={{ color: '#1F1B16', opacity: 0.7 }}>
                  Staff filed explanations on flagged incidents — accept to clear, or dismiss to keep counted.
                </div>
              </div>
              <span style={{
                background: '#FEF3C7', color: '#92400E',
                padding: '2px 8px', borderRadius: 999,
                fontSize: 11, fontWeight: 700,
              }}>
                {pendingDisputes.length}
              </span>
            </div>

            <div className="divide-y" style={{ borderColor: 'rgba(146,64,14,0.1)' }}>
              {pendingDisputes.map(d => {
                const emp = (employees || []).find(e => e.id === d.employee_id);
                const empName = emp?.name || d.employee_id;
                const dateLabel = new Date(d.violation_date).toLocaleDateString('en-GB', {
                  weekday: 'short', day: '2-digit', month: 'short',
                });
                const filedAgo = (() => {
                  const days = Math.max(0, Math.floor((Date.now() - new Date(d.dispute_at).getTime()) / 86400000));
                  if (days === 0) return 'today';
                  if (days === 1) return 'yesterday';
                  return `${days} days ago`;
                })();
                const typeLabel = ({
                  late: 'Late', early_leave: 'Early', early: 'Early',
                  missed_in: 'No punch-in', missed_out: 'No punch-out',
                  unauthorized_absence: 'Unauthorized absence',
                }[d.violation_type]) || d.violation_type;
                return (
                  <div key={d.id} className="px-3 py-3">
                    <div className="flex items-start gap-2 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap text-[12px]">
                          <strong style={{ color: '#0A0A0A' }}>{empName}</strong>
                          <span style={{ color: '#0A0A0A', opacity: 0.55, fontSize: 10 }}>{d.employee_id}</span>
                          <span style={{ color: '#0A0A0A', opacity: 0.7 }}>·</span>
                          <span style={{ color: '#0A0A0A' }}>{dateLabel}</span>
                          <span style={{
                            background: '#FEE2E2', color: '#7F1D1D',
                            padding: '1px 6px', borderRadius: 999, fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
                          }}>
                            {typeLabel.toUpperCase()}
                          </span>
                          <span style={{ color: '#0A0A0A', opacity: 0.55, fontSize: 10 }}>
                            disputed {filedAgo}
                          </span>
                        </div>
                        <div className="mt-1.5 rounded p-2 text-[12px]"
                             style={{ background: '#FFFFFF', border: '1px solid var(--border-soft, #E8E5D8)', color: '#1F1B16', whiteSpace: 'pre-wrap' }}>
                          {d.dispute_text || <em style={{ opacity: 0.5 }}>(no explanation text)</em>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setDisputeAction({ row: d, mode: 'accept' });
                            setDisputeNote(d.dispute_text || '');
                            setDisputeError('');
                          }}
                          className="text-[10px] inline-flex items-center gap-1 px-3 py-1.5 rounded-full font-semibold"
                          style={{
                            background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)',
                            color: '#FFFFFF',
                          }}
                          title="Accept explanation — clears the violation"
                        >
                          <ShieldCheck className="w-3 h-3"/> Accept &amp; clear
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDisputeAction({ row: d, mode: 'dismiss' });
                            setDisputeNote('');
                            setDisputeError('');
                          }}
                          className="text-[10px] inline-flex items-center gap-1 px-3 py-1.5 rounded-full border font-medium"
                          style={{
                            borderColor: 'var(--border-soft, #E8E5D8)',
                            background: '#FFFFFF', color: '#0A0A0A',
                          }}
                          title="Dismiss the dispute — violation continues to count"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Build 5 — chronic-borderline pattern panel. Surfaces staff
            who never crossed the monthly review line but have lived
            in the watch zone (5-9 pts) for 3+ months in the trailing
            6. These are structural patterns the monthly rule misses.
            Tone is lighter than the formal escalation panel above
            (amber, not red) — this is a 'coaching check-in' surface,
            not a 'send the warning email' surface. */}
        {chronicCandidates.length > 0 && (
          <div
            className="rounded-xl border mb-3 overflow-hidden transition-colors"
            style={{
              borderColor: '#FCD34D',
              background: 'linear-gradient(135deg, #FEF3C7 0%, #FBFAF6 100%)',
            }}
          >
            <button
              type="button"
              onClick={() => setChronicPanelOpen(o => !o)}
              className="w-full flex items-center gap-3 px-3 py-3 text-left hover:bg-white/40 transition-colors"
            >
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FCD34D' }}
              >
                <TrendingUp className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold" style={{ color: '#1F1B16' }}>
                  {chronicCandidates.length === 1
                    ? `${salutationFor({ id: chronicCandidates[0].employeeId, name: chronicCandidates[0].employeeName })} has a chronic borderline pattern`
                    : `${chronicCandidates.length} staff have chronic borderline patterns`}
                </div>
                <div className="text-[11px]" style={{ color: '#1F1B16' }}>
                  3+ months in the watch zone over the last 6 — coach before next month-end
                </div>
              </div>
              <span
                className="text-[10px] tracking-[0.2em] px-2 py-0.5 rounded-full flex-shrink-0"
                style={{ background: '#92400E', color: 'white' }}
              >
                PATTERN
              </span>
              <ChevronDown
                className="w-4 h-4 flex-shrink-0 transition-transform"
                style={{ color: '#1F1B16', transform: chronicPanelOpen ? 'rotate(180deg)' : 'none' }}
              />
            </button>

            {chronicPanelOpen && (
              <div className="px-3 pb-3 pt-1 fade-in">
                <div className="space-y-1.5 mb-1">
                  {chronicCandidates.map(row => (
                    <div
                      key={row.employeeId}
                      className="flex items-center gap-3 rounded border px-3 py-2 bg-white"
                      style={{ borderColor: 'var(--border-soft)' }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium" style={{ color: '#1F1B16' }}>
                          {row.employeeName}
                        </div>
                        <div className="text-[11px]" style={{ color: '#1F1B16' }}>
                          {row.monthsInWatch + row.monthsInReview} of 6 months in watch/review zone
                          {row.monthsInReview > 0 && (
                            <> · <strong style={{ color: '#7F1D1D' }}>{row.monthsInReview} review-level</strong></>
                          )}
                          {' '}· {row.totalDeduction} pts cumulative across 6 months
                        </div>
                      </div>
                      {/* Sparkline of the monthly deductions for context. */}
                      <div className="flex items-center gap-0.5">
                        {row.monthlySummaries.map((m, i) => {
                          const isWatch  = m.deduction >= WATCH_LOWER && m.deduction < REVIEW_THRESHOLD;
                          const isReview = m.deduction >= REVIEW_THRESHOLD;
                          const bg = isReview ? '#FEE2E2' : isWatch ? '#FEF3C7' : '#F4F4EE';
                          const fg = isReview ? '#7F1D1D' : isWatch ? '#92400E' : '#0A0A0A';
                          return (
                            <div key={i}
                                 title={`${m.ym}: ${m.deduction} pts (${m.totalCount} incidents)`}
                                 style={{
                                   width: 22, height: 22, borderRadius: 4,
                                   background: bg, color: fg,
                                   fontSize: 9, fontWeight: 700,
                                   display: 'flex', alignItems: 'center', justifyContent: 'center',
                                 }}>
                              {m.deduction === 0 ? '·' : m.deduction}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-[10px] mt-2" style={{ color: '#0A0A0A', opacity: 0.6 }}>
                  These staff haven't crossed the monthly review threshold but the
                  pattern is structural. Consider a coaching conversation with the
                  line manager rather than a formal HR warning.
                </div>
              </div>
            )}
          </div>
        )}

        <div className="space-y-2.5">
          {morningReport}
          {tasks.map(task => {
            const st = computeTaskStatus(task.key, today);
            return (
              <button key={task.key} onClick={() => open(task)}
                      className="w-full flex items-center gap-3 px-3 py-3 rounded-xl border hover:bg-[var(--paper-soft,#F8F8F2)] transition-colors text-left group"
                      style={{ borderColor: 'var(--border-soft)' }}>
                <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                     style={{ background: task.tone + '15', color: task.tone, border: '1px solid ' + task.tone + '40' }}>
                  {task.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--ink)' }}>{task.title}</div>
                  <div className="text-[11px] opacity-70 truncate">{task.subtitle}</div>
                </div>
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
                      style={{ background: st.bg, color: st.color }}>
                  {st.state === 'overdue' && <AlertCircle className="w-3 h-3" />}
                  {st.state === 'due_today' && <CheckCircle2 className="w-3 h-3" />}
                  {(st.state === 'upcoming' || st.state === 'idle' || st.state === 'due_soon' || st.state === 'due_tomorrow') && <Clock className="w-3 h-3" />}
                  {st.due}
                </span>
                <ChevronRight className="w-4 h-4 opacity-30 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all flex-shrink-0" />
              </button>
            );
          })}
        </div>

        <div className="mt-4 pt-3 border-t flex items-center justify-between text-[10px] opacity-60"
             style={{ borderColor: 'var(--border-soft)' }}>
          <span>To: Mr John  ·  CC: Fahad, Badria, Jaffar</span>
          <span>{permsCountSummary(perms, year, month)}</span>
        </div>
      </div>

      {openTask && (
        <TaskPreviewModal
          task={openTask}
          onClose={() => setOpenTask(null)}
          onCompose={() => composeMailto(openTask)}
          onCopyHtml={() => copyHtml(openTask)}
          onCopyPlain={() => copyPlain(openTask)}
          copied={copied}
        />
      )}

      {fanout && (
        <DeptHeadReportModal
          title={fanout.title}
          managers={fanout.managers}
          onClose={() => setFanout(null)}
        />
      )}

      {reviewModalRow && (
        <EvaluationReviewModal
          row={reviewModalRow.row}
          employee={reviewModalRow.employee}
          manager={reviewModalRow.manager}
          me={{ id: 'H94830' }}
          onClose={() => setReviewModalRow(null)}
          onLogged={() => { /* realtime channel will refresh state */ }}
        />
      )}

      {/* Build 4 — manage incidents per employee. Opens from the
          'Manage' button next to 'Review' in the escalation panel.
          Lets Bashaier excuse individual incidents with a reason,
          read staff explanations, and watch the live score update
          as she excuses rows. */}
      {manageRow && (
        <ManageIncidentsModal
          row={manageRow}
          me={{ id: 'H94830' }}
          onClose={() => setManageRow(null)}
          onChange={() => { /* realtime channel re-fetches and the
              row stays open with the freshest data */ }}
        />
      )}

      {/* Dispute action confirmation modal — Build 4 (Nadeem 2026-05-17).
          Opens when Bashaier clicks "Accept & clear" or "Dismiss" on
          a pending-dispute row. Either action is a single-row PATCH
          on attendance_violations: accept stamps cleared_at + reason,
          dismiss nulls dispute_at so it leaves the queue but the
          violation continues to count. Realtime channel refreshes
          everywhere automatically. */}
      {disputeAction && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(20,30,25,0.6)' }}
          onClick={() => !disputeBusy && setDisputeAction(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="px-5 py-4 rounded-t-2xl flex items-start justify-between gap-3"
              style={{
                background: disputeAction.mode === 'accept'
                  ? 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)'
                  : 'linear-gradient(135deg, #6B7280 0%, #4B5563 100%)',
                color: '#fff',
              }}
            >
              <div>
                <div className="text-[10px] tracking-[0.25em] opacity-80 mb-1">
                  — {disputeAction.mode === 'accept' ? 'ACCEPT DISPUTE' : 'DISMISS DISPUTE'}
                </div>
                <h2 className="text-lg font-serif">
                  {(employees || []).find(e => e.id === disputeAction.row.employee_id)?.name || disputeAction.row.employee_id}
                </h2>
                <div className="text-[11px] opacity-85 mt-0.5">
                  {new Date(disputeAction.row.violation_date).toLocaleDateString('en-GB', {
                    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
                  })}
                </div>
              </div>
              <button
                onClick={() => !disputeBusy && setDisputeAction(null)}
                className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/20 transition-colors flex-shrink-0"
                style={{ color: '#fff' }}
                aria-label="Close"
                disabled={disputeBusy}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-5 py-4 space-y-3">
              <div className="text-[12px]" style={{ color: '#0A0A0A' }}>
                {disputeAction.mode === 'accept'
                  ? <>Clearing this violation removes it from the deduction. The reason below is stored on the row as audit trail. The staff member will see the badge change to <strong>cleared</strong>.</>
                  : <>The violation continues to count toward the monthly deduction. The dispute is removed from this queue. Optionally add a note (private to HR audit).</>}
              </div>

              <div className="rounded p-2 text-[11px]"
                   style={{ background: '#FBFAF6', border: '1px solid var(--border-soft, #E8E5D8)', color: '#1F1B16' }}>
                <div className="opacity-60 mb-1" style={{ fontSize: 9, letterSpacing: '0.1em', fontWeight: 700 }}>
                  STAFF EXPLANATION
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>
                  {disputeAction.row.dispute_text || <em style={{ opacity: 0.5 }}>(no text)</em>}
                </div>
              </div>

              <div>
                <div className="text-[10px] mb-1 tracking-wider font-bold" style={{ color: '#0A0A0A' }}>
                  {disputeAction.mode === 'accept' ? 'CLEARED REASON' : 'DISMISSAL NOTE (OPTIONAL)'}
                </div>
                <textarea
                  value={disputeNote}
                  onChange={(e) => setDisputeNote(e.target.value.slice(0, 280))}
                  placeholder={disputeAction.mode === 'accept'
                    ? 'e.g. "Verified with line manager — flat tire on Pepsi road"'
                    : 'e.g. "Coached separately — same pattern as April"'}
                  rows={3}
                  className="w-full px-3 py-2 text-[12px] rounded border resize-none"
                  style={{
                    background: '#FFFFFF', color: '#0A0A0A',
                    borderColor: 'var(--border-soft, #E8E5D8)', outline: 'none',
                  }}
                />
                <div className="text-[10px] mt-1" style={{ color: '#0A0A0A', opacity: 0.6 }}>
                  {disputeNote.length} / 280
                </div>
              </div>

              {disputeError && (
                <div className="text-[11px] px-2 py-1.5 rounded" style={{ background: '#FEE2E2', color: '#7F1D1D' }}>
                  {disputeError}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t flex items-center justify-end gap-2 rounded-b-2xl"
                 style={{ borderColor: 'var(--border-soft, #E8E5D8)' }}>
              <button
                type="button"
                onClick={() => setDisputeAction(null)}
                disabled={disputeBusy}
                className="text-[11px] px-3 py-1.5 rounded-full border font-medium"
                style={{
                  borderColor: 'var(--border-soft, #E8E5D8)',
                  background: '#FFFFFF', color: '#0A0A0A',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (disputeAction.mode === 'accept' && !disputeNote.trim()) {
                    setDisputeError('Please add a reason for the audit trail.');
                    return;
                  }
                  setDisputeBusy(true);
                  setDisputeError('');
                  try {
                    if (disputeAction.mode === 'accept') {
                      await directPatch(
                        'attendance_violations', 'id', disputeAction.row.id,
                        {
                          cleared_at:     new Date().toISOString(),
                          cleared_by:     'H94830',
                          cleared_reason: disputeNote.trim(),
                        },
                        { timeoutMs: 10000 },
                      );
                    } else {
                      // Dismiss — null out dispute_at. Violation stays
                      // counted. The note (if provided) is appended to
                      // cleared_reason for audit, though the row itself
                      // is NOT cleared — Bashaier is just removing the
                      // dispute from her queue.
                      const patch = { dispute_at: null };
                      if (disputeNote.trim()) {
                        patch.cleared_reason = `[Dispute dismissed] ${disputeNote.trim()}`;
                      }
                      await directPatch(
                        'attendance_violations', 'id', disputeAction.row.id,
                        patch,
                        { timeoutMs: 10000 },
                      );
                    }
                    // Optimistic: drop from local list. Realtime channel
                    // also fires and refreshes everything.
                    setPendingDisputes(prev => prev.filter(p => p.id !== disputeAction.row.id));
                    setDisputeAction(null);
                  } catch (e) {
                    console.warn('[disputes] action failed:', e);
                    setDisputeError(e?.message || 'Action failed — please try again.');
                  } finally {
                    setDisputeBusy(false);
                  }
                }}
                disabled={disputeBusy}
                className="text-[11px] px-4 py-1.5 rounded-full font-semibold inline-flex items-center gap-1.5"
                style={{
                  background: disputeAction.mode === 'accept'
                    ? 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)'
                    : 'linear-gradient(135deg, #6B7280 0%, #4B5563 100%)',
                  color: '#FFFFFF',
                  opacity: disputeBusy ? 0.6 : 1,
                  cursor: disputeBusy ? 'wait' : 'pointer',
                }}
              >
                {disputeBusy
                  ? <><Loader2 className="w-3 h-3 animate-spin"/> Working…</>
                  : disputeAction.mode === 'accept'
                    ? <><ShieldCheck className="w-3 h-3"/> Accept &amp; clear</>
                    : <>Dismiss dispute</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function permsCountSummary(perms, year, month) {
  const ms = pad2(month);
  const c = (perms || []).filter(p =>
    (p.status === 'approved' || p.status === 'pending') &&
    p.permission_date?.startsWith(`${year}-${ms}`)
  ).length;
  return `${c} permission${c === 1 ? '' : 's'} this month`;
}

// =============================================================================
// PREVIEW MODAL — shows the email exactly as it will be sent
// =============================================================================
function TaskPreviewModal({ task, onClose, onCompose, onCopyHtml, onCopyPlain, copied }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 overflow-y-auto"
         style={{ background: 'rgba(20,30,25,0.6)' }}
         onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl my-8" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 sm:px-6 py-4 sticky top-0 z-10 rounded-t-2xl flex items-start justify-between gap-3"
             style={{ background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }}>
          <div>
            <div className="text-[10px] tracking-[0.25em] opacity-80 mb-1">— EMAIL PREVIEW</div>
            <h2 className="text-xl font-serif">{task.title}</h2>
          </div>
          <button onClick={onClose}
                  className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-white/20 transition-colors flex-shrink-0"
                  style={{ color: '#fff' }} aria-label="Close">
            <span style={{ fontSize: '18px', lineHeight: 1 }}>×</span>
          </button>
        </div>

        {/* Recipients summary */}
        <div className="px-5 sm:px-6 py-3 border-b text-xs space-y-1" style={{ borderColor: 'var(--border-soft)', background: 'var(--paper-soft, #FBFAF6)' }}>
          <div><strong className="opacity-60 inline-block w-14">To:</strong> johnho@evergreen-shipping.com.sa</div>
          <div><strong className="opacity-60 inline-block w-14">Cc:</strong> fahad.alhussain@..., badria.alhassan@..., jaffar.aldarweash@...</div>
          <div><strong className="opacity-60 inline-block w-14">Subject:</strong> {task.subject}</div>
        </div>

        {/* Rendered body preview */}
        <div className="px-5 sm:px-6 py-4 max-h-[55vh] overflow-y-auto">
          <div dangerouslySetInnerHTML={{ __html: task.bodyHtml }} />
        </div>

        {/* Action buttons */}
        <div className="px-5 sm:px-6 py-4 border-t flex flex-wrap items-center gap-2 sticky bottom-0 bg-white rounded-b-2xl"
             style={{ borderColor: 'var(--border-soft)' }}>
          <button onClick={onCompose}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg"
                  style={{ background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }}>
            <Mail className="w-3.5 h-3.5" /> Open in mail client
          </button>
          <button onClick={onCopyHtml}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg"
                  style={{ background: copied === 'html' ? '#DCFCE7' : 'rgba(45,95,63,0.08)', color: '#2D5F3F', border: '1px solid rgba(45,95,63,0.3)' }}>
            <Copy className="w-3.5 h-3.5" /> {copied === 'html' ? 'Copied with formatting' : 'Copy formatted (paste in Outlook)'}
          </button>
          <button onClick={onCopyPlain}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg"
                  style={{ background: copied === 'plain' ? '#DCFCE7' : 'transparent', color: 'var(--ink)', border: '1px solid var(--border-soft)' }}>
            <Copy className="w-3.5 h-3.5" /> {copied === 'plain' ? 'Copied plain text' : 'Copy plain text'}
          </button>
          <div className="text-[10px] opacity-60 ml-auto">
            {task.count} record{task.count === 1 ? '' : 's'} in this report
          </div>
        </div>
      </div>
    </div>
  );
}

// Fan-out modal: one prefilled email per department head. Each row sends to
// that manager only, CC the fixed oversight list. Bashaier sends/copies each
// individually so she stays in control of what goes out.
function DeptHeadReportModal({ title, managers, onClose }) {
  const [copiedId, setCopiedId] = useState('');
  const [openId, setOpenId]     = useState('');

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const sendOne = (m) => {
    if (!m.to) { alert(`No email address on file for ${m.name}. Add it to their employee record first.`); return; }
    const href = `mailto:${encodeURIComponent(m.to)}?cc=${encodeURIComponent(m.cc.join(';'))}`
      + `&subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.bodyPlain)}`;
    window.location.href = href;
  };
  const copyOne = async (m) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html':  new Blob([m.bodyHtml],  { type: 'text/html'  }),
        'text/plain': new Blob([m.bodyPlain], { type: 'text/plain' }),
      })]);
      setCopiedId(m.id);
      setTimeout(() => setCopiedId(c => (c === m.id ? '' : c)), 2000);
    } catch {
      try { await navigator.clipboard.writeText(m.bodyPlain); setCopiedId(m.id); setTimeout(() => setCopiedId(''), 2000); } catch {}
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 overflow-y-auto"
         style={{ background: 'rgba(20,30,25,0.6)' }}
         onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl my-8" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 sm:px-6 py-4 sticky top-0 z-10 rounded-t-2xl flex items-start justify-between gap-3"
             style={{ background: 'linear-gradient(135deg, #993556 0%, #7A2E47 100%)', color: '#fff' }}>
          <div>
            <div className="text-[10px] tracking-[0.25em] opacity-80 mb-1">— ONE EMAIL PER MANAGER</div>
            <h2 className="text-xl font-serif">{title}</h2>
            <div className="text-[11px] opacity-80 mt-0.5">{managers.length} department head{managers.length === 1 ? '' : 's'} · each goes to the manager, CC John, Fahad, Badria, Jaffar, James</div>
          </div>
          <button onClick={onClose}
                  className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-white/20 transition-colors flex-shrink-0"
                  style={{ color: '#fff' }} aria-label="Close">
            <span style={{ fontSize: '18px', lineHeight: 1 }}>×</span>
          </button>
        </div>

        <div className="px-5 sm:px-6 py-4 max-h-[70vh] overflow-y-auto space-y-2.5">
          {managers.length === 0 ? (
            <p className="text-sm" style={{ color: '#1F1B16', opacity: 0.7 }}>No department heads found (no staff have a manager assigned).</p>
          ) : managers.map(m => (
            <div key={m.id} className="rounded-xl border" style={{ borderColor: 'var(--border-soft)' }}>
              <div className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold truncate" style={{ color: '#1F1B16' }}>{m.name}</div>
                  <div className="text-[11px]" style={{ color: '#1F1B16', opacity: 0.65 }}>
                    {m.dept || '—'} · {m.teamSize} in team · {m.appCount} application{m.appCount === 1 ? '' : 's'}
                    {!m.to && <span style={{ color: '#B91C1C', fontWeight: 600 }}> · no email on file</span>}
                  </div>
                </div>
                <button type="button" onClick={() => setOpenId(o => (o === m.id ? '' : m.id))}
                        className="text-[11px] px-2 py-1.5 rounded-lg border inline-flex items-center gap-1"
                        style={{ borderColor: 'var(--border-soft)', color: '#1F1B16' }}>
                  Preview <ChevronDown className="w-3 h-3" style={{ transform: openId === m.id ? 'rotate(180deg)' : 'none' }} />
                </button>
                <button type="button" onClick={() => copyOne(m)}
                        className="text-[11px] px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1 font-semibold"
                        style={{ background: copiedId === m.id ? '#DCFCE7' : 'rgba(153,53,86,0.08)', color: '#993556', border: '1px solid #F4C0D1' }}>
                  {copiedId === m.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedId === m.id ? 'Copied' : 'Copy HTML'}
                </button>
                <button type="button" onClick={() => sendOne(m)} disabled={!m.to}
                        className="text-[11px] px-3 py-1.5 rounded-lg inline-flex items-center gap-1 font-semibold text-white disabled:opacity-40"
                        style={{ background: '#993556' }}>
                  <Mail className="w-3.5 h-3.5" /> Email
                </button>
              </div>
              {openId === m.id && (
                <div className="px-3 pb-3">
                  <div className="text-[11px] mb-2" style={{ color: '#1F1B16', opacity: 0.7 }}>
                    <strong>To:</strong> {m.to || '—'} &nbsp; <strong>Cc:</strong> {m.cc.join('; ')}
                  </div>
                  <div className="rounded-lg border p-3 bg-white overflow-x-auto" style={{ borderColor: 'var(--border-soft)' }}
                       dangerouslySetInnerHTML={{ __html: m.bodyHtml }} />
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="px-5 sm:px-6 py-3 border-t text-[10px] opacity-60" style={{ borderColor: 'var(--border-soft)' }}>
          Each email is addressed to the manager only; the oversight list is CC'd. Balances are annual leave for the current year.
        </div>
      </div>
    </div>
  );
}
