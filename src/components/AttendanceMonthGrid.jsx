// =============================================================================
// AttendanceMonthGrid.jsx
//
// Monthly calendar view of recorded attendance. Reads from
// attendance_daily and renders a per-employee row of status-coded
// chips, one column per calendar day.
//
// Visual language matches ShiftMonthGrid (the manager's shift
// calendar) so Bashaier sees the same row/column structure she
// already knows from that view, just in a different domain.
//
// STATUS PALETTE
//   present       → green chip with first/last punch times
//   late          → amber chip with "+Nm late" + punch times
//   short         → orange chip with "−Nm" + punch times
//   absent        → red empty chip
//   annual_leave  → teal chip with "AL"
//   sick_leave    → purple chip with "SL"
//   off_roster    → navy chip with "OFF·R" (worked outside roster)
//   off_day       → light navy "OFF" (deliberate off-day, no work)
//   no record yet → blank cell
//   weekend       → beige tint (KSA Fri/Sat) when no record
//   future        → tinted gray (date hasn't happened yet)
//
// Hover any cell with data → richer tooltip rendered as a fixed-
// position panel above the cell, showing employee name, full date,
// status, punch times, schedule (if any), and computed late/early
// minutes.
//
// LIVE UPDATES
//   Subscribes to attendance_daily realtime changes — Bashaier
//   uploading a fresh file mid-view propagates new rows into the
//   grid immediately.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCcw, Loader2, Search, X } from 'lucide-react';
import { directGet, supabase } from '../supabaseClient.js';

