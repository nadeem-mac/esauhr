import React, { useMemo, useState, useEffect } from 'react';
import {
  CalendarDays, Coffee, Plane, Mail, Copy, ClipboardCheck,
  AlertCircle, CheckCircle2, ChevronRight, Clock, Check, ChevronDown, AlertTriangle,
} from 'lucide-react';
import { directGet, supabase } from '../supabaseClient.js';
import EvaluationReviewModal from './EvaluationReviewModal.jsx';

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
<p style="margin:18px 0 0;color:#1F2937;font-family:Calibri,Arial,sans-serif;font-size:14px">Thanks and regards,</p>
<p style="margin:14px 0 0;color:#1F2937;font-family:Calibri,Arial,sans-serif;font-size:14px;line-height:1.45">
  <strong>BASHAIER ALI</strong><br/>
  Evergreen Shipping Agency Saudi Co.,(L.L.C)<br/>
  ESAU - SADMN SUP/ HR DEPT<br/>
  P.O.Box : 1008,  DAMMAM &#8211; 31431, K.S.A<br/>
  966-54 320 9694 &nbsp;&nbsp;&nbsp;&nbsp; 966-013 813 8563 &#8211; Ext 8543<br/>
  <strong>Email:</strong> <a href="mailto:bashaier.alsubaie@evergreen-shipping.com.sa" style="color:#2D5F3F">bashaier.alsubaie@evergreen-shipping.com.sa</a>
</p>`;

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
function plainTable(headers, rows, widths) {
  const sep = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
  const renderRow = (cols) => '| ' + cols.map((c, i) => padR(c, widths[i])).join(' | ') + ' |';
  return [
    sep,
    renderRow(headers),
    sep,
    ...rows.map(renderRow),
    sep,
  ].join('\n');
}

// Build an HTML table for clipboard
function htmlTable(headers, rows) {
  const th = headers.map(h => `<th style="background:#2D5F3F;color:#fff;padding:8px 10px;text-align:left;font-weight:600;font-size:13px;border:1px solid #1F4530">${escapeHtml(h)}</th>`).join('');
  const trs = rows.map((r, i) => {
    const bg = i % 2 === 0 ? '#FFFFFF' : '#F8F8F2';
    const tds = r.map(c => `<td style="padding:7px 10px;border:1px solid #D1D5DB;color:#1F2937;font-size:13px;background:${bg}">${escapeHtml(c == null ? '' : String(c))}</td>`).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  return `<table style="border-collapse:collapse;width:100%;font-family:Calibri,Arial,sans-serif;margin:12px 0">
    <thead><tr>${th}</tr></thead>
    <tbody>${trs}</tbody>
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
function buildMidMonthPermissions({ permissions, employees, year, month, today }) {
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

  const tableRows = rows.map(p => {
    const emp = empMap[p.employee_id];
    return [
      fmtDateShort(p.permission_date),
      emp?.name || p.employee_id,
      emp?.department || '',
      PERM_TYPE_LABELS[p.type] || p.type || '',
      Number(p.hours || 0).toFixed(1) + 'h',
      p.status?.charAt(0).toUpperCase() + p.status?.slice(1),
      p.reason || '',
    ];
  });
  const headers = ['Date', 'Employee', 'Dept', 'Type', 'Hours', 'Status', 'Reason'];
  const widths = [12, 30, 6, 14, 6, 9, 30];
  const tablePlain = rows.length > 0 ? plainTable(headers, tableRows, widths) : '(No permission applications recorded so far this month.)';
  const tableHtml = rows.length > 0 ? htmlTable(headers, tableRows) : '<p style="color:#6B7280;font-style:italic">No permission applications recorded so far this month.</p>';

  const monthName = MONTH_FULL[month - 1];
  const range = `1\u201315 ${monthName} ${year}`;

  const subject = `Permissions Report - Mid-Month Update - ${monthName} ${year}`;

  const intro = [
    `Dear Mr John,`,
    '',
    `As part of our monthly compliance reporting, please find below the consolidated list of permission applications submitted by staff so far this month (${range}). The summary covers both late arrivals and early leaves, with hours and approval status against the monthly quota of 3 hours per employee.`,
    '',
  ].join('\n');

  const totalsLine = `Total this period: ${rows.length} application${rows.length === 1 ? '' : 's'}, ${totalHours.toFixed(1)} hours, ${peopleSet.size} unique staff`;

  const closing = [
    '',
    `The full month-end report will follow on the last day of the month. Please let me know if you would like any breakdown by department, by type, or by individual employee.`,
  ].join('\n');

  const bodyPlain = intro + tablePlain + '\n\n' + totalsLine + closing + SIGNATURE_PLAIN;

  const bodyHtml = `
    <div style="font-family:Calibri,Arial,sans-serif;color:#1F2937;font-size:14px;line-height:1.5">
      <p>Dear Mr John,</p>
      <p>As part of our monthly compliance reporting, please find below the consolidated list of permission applications submitted by staff so far this month (${escapeHtml(range)}). The summary covers both late arrivals and early leaves, with hours and approval status against the monthly quota of 3 hours per employee.</p>
      ${tableHtml}
      <p style="font-weight:600;color:#2D5F3F">${escapeHtml(totalsLine)}</p>
      <p>The full month-end report will follow on the last day of the month. Please let me know if you would like any breakdown by department, by type, or by individual employee.</p>
      ${SIGNATURE_HTML}
    </div>`;

  return { subject, bodyPlain, bodyHtml, count: rows.length };
}

