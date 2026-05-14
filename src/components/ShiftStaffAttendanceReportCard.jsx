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
import { Clock, Download, ChevronDown, ChevronRight, FileText, Users } from 'lucide-react';
import { directGet } from '../supabaseClient.js';
import { localDateString, addDaysIso } from '../lib/dateUtils.js';

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

// Status badge colours (matches AttendanceMonthGrid vocabulary).
const STATUS_PILL = {
  present:       { bg: '#DCFCE7', fg: '#166534', label: 'Present'     },
  late:          { bg: '#FEF3C7', fg: '#92400E', label: 'Late'        },
  short:         { bg: '#FEF3C7', fg: '#92400E', label: 'Short'       },
  absent:        { bg: '#FEE2E2', fg: '#991B1B', label: 'Absent'      },
  sick_leave:    { bg: '#DBEAFE', fg: '#1E40AF', label: 'Sick leave'  },
  annual_leave:  { bg: '#DBEAFE', fg: '#1E40AF', label: 'Annual leave'},
  off_day:       { bg: '#F3F4F6', fg: '#374151', label: 'Off day'     },
  off_roster:    { bg: '#F3F4F6', fg: '#374151', label: 'Off roster'  },
};

// ─── main component ────────────────────────────────────────────────────────

/**
 * @param {Array} employees — full employees list (we filter for is_shift_staff)
 * @param {object} me — current user (for the "generated by" stamp)
 */
export default function ShiftStaffAttendanceReportCard({ employees = [], me }) {
  // Date window — default last 30 days inclusive of today.
  const today = localDateString();
  const [from, setFrom] = useState(addDaysIso(today, -29));
  const [to,   setTo]   = useState(today);
  const [expanded, setExpanded] = useState(new Set());  // employee IDs whose drill-down is open
  const [attendance, setAttendance] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  // Shift-flagged staff only.
  const shiftStaff = useMemo(
    () => (employees || []).filter(e => e.is_shift_staff === true),
    [employees]
  );

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
  }, [shiftStaff, from, to]);

  useEffect(() => { load(); }, [load]);

  // Group attendance by employee_id.
  const byEmployee = useMemo(() => {
    const map = new Map();
    for (const row of attendance) {
      const list = map.get(row.employee_id) || [];
      list.push(row);
      map.set(row.employee_id, list);
    }
    return map;
  }, [attendance]);

  // Per-employee summary stats.
  const summaries = useMemo(() => {
    return shiftStaff.map(emp => {
      const rows = byEmployee.get(emp.id) || [];
      const present  = rows.filter(r => ['present', 'late', 'short'].includes(r.status));
      const leaveD   = rows.filter(r => r.status === 'sick_leave' || r.status === 'annual_leave');
      const absent   = rows.filter(r => r.status === 'absent');
      const totalMin = present.reduce((sum, r) => sum + (Number(r.total_minutes) || 0), 0);
      const avgMin   = present.length > 0 ? Math.round(totalMin / present.length) : 0;
      return {
        emp, rows,
        daysPresent: present.length,
        daysLeave:   leaveD.length,
        daysAbsent:  absent.length,
        totalMin, avgMin,
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
          {summaries.map(s => (
            <div key={s.emp.id} className="rounded-lg border bg-white overflow-hidden"
                 style={{ borderColor: 'var(--border-soft)' }}>
              {/* Summary row */}
              <button type="button" onClick={() => toggleExpand(s.emp.id)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-amber-50 transition text-left">
                {expanded.has(s.emp.id)
                  ? <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: '#1F1B16' }} />
                  : <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: '#1F1B16' }} />}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold" style={{ color: '#1F1B16' }}>
                    {s.emp.name}
                  </div>
                  <div className="text-[10px]" style={{ color: '#1F1B16' }}>
                    {s.emp.id} · {s.emp.department || '—'} · {s.emp.location || '—'}
                  </div>
                </div>
                <div className="hidden sm:flex items-center gap-4 text-[11px]" style={{ color: '#1F1B16' }}>
                  <div className="text-center">
                    <div className="font-semibold text-sm" style={{ color: '#0F4C2A' }}>{s.daysPresent}</div>
                    <div className="text-[9px]">DAYS PRESENT</div>
                  </div>
                  <div className="text-center">
                    <div className="font-semibold text-sm" style={{ color: '#1F1B16' }}>{fmtHoursMins(s.totalMin)}</div>
                    <div className="text-[9px]">TOTAL HOURS</div>
                  </div>
                  <div className="text-center">
                    <div className="font-semibold text-sm" style={{ color: '#1F1B16' }}>{fmtHoursMins(s.avgMin)}</div>
                    <div className="text-[9px]">AVG / DAY</div>
                  </div>
                  {s.daysLeave > 0 && (
                    <div className="text-center">
                      <div className="font-semibold text-sm" style={{ color: '#1E40AF' }}>{s.daysLeave}</div>
                      <div className="text-[9px]">LEAVE</div>
                    </div>
                  )}
                  {s.daysAbsent > 0 && (
                    <div className="text-center">
                      <div className="font-semibold text-sm" style={{ color: '#991B1B' }}>{s.daysAbsent}</div>
                      <div className="text-[9px]">ABSENT</div>
                    </div>
                  )}
                </div>
              </button>

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
                          const pill = STATUS_PILL[r.status] || { bg: '#F3F4F6', fg: '#374151', label: r.status };
                          return (
                            <tr key={r.attendance_date} className="border-t" style={{ borderColor: 'var(--border-soft)' }}>
                              <td className="py-1.5 pr-2 font-mono">{fmtDateLong(r.attendance_date)}</td>
                              <td className="py-1.5 pr-2 font-mono">{fmtTime(r.first_punch)}</td>
                              <td className="py-1.5 pr-2 font-mono">{fmtTime(r.last_punch)}</td>
                              <td className="py-1.5 pr-2 font-mono">{fmtHoursMins(r.total_minutes)}</td>
                              <td className="py-1.5 pr-2">
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                                      style={{ background: pill.bg, color: pill.fg }}>
                                  {pill.label}
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
          ))}
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
          ${s.daysLeave  > 0 ? `<div class="leave"><strong>${s.daysLeave}</strong><span>leave</span></div>` : ''}
          ${s.daysAbsent > 0 ? `<div class="absent"><strong>${s.daysAbsent}</strong><span>absent</span></div>` : ''}
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
              <tr>
                <td class="mono">${escapeHtml(fmtDateLong(r.attendance_date))}</td>
                <td class="mono">${escapeHtml(fmtTime(r.first_punch))}</td>
                <td class="mono">${escapeHtml(fmtTime(r.last_punch))}</td>
                <td class="mono">${escapeHtml(fmtHoursMins(r.total_minutes))}</td>
                <td><span class="pill ${escapeHtml(r.status || '')}">${escapeHtml((STATUS_PILL[r.status] || { label: r.status || '—' }).label)}</span></td>
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
  .pill.sick_leave, .pill.annual_leave { background: #DBEAFE; color: #1E40AF; }
  .pill.off_day, .pill.off_roster { background: #F3F4F6; color: #374151; }
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
