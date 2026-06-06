// =============================================================================
// ShiftStaffAttendanceReportCard.jsx
//
// HR-only (Bashaier) panel in the Attendance tab. Pulls in/out punches
// and total worked hours for every employee where is_shift_staff = true,
// over a configurable date range (default: last 30 days).
//
// USE CASE (the email Sonnie sends Bashaier every month):
//   "Please assist to review time in and out for following staff to help
//    me monitor their performance ... KHALID AL MUTAIRI - H94801,
//    ABDULRAHMAN ALGHAMDI - H94499."
// Instead of Bashaier hand-pulling each row, the card shows the report
// pre-built, and the Download button hands her an HTML she can attach
// to her reply.
//
// DATA
//   • employees: filtered to is_shift_staff = true
//   • attendance_daily: rows for those employees over the date window
//     (employee_id, attendance_date, first_punch, last_punch, total_minutes,
//      status, source). The total_minutes column carries the parsed
//     worked-time from the Time Card xlsx upload.
//
// RENDER
//   • Date range chooser (default last 30 days)
//   • Group-by-employee accordion (expand to see daily rows)
//   • Top-line per-staff summary: total days present, total hours worked,
//     average daily hours, days marked as leave
//   • Download as printable HTML — the same letterhead+brand vocabulary
//     as the monthly attendance report so Bashaier's email recipients
//     recognise the format.
// =============================================================================

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Clock, Download, ChevronDown, ChevronRight, FileText, Users, Mail, FileSpreadsheet, ClipboardCopy, Printer } from 'lucide-react';
import * as XLSX from 'xlsx';
import XLSXStyle from 'xlsx-js-style';
import ExcelJS from 'exceljs';
import { directGet } from '../supabaseClient.js';
import { todayLocal, addDaysIso, isKsaWeekend, isoDayOfWeek } from '../lib/dateUtils.js';
import { salutationFor } from '../lib/salutations.js';
import { renderHrSignature, renderHrSignatureHtml } from '../lib/emailTemplates.js';

// ─── helpers ───────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function fmtDateLong(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  });
}