// Task 2: End-of-month permissions report (whole month)
function buildEndOfMonthPermissions({ permissions, employees, year, month }) {
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

  const tableRows = rows.map(p => {
    const emp = empMap[p.employee_id];
    return [
      fmtDateShort(p.permission_date),
      emp?.name || p.employee_id,
      emp?.department || '',
      PERM_TYPE_LABELS[p.type] || p.type || '',
      Number(p.hours || 0).toFixed(1) + 'h',
      p.status?.charAt(0).toUpperCase() + p.status?.slice(1),
      p.reason || '',
    ];
  });
  const headers = ['Date', 'Employee', 'Dept', 'Type', 'Hours', 'Status', 'Reason'];
  const widths = [12, 30, 6, 14, 6, 9, 30];
  const tablePlain = rows.length > 0 ? plainTable(headers, tableRows, widths) : '(No permission applications recorded for this month.)';
  const tableHtml = rows.length > 0 ? htmlTable(headers, tableRows) : '<p style="color:#6B7280;font-style:italic">No permission applications recorded for this month.</p>';

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

  const bodyHtml = `
    <div style="font-family:Calibri,Arial,sans-serif;color:#1F2937;font-size:14px;line-height:1.5">
      <p>Dear Mr John,</p>
      <p>Please find below the full month-end report of permission applications submitted by staff during ${escapeHtml(monthName + ' ' + year)}. The list covers all late arrivals and early leaves recorded for the month, with hours and approval status against the monthly quota of 3 hours per employee.</p>
      ${tableHtml}
      <p style="font-weight:600;color:#2D5F3F">${escapeHtml(totalsLine)}</p>
      <p>Please let me know if you would like any breakdown by department, by type, or by individual employee.</p>
      ${SIGNATURE_HTML}
    </div>`;

  return { subject, bodyPlain, bodyHtml, count: rows.length };
}