// Auto-fit text helper — CSS-only. No hooks. Uses container queries
// + clamp on font-size based on text length to shrink long names so
// they fit on a single line without ellipsis truncation. Conservative
// floor at 9px so it stays legible.
function FitText({ text, style = {}, className }) {
  const length = (text || '').length;
  // Heuristic font size: longer names get smaller font.
  // 200px column ≈ ~22 chars at 11px, ~30 chars at 9px.
  const fontSize =
    length <= 16 ? 12 :
    length <= 20 ? 11 :
    length <= 24 ? 10 :
    length <= 28 ? 9.5 : 9;
  return (
    <div
      className={className}
      style={{
        ...style,
        fontSize,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
      title={text}
    >
      {text}
    </div>
  );
}

// Local YYYY-MM-DD without timezone surprises.
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayYmd() { return ymd(new Date()); }

// ─── Status → visual style mapping ───────────────────────────────────
// Each entry returns the chip style + a 2-3 char label. Returning
// inline lets the cell renderer keep one switch and stay readable.
//
// A second optional parameter (notes) lets us distinguish present
// rows that were originally late or early but downgraded to present
// because an approved permission covered the punch. Per Nadeem
// (2026-05-06): on the monthly grid, those should look distinct
// from "naturally on time" so HR can tell at a glance which days
// were permission-covered. We detect via the note text the backfill
// stamps when applying coverage ("late arrival covered by..." /
// "early leave covered by...").
function styleForStatus(status, notes) {
  if (status === 'present' && typeof notes === 'string') {
    if (/late arrival covered by approved permission/i.test(notes)) {
      return { bg: '#EFF6FF', fg: '#1E40AF', border: '#93C5FD', label: '✓LP' };
    }
    if (/early leave covered by approved permission/i.test(notes)) {
      return { bg: '#EFF6FF', fg: '#1E40AF', border: '#93C5FD', label: '✓EP' };
    }
  }
  switch (status) {
    case 'present':
      return { bg: '#ECFDF5', fg: '#0F4C2A', border: '#A7F3D0', label: '✓' };
    case 'late':
      return { bg: '#FEF3C7', fg: '#854F0B', border: '#FCD34D', label: 'LT' };
    case 'short':
      return { bg: '#FED7AA', fg: '#7C2D12', border: '#FB923C', label: 'SH' };
    case 'absent':
      return { bg: '#FEE2E2', fg: '#991B1B', border: '#FCA5A5', label: 'AB' };
    case 'annual_leave':
      return { bg: '#CCFBF1', fg: '#115E59', border: '#5EEAD4', label: 'AL' };
    case 'sick_leave':
      return { bg: '#EDE9FE', fg: '#5B21B6', border: '#C4B5FD', label: 'SL' };
    case 'maternity_leave':
      return { bg: '#FCE7F3', fg: '#9D174D', border: '#F9A8D4', label: '✓ML' };
    case 'paternity_leave':
      return { bg: '#E0F2FE', fg: '#075985', border: '#7DD3FC', label: '✓PL' };
    case 'hajj_leave':
      return { bg: '#FEF3C7', fg: '#854F0B', border: '#FCD34D', label: '✓HJ' };
    case 'emergency_leave':
      return { bg: '#FEE2E2', fg: '#7F1D1D', border: '#FCA5A5', label: '✓EL' };
    case 'unpaid_leave':
      return { bg: '#F3F4F6', fg: '#374151', border: '#D1D5DB', label: '✓UL' };
    case 'off_roster':
      return { bg: '#DBEAFE', fg: '#1E3A8A', border: '#93C5FD', label: 'OR' };
    case 'off_day':
      return { bg: '#EEF0FA', fg: '#3B4279', border: '#C7CFE5', label: 'OF' };
    default:
      return { bg: '#F5F5F5', fg: '#525252', border: '#D4D4D4', label: '?' };
  }
}

function readableStatus(status) {
  return ({
    present: 'Present',
    late: 'Late',
    short: 'Short shift',
    absent: 'Absent',
    annual_leave: 'Annual leave',
    sick_leave: 'Sick leave',
    maternity_leave: 'Maternity leave',
    paternity_leave: 'Paternity leave',
    hajj_leave: 'Hajj leave',
    emergency_leave: 'Emergency leave',
    unpaid_leave: 'Unpaid leave',
    off_roster: 'Worked off-roster',
    off_day: 'Off-day',
  })[status] || status;
}

// Phase B + C: external refresh trigger.
//   • refreshTick — integer that bumps externally (from AttendanceView)
//     after a re-evaluation completes, so the grid refetches its rows
//     without the user having to navigate away and back. Per Decision
//     #3 / option A: single refetch at session end, no live updates
//     during the upload to avoid scroll/flicker.
export default function AttendanceMonthGrid({ employees, onEmployeeClick, refreshTick = 0 }) {
  const today = useMemo(() => new Date(), []);
  const [year, setYear]   = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetchErr, setFetchErr] = useState(null);   // surfaced on-screen
  const [lastCount, setLastCount] = useState(null);  // rows from last fetch
  const [hoverTip, setHoverTip] = useState(null);
  // Search filter — Bashaier types a name fragment / PSN / dept and
  // the grid narrows to matching staff. Empty string = no filter.
  // Match is case-insensitive, substring across name, id, department,
  // location, designation — whichever fields the employees row carries.
  const [search, setSearch] = useState('');

  const firstDay = useMemo(() => new Date(year, month, 1), [year, month]);
  const lastDay  = useMemo(() => new Date(year, month + 1, 0), [year, month]);
  const days = useMemo(() => {
    const arr = [];
    const total = lastDay.getDate();
    for (let d = 1; d <= total; d++) arr.push(new Date(year, month, d));
    return arr;
  }, [year, month, lastDay]);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      // select=* (not a fixed column list) so a drifted/renamed column
      // in the live table can never 400 the read and silently blank the
      // grid. Missing optional columns just come back undefined.
      const data = await directGet(
        'attendance_daily',
        `select=*` +
        `&attendance_date=gte.${ymd(firstDay)}` +
        `&attendance_date=lte.${ymd(lastDay)}` +
        `&order=attendance_date.asc`,
        { timeoutMs: 9000 }
      );
      setRecords(data || []);
      setLastCount(Array.isArray(data) ? data.length : 0);
      setFetchErr(null);
    } catch (e) {
      console.warn('attendance_daily fetch failed:', e);
      setRecords([]);
      setLastCount(null);
      setFetchErr(e?.message || String(e) || 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [firstDay, lastDay]);
  useEffect(() => { refetch(); }, [refetch]);

  // External refresh — bumps when AttendanceView's re-evaluation
  // pipeline completes. Skips the initial mount (refetch above
  // already covers that) by gating on tick > 0.
  useEffect(() => {
    if (refreshTick > 0) refetch();
  }, [refreshTick, refetch]);

  // Debounced realtime — bursts of upserts during an upload settle
  // into a single refetch.
  const debounceRef = useRef(null);
  useEffect(() => {
    if (!supabase) return;
    const trigger = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        refetch();
      }, 800);
    };
    const ch = supabase
      .channel('attendance-month-grid')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'attendance_daily' },
        () => trigger()
      )
      .subscribe();
    return () => {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      try { supabase.removeChannel(ch); } catch {}
    };
  }, [refetch]);

  // Index records by (employee_id, date) for O(1) cell lookup.
  const recordIndex = useMemo(() => {
    const idx = new Map();
    records.forEach(r => idx.set(`${r.employee_id}|${r.attendance_date}`, r));
    return idx;
  }, [records]);

  // Diagnostic — how many loaded records' employee_id actually match a
  // directory employee id (the exact string the cell lookup uses), plus
  // a sample row. If matched=0 while records>0, the cells will all be
  // empty because the keys don't line up (e.g. PSN written without the
  // 'H' prefix). Surfaced in the status line. Nadeem 2026-05-31.
  const recordDiag = useMemo(() => {
    if (!records.length) return null;
    const ids = new Set((employees || []).map(e => String(e?.id)));
    let matched = 0;
    for (const r of records) if (ids.has(String(r.employee_id))) matched++;
    const s = records[0] || {};
    return {
      matched, total: records.length,
      sampleId: s.employee_id, sampleDate: s.attendance_date, sampleStatus: s.status,
    };
  }, [records, employees]);

  // Include ALL active staff — not just those with records this
  // month. Staff on long-term leave or new hires who haven't been
  // in any time-card upload yet would otherwise disappear from the
  // grid, making the count diverge from the directory and from the
  // export report. Showing them with empty cells (or leave-seeded
  // chips) keeps the on-screen view authoritative.
  const tracked = useMemo(() => {
    const all = (employees || [])
      .filter(e => e?.id && !e.terminated && e.is_active !== false && e.status !== 'inactive')
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(e => {
      const haystack = [
        e.name, e.id, e.department, e.location,
        e.designation, e.email,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [employees, search]);

  // Total tracked count (before search filter) — all active staff in
  // the directory. Used in the result counter when search is active.
  const trackedTotalCount = useMemo(() => {
    return (employees || []).filter(e =>
      e?.id && !e.terminated && e.is_active !== false && e.status !== 'inactive'
    ).length;
  }, [employees]);

  function nav(delta) {
    let m = month + delta;
    let y = year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0;  y += 1; }
    setMonth(m);
    setYear(y);
  }

  const monthLabel = firstDay.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const todayStr = todayYmd();

  // ─── Row stats — present/absent/leave counts per employee ────────
  const statsByEmp = useMemo(() => {
    const m = new Map();
    records.forEach(r => {
      const cur = m.get(r.employee_id) || { present: 0, late: 0, short: 0, absent: 0, leave: 0, off: 0 };
      if (r.status === 'present') cur.present++;
      else if (r.status === 'late') cur.late++;
      else if (r.status === 'short') cur.short++;
      else if (r.status === 'absent') cur.absent++;
      else if (r.status === 'annual_leave' || r.status === 'sick_leave'
            || r.status === 'maternity_leave' || r.status === 'paternity_leave'
            || r.status === 'hajj_leave' || r.status === 'emergency_leave'
            || r.status === 'unpaid_leave') cur.leave++;
      else if (r.status === 'off_day' || r.status === 'off_roster') cur.off++;
      m.set(r.employee_id, cur);
    });
    return m;
  }, [records]);

  // ─── Hover-tooltip handlers ──────────────────────────────────────
  const handleEnter = useCallback((e, payload) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHoverTip({
      x: rect.left + rect.width / 2,
      yTop: rect.top, yBottom: rect.bottom,
      ...payload,
    });
  }, []);
  const handleLeave = useCallback(() => setHoverTip(null), []);

  return (
    <div className="rounded-2xl border bg-white p-3 sm:px-4 sm:py-3" style={{ borderColor: '#D4D4D4' }}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
        <div>
          <div className="flex items-baseline gap-3">
            <span style={{
              fontFamily: 'inherit',
              fontSize: 22,
              fontWeight: 700,
              color: '#1F1B16',
              letterSpacing: '-0.01em',
            }}>
              {monthLabel}
            </span>
            <span className="text-[10px]" style={{ color: '#7A7A7A', letterSpacing: '0.18em', fontWeight: 700, textTransform: 'uppercase' }}>
              Monthly attendance
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap" style={{ flex: '1 1 auto', justifyContent: 'flex-end' }}>
          {/* Search box — inline with title bar nav. Has clear border
              so it visually reads as a search input. */}
          {trackedTotalCount > 0 && (
            <div
              style={{
                position: 'relative',
                flex: '0 1 280px',
                minWidth: 200,
              }}
            >
              <Search
                className="w-3.5 h-3.5"
                style={{
                  position: 'absolute',
                  left: 10, top: '50%',
                  transform: 'translateY(-50%)',
                  color: '#0A0A0A',
                  opacity: 0.5,
                  pointerEvents: 'none',
                }}
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, PSN, department…"
                aria-label="Search staff in monthly attendance"
                style={{
                  width: '100%',
                  padding: '6px 30px 6px 30px',
                  border: '1.5px solid #C7C2B6',
                  borderRadius: 8,
                  fontSize: 12,
                  fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
                  background: '#FFFFFF',
                  color: '#1F1B16',
                  outline: 'none',
                }}
                onFocus={(e) => { e.target.style.borderColor = '#0F4C2A'; }}
                onBlur={(e) => { e.target.style.borderColor = '#C7C2B6'; }}
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  style={{
                    position: 'absolute',
                    right: 4, top: '50%',
                    transform: 'translateY(-50%)',
                    width: 22, height: 22,
                    borderRadius: 999,
                    border: 'none',
                    background: '#F5F5F5',
                    color: '#0A0A0A',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
          {/* Staff count — inline with search/nav. */}
          {trackedTotalCount > 0 && (
            <div className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7, fontWeight: 500, whiteSpace: 'nowrap' }}>
              {search
                ? `${tracked.length} / ${trackedTotalCount}`
                : `${trackedTotalCount} staff`}
            </div>
          )}
          <button
            onClick={() => nav(-1)}
            className="w-8 h-8 rounded-full inline-flex items-center justify-center"
            style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#0A0A0A', cursor: 'pointer' }}
            aria-label="Previous month"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => { setMonth(today.getMonth()); setYear(today.getFullYear()); }}
            className="text-[11px] px-3 py-1.5 rounded-full"
            style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#0A0A0A', cursor: 'pointer', fontWeight: 600 }}
          >
            Today
          </button>
          <button
            onClick={() => nav(1)}
            className="w-8 h-8 rounded-full inline-flex items-center justify-center"
            style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#0A0A0A', cursor: 'pointer' }}
            aria-label="Next month"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={refetch}
            className="w-8 h-8 rounded-full inline-flex items-center justify-center"
            style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#0A0A0A', cursor: 'pointer' }}
            aria-label="Refresh"
            title="Refresh"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin"/> : <RefreshCcw className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Fetch diagnostic — surfaces what the attendance_daily read
          actually returned so an empty grid is never a silent mystery.
          Shows the error in red if the read failed, otherwise the row
          count + the exact date range queried. */}
      {fetchErr ? (
        <div className="text-[11px] mb-2 px-2 py-1 rounded"
             style={{ background: '#FEF2F2', color: '#991B1B', border: '1px solid #FCA5A5' }}>
          Couldn’t load attendance for {ymd(firstDay)} → {ymd(lastDay)}: {fetchErr}
        </div>
      ) : lastCount != null && (
        <div className="text-[11px] mb-2" style={{ color: '#0A0A0A', opacity: 0.7 }}>
          {lastCount} record{lastCount === 1 ? '' : 's'} loaded for {ymd(firstDay)} → {ymd(lastDay)}
          {recordDiag && (
            <span style={{ color: recordDiag.matched === 0 && recordDiag.total > 0 ? '#991B1B' : 'inherit' }}>
              {' · '}{recordDiag.matched}/{recordDiag.total} match a known employee
              {' · sample: '}{recordDiag.sampleId} / {recordDiag.sampleDate} / {recordDiag.sampleStatus}
            </span>
          )}
        </div>
      )}


      {/* When search filters out everything, show a dedicated empty
          state so Bashaier doesn't see a blank canvas. The "no records
          this month" empty state below handles the unfiltered case. */}
      {trackedTotalCount > 0 && tracked.length === 0 && search ? (
        <div className="text-center py-8" style={{ color: '#0A0A0A', opacity: 0.55 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>No staff match &ldquo;{search}&rdquo;.</div>
          <button
            onClick={() => setSearch('')}
            className="text-[11px] mt-2 px-3 py-1.5 rounded-full"
            style={{
              background: '#FFFFFF',
              color: '#1F1B16',
              border: '1px solid #D4D4D4',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
            }}
          >
            Clear search
          </button>
        </div>
      ) : null}

      {trackedTotalCount === 0 ? (
        <div className="text-center py-10" style={{ color: '#0A0A0A', opacity: 0.5 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>No attendance records yet for {monthLabel}.</div>
          <div className="text-xs mt-1">Upload an attendance file above and the calendar will start filling in.</div>
        </div>
      ) : tracked.length === 0 ? null : (
        <>
        {/* Legend — sits above the grid in a single horizontal line.
            Set to nowrap so all items stay on one row; if the viewport
            is too narrow, horizontal scroll appears (cleaner than
            wrapping into multiple rows). */}
        <div className="text-[11px] mb-2 flex gap-2 items-center"
          style={{
            color: '#0A0A0A',
            padding: '8px 12px',
            background: '#FAFAF9',
            border: '1px solid #EEEAE0',
            borderRadius: 8,
            overflowX: 'auto',
            whiteSpace: 'nowrap',
            flexWrap: 'nowrap',
          }}>
          {[
            { st: 'present',      lbl: 'Present' },
            { st: 'present',      lbl: 'Late — permitted', overrideStyle: { bg: '#EFF6FF', fg: '#1E40AF', border: '#93C5FD', label: '✓LP' } },
            { st: 'present',      lbl: 'Early — permitted', overrideStyle: { bg: '#EFF6FF', fg: '#1E40AF', border: '#93C5FD', label: '✓EP' } },
            { st: 'late',         lbl: 'Late' },
            { st: 'short',        lbl: 'Short' },
            { st: 'absent',       lbl: 'Absent' },
            { st: 'annual_leave', lbl: 'Annual leave' },
            { st: 'sick_leave',   lbl: 'Sick leave' },
            { st: 'maternity_leave', lbl: 'Maternity' },
            { st: 'paternity_leave', lbl: 'Paternity' },
            { st: 'hajj_leave',      lbl: 'Hajj' },
            { st: 'emergency_leave', lbl: 'Emergency' },
            { st: 'unpaid_leave',    lbl: 'Unpaid' },
            { st: 'off_roster',   lbl: 'Off-roster' },
            { st: 'off_day',      lbl: 'Off-day' },
            { st: 'present',      lbl: 'Shift day', overrideStyle: { bg: '#F8FAFC', fg: '#1F2937', border: '#CBD5E1', label: '🌙' } },
          ].map(({ st, lbl, overrideStyle }, idx) => {
            const sty = overrideStyle || styleForStatus(st);
            return (
              <span key={`${st}-${idx}`} className="inline-flex items-center gap-1" style={{ flex: '0 0 auto' }}>
                <span style={{
                  background: sty.bg,
                  color: sty.fg,
                  border: `1px solid ${sty.border}`,
                  borderRadius: 3,
                  fontSize: 9,
                  padding: '1px 5px',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                }}>{sty.label}</span>
                <span style={{ fontSize: 10, color: '#0A0A0A' }}>{lbl}</span>
              </span>
            );
          })}
        </div>
        <div style={{ overflowX: 'visible', maxWidth: '100%', boxSizing: 'border-box' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `190px repeat(${days.length}, minmax(0, 1fr))`,
            gap: 3,
            width: '100%',
            boxSizing: 'border-box',
          }}>
            {/* Header */}
            <div style={{ background: '#FAFAFA', padding: '6px 8px', fontSize: 10, fontWeight: 700, color: '#0A0A0A', letterSpacing: '0.05em' }}>
              EMPLOYEE
            </div>
            {days.map(d => {
              const dStr = ymd(d);
              const dow = d.getDay();
              const isWeekend = dow === 5 || dow === 6;
              const isToday = dStr === todayStr;
              return (
                <div
                  key={dStr}
                  style={{
                    background: isToday
                      ? 'rgba(15,76,42,0.10)'
                      : isWeekend
                        ? '#FEF3C7'  // amber-50 — clearly distinguishable from working days
                        : '#FAFAFA',
                    padding: '4px 0',
                    fontSize: 9,
                    fontWeight: 700,
                    color: isWeekend ? '#854F0B' : '#0A0A0A',
                    textAlign: 'center',
                    borderTop: isToday ? '2px solid #0F4C2A' : (isWeekend ? '2px solid #FCD34D' : '1px solid transparent'),
                    borderBottom: isWeekend ? '1px solid #FCD34D' : 'none',
                  }}
                >
                  <div style={{ fontSize: 8, opacity: isWeekend ? 0.95 : 0.6, fontWeight: isWeekend ? 700 : 600, letterSpacing: isWeekend ? '0.05em' : 0 }}>
                    {['Su','Mo','Tu','We','Th','Fr','Sa'][dow]}
                  </div>
                  <div>{d.getDate()}</div>
                </div>
              );
            })}

            {/* Body — one row per employee */}
            {tracked.map(emp => {
              const stats = statsByEmp.get(emp.id) || {};
              return (
                <React.Fragment key={emp.id}>
                  <button
                    type="button"
                    onClick={onEmployeeClick ? () => onEmployeeClick(emp) : undefined}
                    disabled={!onEmployeeClick}
                    title={onEmployeeClick ? `Open ${emp.name || emp.id}'s attendance detail` : (emp.name || emp.id)}
                    style={{
                      background: '#FFFFFF',
                      padding: '6px 8px',
                      borderTop: '1px solid var(--border-soft, #EFEFEF)',
                      borderRight: 'none', borderLeft: 'none', borderBottom: 'none',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'center',
                      textAlign: 'left',
                      cursor: onEmployeeClick ? 'pointer' : 'default',
                      transition: 'background 0.15s ease',
                      width: '100%',
                    }}
                    onMouseEnter={(e) => {
                      if (onEmployeeClick) e.currentTarget.style.background = '#F8F8F4';
                    }}
                    onMouseLeave={(e) => {
                      if (onEmployeeClick) e.currentTarget.style.background = '#FFFFFF';
                    }}
                  >
                    <FitText
                      text={emp.name || emp.id}
                      style={{
                        fontWeight: 600,
                        color: '#0A0A0A',
                        lineHeight: 1.2,
                        textDecoration: onEmployeeClick ? 'underline' : 'none',
                        textDecorationColor: 'rgba(15,76,42,0.25)',
                        textUnderlineOffset: 2,
                      }}
                    />
                    <div style={{ fontSize: 9, color: '#0A0A0A', opacity: 0.6, marginTop: 1 }}>
                      {emp.id} · {emp.department || '—'}
                    </div>
                    <div style={{ fontSize: 9, color: '#0A0A0A', opacity: 0.7, marginTop: 2, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {stats.present > 0 && <span style={{ color: '#0F4C2A' }}>✓{stats.present}</span>}
                      {stats.late    > 0 && <span style={{ color: '#854F0B' }}>LT{stats.late}</span>}
                      {stats.short   > 0 && <span style={{ color: '#7C2D12' }}>SH{stats.short}</span>}
                      {stats.absent  > 0 && <span style={{ color: '#991B1B' }}>AB{stats.absent}</span>}
                      {stats.leave   > 0 && <span style={{ color: '#115E59' }}>LV{stats.leave}</span>}
                    </div>
                  </button>
                  {days.map(d => {
                    const dStr = ymd(d);
                    const dow = d.getDay();
                    const isWeekend = dow === 5 || dow === 6;
                    const isToday = dStr === todayStr;
                    const isFuture = dStr > todayStr;
                    const r = recordIndex.get(`${emp.id}|${dStr}`);
                    const cellBg = isToday ? 'rgba(15,76,42,0.04)'
                                 : isFuture ? '#FAFAFA'
                                 : isWeekend ? '#FEF8E1' : 'transparent';
                    if (!r) {
                      return (
                        <div
                          key={dStr}
                          style={{
                            background: cellBg,
                            borderTop: '1px solid var(--border-soft, #EFEFEF)',
                            borderLeft: '1px solid var(--border-soft, #EFEFEF)',
                          }}
                        />
                      );
                    }
                    const sty = styleForStatus(r.status, r.notes);
                    // Missed-punch indicator — small magenta dot on the
                    // chip when first or last punch is missing. Same
                    // visual language as the tooltip's ⚠ marker.
                    const hasFirst = !!r.first_punch;
                    const hasLast  = !!r.last_punch;
                    const missedPunch = (hasFirst && !hasLast) || (!hasFirst && hasLast);
                    // Shift-day indicator — moon icon shown alongside
                    // the status chip when this row was evaluated
                    // against a manager-assigned shift schedule (the
                    // notes carry the "Shift (HH:MM-HH:MM)" or
                    // "Overnight Shift (...)" marker the backfill
                    // stamps). Per Nadeem (2026-05-06): staff assigned
                    // a shift during the month should have a small 🌙
                    // alongside their daily status chip.
                    const isShiftDay = typeof r.notes === 'string' &&
                      /(?:^|\s)(?:Overnight\s+)?Shift\s*\(\d{2}:\d{2}-\d{2}:\d{2}\)/i.test(r.notes);
                    return (
                      <div
                        key={dStr}
                        style={{
                          background: cellBg,
                          borderTop: '1px solid var(--border-soft, #EFEFEF)',
                          borderLeft: '1px solid var(--border-soft, #EFEFEF)',
                          padding: '5px 4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                        onMouseEnter={(e) => handleEnter(e, { record: r, employee: emp, dateStr: dStr, weekday: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow] })}
                        onMouseLeave={handleLeave}
                      >
                        <div
                          style={{
                            position: 'relative',
                            background: sty.bg,
                            color: sty.fg,
                            border: `1px solid ${sty.border}`,
                            borderRadius: 4,
                            width: '100%',
                            minHeight: 28,
                            padding: '3px 3px',
                            fontSize: 10,
                            fontWeight: 700,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 2,
                            letterSpacing: '0.02em',
                            cursor: 'default',
                          }}
                        >
                          {sty.label}
                          {isShiftDay && (
                            <span
                              aria-hidden
                              title="Shift day"
                              style={{
                                marginLeft: 1,
                                fontSize: 10,
                                lineHeight: 1,
                              }}
                            >🌙</span>
                          )}
                          {missedPunch && (
                            <span
                              aria-hidden
                              style={{
                                position: 'absolute',
                                top: 1,
                                right: 1,
                                width: 6,
                                height: 6,
                                borderRadius: 999,
                                background: '#C026D3',
                                boxShadow: '0 0 0 1.5px ' + sty.bg,
                              }}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </div>
        </div>
        </>
      )}

      {/* Hover tooltip */}
      {hoverTip && <HoverTooltip {...hoverTip} />}
    </div>
  );
}

// ─── Hover-tooltip panel ─────────────────────────────────────────────
function HoverTooltip({ x, yTop, yBottom, record, employee, dateStr, weekday }) {
  // Position above the cell when there's room, otherwise below
  const flipBelow = yTop < 140;
  const sty = styleForStatus(record.status, record.notes);
  const label = readableStatus(record.status);
  const punch = (record.first_punch || record.last_punch)
    ? `${record.first_punch ? record.first_punch.slice(0,5) : '—'} → ${record.last_punch ? record.last_punch.slice(0,5) : '—'}`
    : null;
  const sched = (record.expected_start || record.expected_end)
    ? `Scheduled ${record.expected_start ? record.expected_start.slice(0,5) : '?'}–${record.expected_end ? record.expected_end.slice(0,5) : '?'}`
    : null;

  const minutesLine = record.late_minutes > 0
    ? `${record.late_minutes} min late`
    : record.early_leave_minutes > 0
      ? `Left ${record.early_leave_minutes} min early`
      : null;

  // Permission-coverage line — shown when the row was downgraded
  // from late/short to present because an approved permission
  // covered the punch. The blue chip on the cell uses the LP/EP
  // label; the tooltip explains it in words.
  const isLatePermitted  = typeof record.notes === 'string' && /late arrival covered by approved permission/i.test(record.notes);
  const isEarlyPermitted = typeof record.notes === 'string' && /early leave covered by approved permission/i.test(record.notes);
  const coveredLine = isLatePermitted
    ? 'Late arrival — covered by approved permission'
    : isEarlyPermitted
      ? 'Early leave — covered by approved permission'
      : null;
  // Shift-day indicator on the tooltip — extracts the schedule
  // label from the notes so HR can see exactly which shift was
  // assigned ("Shift (20:00-05:00)") on hover.
  const shiftMatch = typeof record.notes === 'string'
    ? record.notes.match(/(?:Overnight\s+)?Shift\s*\((\d{2}:\d{2}-\d{2}:\d{2})\)/i)
    : null;
  const shiftLine = shiftMatch ? `🌙 Shift day — ${shiftMatch[1]}` : null;

  // Detect missing punches — surfaces the data-quality issue clearly
  // rather than hiding it inside the notes field. A row is "missed
  // in" if it has a last_punch but no first_punch (staff left, but
  // we don't have proof of arrival time), and "missed out" the
  // converse.
  const hasFirst = !!record.first_punch;
  const hasLast  = !!record.last_punch;
  const missedLine = (!hasFirst && hasLast)
    ? 'No clock-in recorded'
    : (hasFirst && !hasLast)
      ? 'No clock-out recorded'
      : null;

  const style = {
    position: 'fixed',
    left: x,
    top: flipBelow ? yBottom + 6 : yTop - 6,
    transform: flipBelow ? 'translateX(-50%)' : 'translate(-50%, -100%)',
    zIndex: 60,
    background: '#1F1B16',
    color: '#FFFFFF',
    padding: '8px 10px',
    borderRadius: 8,
    fontSize: 11,
    minWidth: 180,
    maxWidth: 260,
    boxShadow: '0 10px 24px rgba(0,0,0,0.25)',
    pointerEvents: 'none',
  };
  return (
    <div style={style}>
      <div style={{ fontSize: 9, opacity: 0.7, letterSpacing: '0.06em' }}>{(employee?.id || '').toString()}</div>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2 }}>{employee?.name || record.employee_id}</div>
      <div style={{ fontSize: 10, opacity: 0.85, marginBottom: 4 }}>{weekday}, {dateStr}</div>
      <div style={{ display: 'inline-block', background: sty.bg, color: sty.fg, border: `1px solid ${sty.border}`, padding: '1px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700, letterSpacing: '0.04em', marginBottom: 4 }}>
        {label.toUpperCase()}
      </div>
      {punch && <div style={{ fontSize: 10.5 }}>Punched: {punch}</div>}
      {sched && <div style={{ fontSize: 10.5, opacity: 0.85 }}>{sched}</div>}
      {missedLine && <div style={{ fontSize: 10.5, color: '#F0ABFC', marginTop: 2, fontWeight: 700 }}>⚠ {missedLine}</div>}
      {minutesLine && <div style={{ fontSize: 10.5, color: '#FCD34D', marginTop: 2 }}>{minutesLine}</div>}
      {coveredLine && <div style={{ fontSize: 10.5, color: '#93C5FD', marginTop: 2, fontWeight: 700 }}>✓ {coveredLine}</div>}
      {shiftLine && <div style={{ fontSize: 10.5, color: '#CBD5E1', marginTop: 2, fontWeight: 600 }}>{shiftLine}</div>}
      {record.notes && <div style={{ fontSize: 10, opacity: 0.85, marginTop: 4, fontStyle: 'italic' }}>{record.notes}</div>}
    </div>
  );
}