function fmtTime(iso) {
  if (!iso) return '—';
  // Punch columns are stored as 'HH:MM:SS' or a full ISO timestamp.
  // Handle both: if the value lacks a 'T', treat as time-only.
  if (typeof iso === 'string' && !iso.includes('T') && iso.includes(':')) {
    return iso.length >= 5 ? iso.slice(0, 5) : iso;
  }
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtHoursMins(minutes) {
  if (minutes == null || isNaN(minutes)) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0 && m === 0) return '0h';
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// ── status label & punch-type detection ────────────────────────────────────
//
// attendance_daily.status is one of: present|late|short|absent|annual_leave|
// sick_leave|off_day|off_roster. 'short' covers both "left early" and
// "missing one punch" — Bashaier needs to distinguish them because the
// follow-up conversation is different:
//   • missing in-punch  → forgot to scan on arrival (low severity)
//   • missing out-punch → left without scanning out (medium severity)
//   • early leave       → arrived fine but left before shift end (high)
//
// Detection (client-side from punches):
//   • only first_punch       → missing OUT
//   • only last_punch        → missing IN
//   • both punches + 'short' → genuine early leave (early_leave_minutes>0)
function classifyShort(row) {
  const hasIn  = !!row.first_punch;
  const hasOut = !!row.last_punch;
  if (hasIn && !hasOut) return { kind: 'missed_out', label: 'No out-punch',  short: 'No out' };
  if (!hasIn && hasOut) return { kind: 'missed_in',  label: 'No in-punch',   short: 'No in'  };
  return                       { kind: 'early',      label: 'Left early',    short: 'Early'  };
}

// Build a human label for the Status column. Adds minute counts where
// available so 'Late' becomes 'Late · 47 min' and 'Short' becomes
// 'No out-punch' / 'No in-punch' / 'Left early · 32 min'.
function detailedStatusLabel(row) {
  switch (row.status) {
    case 'present':      return 'Present';
    case 'late': {
      const m = Number(row.late_minutes) || 0;
      return m > 0 ? `Late · ${m} min` : 'Late';
    }
    case 'short': {
      const { kind, label } = classifyShort(row);
      if (kind === 'early') {
        const m = Number(row.early_leave_minutes) || 0;
        return m > 0 ? `${label} · ${m} min` : label;
      }
      return label;
    }
    case 'absent':            return 'Absent';
    case 'sick_leave':        return 'Sick leave';
    case 'annual_leave':      return 'Annual leave';
    case 'maternity_leave':   return 'Maternity leave';
    case 'paternity_leave':   return 'Paternity leave';
    case 'hajj_leave':        return 'Hajj leave';
    case 'marriage_leave':    return 'Marriage leave';
    case 'bereavement_leave': return 'Bereavement leave';
    case 'unpaid_leave':      return 'Unpaid leave';
    case 'emergency_leave':   return 'Emergency leave';
    case 'iddah_leave':       return 'Iddah leave';
    case 'off_day':           return 'Off day';
    case 'off_roster':        return 'Off roster';
    default:                  return row.status || '—';
  }
}

// Pill colours by status family (used both inline + in the HTML report).
function statusPill(status) {
  switch (status) {
    case 'present':           return { bg: '#DCFCE7', fg: '#166534' };
    case 'late':
    case 'short':             return { bg: '#FEF3C7', fg: '#92400E' };
    case 'absent':            return { bg: '#FEE2E2', fg: '#991B1B' };
    case 'sick_leave':        return { bg: '#EDE9FE', fg: '#5B21B6' };
    case 'annual_leave':      return { bg: '#CCFBF1', fg: '#115E59' };
    case 'maternity_leave':   return { bg: '#FCE7F3', fg: '#9D174D' };
    case 'paternity_leave':   return { bg: '#E0F2FE', fg: '#075985' };
    case 'hajj_leave':        return { bg: '#FEF3C7', fg: '#854F0B' };
    case 'marriage_leave':    return { bg: '#FCE7F3', fg: '#831843' };
    case 'bereavement_leave': return { bg: '#E5E7EB', fg: '#374151' };
    case 'unpaid_leave':      return { bg: '#F3F4F6', fg: '#374151' };
    case 'emergency_leave':   return { bg: '#FEE2E2', fg: '#7F1D1D' };
    case 'iddah_leave':       return { bg: '#F3E8FF', fg: '#6B21A8' };
    case 'off_day':
    case 'off_roster':        return { bg: '#F3F4F6', fg: '#374151' };
    default:                  return { bg: '#F3F4F6', fg: '#374151' };
  }
}

// Walk a date window and emit YYYY-MM-DD strings for every weekday
// (skipping KSA weekend Fri+Sat). Used to detect days where a flagged
// shift staff has NO attendance row at all — those are silent absences.
// Tolerance (minutes) before a worked day counts as an hours shortfall.
// Matches the 15-minute late grace: arriving within grace and leaving on
// time leaves a few minutes' gap against the assigned window (e.g. an
// 08:00–17:00 = 9h window with an 08:06 in / 17:02 out = 8h56m presence),
// which must NOT be flagged red. (Nadeem 2026-06-05)
const SHORTFALL_GRACE_MIN = 15;

function eachWeekday(fromIso, toIso) {
  const out = [];
  if (!fromIso || !toIso) return out;
  const start = new Date(fromIso + 'T00:00:00');
  const end   = new Date(toIso   + 'T00:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();   // Fri=5, Sat=6
    if (dow === 5 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Parse a 'HH:MM:SS' or 'HH:MM' time string to minutes-since-midnight.
// Returns null for empty / malformed values.
function timeToMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  const parts = t.split(':');
  if (parts.length < 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

// Worked minutes between first_punch and last_punch. Handles overnight
// shifts (e.g. 20:00 -> 05:00) by adding 24h when the last punch is
// numerically less than the first.
// Returns null when either punch is missing — those days show '—'
// in the Total column rather than '0h', which would falsely suggest
// the person worked zero minutes when actually we have no signal.
function computeWorkedMinutes(firstPunch, lastPunch) {
  const a = timeToMinutes(firstPunch);
  const b = timeToMinutes(lastPunch);
  if (a == null || b == null) return null;
  let diff = b - a;
  if (diff < 0) diff += 24 * 60;       // overnight shift
  // Sanity bound: ignore obvious data errors like 23-hour days.
  if (diff > 18 * 60) return null;
  return diff;
}

// ── shift compliance + overnight handling ─────────────────────────────────
//
// "Did the staff follow the proper procedure for their assigned shift?"
// Three checks, computed against attendance_daily.expected_start /
// expected_end (set at upload time from employee_shifts.start_time /
// end_time — see attendanceRecorder.js). All three with a 15-min
// grace window so a small data entry slip doesn't flag a clean day.
//
//   onTime:    in_punch  <= expected_start + 15min grace
//   fullShift: out_punch >= expected_end   - 15min grace
//   bothPunch: in_punch AND out_punch both recorded
//
// A "clean shift day" is when all three are true.
//
// OVERNIGHT SHIFTS (Abdulrahman case 2026-05-10):
// When expected_end < expected_start (e.g. 20:00 → 05:00), the shift
// crosses midnight. The system stores punches keyed by calendar date,
// so the shift's IN is on day D's row but the OUT is on day D+1's row
// (the next morning). Standard logic compared today's first_punch /
// last_punch — which for overnight means it compared yesterday's
// shift-end against today's expected_start. Garbage. This helper:
//   • detects overnight via expected_end < expected_start
//   • for IN, uses today's evening-side punch (last_punch if first
//     looks like a morning carry-out; first_punch otherwise)
//   • for OUT, uses tomorrow's first_punch (passed in as nextDayRow)
//   • computes worked minutes across the two-day pair
// Skipped (no compliance flags) when:
//   • expected_start / expected_end is null (no shift assigned that day)
//   • status is a leave variant or off_day / off_roster
//   • row is a synthetic absence (no record at all)

const GRACE_MIN = 15;

function isNextCalendarDay(aDate, bDate) {
  if (!aDate || !bDate) return false;
  const a = new Date(aDate + 'T00:00:00');
  const b = new Date(bDate + 'T00:00:00');
  return (b.getTime() - a.getTime()) === 24 * 3600 * 1000;
}

function enrichForShift(row, nextDayRow) {
  const out = {
    isShiftDay:        false,
    isOvernight:       false,
    onTime:            null,
    fullShift:         null,
    bothPunch:         null,
    effective_in:      row.first_punch,
    effective_out:     row.last_punch,
    effective_carry:   null,  // morning carry-out punch from previous shift
    total_minutes:     computeWorkedMinutes(row.first_punch, row.last_punch),
  };
  // Skip non-working days.
  if (!row.expected_start || !row.expected_end) return out;
  if (row.status === 'off_day' || row.status === 'off_roster') return out;
  if (row.status && row.status.endsWith('_leave')) return out;
  out.isShiftDay = true;

  const expStart = timeToMinutes(row.expected_start);
  const expEnd   = timeToMinutes(row.expected_end);
  out.isOvernight = expEnd < expStart;

  if (!out.isOvernight) {
    // ─── Day shift — straightforward ───────────────────────────
    const inMin    = timeToMinutes(row.first_punch);
    const outMin   = timeToMinutes(row.last_punch);
    out.bothPunch  = !!(row.first_punch && row.last_punch);
    if (inMin != null) out.onTime    = (inMin  - expStart) <= GRACE_MIN;
    if (outMin != null) out.fullShift = (outMin - expEnd)   >= -GRACE_MIN;
    return out;
  }

  // ─── Overnight shift ─────────────────────────────────────────
  // Determine which of today's punches is the actual shift-IN. If
  // first_punch is in the morning hours, it's the carry-out from
  // yesterday's shift, so today's shift-IN is in last_punch. If
  // first_punch is already in the evening, that's the only punch we
  // have and it IS the shift-IN. Carry-out from yesterday is captured
  // separately so the table can still show it.
  const fpMin = timeToMinutes(row.first_punch);
  const lpMin = timeToMinutes(row.last_punch);
  // "Evening" = 12:00 onwards. Conservative — handles shifts starting
  // anywhere from noon to midnight.
  const fpEvening = fpMin != null && fpMin >= 12 * 60;
  const lpEvening = lpMin != null && lpMin >= 12 * 60;

  let actualIn = null;
  if (fpEvening) {
    actualIn = row.first_punch;
    // No carry-out punch on this row.
  } else if (lpEvening) {
    actualIn = row.last_punch;
    // first_punch was a morning carry-out from yesterday's shift.
    out.effective_carry = row.first_punch;
  } else if (row.first_punch) {
    // Both punches are morning — both are carry-outs, no IN today.
    out.effective_carry = row.first_punch;
  }

  // OUT is on tomorrow's row as its first_punch (the morning end).
  const actualOut = nextDayRow?.first_punch || null;

  out.effective_in   = actualIn;
  out.effective_out  = actualOut;
  out.bothPunch      = !!(actualIn && actualOut);
  out.total_minutes  = computeWorkedMinutes(actualIn, actualOut);

  // On-time check: actualIn vs expected_start, with grace.
  if (actualIn) {
    const inMin = timeToMinutes(actualIn);
    const diff  = inMin - expStart;
    out.onTime  = diff <= GRACE_MIN && diff >= -3 * 60;   // within 3h before is fine
  }
  // Full-shift check: actualOut (next morning) vs expected_end.
  if (actualOut) {
    const outMin = timeToMinutes(actualOut);
    const diff   = outMin - expEnd;
    out.fullShift = diff >= -GRACE_MIN;
  }
  return out;
}

// Format an expected window as "06:00 → 18:00" (or "20:00 → 05:00 (+1)"
// for overnight shifts so the next-day end is visually obvious).
function fmtShiftWindow(start, end) {
  const s = start ? String(start).slice(0, 5) : null;
  const e = end   ? String(end).slice(0, 5)   : null;
  if (!s && !e) return null;
  if (!s || !e)  return `${s || '—'}  →  ${e || '—'}`;
  const sMin = timeToMinutes(s);
  const eMin = timeToMinutes(e);
  const overnight = sMin != null && eMin != null && eMin < sMin;
  return overnight ? `${s}  →  ${e}  (+1)` : `${s}  →  ${e}`;
}

// ─── main component ────────────────────────────────────────────────────────

/**
 * @param {Array} employees — full employees list (we filter for is_shift_staff
 *                            AND use it as a lookup table for managers)
 * @param {object} me — current user (for the "generated by" stamp)
 */
export default function ShiftStaffAttendanceReportCard({ employees = [], me }) {
  // Date window — default last 30 days inclusive of today.
  // todayLocal() returns 'YYYY-MM-DD'; localDateString(date) needs an
  // actual Date arg and returned null when called bare. The null then
  // hit the date filter as the literal string 'null' and Supabase
  // rejected the query (22007 invalid input syntax for type date).
  const today = todayLocal();
  const [from, setFrom] = useState(today);   // default: today (single-day)
  const [to,   setTo]   = useState(today);
  const [expanded, setExpanded] = useState(new Set());  // employee IDs whose drill-down is open
  const [reportScope, setReportScope] = useState('all'); // 'all' or a specific employee id for export
  const [copiedId, setCopiedId] = useState(null);
  const [attendance, setAttendance] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [searched, setSearched] = useState(false);  // gate: data shows only after Search
  const [holidays, setHolidays] = useState(new Map()); // date(YYYY-MM-DD) → holiday name
  const [morningMode, setMorningMode] = useState(false);            // 10AM two-part report
  const [pendingMorningGenerate, setPendingMorningGenerate] = useState(false);

  // Shift-flagged staff only. We also compute a stable string key
  // of just the IDs so the load() callback can depend on the SET of
  // people (not the array reference). Without this the load fires
  // on every parent re-render of AttendanceView — and AttendanceView
  // re-renders a lot during the daily upload flow — which caused a
  // visible flicker as the loading state flipped on/off.
  // The report now covers ALL staff (renamed to "Attendance report
  // card"). Shift staff are still identified — via shiftIdSet — so they
  // can be colour-marked in the list, HTML report and Excel.
  // Nadeem 2026-06-03.
  const shiftStaff = useMemo(
    () => (employees || []).slice(),
    [employees]
  );
  const shiftIdSet = useMemo(
    () => new Set((employees || []).filter(e => e.is_shift_staff === true).map(e => e.id)),
    [employees]
  );
  const staffKey = useMemo(
    () => shiftStaff.map(e => e.id).sort().join(','),
    [shiftStaff]
  );

  // Manager lookup for the "email manager" button — empMap[id] -> employee.
  const empMap = useMemo(() => {
    const m = {};
    for (const e of (employees || [])) m[e.id] = e;
    return m;
  }, [employees]);

  // Build mailto: link for a per-staff escalation email to the line manager.
  // Pre-fills subject and body with the problem rows so Bashaier doesn't
  // copy-paste — one tap opens her email client with everything filled.
  const emailManager = useCallback((summary) => {
    const emp     = summary.emp;
    const manager = emp.manager_id ? empMap[emp.manager_id] : null;
    if (!manager?.email) {
      alert(`No email address on file for ${emp.name}'s manager. Update the manager's email on their employee record first.`);
      return;
    }
    const periodLabel = `${fmtDate(from)} – ${fmtDate(to)}`;
    const lines = [];
    lines.push(`Dear ${salutationFor(manager)},`);
    lines.push('');
    lines.push(`Please review the attendance anomalies below for ${emp.name} (${emp.id}) covering ${periodLabel}, pulled from the fingerprint records.`);
    lines.push('');
    lines.push(`Summary: ${summary.daysLate} late · ${summary.daysShort} short · ${summary.daysAbsent} absent · ${summary.daysPresent} days present in window.`);
    lines.push('');
    if (summary.problemRows.length > 0) {
      lines.push('Anomalies:');
      for (const r of summary.problemRows) {
        const tIn  = fmtTime(r.first_punch) || '—';
        const tOut = fmtTime(r.last_punch)  || '—';
        const tot  = fmtHoursMins(r.total_minutes);
        lines.push(`  • ${fmtDateLong(r.attendance_date)}   In: ${tIn}   Out: ${tOut}   Total: ${tot}   ${detailedStatusLabel(r)}`);
      }
      lines.push('');
    }
    lines.push('Day-to-day supervision stays with you as their line manager — please let me know if any of these need to be formalised into a notice from HR side.');
    lines.push('');
    lines.push(renderHrSignature());

    const subject = `Attendance review – ${emp.name} (${emp.id}) · ${periodLabel}`;
    const body    = lines.join('\n');
    const href    = `mailto:${encodeURIComponent(manager.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = href;
  }, [empMap, from, to, me]);

  // Build a clean HTML report for one staff member's anomalies that
  // Bashaier can paste straight into Outlook (keeps table + signature
  // formatting). Copies both rich HTML and a plain-text fallback.
  const copyManagerHtml = useCallback(async (summary) => {
    const emp     = summary.emp;
    const manager = emp.manager_id ? empMap[emp.manager_id] : null;
    const periodLabel = `${fmtDate(from)} – ${fmtDate(to)}`;
    const rowsHtml = (summary.problemRows.length ? summary.problemRows : summary.rows).map((r, i) => {
      const bg = i % 2 === 0 ? '#FFFFFF' : '#F7F7F2';
      return `<tr>
        <td style="padding:6px 12px;border:1px solid #D1D5DB;font-size:13px;background:${bg};white-space:nowrap;font-weight:600;color:#1F2937">${escapeHtml(fmtDateLong(r.attendance_date))}</td>
        <td style="padding:6px 12px;border:1px solid #D1D5DB;font-size:13px;background:${bg};white-space:nowrap;color:#1F2937">${escapeHtml(fmtShiftWindow(r.expected_start, r.expected_end) || '—')}</td>
        <td style="padding:6px 12px;border:1px solid #D1D5DB;font-size:13px;background:${bg};white-space:nowrap;color:#1F2937">${escapeHtml(fmtTime(r.effective_in) || '—')}</td>
        <td style="padding:6px 12px;border:1px solid #D1D5DB;font-size:13px;background:${bg};white-space:nowrap;color:#1F2937">${escapeHtml(fmtTime(r.effective_out) || '—')}</td>
        <td style="padding:6px 12px;border:1px solid #D1D5DB;font-size:13px;background:${bg};white-space:nowrap;color:#1F2937">${escapeHtml(fmtHoursMins(r.total_minutes))}</td>
        <td style="padding:6px 12px;border:1px solid #D1D5DB;font-size:13px;background:${bg};color:#1F2937">${escapeHtml(detailedStatusLabel(r))}</td>
      </tr>`;
    }).join('');
    const html = `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#0A0A0A;line-height:1.5;max-width:820px">
  <p style="margin:0 0 12px 0">Dear ${escapeHtml(salutationFor(manager || {}))},</p>
  <p style="margin:0 0 12px 0">Please review the attendance record below for <strong>${escapeHtml(emp.name)} (${escapeHtml(emp.id)})</strong> covering <strong>${escapeHtml(periodLabel)}</strong>, pulled from the fingerprint records.</p>
  <p style="margin:0 0 12px 0">Summary: ${summary.daysLate} late · ${summary.daysShort} short · ${summary.daysAbsent} absent · ${summary.daysPresent} days present in window.</p>
  <table style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;margin:12px 0">
    <thead><tr>
      ${['Date','Assigned shift','In','Out','Total','Status'].map(h => `<th style="background:#2D5F3F;color:#fff;padding:7px 12px;text-align:left;font-weight:600;font-size:13px;border:1px solid #1F4530">${h}</th>`).join('')}
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <p style="margin:14px 0 12px 0">Day-to-day supervision stays with you as their line manager — please let me know if any of these need to be formalised into a notice from HR side.</p>
  ${renderHrSignatureHtml()}
</div>`;
    const plain = `Attendance review – ${emp.name} (${emp.id}) · ${periodLabel}`;
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new window.ClipboardItem({
          'text/html':  new Blob([html],  { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        })]);
      } else {
        await navigator.clipboard.writeText(html);
      }
      setCopiedId(emp.id);
      setTimeout(() => setCopiedId(c => (c === emp.id ? null : c)), 2000);
    } catch (e) {
      alert('Could not copy to clipboard: ' + (e?.message || e));
    }
  }, [empMap, from, to]);

  // Fetch attendance_daily rows for the date window + flagged staff.
  // attendance_daily has first_punch + last_punch as TIME columns; the
  // worked-time isn't stored directly. We fetch the punches plus
  // late/early/expected columns and compute total worked minutes
  // client-side. Schema reference: supabase/migration_attendance_daily.sql
  const load = useCallback(async (fromArg = from, toArg = to) => {
    if (shiftStaff.length === 0) {
      setAttendance([]);
      return;
    }
    // Belt-and-braces: even after fixing the initial null bug, the
    // date-picker inputs CAN produce empty strings if the user clears
    // them. Don't fire the query in that state — show the existing
    // data and wait for them to set a valid range.
    if (!fromArg || !toArg) return;
    setLoading(true);
    setErr(null);
    try {
      const ids = shiftStaff.map(e => `"${e.id}"`).join(',');
      const q = `select=employee_id,attendance_date,first_punch,last_punch,punch_count,expected_start,expected_end,late_minutes,early_leave_minutes,status,leave_request_id`
             + `&employee_id=in.(${ids})`
             + `&attendance_date=gte.${fromArg}`
             + `&attendance_date=lte.${toArg}`
             + `&order=attendance_date.asc`;
      const rows = await directGet('attendance_daily', q, { timeoutMs: 12000 });
      // Group by employee + sort by date so we can pair overnight
      // shifts with the next calendar day's morning out-punch.
      const grouped = new Map();
      for (const r of (Array.isArray(rows) ? rows : [])) {
        if (!grouped.has(r.employee_id)) grouped.set(r.employee_id, []);
        grouped.get(r.employee_id).push(r);
      }
      for (const list of grouped.values()) {
        list.sort((a, b) =>
          a.attendance_date < b.attendance_date ? -1 :
          a.attendance_date > b.attendance_date ?  1 : 0);
      }

      // Enrich each row with overnight-aware shift compliance:
      //   • Day shift: IN = first_punch, OUT = last_punch (existing).
      //   • Overnight shift: IN = today's evening punch, OUT = tomorrow's
      //     morning first_punch. Worked minutes computed across the
      //     two calendar days. Compliance flags evaluated against the
      //     real shift, not against today's noise (the carry-out from
      //     yesterday's shift sitting in today's first_punch).
      const enriched = [];
      for (const [, list] of grouped) {
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          const next = (i + 1 < list.length) ? list[i + 1] : null;
          // Only treat as "consecutive day" if attendance_date for next
          // is exactly one day after current — otherwise we'd pair a
          // Thursday with the following Sunday across the weekend.
          const nextDay = next && isNextCalendarDay(r.attendance_date, next.attendance_date)
            ? next : null;
          enriched.push({
            ...r,
            ...enrichForShift(r, nextDay),
          });
        }
      }
      setAttendance(enriched);
      // Public holidays in range — used to mark holiday dates and to
      // suppress false absences on them. (Nadeem 2026-06-05)
      try {
        const hq = `select=date,name&date=gte.${fromArg}&date=lte.${toArg}&order=date`;
        const hrows = await directGet('public_holidays', hq, { timeoutMs: 8000 });
        const hmap = new Map();
        (Array.isArray(hrows) ? hrows : []).forEach(h => {
          if (h?.date) hmap.set(String(h.date).slice(0, 10), h.name || 'Public holiday');
        });
        setHolidays(hmap);
      } catch { setHolidays(new Map()); /* non-fatal — table may be empty */ }
    } catch (e) {
      console.error('[shift-staff report] load failed:', e);
      setErr(e?.message || 'Failed to load attendance');
    } finally {
      setLoading(false);
    }
    // We depend on the stable string key (staffKey) instead of the
    // shiftStaff array — the array reference can change on every
    // parent render even when the IDs are identical, which would
    // refire the fetch and cause a visible flicker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staffKey, from, to]);

  // No auto-load — the report is search-gated. Data appears only after
  // the user picks a period and presses Search. (Nadeem 2026-06-04)
  const handleSearch = useCallback(() => { setSearched(true); load(); }, [load]);
  // Quick range presets — set the window and run the search immediately
  // (load accepts explicit dates so we avoid stale state). (Nadeem 2026-06-05)
  const applyPreset = useCallback((f, t) => {
    setFrom(f); setTo(t); setSearched(true); load(f, t);
  }, [load]);
  const presetToday     = () => applyPreset(today, today);
  const presetYesterday = () => { const d = addDaysIso(today, -1); applyPreset(d, d); };
  const presetThisWeek  = () => { const dow = isoDayOfWeek(today); applyPreset(addDaysIso(today, -(dow < 0 ? 0 : dow)), today); };
  const presetThisMonth = () => applyPreset(`${today.slice(0, 8)}01`, today);

  // Previous working day (skips Fri/Sat). Used by the morning report so
  // "yesterday" means the last working day, not literally yesterday.
  const prevWorkingDay = (iso) => {
    let d = addDaysIso(iso, -1), guard = 0;
    while (isKsaWeekend(d) && guard++ < 8) d = addDaysIso(d, -1);
    return d;
  };

  // "Morning report for John" (run ~10AM): loads the last working day +
  // today, then generates a two-part Excel (today = arrival roll-call,
  // yesterday = full detail) and opens the email. The actual generate
  // fires from the effect below once the data has loaded. (Nadeem 2026-06-05)
  const handleMorningReport = useCallback(() => {
    const t = todayLocal();
    const y = prevWorkingDay(t);
    setMorningMode(true);
    setFrom(y); setTo(t); setSearched(true);
    setPendingMorningGenerate(true);
    load(y, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useEffect(() => {
    if (!pendingMorningGenerate || loading) return;
    setPendingMorningGenerate(false);
    (async () => {
      try { await handleExcel({ morning: true }); } catch { /* still email */ }
      emailJohn({ morning: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMorningGenerate, loading]);

  // Changing either date invalidates the shown results — hide them and
  // require a fresh Search so exports never reflect a stale window.
  const onFromChange = (v) => { setFrom(v); setSearched(false); };
  const onToChange   = (v) => { setTo(v);   setSearched(false); };

  // Group attendance by employee_id, then for each flagged staff fill
  // missing weekdays in the window as synthetic 'absent' rows so the
  // drill-down shows silent absences instead of just omitting the day.
  // KSA weekend (Fri + Sat) is skipped — staff aren't expected there.
  const byEmployee = useMemo(() => {
    const map = new Map();
    for (const row of attendance) {
      const list = map.get(row.employee_id) || [];
      list.push(row);
      map.set(row.employee_id, list);
    }
    // Only synthesize absences for dates that actually have attendance
    // data. A weekday with NO uploaded rows for anyone means the day was
    // simply not uploaded — fabricating "absent" for the whole roster
    // (e.g. the day before the selected date) is wrong, so we skip it.
    // Nadeem 2026-06-04.
    const datesWithData = new Set(attendance.map(r => r.attendance_date));
    // Skip weekends (eachWeekday) AND public holidays — staff aren't
    // expected on a holiday, so don't fabricate absences for them.
    const weekdays = eachWeekday(from, to).filter(d => datesWithData.has(d) && !holidays.has(d));
    for (const emp of shiftStaff) {
      const existing  = map.get(emp.id) || [];
      const haveDates = new Set(existing.map(r => r.attendance_date));
      const synthetic = [];
      for (const d of weekdays) {
        if (!haveDates.has(d)) {
          synthetic.push({
            employee_id:        emp.id,
            attendance_date:    d,
            status:             'absent',
            first_punch:        null,
            last_punch:         null,
            late_minutes:       0,
            early_leave_minutes:0,
            total_minutes:      null,
            _synthetic:         true,   // flag so we can render differently
          });
        }
      }
      // Sort merged: real rows + synthetic, by date ascending.
      const merged = [...existing, ...synthetic].sort((a, b) =>
        a.attendance_date < b.attendance_date ? -1 : a.attendance_date > b.attendance_date ? 1 : 0
      );
      map.set(emp.id, merged);
    }
    return map;
  }, [attendance, shiftStaff, from, to, holidays]);

  // Per-employee summary stats — adds dedicated counts for late, short
  // (with sub-classification), and absent. These power the anomaly
  // chips in each staff header so Bashaier can triage by severity.
  const summaries = useMemo(() => {
    return shiftStaff.map(emp => {
      const rows = byEmployee.get(emp.id) || [];
      const present   = rows.filter(r => r.status === 'present');
      const late      = rows.filter(r => r.status === 'late');
      const shortRows = rows.filter(r => r.status === 'short');
      const absentReal = rows.filter(r => r.status === 'absent' && !r._synthetic);
      const absentSilent = rows.filter(r => r.status === 'absent' &&  r._synthetic);
      const leaveD    = rows.filter(r => r.status === 'sick_leave' || r.status === 'annual_leave');

      // Short sub-breakdown for the chip + per-staff email body.
      let missedIn = 0, missedOut = 0, leftEarly = 0;
      for (const r of shortRows) {
        const k = classifyShort(r).kind;
        if (k === 'missed_in')  missedIn++;
        else if (k === 'missed_out') missedOut++;
        else leftEarly++;
      }

      // Hours: from worked rows (any status with both punches).
      const worked   = rows.filter(r => r.total_minutes != null);
      const totalMin = worked.reduce((s, r) => s + r.total_minutes, 0);
      const avgMin   = worked.length > 0 ? Math.round(totalMin / worked.length) : 0;

      // "Problem rows" — what we'd put in an escalation email to the
      // manager. Late + short (any sub-kind) + silent absences.
      const problemRows = rows.filter(r =>
        r.status === 'late' || r.status === 'short' || r.status === 'absent'
      );

      // Compliance — across all shift days in window. A "clean" shift
      // day is on-time arrival + full shift + both punches. Score is
      // (clean / shift days) × 100. Skips non-shift days (leave, off).
      let shiftDays = 0, cleanDays = 0;
      let countLateIn = 0, countShortOut = 0, countMissedAny = 0;
      for (const r of rows) {
        if (!r.isShiftDay) continue;
        shiftDays++;
        const isClean = r.onTime === true && r.fullShift === true && r.bothPunch === true;
        if (isClean) cleanDays++;
        if (r.onTime === false)   countLateIn++;
        if (r.fullShift === false) countShortOut++;
        if (r.bothPunch === false) countMissedAny++;
      }
      const compliancePct = shiftDays > 0 ? Math.round((cleanDays / shiftDays) * 100) : null;

      return {
        emp, rows,
        isShift: shiftIdSet.has(emp.id),
        daysPresent: present.length + late.length + shortRows.length,
        daysLate:    late.length,
        daysShort:   shortRows.length,
        missedIn, missedOut, leftEarly,
        daysAbsent:  absentReal.length + absentSilent.length,
        daysLeave:   leaveD.length,
        totalMin, avgMin,
        problemRows,
        shiftDays, cleanDays, compliancePct,
        countLateIn, countShortOut, countMissedAny,
      };
    }).sort((a, b) => {
      const loc = (a.emp.location || '').localeCompare(b.emp.location || '');
      if (loc) return loc;
      const dep = (a.emp.department || '').localeCompare(b.emp.department || '');
      if (dep) return dep;
      return (a.emp.name || '').localeCompare(b.emp.name || '');
    });
  }, [shiftStaff, byEmployee, shiftIdSet]);

  const toggleExpand = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Summaries limited to the chosen export scope (all staff or one).
  const reportSummaries = useMemo(
    () => (reportScope === 'all' ? summaries : summaries.filter(s => s.emp.id === reportScope)),
    [summaries, reportScope],
  );
  const scopeTag = reportScope === 'all' ? 'all-staff' : reportScope;

  const handleDownload = () => {
    const html = renderReportHtml({ summaries: reportSummaries, from, to, me, holidays });
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `Shift-Staff-Attendance-${scopeTag}-${from}_to_${to}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Open the report in a new window and trigger the print dialog so
  // Bashaier can "Save as PDF" with the clean letterhead layout.
  const handlePrint = () => {
    const html = renderReportHtml({ summaries: reportSummaries, from, to, me, holidays });
    const w = window.open('', '_blank');
    if (!w) { alert('Pop-up blocked — allow pop-ups to print/save as PDF.'); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 400);
  };

  // Excel export — one "Detail" sheet (every day) + a "Summary" sheet
  // (per-staff totals), respecting the chosen scope. Cells are coloured
  // to match the HTML report's status pills via xlsx-js-style.
  const handleExcel = async (opts = {}) => {
    const morning = !!opts.morning;
    // Status family → ARGB fill/font matching the HTML pills.
    const STATUS_FILL = {
      present:          { bg: 'FFDCFCE7', fg: 'FF166534' },
      late:             { bg: 'FFFEF3C7', fg: 'FF92400E' },
      short:            { bg: 'FFFEF3C7', fg: 'FF92400E' },
      absent:           { bg: 'FFFEE2E2', fg: 'FF991B1B' },
      sick_leave:       { bg: 'FFEDE9FE', fg: 'FF5B21B6' },
      annual_leave:     { bg: 'FFCCFBF1', fg: 'FF115E59' },
      maternity_leave:  { bg: 'FFFCE7F3', fg: 'FF9D174D' },
      paternity_leave:  { bg: 'FFE0F2FE', fg: 'FF075985' },
      hajj_leave:       { bg: 'FFFEF3C7', fg: 'FF854F0B' },
      marriage_leave:   { bg: 'FFFCE7F3', fg: 'FF831843' },
      bereavement_leave:{ bg: 'FFE5E7EB', fg: 'FF374151' },
      unpaid_leave:     { bg: 'FFF3F4F6', fg: 'FF374151' },
      emergency_leave:  { bg: 'FFFEE2E2', fg: 'FF7F1D1D' },
      iddah_leave:      { bg: 'FFF3E8FF', fg: 'FF6B21A8' },
      off_day:          { bg: 'FFF3F4F6', fg: 'FF374151' },
      off_roster:       { bg: 'FFF3F4F6', fg: 'FF374151' },
    };
    const fmtDay = (iso) => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' }) : '';
    // Late as mm:ss past the official start (08:00 / shift start), using
    // the raw punch seconds. Only for genuinely late rows.
    const lateMMSS = (r) => {
      const toSec = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0)) : null; };
      const inS = toSec(r.first_punch); const st = toSec(r.expected_start);
      if (inS == null || st == null) return '';
      const d = inS - st;
      if (d <= 0 || r.status !== 'late') return '';
      const mm = Math.floor(d / 60); const ss = d % 60;
      return `${mm}:${String(ss).padStart(2, '0')}`;
    };
    const lateSec = (r) => {
      const toSec = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0)) : null; };
      const inS = toSec(r.first_punch); const st = toSec(r.expected_start);
      if (inS == null || st == null) return 0;
      const d = inS - st;
      return (d > 0 && r.status === 'late') ? d : 0;
    };
    const fmtLateSec = (sec) => { if (!sec) return ''; const m = Math.floor(sec / 60); const s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; };
    // Assigned shift length in minutes (overnight-aware). Falls back to a
    // standard 8h day when no expected window is stamped on the row.
    const assignedMin = (r) => {
      const toSec = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0)) : null; };
      const s = toSec(r.expected_start), e = toSec(r.expected_end);
      if (s == null || e == null) return 480;
      let d = e - s; if (d <= 0) d += 24 * 3600;
      return Math.round(d / 60);
    };
    // True when a worked day fell short of the assigned hours.
    // Total (h:m) is flagged red ONLY when the attendance engine itself
    // classified the day as "short". Comparing raw presence to the gross
    // window (08:00–17:00 = 9h incl. the 1h lunch) wrongly flagged Present
    // staff who arrived a minute late. Trust the Status column so a row
    // shown as Present is never red. (Nadeem 2026-06-05)
    const isShortfall = (r) => r.status === 'short';
    const thin = { style: 'thin', color: { argb: 'FFD1D5DB' } };
    const allBorder = { top: thin, bottom: thin, left: thin, right: thin };
    const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F4C2A' } };
    const RED_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
    const SHIFT_FILL= { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
    const EMP_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };

    const wb = new ExcelJS.Workbook();

    // Shared sheet builder — auto-fits column widths to content and
    // supports centred columns.
    const buildSheet = (name, title, headers, rowsData, centerCols = []) => {
      const ws = wb.addWorksheet(name, {
        views: [{ state: 'frozen', ySplit: 2 }],   // title + header rows frozen
      });
      // Auto-fit each column to the widest of its header / cell values.
      const widths = headers.map((h, ci) => {
        let max = String(h).length;
        for (const rd of rowsData) {
          const v = rd.values[ci];
          const len = v == null ? 0 : String(v).length;
          if (len > max) max = len;
        }
        return Math.min(Math.max(max + 2, 6), 42);
      });
      ws.columns = widths.map(w => ({ width: w }));
      const horizFor = (col, rightCols) =>
        (rightCols || []).includes(col) ? 'right'
          : centerCols.includes(col) ? 'center'
          : 'left';
      // Row 1 — centered, merged title.
      const titleRow = ws.addRow([title]);
      ws.mergeCells(1, 1, 1, headers.length);
      const tcell = ws.getCell(1, 1);
      tcell.font = { bold: true, size: 13, color: { argb: 'FF0F4C2A' } };
      tcell.alignment = { horizontal: 'center', vertical: 'middle' };
      titleRow.height = 22;
      // Row 2 — column headers (aligned to match their column).
      const hRow = ws.addRow(headers);
      hRow.eachCell((c, col) => {
        c.fill = HEAD_FILL;
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        c.alignment = { vertical: 'middle', horizontal: horizFor(col) === 'right' ? 'right' : (centerCols.includes(col) ? 'center' : 'left') };
        c.border = allBorder;
      });
      // Data rows.
      rowsData.forEach((rd, i) => {
        const row = ws.addRow(rd.values);
        if (rd.subtotal) {
          row.eachCell({ includeEmpty: true }, (c, col) => {
            c.border = allBorder;
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE68A' } };
            c.font = { bold: true, color: { argb: 'FF1F1B16' } };
            c.alignment = { vertical: 'middle', horizontal: horizFor(col, rd.rightCols) };
          });
          return;
        }
        const zebra = i % 2 === 0 ? 'FFFFFFFF' : 'FFFAF8F1';
        row.eachCell({ includeEmpty: true }, (c, col) => {
          c.border = allBorder;
          c.alignment = { vertical: 'middle', horizontal: horizFor(col, rd.rightCols) };
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } };
          c.font = { color: { argb: 'FF1F2937' } };
        });
        (rd.style || []).forEach(({ col, fill, font, align }) => {
          const c = row.getCell(col);
          if (fill) c.fill = fill;
          if (font) c.font = font;
          if (align) c.alignment = { vertical: 'middle', horizontal: align };
        });
      });
      return ws;
    };

    // ── MORNING MODE — two sheets ──────────────────────────────────────
    //   Sheet 1: Today — arrival roll-call (sign-outs not known yet).
    //   Sheet 2: Yesterday — full detail (complete day).
    if (morning) {
      const t = to;                  // today
      const yday = from;             // previous working day
      const clock = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const dShort = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
      const sheetName1 = `Today (${dShort(t)}, ${fmtDay(t)})`.slice(0, 31);
      const sheetName2 = `Yesterday detail (${dShort(yday)}, ${fmtDay(yday)})`.slice(0, 31);
      const NEUTRAL = { bg: 'FFF1F5F9', fg: 'FF475569' };
      const HOL = { bg: 'FFEDE9FE', fg: 'FF5B21B6' };

      // Sheet 1 — Today roll-call (one row per staff).
      const rcHeaders = ['#','Employee','Shift','PSN','Department','Location','Assigned shift','Check in','Late (mm:ss)','Status'];
      const rcRows = reportSummaries.map((s, idx) => {
        const tr = s.rows.find(r => r.attendance_date === t) || null;
        const hol = holidays.get(t);
        const worked = tr && (tr.first_punch || (tr.punch_count || 0) > 0) && tr.status !== 'absent';
        const isLeave = tr && /_leave$/.test(tr.status || '');
        let statusText, fam, checkIn = '', lms = '';
        if (worked) {
          checkIn = fmtTime(tr.effective_in || tr.first_punch) || '';
          lms = lateMMSS(tr);
          statusText = detailedStatusLabel(tr);
          fam = STATUS_FILL[tr.status] || NEUTRAL;
        } else if (isLeave) {
          statusText = detailedStatusLabel(tr); fam = STATUS_FILL[tr.status] || NEUTRAL;
        } else if (hol) {
          statusText = `Holiday: ${hol}`; fam = HOL;
        } else {
          statusText = 'Not yet in'; fam = NEUTRAL;
        }
        const style = [{ col: 10, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: fam.bg } }, font: { bold: true, color: { argb: fam.fg } } }];
        if (s.isShift) {
          style.push({ col: 2, fill: EMP_FILL, font: { bold: true, color: { argb: 'FF1E3A8A' } } });
          style.push({ col: 3, fill: SHIFT_FILL, font: { bold: true, color: { argb: 'FFFFFFFF' } }, align: 'center' });
        }
        if (lms) style.push({ col: 9, fill: RED_FILL, font: { bold: true, color: { argb: 'FFB91C1C' } }, align: 'center' });
        return {
          values: [
            idx + 1, s.emp.name, s.isShift ? 'SHIFT' : '', s.emp.id,
            s.emp.department || '', s.emp.location || '',
            fmtShiftWindow(tr?.expected_start, tr?.expected_end) || '',
            checkIn, lms, statusText,
          ],
          rightCols: [1],
          style,
        };
      });
      buildSheet(sheetName1, `Today — Morning roll-call · ${fmtDate(t)} (as of ${clock}) · sign-outs finalize end-of-day`, rcHeaders, rcRows, [4, 5, 6, 7, 8, 9, 10]);

      // Sheet 2 — Yesterday full detail (the complete previous working day).
      const yHeaders = ['#','Employee','Shift','PSN','Department','Location','Date','Day','Assigned shift','Check in','Out','Total (h:m)','Late (mm:ss)','Status'];
      const yFlat = [];
      for (const s of reportSummaries) for (const r of s.rows) if (r.attendance_date === yday) yFlat.push({ s, r });
      const yRows = [];
      let yN = 0, ySumMin = 0, ySumLate = 0;
      for (const { s, r } of yFlat) {
        yN += 1; ySumMin += Number(r.total_minutes || 0); ySumLate += lateSec(r);
        const lms = lateMMSS(r);
        const holName = holidays.get(r.attendance_date);
        const worked = (r.punch_count || 0) > 0 || r.first_punch || r.last_punch;
        const statusText = holName ? (worked ? `${detailedStatusLabel(r)} · Holiday: ${holName}` : `Holiday: ${holName}`) : detailedStatusLabel(r);
        const fam = STATUS_FILL[r.status] || { bg: 'FFF3F4F6', fg: 'FF374151' };
        const style = [holName
          ? { col: 14, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: HOL.bg } }, font: { bold: true, color: { argb: HOL.fg } } }
          : { col: 14, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: fam.bg } }, font: { bold: true, color: { argb: fam.fg } } }];
        if (s.isShift) {
          style.push({ col: 2, fill: EMP_FILL, font: { bold: true, color: { argb: 'FF1E3A8A' } } });
          style.push({ col: 3, fill: SHIFT_FILL, font: { bold: true, color: { argb: 'FFFFFFFF' } }, align: 'center' });
        }
        if (lms) style.push({ col: 13, fill: RED_FILL, font: { bold: true, color: { argb: 'FFB91C1C' } }, align: 'center' });
        if (!holName && isShortfall(r)) style.push({ col: 12, fill: RED_FILL, font: { bold: true, color: { argb: 'FFB91C1C' } }, align: 'center' });
        yRows.push({
          values: [
            yN, s.emp.name, s.isShift ? 'SHIFT' : '', s.emp.id,
            s.emp.department || '', s.emp.location || '',
            fmtDate(r.attendance_date), fmtDay(r.attendance_date),
            fmtShiftWindow(r.expected_start, r.expected_end) || '',
            fmtTime(r.effective_in) || '', fmtTime(r.effective_out) || '',
            fmtHoursMins(r.total_minutes), lms, statusText,
          ],
          rightCols: [1],
          style,
        });
      }
      if (yRows.length) {
        yRows.push({ subtotal: true, values: ['', `${yN} staff`, '', '', '', '', fmtDate(yday), '', '', '', 'TOTAL →', fmtHoursMins(ySumMin), fmtLateSec(ySumLate), ''], rightCols: [] });
      }
      buildSheet(sheetName2, `Yesterday — Full attendance · ${fmtDate(yday)}`, yHeaders, yRows, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `Attendance-Morning-${t}.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }

    // ── Detail sheet only ──  (Summary dropped per Nadeem 2026-06-04.)
    // Detail sheet — sorted by DATE, with a subtotal row per date
    //    (staff count + sum of Total h:m + sum of Late mm:ss).
    const detHeaders = ['#','Employee','Shift','PSN','Department','Location','Date','Day','Assigned shift','Check in','Out','Total (h:m)','Late (mm:ss)','Status'];
    const detRows = [];
    // Flatten all staff/day pairs, then stable-sort by date (within a
    // date the location→department→name order is preserved).
    const flat = [];
    for (const s of reportSummaries) for (const r of s.rows) flat.push({ s, r });
    flat.sort((a, b) => a.r.attendance_date < b.r.attendance_date ? -1 : a.r.attendance_date > b.r.attendance_date ? 1 : 0);
    let dN = 0, i = 0;
    while (i < flat.length) {
      const date = flat[i].r.attendance_date;
      let cnt = 0, sumMin = 0, sumLate = 0;
      while (i < flat.length && flat[i].r.attendance_date === date) {
        const { s, r } = flat[i];
        dN += 1; cnt += 1;
        sumMin  += Number(r.total_minutes || 0);
        sumLate += lateSec(r);
        const lms = lateMMSS(r);
        const holName = holidays.get(r.attendance_date);
        const worked = (r.punch_count || 0) > 0 || r.first_punch || r.last_punch;
        // On a holiday: absentees are not absent (no duty); workers keep
        // their status. Either way the Status carries the holiday name.
        const statusText = holName
          ? (worked ? `${detailedStatusLabel(r)} · Holiday: ${holName}` : `Holiday: ${holName}`)
          : detailedStatusLabel(r);
        const HOL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9FE' } }; // violet-100
        const HOL_FONT = { bold: true, color: { argb: 'FF5B21B6' } };
        const fam = STATUS_FILL[r.status] || { bg: 'FFF3F4F6', fg: 'FF374151' };
        const style = [
          holName
            ? { col: 14, fill: HOL_FILL, font: HOL_FONT }
            : { col: 14, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: fam.bg } }, font: { bold: true, color: { argb: fam.fg } } },
        ];
        if (holName) {                                  // mark the date itself
          style.push({ col: 7, fill: HOL_FILL, font: HOL_FONT, align: 'center' });
          style.push({ col: 8, fill: HOL_FILL, font: HOL_FONT, align: 'center' });
        }
        if (s.isShift) {
          style.push({ col: 2, fill: EMP_FILL, font: { bold: true, color: { argb: 'FF1E3A8A' } } });
          style.push({ col: 3, fill: SHIFT_FILL, font: { bold: true, color: { argb: 'FFFFFFFF' } }, align: 'center' });
        }
        if (lms) style.push({ col: 13, fill: RED_FILL, font: { bold: true, color: { argb: 'FFB91C1C' } }, align: 'center' });
        if (!holName && isShortfall(r)) style.push({ col: 12, fill: RED_FILL, font: { bold: true, color: { argb: 'FFB91C1C' } }, align: 'center' });
        detRows.push({
          values: [
            dN, s.emp.name, s.isShift ? 'SHIFT' : '', s.emp.id,
            s.emp.department || '', s.emp.location || '',
            fmtDate(r.attendance_date), fmtDay(r.attendance_date),
            fmtShiftWindow(r.expected_start, r.expected_end) || '',
            fmtTime(r.effective_in) || '', fmtTime(r.effective_out) || '',
            fmtHoursMins(r.total_minutes), lms, statusText,
          ],
          rightCols: [1],
          style,
        });
        i += 1;
      }
      // Per-date subtotal row.
      detRows.push({
        subtotal: true,
        values: [
          '', `${cnt} staff`, '', '', '', '',
          fmtDate(date), '', '', '', 'TOTAL →',
          fmtHoursMins(sumMin), fmtLateSec(sumLate), '',
        ],
        rightCols: [],
      });
    }
    buildSheet('Detail', `Attendance Report — ${fmtDate(from)} to ${fmtDate(to)}`, detHeaders, detRows, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Attendance-Report-${scopeTag}-${from}_to_${to}.xlsx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // "Email to John" — first downloads the Excel (so it's ready to attach,
  // since mailto can't attach a file), then opens a prefilled mail to the
  // Country Head with a brief, dated summary. CC the SUP team. Defined
  // after handleExcel so it can call it without a TDZ. (Nadeem 2026-06-05)
  const JOHN_EMAIL = 'johnho@evergreen-shipping.com.sa';
  const JOHN_CC_PSNS = ['H94458', 'H94330', 'H94712']; // Badria, Jaffar, Fahad (SUP)
  const emailJohn = async (opts = {}) => {
    const morning = !!opts.morning;
    // Export the workbook first so the user has the file to attach. In
    // morning mode the two-part workbook was already exported by
    // handleMorningReport's effect, so skip the re-export here.
    if (!morning) { try { await handleExcel(); } catch { /* non-fatal */ } }
    const lines = [];
    let subject;
    if (morning) {
      const t = to, yday = from;
      const wkShort   = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
      const dShort    = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
      const dayDate   = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
      const sheet1 = `Today (${dShort(t)}, ${wkShort(t)})`.slice(0, 31);
      const sheet2 = `Yesterday detail (${dShort(yday)}, ${wkShort(yday)})`.slice(0, 31);
      const clock = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      // Quick today roll-call counts.
      let inCount = 0, lateCount = 0, notIn = 0, leaveCount = 0;
      reportSummaries.forEach(s => {
        const tr = s.rows.find(r => r.attendance_date === t);
        const worked = tr && (tr.first_punch || (tr.punch_count || 0) > 0) && tr.status !== 'absent';
        if (worked) { inCount += 1; if (tr.status === 'late') lateCount += 1; }
        else if (tr && /_leave$/.test(tr.status || '')) leaveCount += 1;
        else if (!holidays.has(t)) notIn += 1;
      });
      subject = `Daily Attendance — ${fmtDate(t)} (morning roll-call + ${fmtDate(yday)} full)`;
      lines.push('Dear Mr. John,');
      lines.push('');
      lines.push(`Please find today's morning attendance for check-in time as of ${clock} (${dayDate(t)}). Sign-outs and total hours finalise at end of day, so this report shows arrivals only.`);
      lines.push('');
      lines.push(`Today so far: ${inCount} signed in (${lateCount} late), ${notIn} not yet in, ${leaveCount} on leave.`);
      lines.push('');
      lines.push(`Please see the attached Excel file which has two sheets: "${sheet1}" (arrivals) and "${sheet2}", the complete report for ${dayDate(yday)} (in/out, total hours, late and early departures).`);
      lines.push('');
      lines.push('Thanks and regards,');
    } else {
      const periodLabel = from === to ? fmtDateLong(from) : `${fmtDate(from)} – ${fmtDate(to)}`;
      const scopeLabel = reportScope === 'all'
        ? `all ${reportSummaries.length} staff`
        : (reportSummaries[0]?.emp ? `${reportSummaries[0].emp.name} (${reportSummaries[0].emp.id})` : 'selected staff');
      subject = `Attendance Report — ${from === to ? fmtDate(from) : `${fmtDate(from)} to ${fmtDate(to)}`}`;
      lines.push('Dear Mr. John,');
      lines.push('');
      lines.push(`Please find a brief attendance summary for ${periodLabel}, covering ${scopeLabel}. The detailed report (Excel) is attached.`);
      lines.push('');
      lines.push('(The Excel report has just been downloaded to your device — please attach it before sending.)');
      lines.push('');
      lines.push('Kindly let me know if you would like any specific day or employee expanded.');
    }
    lines.push('');
    lines.push(renderHrSignature());
    const ccEmails = JOHN_CC_PSNS.map(id => empMap[id]?.email).filter(Boolean);
    let href = `mailto:${encodeURIComponent(JOHN_EMAIL)}?`;
    if (ccEmails.length) href += `cc=${encodeURIComponent(ccEmails.join(','))}&`;
    href += `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
    // Small delay so the download starts before the mail client steals focus.
    setTimeout(() => { window.location.href = href; }, 400);
  };
  // After a search, remind to upload today's time card when today is in
  // range but has no rows. Fri/Sat are the KSA weekend: no duty, no
  // upload expected, so never remind (or flag) on those days.
  const todayHasData = attendance.some(r => r.attendance_date === today);
  const todayIsWeekend = isKsaWeekend(today);
  const todayIsHoliday = holidays.has(today);
  const needsUploadReminder = searched && !loading && !err
    && from <= today && today <= to && !todayHasData && !todayIsWeekend && !todayIsHoliday;
  // Single weekend day selected with no data → say so plainly instead.
  const weekendOnlyNotice = searched && !loading && !err
    && from === to && isKsaWeekend(from) && !todayHasData;

  // ─── render ──
  return (
    <div className="rounded-2xl border bg-white p-5"
         style={{ borderColor: 'var(--border-soft)', boxShadow: '0 1px 2px rgba(31,27,22,0.04), 0 4px 14px rgba(31,27,22,0.06)' }}>
      {/* Header */}
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div>
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5" style={{ color: '#0F4C2A' }} />
            <div style={{ fontFamily: 'inherit', fontSize: '20px', color: '#1F1B16' }}>
              Attendance report card
            </div>
          </div>
          <div className="text-[11px] mt-1" style={{ color: '#1F1B16' }}>
            Pick a date range and press Search, then export the attendance report to Excel or email a brief summary to Mr. John. Sorted by Location, Department, then name; shift staff are colour-marked.
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={reportScope}
            onChange={e => setReportScope(e.target.value)}
            disabled={loading || shiftStaff.length === 0}
            title="Choose which staff the export covers"
            className="px-2 py-1.5 rounded-md text-xs border bg-white disabled:opacity-50"
            style={{ borderColor: 'var(--border-soft)', color: '#1F1B16', maxWidth: 220 }}>
            <option value="all">All shift staff ({summaries.length})</option>
            {summaries.map(s => (
              <option key={s.emp.id} value={s.emp.id}>{s.emp.name} ({s.emp.id})</option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleExcel}
            disabled={!searched || loading || reportSummaries.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition disabled:opacity-50"
            style={{ background: '#107C41', color: '#FFFFFF' }}>
            <FileSpreadsheet className="w-3.5 h-3.5" />
            Excel
          </button>
          <button
            type="button"
            onClick={async () => { await handleExcel(); emailJohn(); }}
            disabled={!searched || loading || reportSummaries.length === 0}
            title="Downloads the Excel report, then opens a prefilled email to Mr. John — attach the downloaded file before sending."
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition disabled:opacity-50"
            style={{ background: '#0F4C2A', color: '#FFFFFF' }}>
            <Mail className="w-3.5 h-3.5" />
            Email to John
          </button>
          <button
            type="button"
            onClick={handleMorningReport}
            disabled={loading || shiftStaff.length === 0}
            title="Run the 10AM report: today's arrival roll-call + yesterday's full detail. Downloads a 2-sheet Excel and opens the email to Mr. John."
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition disabled:opacity-50"
            style={{ background: '#B45309', color: '#FFFFFF' }}>
            <Clock className="w-3.5 h-3.5" />
            Morning report (John)
          </button>
        </div>
      </div>

      {/* Date range chooser */}
      <div className="flex items-center gap-3 flex-wrap mb-4 p-3 rounded-lg"
           style={{ background: '#FBF6E9' }}>
        <div className="text-[11px] font-semibold" style={{ color: '#1F1B16' }}>PERIOD</div>
        <label className="flex items-center gap-1.5 text-[11px]" style={{ color: '#1F1B16' }}>
          From
          <input type="date" value={from} onChange={e => onFromChange(e.target.value)}
                 className="px-2 py-1 rounded border bg-white text-[11px]"
                 style={{ borderColor: 'var(--border-soft)', color: '#1F1B16' }} />
        </label>
        <label className="flex items-center gap-1.5 text-[11px]" style={{ color: '#1F1B16' }}>
          to
          <input type="date" value={to} onChange={e => onToChange(e.target.value)}
                 className="px-2 py-1 rounded border bg-white text-[11px]"
                 style={{ borderColor: 'var(--border-soft)', color: '#1F1B16' }} />
        </label>
        <button
          type="button"
          onClick={handleSearch}
          disabled={loading || shiftStaff.length === 0}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-bold transition disabled:opacity-50"
          style={{ background: '#4338CA', color: '#FFFFFF', boxShadow: '0 2px 6px rgba(67,56,202,0.4)' }}>
          <Clock className="w-3.5 h-3.5" />
          {loading ? 'Searching…' : 'Search'}
        </button>
        <div className="flex items-center gap-1.5">
          {[
            { label: 'Today',      fn: presetToday },
            { label: 'Yesterday',  fn: presetYesterday },
            { label: 'This week',  fn: presetThisWeek },
            { label: 'This month', fn: presetThisMonth },
          ].map(p => (
            <button
              key={p.label}
              type="button"
              onClick={p.fn}
              disabled={loading || shiftStaff.length === 0}
              className="px-2.5 py-1 rounded-full text-[11px] font-medium border transition disabled:opacity-50"
              style={{ background: '#FFFFFF', color: '#3730A3', borderColor: '#C7D2FE' }}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="text-[10px]" style={{ color: '#1F1B16' }}>
          {shiftStaff.length} staff · {shiftIdSet.size} shift staff
        </div>
      </div>

      {/* Reminder: searched today but no time card uploaded for today */}
      {needsUploadReminder && (
        <div className="flex items-start gap-2 mb-4 p-3 rounded-lg border"
             style={{ background: '#FEF3C7', borderColor: '#F59E0B', color: '#7C2D12' }}>
          <FileSpreadsheet className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: '#B45309' }} />
          <div>
            <div className="text-sm font-semibold">No time card uploaded for today ({fmtDate(today)})</div>
            <div className="text-[11px] mt-0.5">
              There's no attendance data for today yet. Please upload today's time card (Upload Time Card) first, then search again — otherwise today will be blank in the report.
            </div>
          </div>
        </div>
      )}

      {/* Weekend (Fri/Sat) selected — no duty expected */}
      {weekendOnlyNotice && (
        <div className="flex items-start gap-2 mb-4 p-3 rounded-lg border"
             style={{ background: '#EFF6FF', borderColor: '#93C5FD', color: '#1E3A8A' }}>
          <Clock className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: '#1D4ED8' }} />
          <div>
            <div className="text-sm font-semibold">{fmtDate(from)} is a weekend (Fri/Sat)</div>
            <div className="text-[11px] mt-0.5">
              No attendance is expected on the KSA weekend, so there's nothing to report for this day. Any shift staff who worked it will still appear below if their punches were uploaded.
            </div>
          </div>
        </div>
      )}

      {/* Body */}
      {shiftStaff.length === 0 ? (
        <div className="flex items-center gap-2 text-sm py-6 px-3 rounded-lg"
             style={{ background: '#FBF6E9', color: '#1F1B16' }}>
          <Users className="w-4 h-4" style={{ color: '#1F1B16' }} />
          <div>
            <div className="font-medium">No staff found</div>
            <div className="text-[11px] mt-0.5">
              No employees are loaded yet. Shift staff (marked by managers) are highlighted once data appears.
            </div>
          </div>
        </div>
      ) : err ? (
        <div className="text-xs text-red-700 bg-red-50 rounded-md p-2">{err}</div>
      ) : loading ? (
        <div className="text-center text-xs opacity-50 py-4">Loading attendance…</div>
      ) : !searched ? (
        <div className="flex items-center gap-2 text-sm py-6 px-3 rounded-lg"
             style={{ background: '#FBF6E9', color: '#1F1B16' }}>
          <Clock className="w-4 h-4" style={{ color: '#0F4C2A' }} />
          <div>
            <div className="font-medium">Pick a period and press Search</div>
            <div className="text-[11px] mt-0.5">
              The attendance data and the Excel / Email to John actions appear once you run a search.
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {summaries.map(s => {
            const manager = s.emp.manager_id ? empMap[s.emp.manager_id] : null;
            const hasManagerEmail = !!manager?.email;
            return (
            <div key={s.emp.id} className="rounded-lg border bg-white overflow-hidden"
                 style={{ borderColor: 'var(--border-soft)', borderLeft: s.isShift ? '4px solid #1D4ED8' : undefined }}>
              {/* Summary row */}
              <div className="flex items-center gap-3 px-3 py-2.5"
                   style={{ background: s.isShift ? '#EFF6FF' : undefined }}>
                <button type="button" onClick={() => toggleExpand(s.emp.id)}
                        className="flex items-center gap-3 flex-1 min-w-0 text-left hover:opacity-80 transition">
                  {expanded.has(s.emp.id)
                    ? <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: '#1F1B16' }} />
                    : <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: '#1F1B16' }} />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold flex items-center gap-2" style={{ color: '#1F1B16' }}>
                      {s.emp.name}
                      {s.isShift && (
                        <span style={{ background: '#1D4ED8', color: '#fff', fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 999, letterSpacing: '.04em' }}>SHIFT</span>
                      )}
                    </div>
                    <div className="text-[10px] flex items-center gap-2 flex-wrap mt-0.5" style={{ color: '#1F1B16' }}>
                      <span>{s.emp.id} · {s.emp.department || '—'} · {s.emp.location || '—'}</span>
                      {manager && (
                        <span className="opacity-70">· Manager: {manager.name}</span>
                      )}
                    </div>
                  </div>
                </button>

                {/* Anomaly chip row — quick triage. Each chip shows count
                    and is colour-coded by severity. Renders only when count>0. */}
                <div className="hidden md:flex items-center gap-1.5">
                  {s.daysLate > 0 && (
                    <Chip count={s.daysLate} label="LATE" bg="#FEF3C7" fg="#92400E" />
                  )}
                  {s.daysShort > 0 && (
                    <Chip count={s.daysShort} label="SHORT" bg="#FEF3C7" fg="#92400E"
                          title={`${s.missedIn ? `${s.missedIn} no in-punch · ` : ''}${s.missedOut ? `${s.missedOut} no out-punch · ` : ''}${s.leftEarly ? `${s.leftEarly} left early` : ''}`.replace(/ · $/, '')} />
                  )}
                  {s.daysAbsent > 0 && (
                    <Chip count={s.daysAbsent} label="ABSENT" bg="#FEE2E2" fg="#991B1B" />
                  )}
                  {s.daysLeave > 0 && (
                    <Chip count={s.daysLeave} label="LEAVE" bg="#DBEAFE" fg="#1E40AF" />
                  )}
                </div>

                {/* Stats — desktop only */}
                <div className="hidden lg:flex items-center gap-4 text-[11px] pl-2" style={{ color: '#1F1B16' }}>
                  <div className="text-center">
                    <div className="font-semibold text-sm" style={{ color: '#0F4C2A' }}>{s.daysPresent}</div>
                    <div className="text-[9px]">DAYS</div>
                  </div>
                  <div className="text-center">
                    <div className="font-semibold text-sm" style={{ color: '#1F1B16' }}>{fmtHoursMins(s.totalMin)}</div>
                    <div className="text-[9px]">TOTAL</div>
                  </div>
                  <div className="text-center">
                    <div className="font-semibold text-sm" style={{ color: '#1F1B16' }}>{fmtHoursMins(s.avgMin)}</div>
                    <div className="text-[9px]">AVG</div>
                  </div>
                  {/* Compliance — only meaningful when we evaluated at
                      least one shift day. Colour: green ≥90%, amber 70-89%,
                      red <70%. Tooltip shows the underlying breakdown. */}
                  {s.compliancePct != null && (
                    <div className="text-center"
                         title={`${s.cleanDays}/${s.shiftDays} clean shifts · ${s.countLateIn} late in · ${s.countShortOut} early out · ${s.countMissedAny} missing a punch`}>
                      <div className="font-semibold text-sm"
                           style={{
                             color: s.compliancePct >= 90 ? '#0F4C2A'
                                  : s.compliancePct >= 70 ? '#92400E'
                                  : '#991B1B',
                           }}>
                        {s.compliancePct}%
                      </div>
                      <div className="text-[9px]">SHIFT</div>
                    </div>
                  )}
                </div>

                {/* Email manager button — single tap fires a mailto:
                    with subject + anomaly rows pre-filled. */}
                <button
                  type="button"
                  onClick={() => emailManager(s)}
                  disabled={!hasManagerEmail}
                  className="flex items-center gap-1 px-2 py-1.5 rounded-md text-[10px] font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
                  style={{
                    background: hasManagerEmail ? '#0F4C2A' : '#F3F4F6',
                    color:      hasManagerEmail ? '#FFFFFF' : '#9CA3AF',
                  }}
                  title={hasManagerEmail
                    ? `Email ${manager.name} about ${s.emp.name}'s anomalies (mailto: opens your default email client)`
                    : `No email on file for ${s.emp.name}'s manager`}>
                  <Mail className="w-3 h-3" />
                  EMAIL MGR
                </button>
                {/* Copy a clean HTML report to paste into Outlook. */}
                <button
                  type="button"
                  onClick={() => copyManagerHtml(s)}
                  className="flex items-center gap-1 px-2 py-1.5 rounded-md text-[10px] font-semibold transition flex-shrink-0 border"
                  style={{ background: '#FFFFFF', color: '#0F4C2A', borderColor: '#0F4C2A' }}
                  title={`Copy a clean HTML report for ${s.emp.name} to paste into Outlook`}>
                  <ClipboardCopy className="w-3 h-3" />
                  {copiedId === s.emp.id ? 'COPIED' : 'COPY HTML'}
                </button>
              </div>

              {/* Drill-down: per-day rows */}
              {expanded.has(s.emp.id) && (
                <div className="border-t px-3 py-2" style={{ borderColor: 'var(--border-soft)', background: '#FBF6E9' }}>
                  {s.rows.length === 0 ? (
                    <div className="text-[11px] py-2 text-center" style={{ color: '#1F1B16' }}>
                      No attendance rows for this period.
                    </div>
                  ) : (
                    <table className="w-full text-[11px]" style={{ color: '#1F1B16' }}>
                      <thead>
                        <tr className="text-left" style={{ color: '#1F1B16' }}>
                          <th className="py-1.5 pr-2 font-semibold">Date</th>
                          <th className="py-1.5 pr-2 font-semibold">Shift</th>
                          <th className="py-1.5 pr-2 font-semibold">In</th>
                          <th className="py-1.5 pr-2 font-semibold">Out</th>
                          <th className="py-1.5 pr-2 font-semibold">Total</th>
                          <th className="py-1.5 pr-2 font-semibold">Status</th>
                          <th className="py-1.5 pr-2 font-semibold" title="Shift compliance: on-time in · full shift · both punches">✓</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.rows.map(r => {
                          const pill = statusPill(r.status);
                          const label = detailedStatusLabel(r);
                          const isSilent = !!r._synthetic;
                          const shift = fmtShiftWindow(r.expected_start, r.expected_end);
                          return (
                            <tr key={r.attendance_date}
                                className="border-t"
                                style={{
                                  borderColor: 'var(--border-soft)',
                                  opacity: isSilent ? 0.85 : 1,
                                }}>
                              <td className="py-1.5 pr-2 font-mono">
                                {fmtDateLong(r.attendance_date)}
                                {isSilent && (
                                  <span className="ml-1.5 text-[9px] uppercase tracking-wide"
                                        style={{ color: '#991B1B' }}>
                                    no record
                                  </span>
                                )}
                              </td>
                              <td className="py-1.5 pr-2 font-mono" style={{ color: shift ? '#1F1B16' : '#9CA3AF' }}>
                                {shift || '—'}
                              </td>
                              <td className="py-1.5 pr-2 font-mono">
                                {fmtTime(r.effective_in)}
                                {r.isOvernight && r.effective_carry && (
                                  <div className="text-[9px]" style={{ color: '#9CA3AF' }}>
                                    {fmtTime(r.effective_carry)} (prev)
                                  </div>
                                )}
                              </td>
                              <td className="py-1.5 pr-2 font-mono">
                                {fmtTime(r.effective_out)}
                                {r.isOvernight && r.effective_out && (
                                  <span className="ml-1 text-[9px]" style={{ color: '#9CA3AF' }}>+1d</span>
                                )}
                              </td>
                              <td className="py-1.5 pr-2 font-mono">{fmtHoursMins(r.total_minutes)}</td>
                              <td className="py-1.5 pr-2">
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                                      style={{ background: pill.bg, color: pill.fg }}>
                                  {label}
                                </span>
                              </td>
                              <td className="py-1.5 pr-2">
                                {r.isShiftDay ? (
                                  <ComplianceDots row={r} />
                                ) : (
                                  <span className="text-[10px]" style={{ color: '#9CA3AF' }}>—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          );
          })}
        </div>
      )}
    </div>
  );
}

// ─── printable HTML report ─────────────────────────────────────────────────

/**
 * Build a standalone HTML document Bashaier can download, open, print to PDF,
 * or attach to an email reply. Uses the same brand vocabulary as the rest
 * of the portal: warm cream paper background, evergreen header, copper
 * stamps. Print-stylesheet collapses to letter-format margins.
 */
function renderReportHtml({ summaries, from, to, me, holidays = new Map() }) {
  const now = new Date();
  const generatedAt = now.toLocaleString('en-GB', {
    weekday: 'long', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const fmtDay = (iso) => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' }) : '';
  const compCls = (p) => p == null ? '' : p >= 90 ? 'cgood' : p >= 70 ? 'camber' : 'cred';
  const lateMMSS = (r) => {
    const toSec = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0)) : null; };
    const inS = toSec(r.first_punch); const st = toSec(r.expected_start);
    if (inS == null || st == null) return '';
    const d = inS - st;
    if (d <= 0 || r.status !== 'late') return '';
    return `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`;
  };

  // SUMMARY table — one row per staff (mirrors the Excel Summary sheet).
  let sN = 0;
  const summaryRows = summaries.map(s => {
    sN += 1;
    const lateRow = s.rows.find(r => r.status === 'late');
    const punchRow = lateRow || [...s.rows].reverse().find(r => r.first_punch) || s.rows[s.rows.length - 1] || null;
    const checkIn = punchRow ? (fmtTime(punchRow.effective_in || punchRow.first_punch) || '—') : '—';
    const lms = punchRow ? lateMMSS(punchRow) : '';
    return `<tr class="${s.isShift ? 'shiftrow' : ''}">
      <td class="num">${sN}</td>
      <td class="name">${escapeHtml(s.emp.name)}</td>
      <td class="ctr">${s.isShift ? '<span class="shift-badge">SHIFT</span>' : ''}</td>
      <td class="ctr mono">${escapeHtml(s.emp.id)}</td>
      <td class="ctr">${escapeHtml(s.emp.department || '—')}</td>
      <td class="ctr">${escapeHtml(s.emp.location || '—')}</td>
      <td class="ctr mono">${escapeHtml(checkIn)}</td>
      <td class="num red">${escapeHtml(lms)}</td>
      <td class="num ${compCls(s.compliancePct)}">${s.compliancePct != null ? s.compliancePct + '%' : '—'}</td>
      <td class="num">${s.daysShort ? s.daysShort : ''}</td>
    </tr>`;
  }).join('');

  // DETAIL table — one row per staff per day (mirrors the Excel Detail sheet).
  // DETAIL — sorted by DATE with a subtotal row per date.
  const lateSec = (r) => {
    const toSec = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0)) : null; };
    const inS = toSec(r.first_punch); const st = toSec(r.expected_start);
    if (inS == null || st == null) return 0;
    const d = inS - st;
    return (d > 0 && r.status === 'late') ? d : 0;
  };
  const fmtLateSec = (sec) => { if (!sec) return ''; return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  const assignedMin = (r) => {
    const toSec = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0)) : null; };
    const s = toSec(r.expected_start), e = toSec(r.expected_end);
    if (s == null || e == null) return 480;
    let d = e - s; if (d <= 0) d += 24 * 3600;
    return Math.round(d / 60);
  };
  const isShortfall = (r) => r.status === 'short';

  const flatD = [];
  for (const s of summaries) for (const r of s.rows) flatD.push({ s, r });
  flatD.sort((a, b) => a.r.attendance_date < b.r.attendance_date ? -1 : a.r.attendance_date > b.r.attendance_date ? 1 : 0);

  let dN = 0, di = 0;
  const detailParts = [];
  while (di < flatD.length) {
    const date = flatD[di].r.attendance_date;
    let cnt = 0, sumMin = 0, sumLate = 0;
    while (di < flatD.length && flatD[di].r.attendance_date === date) {
      const { s, r } = flatD[di];
      dN += 1; cnt += 1;
      sumMin  += Number(r.total_minutes || 0);
      sumLate += lateSec(r);
      const lms = lateMMSS(r);
      const shift = fmtShiftWindow(r.expected_start, r.expected_end);
      const holName = holidays.get(r.attendance_date);
      const worked = (r.punch_count || 0) > 0 || r.first_punch || r.last_punch;
      const statusCell = holName
        ? (worked
            ? `<span class="pill ${escapeHtml(r.status || '')}">${escapeHtml(detailedStatusLabel(r))}</span> <span class="pill holiday">Holiday: ${escapeHtml(holName)}</span>`
            : `<span class="pill holiday">Holiday: ${escapeHtml(holName)}</span>`)
        : `<span class="pill ${escapeHtml(r.status || '')}">${escapeHtml(detailedStatusLabel(r))}</span>${r._synthetic ? ' <span class="badge-silent">no record</span>' : ''}`;
      detailParts.push(`<tr class="${s.isShift ? 'shiftrow' : ''}${r._synthetic ? ' silent' : ''}${holName ? ' holidayrow' : ''}">
        <td class="num">${dN}</td>
        <td class="name">${escapeHtml(s.emp.name)}</td>
        <td class="ctr">${s.isShift ? '<span class="shift-badge">SHIFT</span>' : ''}</td>
        <td class="ctr mono">${escapeHtml(s.emp.id)}</td>
        <td class="ctr">${escapeHtml(s.emp.department || '—')}</td>
        <td class="ctr">${escapeHtml(s.emp.location || '—')}</td>
        <td class="ctr mono">${escapeHtml(fmtDate(r.attendance_date))}</td>
        <td class="ctr">${escapeHtml(fmtDay(r.attendance_date))}</td>
        <td class="ctr mono" style="color:${shift ? '#1F1B16' : '#9CA3AF'};">${escapeHtml(shift || '—')}</td>
        <td class="ctr mono">${escapeHtml(fmtTime(r.effective_in) || '—')}${r.isOvernight && r.effective_carry ? `<br><span class="sub">${escapeHtml(fmtTime(r.effective_carry))} (prev)</span>` : ''}</td>
        <td class="ctr mono">${escapeHtml(fmtTime(r.effective_out) || '—')}${r.isOvernight && r.effective_out ? ' <span class="sub">+1d</span>' : ''}</td>
        <td class="ctr mono${!holName && isShortfall(r) ? ' red' : ''}">${escapeHtml(fmtHoursMins(r.total_minutes))}</td>
        <td class="ctr red">${escapeHtml(lms)}</td>
        <td class="ctr">${statusCell}</td>
      </tr>`);
      di += 1;
    }
    detailParts.push(`<tr class="subtotal">
      <td></td><td>${cnt} staff</td><td></td><td></td><td></td><td></td>
      <td class="ctr mono">${escapeHtml(fmtDate(date))}</td><td></td><td></td><td></td>
      <td class="ctr">TOTAL →</td>
      <td class="ctr">${escapeHtml(fmtHoursMins(sumMin))}</td>
      <td class="ctr">${escapeHtml(fmtLateSec(sumLate))}</td><td></td>
    </tr>`);
  }
  const detailRows = detailParts.join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Attendance Report · ${from} to ${to}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: Calibri, 'Segoe UI', system-ui, sans-serif;
    color: #1F1B16;
    background: #FBF6E9;
    margin: 0;
    padding: 24px;
    font-size: 11pt;
  }
  .page {
    max-width: 920px;
    margin: 0 auto;
    background: #FFFFFF;
    border: 1px solid #D4C7AB;
    padding: 32px 40px;
  }
  header.brand {
    border-bottom: 2px solid #0F4C2A;
    padding-bottom: 14px;
    margin-bottom: 22px;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
  }
  .brand-name { font-size: 22px; font-weight: 700; color: #0F4C2A; letter-spacing: 0.5px; }
  .brand-sub  { font-size: 10pt; color: #5C4406; margin-top: 4px; font-style: italic; }
  .meta       { font-size: 9pt; color: #5C4406; text-align: right; line-height: 1.6; }
  h1 {
    font-size: 18pt; color: #0F4C2A; margin: 0 0 4px;
    font-weight: 700; letter-spacing: 0.3px;
  }
  h1 + .period { font-size: 10pt; color: #5C4406; margin-bottom: 24px; }
  section.emp { margin-bottom: 28px; page-break-inside: avoid; }
  section.emp.shift .emp-header {
    background: #EFF6FF; border-left: 3px solid #1D4ED8;
  }
  .shift-badge {
    display: inline-block; margin-left: 8px; vertical-align: middle;
    background: #1D4ED8; color: #FFFFFF; font-size: 8pt; font-weight: 700;
    padding: 1px 7px; border-radius: 999px; letter-spacing: 0.5px;
  }
  .emp-header {
    display: flex; justify-content: space-between; align-items: flex-end;
    padding: 8px 12px;
    background: #F4EEDF; border-left: 3px solid #0F4C2A;
    margin-bottom: 8px;
  }
  .emp-name { font-size: 13pt; font-weight: 700; color: #1F1B16; }
  .emp-meta { font-size: 9pt; color: #5C4406; margin-top: 2px; }
  .stats { display: flex; gap: 18px; }
  .stats div { text-align: center; }
  .stats strong { display: block; font-size: 14pt; color: #0F4C2A; font-weight: 700; }
  .stats span { font-size: 7.5pt; color: #5C4406; text-transform: uppercase; letter-spacing: 0.5px; }
  .stats .leave strong  { color: #1E40AF; }
  .stats .absent strong { color: #991B1B; }
  .stats .late strong   { color: #92400E; }
  .stats .short strong  { color: #92400E; }
  .stats .good strong   { color: #0F4C2A; }
  .dot {
    display: inline-block; width: 7px; height: 7px; border-radius: 50%;
    margin-right: 2px; background: #D1D5DB;
  }
  .dot.good { background: #15803D; }
  .dot.bad  { background: #B91C1C; }
  .dot.na   { background: #D1D5DB; }
  table.grid { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin: 4px 0 22px; }
  table.grid thead th {
    text-align: left; padding: 7px 10px; background: #0F4C2A; color: #FFFFFF;
    border: 1px solid #0B3A20; font-weight: 600; white-space: nowrap;
  }
  table.grid thead th.num { text-align: right; }
  table.grid thead th.ctr { text-align: center; }
  table.grid tbody td { padding: 6px 10px; border: 1px solid #E5E0D2; vertical-align: middle; white-space: nowrap; }
  table.grid tbody tr:nth-child(even) td { background: #FAF8F1; }
  table.grid tbody tr.shiftrow td { background: #EFF6FF; }
  table.grid tbody tr.shiftrow td:first-child { border-left: 3px solid #1D4ED8; }
  table.grid td.num { text-align: right; }
  table.grid td.ctr { text-align: center; }
  table.grid td.name { font-weight: 600; }
  table.grid td.red { color: #B91C1C; font-weight: 700; }
  table.grid td.cgood  { color: #166534; font-weight: 700; }
  table.grid td.camber { color: #92400E; font-weight: 700; }
  table.grid td.cred   { color: #991B1B; font-weight: 700; }
  table.grid .sub { font-size: 8pt; color: #9CA3AF; }
  .sec-title { font-size: 12pt; font-weight: 700; color: #0F4C2A; margin: 18px 0 2px; letter-spacing: 0.3px; }
  table.grid tr.silent td { opacity: 0.75; }
  table.grid tr.subtotal td { background: #FDE68A !important; font-weight: 700; color: #1F1B16; border-color: #D4C7AB; }
  table.grid tr.holidayrow td { background: #F5F3FF; }
  .pill.holiday { background: #EDE9FE; color: #5B21B6; font-weight: 700; }
  thead th {
    text-align: left; padding: 9px 14px;
    background: #0F4C2A; color: #FFFFFF; border: 1px solid #0B3A20;
    font-weight: 600; letter-spacing: 0.02em; white-space: nowrap;
  }
  tbody td { padding: 8px 14px; border: 1px solid #E5E0D2; vertical-align: middle; }
  tbody tr:nth-child(even) td { background: #FAF8F1; }
  tbody tr:hover td { background: #F4EEDF; }
  .mono { font-family: 'Consolas', 'Courier New', monospace; font-size: 9.5pt; }
  .pill {
    display: inline-block; padding: 2px 8px; border-radius: 4px;
    font-size: 8.5pt; font-weight: 600;
    background: #F3F4F6; color: #374151;
  }
  .pill.present { background: #DCFCE7; color: #166534; }
  .pill.late, .pill.short { background: #FEF3C7; color: #92400E; }
  .pill.absent { background: #FEE2E2; color: #991B1B; }
  .pill.sick_leave        { background: #EDE9FE; color: #5B21B6; }
  .pill.annual_leave      { background: #CCFBF1; color: #115E59; }
  .pill.maternity_leave   { background: #FCE7F3; color: #9D174D; }
  .pill.paternity_leave   { background: #E0F2FE; color: #075985; }
  .pill.hajj_leave        { background: #FEF3C7; color: #854F0B; }
  .pill.marriage_leave    { background: #FCE7F3; color: #831843; }
  .pill.bereavement_leave { background: #E5E7EB; color: #374151; }
  .pill.unpaid_leave      { background: #F3F4F6; color: #374151; }
  .pill.emergency_leave   { background: #FEE2E2; color: #7F1D1D; }
  .pill.iddah_leave       { background: #F3E8FF; color: #6B21A8; }
  .pill.off_day, .pill.off_roster { background: #F3F4F6; color: #374151; }
  tr.silent td { opacity: 0.7; }
  .badge-silent {
    display: inline-block; margin-left: 8px;
    font-size: 8pt; font-weight: 700; color: #991B1B;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .empty { padding: 12px; text-align: center; font-style: italic; color: #5C4406; }
  footer.foot {
    border-top: 1px solid #D4C7AB; margin-top: 28px; padding-top: 12px;
    font-size: 8.5pt; color: #5C4406; text-align: right; font-style: italic;
  }
  @media print {
    body { background: #FFFFFF; padding: 0; }
    .page { border: 0; padding: 16mm 14mm; max-width: none; }
    section.emp { page-break-inside: avoid; }
  }
</style></head><body>
<div class="page">
  <header class="brand">
    <div>
      <div class="brand-name">EVERGREEN LINE</div>
      <div class="brand-sub">Evergreen Shipping Agency Saudi Co. (L.L.C) · ESAU SADMN SUP / HR Dept</div>
    </div>
    <div class="meta">
      ${escapeHtml(me?.name || 'ESAU HR')}
    </div>
  </header>

  <h1>Attendance Report</h1>
  <div class="period">${escapeHtml(fmtDate(from))} &nbsp;to&nbsp; ${escapeHtml(fmtDate(to))}  ·  ${summaries.length} staff  ·  sorted by location → department → name</div>

  <div class="sec-title">Detail</div>
  <table class="grid">
    <thead><tr>
      <th>#</th><th>Employee</th><th>Shift</th><th class="ctr">PSN</th><th class="ctr">Department</th><th class="ctr">Location</th>
      <th class="ctr">Date</th><th class="ctr">Day</th><th class="ctr">Assigned shift</th><th class="ctr">Check in</th><th class="ctr">Out</th><th class="ctr">Total</th>
      <th class="ctr">Late (mm:ss)</th><th class="ctr">Status</th>
    </tr></thead>
    <tbody>${detailRows}</tbody>
  </table>

  <footer class="foot">
    Generated from the ESAU HR Portal · esauhr.netlify.app<br>
    Data sourced from attendance_daily (Time Card uploads). Punches reflect the first and last fingerprint event of the day; total hours are the parsed worked-time.
  </footer>
</div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Small pill that shows a count + a short label. Used in each staff
// header for the LATE / SHORT / ABSENT / LEAVE anomaly chips. Hover
// title can carry sub-detail (e.g. SHORT chip shows the missed-in /
// missed-out / left-early breakdown on hover).
function Chip({ count, label, bg, fg, title }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9.5px] font-bold tracking-wide"
      style={{ background: bg, color: fg }}
      title={title || undefined}>
      <span style={{ fontSize: '11px', lineHeight: 1 }}>{count}</span>
      <span>{label}</span>
    </span>
  );
}

// Compact compliance indicator — three dots representing the three
// shift-discipline checks (on-time in, full shift, both punches).
// Green = compliant; red = violated; grey = couldn't evaluate.
// The dot vocabulary keeps the column narrow while giving an at-a-
// glance read of whether the day was clean.
function ComplianceDots({ row }) {
  const dot = (flag, title) => {
    const colour = flag === true  ? '#15803D'    // green
                 : flag === false ? '#B91C1C'    // red
                 :                  '#D1D5DB';   // grey (couldn't evaluate)
    return (
      <span title={title}
            style={{
              display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
              background: colour, marginRight: 2,
            }} />
    );
  };
  const onTimeTitle =
    row.onTime === true  ? 'On-time arrival (within 15-min grace)'
  : row.onTime === false ? 'Late arrival (more than 15 min after shift start)'
  : 'Not enough data to check arrival';
  const fullTitle =
    row.fullShift === true  ? 'Full shift worked'
  : row.fullShift === false ? 'Left early (more than 15 min before shift end)'
  : 'Not enough data to check end';
  const bothTitle =
    row.bothPunch === true  ? 'Both punches recorded'
  : row.bothPunch === false ? 'Missing a punch'
  : '—';
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {dot(row.onTime, onTimeTitle)}
      {dot(row.fullShift, fullTitle)}
      {dot(row.bothPunch, bothTitle)}
    </span>
  );
}