// Task 3: Last month vacation summary (with return dates)
function buildVacationSummary({ requests, employees, year, month }) {
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
  const tableHtml = rows.length > 0 ? htmlTable(headers, tableRows) : '<p style="color:#6B7280;font-style:italic">No vacation applications recorded for last month.</p>';

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
    <div style="font-family:Calibri,Arial,sans-serif;color:#1F2937;font-size:14px;line-height:1.5">
      <p>Dear Mr John,</p>
      <p>Please find below the summary of vacation applications taken by staff during ${escapeHtml(monthName + ' ' + year)}, including their return dates. This covers all approved leaves that overlap with the month.</p>
      ${tableHtml}
      <p style="font-weight:600;color:#2D5F3F">${escapeHtml(totalsLine)}</p>
      <p>Please let me know if you would like any further breakdown by department or by individual employee.</p>
      ${SIGNATURE_HTML}
    </div>`;

  return { subject, bodyPlain, bodyHtml, count: rows.length };
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

// Task 4: Monthly shift-staff timing reminder. Reminds dept managers to verify
// or update shift-based working hours for any of their team members. Bashaier
// sees this in her tasks card and clicks to send the reminder email.
function buildShiftStaffReminder({ year, month }) {
  const monthName = MONTH_FULL[month - 1] + ' ' + year;
  const subject = 'Monthly Reminder \u2014 Please update shift-staff timing in HR system (' + monthName + ')';
  const bodyPlain =
    'Dear team,\n\n' +
    'I hope you are well. This is the monthly reminder from HR to please review and update the shift-based working hours for any team member who works on a non-standard schedule.\n\n' +
    'Why this matters: Our daily attendance check applies the standard 08:00 \u2013 17:00 schedule (or 08:00 \u2013 16:00 for the SUP/HR team) to detect late arrivals and early departures. If a team member is on a different shift and we do not have it on file, the system will incorrectly flag them as late or early, and they will receive an email they should not have.\n\n' +
    'What I am asking: Please open the HR portal, find any team member whose schedule is not the standard 08:00 \u2013 17:00, and either confirm their existing shift entry is still correct, or update it. Once you save it, the team member will be asked to acknowledge the schedule, and HR will be notified once they accept.\n\n' +
    'If you have no shift staff or all schedules are already correct, a quick reply confirming that is all I need.\n\n' +
    'Thank you for keeping the records accurate \u2014 it makes a real difference for fair attendance handling and payroll.\n\n' +
    HR_SIGNATURE;
  const bodyHtml =
    `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#1F2937;line-height:1.55">
      <p>Dear team,</p>
      <p>I hope you are well. This is the monthly reminder from HR to please review and update the shift-based working hours for any team member who works on a non-standard schedule.</p>
      <p><strong>Why this matters:</strong> Our daily attendance check applies the standard 08:00 \u2013 17:00 schedule (or 08:00 \u2013 16:00 for the SUP/HR team) to detect late arrivals and early departures. If a team member is on a different shift and we do not have it on file, the system will incorrectly flag them as late or early.</p>
      <p><strong>What I am asking:</strong> Please open the HR portal, find any team member whose schedule is not the standard 08:00 \u2013 17:00, and either confirm their existing shift entry is still correct, or update it. Once saved, the team member will acknowledge the schedule, and HR will be notified.</p>
      <p>If you have no shift staff or all schedules are already correct, a quick reply confirming that is all I need.</p>
      <p>Thank you for keeping the records accurate \u2014 it makes a real difference for fair attendance handling and payroll.</p>
      ${SIGNATURE_HTML}
    </div>`;
  return { subject, bodyPlain, bodyHtml, count: 0 };
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================
export default function BashaierTasksCard({ employees, requests, permissions: passedPerms }) {
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
  const [loggedEvalKeys, setLoggedEvalKeys] = useState({});  // 'empId:YYYY-MM' → true
  const [evalPanelOpen, setEvalPanelOpen] = useState(false);
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
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const rows = await directGet(
          'attendance_violations',
          `select=employee_id,violation_type,violation_date` +
          `&violation_date=gte.${monthRange.start}&violation_date=lte.${monthRange.end}` +
          `&order=violation_date`,
          { timeoutMs: 8000 }
        );
        if (mounted) setMonthViolations(Array.isArray(rows) ? rows : []);
      } catch {
        if (mounted) setMonthViolations([]);
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
    };
    refresh();
    const ch = supabase.channel('hr-monthly-violations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_violations' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'evaluation_scores' }, refresh)
      .subscribe();
    return () => { mounted = false; supabase.removeChannel(ch); };
  }, [monthRange.start, monthRange.end, monthRange.monthStart]);

  // Aggregate to one row per employee with >5 violations this month.
  const escalations = useMemo(() => {
    const byEmp = new Map();
    monthViolations.forEach(v => {
      if (!v?.employee_id) return;
      let agg = byEmp.get(v.employee_id);
      if (!agg) {
        agg = { employeeId: v.employee_id, totalCount: 0, lateCount: 0, earlyCount: 0, missedCount: 0, dates: new Set() };
        byEmp.set(v.employee_id, agg);
      }
      agg.totalCount += 1;
      if (v.violation_type === 'late') agg.lateCount += 1;
      else if (v.violation_type === 'early' || v.violation_type === 'early_leave') agg.earlyCount += 1;
      else if (v.violation_type === 'missed_in' || v.violation_type === 'missed_out') agg.missedCount += 1;
      if (v.violation_date) agg.dates.add(v.violation_date);
    });
    return Array.from(byEmp.values())
      .filter(a => a.totalCount > 5)
      .map(a => {
        const emp = (employees || []).find(e => e.id === a.employeeId);
        const monthYM = monthRange.monthStart.slice(0, 7);
        return {
          ...a,
          dates: Array.from(a.dates).sort(),
          monthStart: monthRange.monthStart,
          employeeName: emp?.name || a.employeeId,
          alreadyLogged: !!loggedEvalKeys[`${a.employeeId}:${monthYM}`],
        };
      })
      .sort((a, b) => b.totalCount - a.totalCount);
  }, [monthViolations, employees, loggedEvalKeys, monthRange.monthStart]);

  const escalationsPending = useMemo(
    () => escalations.filter(r => !r.alreadyLogged),
    [escalations]
  );

  const openReviewFor = (row) => {
    const employee = (employees || []).find(e => e.id === row.employeeId) || { id: row.employeeId };
    const manager  = employee?.manager_id
      ? (employees || []).find(e => e.id === employee.manager_id) || null
      : null;
    setReviewModalRow({ row, employee, manager });
  };
  // ────────────────────────────────────────────────────────────────────────

  const tasks = useMemo(() => [
    {
      key: 'mid_month_perms',
      title: 'Mid-month permissions report',
      subtitle: `Send a 1\u201315 ${MONTH_FULL[month-1]} update to Mr John`,
      icon: <Coffee className="w-4 h-4" />,
      tone: '#C97A4F',
      build: () => buildMidMonthPermissions({ permissions: perms, employees, year, month, today }),
    },
    {
      key: 'end_of_month_perms',
      title: 'End-of-month permissions report',
      subtitle: `Full ${MONTH_FULL[month-1]} ${year} permissions report`,
      icon: <CalendarDays className="w-4 h-4" />,
      tone: '#5A8A9A',
      build: () => buildEndOfMonthPermissions({ permissions: perms, employees, year, month }),
    },
    {
      key: 'last_month_vacation',
      title: `${MONTH_FULL[prevMonth-1]} vacation summary`,
      subtitle: 'Last month staff vacations with return dates',
      icon: <Plane className="w-4 h-4" />,
      tone: '#2D5F3F',
      build: () => buildVacationSummary({ requests, employees, year: prevYear, month: prevMonth }),
    },
    {
      key: 'shift_staff_reminder',
      title: 'Shift staff timing reminder',
      subtitle: 'Remind department managers to update shift-based schedules in the system',
      icon: <Clock className="w-4 h-4" />,
      tone: '#7E22CE',
      build: () => buildShiftStaffReminder({ year, month }),
    },
  ], [perms, employees, requests, month, year, prevMonth, prevYear]);

  const open = (task) => {
    const built = task.build();
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
        style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}
      >
        <div className="flex items-baseline justify-between mb-4 pb-3 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--evergreen-500)' }} />
            <h3 className="serif text-lg" style={{ fontWeight: 500 }}>Reports for Mr John</h3>
          </div>
          <div className="text-xs opacity-60 flex items-center gap-1.5">
            <ClipboardCheck className="w-3 h-3" /> 3 scheduled emails
          </div>
        </div>

        <p className="text-xs mb-4" style={{ color: '#1F1B16' }}>
          Click any task to preview, then send via your mail client or copy to paste into Outlook.
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
                    ? `${escalationsPending[0].employeeName.split(' ')[0]} crossed the monthly attendance threshold`
                    : `${escalationsPending.length} staff crossed the monthly attendance threshold`}
                </div>
                <div className="text-[11px]" style={{ color: '#1F1B16' }}>
                  Above 5 incidents this month — review and notify direct manager
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
                    const charged = Math.max(0, row.totalCount - 5);
                    return (
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
                            {row.totalCount} incidents · {row.lateCount} late · {row.earlyCount} early · {row.missedCount} missed
                            {' · '}<strong>{charged * 2} pt deduction</strong>
                          </div>
                        </div>
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

        <div className="space-y-2.5">
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
         style={{ background: 'rgba(20,30,25,0.55)', backdropFilter: 'blur(2px)' }}
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
