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
import { Clock, Download, ChevronDown, ChevronRight, FileText, Users, Mail } from 'lucide-react';
import { directGet } from '../supabaseClient.js';
import { todayLocal, addDaysIso } from '../lib/dateUtils.js';

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
  const [from, setFrom] = useState(addDaysIso(today, -29));
  const [to,   setTo]   = useState(today);
  const [expanded, setExpanded] = useState(new Set());  // employee IDs whose drill-down is open
  const [attendance, setAttendance] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  // Shift-flagged staff only. We also compute a stable string key
  // of just the IDs so the load() callback can depend on the SET of
  // people (not the array reference). Without this the load fires
  // on every parent re-render of AttendanceView — and AttendanceView
  // re-renders a lot during the daily upload flow — which caused a
  // visible flicker as the loading state flipped on/off.
  const shiftStaff = useMemo(
    () => (employees || []).filter(e => e.is_shift_staff === true),
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
    lines.push(`Dear ${manager.name?.split(' ')[0] || manager.name},`);
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
    lines.push('Best regards,');
    lines.push(me?.name || 'ESAU HR');
    lines.push('HR / Admin Supervisory · ESAU Dammam');

    const subject = `Attendance review – ${emp.name} (${emp.id}) · ${periodLabel}`;
    const body    = lines.join('\n');
    const href    = `mailto:${encodeURIComponent(manager.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = href;
  }, [empMap, from, to, me]);

  // Fetch attendance_daily rows for the date window + flagged staff.
  // attendance_daily has first_punch + last_punch as TIME columns; the
  // worked-time isn't stored directly. We fetch the punches plus
  // late/early/expected columns and compute total worked minutes
  // client-side. Schema reference: supabase/migration_attendance_daily.sql
  const load = useCallback(async () => {
    if (shiftStaff.length === 0) {
      setAttendance([]);
      return;
    }
    // Belt-and-braces: even after fixing the initial null bug, the
    // date-picker inputs CAN produce empty strings if the user clears
    // them. Don't fire the query in that state — show the existing
    // data and wait for them to set a valid range.
    if (!from || !to) return;
    setLoading(true);
    setErr(null);
    try {
      const ids = shiftStaff.map(e => `"${e.id}"`).join(',');
      const q = `select=employee_id,attendance_date,first_punch,last_punch,punch_count,expected_start,expected_end,late_minutes,early_leave_minutes,status`
             + `&employee_id=in.(${ids})`
             + `&attendance_date=gte.${from}`
             + `&attendance_date=lte.${to}`
             + `&order=attendance_date.asc`;
      const rows = await directGet('attendance_daily', q, { timeoutMs: 12000 });
      // Enrich each row with a computed `total_minutes` field so the
      // rest of the component (summaries, renderer, HTML report) can
      // use it without re-doing the arithmetic.
      const enriched = (Array.isArray(rows) ? rows : []).map(r => ({
        ...r,
        total_minutes: computeWorkedMinutes(r.first_punch, r.last_punch),
      }));
      setAttendance(enriched);
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

  useEffect(() => { load(); }, [load]);

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
    // Synthesize absences for each flagged staff.
    const weekdays = eachWeekday(from, to);
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
  }, [attendance, shiftStaff, from, to]);

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

      return {
        emp, rows,
        daysPresent: present.length + late.length + shortRows.length,
        daysLate:    late.length,
        daysShort:   shortRows.length,
        missedIn, missedOut, leftEarly,
        daysAbsent:  absentReal.length + absentSilent.length,
        daysLeave:   leaveD.length,
        totalMin, avgMin,
        problemRows,
      };
    });
  }, [shiftStaff, byEmployee]);

  const toggleExpand = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleDownload = () => {
    const html = renderReportHtml({ summaries, from, to, me });
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `Shift-Staff-Attendance-${from}_to_${to}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

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
              Shift staff attendance
            </div>
          </div>
          <div className="text-[11px] mt-1" style={{ color: '#1F1B16' }}>
            In / out punches + total worked hours for staff marked as shift workers by their managers.
          </div>
        </div>
        <button
          type="button"
          onClick={handleDownload}
          disabled={loading || shiftStaff.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition disabled:opacity-50"
          style={{ background: '#0F4C2A', color: '#FFFFFF' }}>
          <Download className="w-3.5 h-3.5" />
          Download report
        </button>
      </div>

      {/* Date range chooser */}
      <div className="flex items-center gap-3 flex-wrap mb-4 p-3 rounded-lg"
           style={{ background: '#FBF6E9' }}>
        <div className="text-[11px] font-semibold" style={{ color: '#1F1B16' }}>PERIOD</div>
        <label className="flex items-center gap-1.5 text-[11px]" style={{ color: '#1F1B16' }}>
          From
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                 className="px-2 py-1 rounded border bg-white text-[11px]"
                 style={{ borderColor: 'var(--border-soft)', color: '#1F1B16' }} />
        </label>
        <label className="flex items-center gap-1.5 text-[11px]" style={{ color: '#1F1B16' }}>
          to
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
                 className="px-2 py-1 rounded border bg-white text-[11px]"
                 style={{ borderColor: 'var(--border-soft)', color: '#1F1B16' }} />
        </label>
        <div className="text-[10px]" style={{ color: '#1F1B16' }}>
          {shiftStaff.length} shift {shiftStaff.length === 1 ? 'staff' : 'staff'} flagged
        </div>
      </div>

      {/* Body */}
      {shiftStaff.length === 0 ? (
        <div className="flex items-center gap-2 text-sm py-6 px-3 rounded-lg"
             style={{ background: '#FBF6E9', color: '#1F1B16' }}>
          <Users className="w-4 h-4" style={{ color: '#1F1B16' }} />
          <div>
            <div className="font-medium">No shift staff flagged yet</div>
            <div className="text-[11px] mt-0.5">
              Each manager can mark their direct reports as shift staff from their dashboard — once flagged, they appear here.
            </div>
          </div>
        </div>
      ) : err ? (
        <div className="text-xs text-red-700 bg-red-50 rounded-md p-2">{err}</div>
      ) : loading ? (
        <div className="text-center text-xs opacity-50 py-4">Loading attendance…</div>
      ) : (
        <div className="space-y-2">
          {summaries.map(s => {
            const manager = s.emp.manager_id ? empMap[s.emp.manager_id] : null;
            const hasManagerEmail = !!manager?.email;
            return (
            <div key={s.emp.id} className="rounded-lg border bg-white overflow-hidden"
                 style={{ borderColor: 'var(--border-soft)' }}>
              {/* Summary row */}
              <div className="flex items-center gap-3 px-3 py-2.5">
                <button type="button" onClick={() => toggleExpand(s.emp.id)}
                        className="flex items-center gap-3 flex-1 min-w-0 text-left hover:opacity-80 transition">
                  {expanded.has(s.emp.id)
                    ? <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: '#1F1B16' }} />
                    : <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: '#1F1B16' }} />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold" style={{ color: '#1F1B16' }}>
                      {s.emp.name}
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
                          <th className="py-1.5 pr-2 font-semibold">In</th>
                          <th className="py-1.5 pr-2 font-semibold">Out</th>
                          <th className="py-1.5 pr-2 font-semibold">Total</th>
                          <th className="py-1.5 pr-2 font-semibold">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.rows.map(r => {
                          const pill = statusPill(r.status);
                          const label = detailedStatusLabel(r);
                          const isSilent = !!r._synthetic;
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
                              <td className="py-1.5 pr-2 font-mono">{fmtTime(r.first_punch)}</td>
                              <td className="py-1.5 pr-2 font-mono">{fmtTime(r.last_punch)}</td>
                              <td className="py-1.5 pr-2 font-mono">{fmtHoursMins(r.total_minutes)}</td>
                              <td className="py-1.5 pr-2">
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                                      style={{ background: pill.bg, color: pill.fg }}>
                                  {label}
                                </span>
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
function renderReportHtml({ summaries, from, to, me }) {
  const generatedAt = new Date().toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const employeeBlocks = summaries.map(s => `
    <section class="emp">
      <header class="emp-header">
        <div>
          <div class="emp-name">${escapeHtml(s.emp.name)}</div>
          <div class="emp-meta">${escapeHtml(s.emp.id)} · ${escapeHtml(s.emp.department || '—')} · ${escapeHtml(s.emp.location || '—')}</div>
        </div>
        <div class="stats">
          <div><strong>${s.daysPresent}</strong><span>days present</span></div>
          <div><strong>${fmtHoursMins(s.totalMin)}</strong><span>total hours</span></div>
          <div><strong>${fmtHoursMins(s.avgMin)}</strong><span>avg / day</span></div>
          ${s.daysLate   > 0 ? `<div class="late"><strong>${s.daysLate}</strong><span>late</span></div>`     : ''}
          ${s.daysShort  > 0 ? `<div class="short"><strong>${s.daysShort}</strong><span>short</span></div>`  : ''}
          ${s.daysAbsent > 0 ? `<div class="absent"><strong>${s.daysAbsent}</strong><span>absent</span></div>` : ''}
          ${s.daysLeave  > 0 ? `<div class="leave"><strong>${s.daysLeave}</strong><span>leave</span></div>`  : ''}
        </div>
      </header>
      ${s.rows.length === 0 ? `
        <div class="empty">No attendance rows for this period.</div>
      ` : `
        <table>
          <thead>
            <tr>
              <th>Date</th><th>In</th><th>Out</th><th>Total</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${s.rows.map(r => `
              <tr${r._synthetic ? ' class="silent"' : ''}>
                <td class="mono">${escapeHtml(fmtDateLong(r.attendance_date))}${r._synthetic ? ' <span class="badge-silent">no record</span>' : ''}</td>
                <td class="mono">${escapeHtml(fmtTime(r.first_punch))}</td>
                <td class="mono">${escapeHtml(fmtTime(r.last_punch))}</td>
                <td class="mono">${escapeHtml(fmtHoursMins(r.total_minutes))}</td>
                <td><span class="pill ${escapeHtml(r.status || '')}">${escapeHtml(detailedStatusLabel(r))}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </section>
  `).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Shift Staff Attendance · ${from} to ${to}</title>
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
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  thead th {
    text-align: left; padding: 6px 8px;
    background: #FBF6E9; border-bottom: 1px solid #D4C7AB;
    font-weight: 700; color: #1F1B16;
  }
  tbody td { padding: 5px 8px; border-bottom: 1px solid #EFE6CF; }
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
      Generated ${escapeHtml(generatedAt)}<br>
      ${escapeHtml(me?.name || 'ESAU HR')}
    </div>
  </header>

  <h1>Shift Staff Attendance Report</h1>
  <div class="period">${escapeHtml(fmtDate(from))} &nbsp;to&nbsp; ${escapeHtml(fmtDate(to))}  ·  ${summaries.length} shift staff</div>

  ${employeeBlocks}

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
