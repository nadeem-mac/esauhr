import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Calendar as CalIcon } from 'lucide-react';
import { directGet, supabase } from '../supabaseClient.js';

// ─────────────────────────────────────────────────────────────────────────────
// ShiftMonthGrid
//
// Shared "who's on shift this month" matrix used by three role-specific cards:
//
//   • TeamShiftMonthCard    — manager view, scoped to direct reports
//   • MyShiftMonthCard      — staff view, scoped to themselves
//   • HrShiftMonthCard      — HR / Bashaier view, every employee with shifts
//                              this month, grouped by location
//
// Layout: rows = employees, columns = days of the visible month. Each cell
// is a colored chip whose background encodes status, with a short label
// (9-5, 8-4, N for night, or HH-HH for custom). Sticky first column keeps
// the staff name visible while scrolling horizontally; sticky header row
// keeps the day-of-month visible while scrolling vertically. Today's
// column gets a faint green highlight, KSA weekend (Fri/Sat) gets a
// light beige tint.
//
// Realtime: subscribes to employee_shifts changes (no row filter — the
// table is small and Supabase free-tier realtime budgets are generous
// enough). Refetch debounced to once per 800ms.
//
// Status → color:
//   pending                                → amber
//   accepted, notified_hr_at IS NULL       → light green (waiting SUP)
//   accepted, notified_hr_at IS NOT NULL   → dark green  (approved by SUP)
//   declined                               → red
// ─────────────────────────────────────────────────────────────────────────────

const DOW_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// Format the chip label. Two preset shorthands match the editor's
// "9 – 5" and "8 – 4" preset chips so the visual continuity is
// preserved from the manager picking a preset to the staff/HR seeing
// the chip. Overnight shifts (start > end, e.g. 23:00 → 07:00) show
// the arrow instead of a hyphen so the next-day end is visually
// distinct. Everything else falls through to "Hs-He" with no leading
// zero.
//
// The previous 'N' shorthand was retired — it was self-descriptive
// only if you knew the convention, which Nadeem rightly flagged.
// Numbers are always more legible.
function formatChipLabel(start, end) {
  if (!start || !end) return '';
  if (start === '09:00' && end === '17:00') return '9-5';
  if (start === '08:00' && end === '16:00') return '8-4';
  const sh = parseInt(start.slice(0, 2), 10);
  const eh = parseInt(end.slice(0, 2), 10);
  if (start > end) return `${sh}\u2192${eh}`; // overnight: e.g. "23→7"
  return `${sh}-${eh}`;
}

// Map status → style. Per Nadeem: shift acknowledgment is between
// the manager and the staff member directly — no SUP / HR approval
// step. Once staff accepts, the shift is final and locked. Status
// colours collapse to three:
//
//   pending   → amber   (waiting on staff acknowledgment)
//   accepted  → green   (final, locked, cross-referenced to attendance)
//   declined  → red
//
// The previous "approved by SUP" dark-green state is gone; older
// rows that may still have notified_hr_at populated render exactly
// the same as a fresh accepted row — the column is now ignored
// downstream.
function chipStyle(status) {
  if (status === 'declined') {
    return { background: '#FCEBEB', border: '1px solid #A32D2D', color: '#791F1F' };
  }
  if (status === 'accepted') {
    // Solid brand green — the strong, unmistakable "this shift is
    // final" treatment Nadeem asked for. Equivalent prominence to
    // the old SUP-approved chip, applied at the staff-acknowledged
    // step instead.
    return { background: '#0F4C2A', border: '1px solid #0F4C2A', color: '#FFFFFF' };
  }
  // pending or anything else — amber
  return { background: '#FAEEDA', border: '1px solid #BA7517', color: '#854F0B' };
}

// Local YYYY-MM-DD without UTC drift
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function todayYmd() { return ymd(new Date()); }

export default function ShiftMonthGrid({
  // Required
  me,
  employees,            // Array of {id, name, department, location} — rows to render
  // Optional behavior
  groupByLocation = false,
  onEmployeeClick = null, // (employee) => void — when a row name is clicked
  // Card chrome
  title = 'Shift schedule',
  subtitle = '',
  kicker = 'SHIFTS',
  actionSlot = null,    // JSX rendered top-right (e.g. "Set new shifts" link)
  hideEmptyRows = false, // if true, employees with no shift this month are hidden
}) {
  const today = useMemo(() => new Date(), []);
  const [year, setYear]   = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0-indexed
  const [shifts, setShifts] = useState([]);
  // Off-pattern map: employeeId → Set<weekday-number 0-6>. Built from
  // monthly_shift_plans rows for the visible month. Used by the
  // calendar render to show OFF cells with a distinct blue tint on
  // the manager-marked off-days, even on dates with no shift.
  const [offPatternByEmp, setOffPatternByEmp] = useState(() => new Map());
  const [loading, setLoading] = useState(false);

  // Hover-tooltip state. Tracks the currently-hovered shift cell + its
  // viewport coordinates so a richer tooltip can render at fixed
  // position above (or below, if near the top) the cell. Clears on
  // mouse-leave. The browser-native title= attribute remains on the
  // cell as accessibility fallback for screen readers and contexts
  // where hover doesn't fire (touch, focus-only navigation).
  const [hoverTip, setHoverTip] = useState(null);
  const handleCellEnter = useCallback((e, payload) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHoverTip({
      x: rect.left + rect.width / 2,
      yTop:    rect.top,
      yBottom: rect.bottom,
      ...payload,
    });
  }, []);
  const handleCellLeave = useCallback(() => setHoverTip(null), []);

  // Month bounds in local YYYY-MM-DD
  const firstDay = useMemo(() => new Date(year, month, 1), [year, month]);
  const lastDay  = useMemo(() => new Date(year, month + 1, 0), [year, month]);
  const days = useMemo(() => {
    const arr = [];
    const totalDays = lastDay.getDate();
    for (let d = 1; d <= totalDays; d++) arr.push(new Date(year, month, d));
    return arr;
  }, [year, month, lastDay]);

  // Fetch shifts for the visible month, scoped to the employees prop.
  // Uses an `employee_id=in.(id1,id2,...)` filter for the team/staff
  // case, and an unfiltered query for the HR full-fleet case (when
  // `employees` is the global directory the call still runs through
  // the `in` filter — its size is bounded by the company headcount).
  const refetch = useCallback(async () => {
    if (!employees || !employees.length) {
      setShifts([]);
      setOffPatternByEmp(new Map());
      return;
    }
    setLoading(true);
    try {
      const ids = employees.map(e => e.id).join(',');
      const data = await directGet(
        'employee_shifts',
        `select=id,employee_id,shift_date,start_time,end_time,status,set_by` +
        `&shift_date=gte.${ymd(firstDay)}&shift_date=lte.${ymd(lastDay)}` +
        `&employee_id=in.(${encodeURIComponent(ids)})` +
        `&order=shift_date.asc`,
        { timeoutMs: 9000 }
      );
      setShifts(data || []);

      // Fetch the off-pattern for the same employees and the visible
      // month from monthly_shift_plans. The tracker is keyed by
      // (manager_id, employee_id, plan_month) — there can be multiple
      // rows per employee if they've ever changed manager. We just
      // pick the most recent row per employee_id, since the off-
      // pattern is "current" for that employee at this point.
      try {
        const planMonthKey = ymd(firstDay);
        const trackerRows = await directGet(
          'monthly_shift_plans',
          `select=employee_id,off_weekdays,last_committed_at` +
          `&plan_month=eq.${planMonthKey}` +
          `&employee_id=in.(${encodeURIComponent(ids)})` +
          `&order=last_committed_at.desc`,
          { timeoutMs: 6000 }
        );
        const m = new Map();
        (trackerRows || []).forEach(r => {
          if (!r?.employee_id) return;
          // Most recent first via the order=last_committed_at.desc — only
          // set if not already present so we keep the latest per employee.
          if (m.has(r.employee_id)) return;
          if (Array.isArray(r.off_weekdays) && r.off_weekdays.length > 0) {
            m.set(r.employee_id, new Set(r.off_weekdays));
          } else {
            m.set(r.employee_id, new Set());
          }
        });
        setOffPatternByEmp(m);
      } catch {
        // Off-pattern fetch failure is non-fatal — grid still renders
        // shifts, just without the OFF cells.
        setOffPatternByEmp(new Map());
      }
    } catch {
      setShifts([]);
      setOffPatternByEmp(new Map());
    } finally {
      setLoading(false);
    }
  }, [employees, firstDay, lastDay]);
  useEffect(() => { refetch(); }, [refetch]);

  // Realtime — debounced to 800ms so a burst of upserts (manager saving
  // a week of shifts at once) only triggers one refetch. Filter is
  // intentionally absent: row-level filtering on Supabase realtime
  // requires the column to be a single value, and we want all changes
  // anywhere in the visible window.
  const debounceRef = useRef(null);
  useEffect(() => {
    if (!supabase) return;
    const trigger = () => {
      if (debounceRef.current) return;
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        refetch();
      }, 800);
    };
    const ch = supabase
      .channel('shift-month-grid')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'employee_shifts' },
        () => trigger()
      )
      // Also listen on monthly_shift_plans so when a manager toggles
      // an off-day pattern in the planner and saves, every open
      // ShiftMonthGrid (Bashaier's HR view, the manager's team view,
      // a staff member's own view) refreshes its OFF cells live.
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'monthly_shift_plans' },
        () => trigger()
      )
      .subscribe();
    return () => {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      try { supabase.removeChannel(ch); } catch {}
    };
  }, [refetch]);

  // Index shifts by (employee_id, shift_date) for O(1) lookup during render
  const shiftIndex = useMemo(() => {
    const idx = new Map();
    shifts.forEach(s => {
      idx.set(`${s.employee_id}|${s.shift_date}`, s);
    });
    return idx;
  }, [shifts]);

  // Optionally group employees by location for HR view. Keeps insertion
  // order stable by sorting locations alphabetically and employees
  // within each location alphabetically by name. When hideEmptyRows is
  // set, employees with no shift in the visible month are dropped — used
  // by the HR full-fleet card so it shows only the "actually scheduled"
  // subset rather than every directory row.
  const grouped = useMemo(() => {
    let pool = employees || [];
    if (hideEmptyRows) {
      const haveShift = new Set(shifts.map(s => s.employee_id));
      pool = pool.filter(e => haveShift.has(e.id));
    }
    if (!groupByLocation) {
      return [{ location: null, employees: pool }];
    }
    const map = new Map();
    pool.forEach(e => {
      const loc = e.location || '\u2014';
      if (!map.has(loc)) map.set(loc, []);
      map.get(loc).push(e);
    });
    const sortedLocs = [...map.keys()].sort();
    return sortedLocs.map(loc => ({
      location: loc,
      employees: [...map.get(loc)].sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''))
      ),
    }));
  }, [employees, groupByLocation, hideEmptyRows, shifts]);

  const monthLabel = firstDay.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const todayStr = todayYmd();

  // Nav handlers
  const goPrev = () => {
    const m = month - 1;
    if (m < 0) { setYear(y => y - 1); setMonth(11); } else { setMonth(m); }
  };
  const goNext = () => {
    const m = month + 1;
    if (m > 11) { setYear(y => y + 1); setMonth(0); } else { setMonth(m); }
  };
  const goToday = () => { setYear(today.getFullYear()); setMonth(today.getMonth()); };

  const totalShiftsThisMonth = shifts.length;

  // Header column count = day count (matches days.length). Day-cell width
  // is a fixed 32px so the grid is predictably wide; the wrapping
  // overflow-x: auto handles narrow viewports.
  const dayColTpl = `repeat(${days.length}, 32px)`;
  const gridTpl   = `180px ${dayColTpl}`;

  return (
    <section className="rounded-2xl border bg-white p-3 sm:p-5"
      style={{ borderColor: 'var(--border, #E5E5E5)', background: 'var(--paper, #FFFFFF)' }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <div className="text-[10px] mb-1" style={{ color: '#0A0A0A', letterSpacing: '0.25em', fontWeight: 700 }}>
            {kicker}
          </div>
          <div style={{ fontFamily: 'inherit', fontSize: '20px', color: '#0A0A0A' }}>
            {title}
          </div>
          {subtitle && (
            <div className="text-xs mt-1" style={{ color: '#0A0A0A', opacity: 0.75 }}>
              {subtitle}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {actionSlot}
          <div className="flex items-center gap-1 rounded-lg border" style={{ borderColor: 'var(--border, #E5E5E5)' }}>
            <button onClick={goPrev}
              className="p-1.5 hover:opacity-70 transition-opacity"
              style={{ color: '#0A0A0A' }}
              title="Previous month"
              type="button"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button onClick={goToday}
              className="px-2 text-xs"
              style={{ color: '#0A0A0A', fontWeight: 600, minWidth: 110, textAlign: 'center' }}
              title="Jump to current month"
              type="button"
            >
              {monthLabel}
            </button>
            <button onClick={goNext}
              className="p-1.5 hover:opacity-70 transition-opacity"
              style={{ color: '#0A0A0A' }}
              title="Next month"
              type="button"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-3 text-[11px]" style={{ color: '#0A0A0A' }}>
        <span className="inline-flex items-center gap-1.5">
          <span style={{ width: 10, height: 10, background: '#FAEEDA', border: '1px solid #BA7517', borderRadius: 2, display: 'inline-block' }}></span>
          Pending acknowledgment
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span style={{ width: 10, height: 10, background: '#0F4C2A', border: '1px solid #0F4C2A', borderRadius: 2, display: 'inline-block' }}></span>
          Accepted &amp; locked
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span style={{ width: 10, height: 10, background: '#FCEBEB', border: '1px solid #A32D2D', borderRadius: 2, display: 'inline-block' }}></span>
          Declined
        </span>
      </div>

      {(() => {
        const hasAnyRows = grouped.some(g => g.employees.length > 0);
        if (!hasAnyRows && !loading) {
          return (
            <div className="rounded-xl p-8 text-center text-sm"
              style={{ background: 'var(--paper-2, #F7F7F7)', color: '#0A0A0A', opacity: 0.75 }}>
              <CalIcon className="w-5 h-5 inline-block mr-2" style={{ opacity: 0.5 }} />
              {hideEmptyRows
                ? `No shifts assigned in ${monthLabel}.`
                : 'No staff in scope for this month.'}
            </div>
          );
        }
        if (loading && !shifts.length) {
          return (
            <div className="flex justify-center items-center py-12">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: '#0F4C2A' }} />
            </div>
          );
        }
        return null;
      })()}

      {(() => {
        const hasAnyRows = grouped.some(g => g.employees.length > 0);
        if (!hasAnyRows) return null;
        return (
          <>
          <div className="rounded-lg border overflow-x-auto" style={{ borderColor: 'var(--border, #E5E5E5)', maxHeight: 520 }}>
            <div style={{ minWidth: `calc(180px + ${days.length} * 32px)` }}>
              {/* Sticky header row */}
              <div
                className="sticky top-0 z-10"
                style={{
                  display: 'grid',
                  gridTemplateColumns: gridTpl,
                  background: 'var(--paper-2, #F7F7F7)',
                  borderBottom: '1px solid var(--border, #E5E5E5)',
                }}
              >
                <div className="sticky left-0 z-20 px-3 py-2"
                  style={{
                    background: 'var(--paper-2, #F7F7F7)',
                    borderRight: '1px solid var(--border, #E5E5E5)',
                    fontSize: 10,
                    color: '#0A0A0A',
                    fontWeight: 700,
                    letterSpacing: '0.2em',
                  }}>
                  STAFF
                </div>
                {days.map(d => {
                  const dow = d.getDay();
                  const isWeekend = dow === 5 || dow === 6;
                  const dStr = ymd(d);
                  const isToday = dStr === todayStr;
                  return (
                    <div key={dStr}
                      className="text-center"
                      style={{
                        padding: '4px 0',
                        background: isToday ? 'rgba(15,76,42,0.08)' : (isWeekend ? '#F0F0F0' : 'transparent'),
                        fontSize: 10,
                      }}>
                      <div style={{
                        color: isToday ? '#0F4C2A' : '#0A0A0A',
                        opacity: isWeekend && !isToday ? 0.6 : 0.85,
                        fontWeight: isToday ? 700 : 500,
                      }}>
                        {DOW_SHORT[dow]}
                      </div>
                      <div style={{
                        fontSize: 12,
                        color: isToday ? '#0F4C2A' : '#0A0A0A',
                        fontWeight: isToday ? 700 : 500,
                        fontVariantNumeric: 'tabular-nums',
                      }}>
                        {d.getDate()}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Body — optionally grouped by location */}
              {grouped.map(({ location, employees: rows }) => (
                <React.Fragment key={location || 'flat'}>
                  {location && (
                    <div className="sticky left-0 z-10"
                      style={{
                        gridColumn: `1 / -1`,
                        padding: '6px 12px',
                        background: 'var(--paper-3, #EAEAEA)',
                        borderBottom: '1px solid var(--border, #E5E5E5)',
                        fontSize: 10,
                        color: '#0A0A0A',
                        fontWeight: 700,
                        letterSpacing: '0.2em',
                      }}>
                      {location.toUpperCase()} &middot; {rows.length} staff
                    </div>
                  )}
                  {rows.map(emp => (
                    <div key={emp.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: gridTpl,
                        borderBottom: '1px solid var(--border-soft, #F0F0F0)',
                      }}>
                      <button
                        type="button"
                        onClick={onEmployeeClick ? () => onEmployeeClick(emp) : undefined}
                        disabled={!onEmployeeClick}
                        className="sticky left-0 z-10 text-left flex items-center gap-2"
                        style={{
                          background: '#FFFFFF',
                          padding: '8px 10px',
                          borderRight: '1px solid var(--border, #E5E5E5)',
                          cursor: onEmployeeClick ? 'pointer' : 'default',
                        }}
                        title={onEmployeeClick ? `Open ${emp.name || emp.id}` : (emp.name || emp.id)}
                      >
                        <div className="rounded-full flex-none flex items-center justify-center"
                          style={{
                            width: 24, height: 24,
                            background: 'var(--paper-3, #EAEAEA)',
                            color: '#0A0A0A',
                            fontWeight: 700, fontSize: 10, letterSpacing: '0.04em',
                          }}>
                          {(() => {
                            const parts = String(emp.name || '').trim().split(/\s+/);
                            if (!parts[0]) return '?';
                            if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
                            return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
                          })()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs" style={{
                            color: '#0A0A0A',
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}>
                            {emp.name || emp.id}
                          </div>
                          <div className="text-[10px]" style={{
                            color: '#0A0A0A',
                            opacity: 0.65,
                            fontVariantNumeric: 'tabular-nums',
                            whiteSpace: 'nowrap',
                          }}>
                            {emp.id}{emp.department ? ' \u00B7 ' + emp.department : ''}
                          </div>
                        </div>
                      </button>
                      {days.map(d => {
                        const dStr = ymd(d);
                        const dow = d.getDay();
                        const isWeekend = dow === 5 || dow === 6;
                        const isToday = dStr === todayStr;
                        const s = shiftIndex.get(`${emp.id}|${dStr}`);
                        const cellBg = isToday ? 'rgba(15,76,42,0.04)' : (isWeekend ? '#F5F5F5' : 'transparent');
                        // Off-pattern check: this employee has a saved
                        // off-pattern AND this weekday is in it AND no
                        // shift exists for the date (shift wins). Used
                        // to render an OFF chip with a distinctive blue
                        // tint, matching the planner's off-day styling
                        // so the two surfaces look consistent.
                        const empOffSet = offPatternByEmp.get(emp.id);
                        const isOffPattern = !s && empOffSet && empOffSet.has(dow);
                        if (!s) {
                          if (isOffPattern) {
                            return (
                              <div
                                key={dStr}
                                style={{
                                  background: cellBg,
                                  borderLeft: '1px solid var(--border-soft, #EFEFEF)',
                                  padding: '3px 2px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                                title={`${emp.name || emp.id} \u2014 ${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}\nOff-day per the manager's weekly pattern`}
                              >
                                <div style={{
                                  background: '#EEF0FA',
                                  color: '#3B4279',
                                  border: '1px solid #C7CFE5',
                                  borderRadius: 4,
                                  width: '100%',
                                  minHeight: 22,
                                  fontSize: 9,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontWeight: 700,
                                  letterSpacing: '0.06em',
                                }}>
                                  OFF
                                </div>
                              </div>
                            );
                          }
                          return (
                            <div key={dStr}
                              style={{ background: cellBg, borderLeft: '1px solid var(--border-soft, #EFEFEF)' }}
                            />
                          );
                        }
                        const style = chipStyle(s.status);
                        const label = formatChipLabel(s.start_time, s.end_time);
                        const isAccepted = s.status === 'accepted';
                        const isOvernight = s.start_time && s.end_time && s.start_time > s.end_time;
                        const tooltipText =
                          `${emp.name || emp.id} \u2014 ${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}\n` +
                          `${s.start_time ? s.start_time.slice(0,5) : '?'} \u2192 ${s.end_time ? s.end_time.slice(0,5) : '?'}` +
                          (isOvernight ? ' (next day)' : '') + '\n' +
                          `${isOvernight ? 'Night shift (overnight) \u2014 ' : ''}${s.status}${isAccepted ? ' \u2014 acknowledged & locked' : ''}`;
                        return (
                          <div key={dStr}
                            style={{
                              background: cellBg,
                              borderLeft: '1px solid var(--border-soft, #EFEFEF)',
                              padding: '3px 2px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              // Highlight accepted days with a subtle glow + green
                              // tint behind the chip so the day stands out from
                              // pending/declined neighbours when the manager,
                              // staff or HR scans the row.
                              ...(isAccepted ? {
                                background: 'rgba(15, 76, 42, 0.10)',
                                boxShadow: 'inset 0 0 0 1px rgba(15, 76, 42, 0.20)',
                              } : {}),
                            }}
                            title={tooltipText}
                            onMouseEnter={(e) => handleCellEnter(e, {
                              empName: emp.name || emp.id,
                              empPsn:  emp.id,
                              dateStr: d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
                              startStr: s.start_time ? s.start_time.slice(0, 5) : '\u2014',
                              endStr:   s.end_time   ? s.end_time.slice(0, 5)   : '\u2014',
                              isOvernight,
                              status: s.status,
                              isAccepted,
                            })}
                            onMouseLeave={handleCellLeave}
                          >
                            <div style={{
                              ...style,
                              borderRadius: 4,
                              width: '100%',
                              minHeight: 22,
                              fontSize: 10,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontWeight: 600,
                              fontVariantNumeric: 'tabular-nums',
                            }}>
                              {label}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </React.Fragment>
              ))}
            </div>
          </div>
          <div className="text-[11px] mt-2 flex flex-wrap gap-3 items-center" style={{ color: '#0A0A0A', opacity: 0.8 }}>
            <span>{totalShiftsThisMonth} shift{totalShiftsThisMonth === 1 ? '' : 's'} in {monthLabel}</span>
            <span>&middot;</span>
            <span>Hover any cell for the full time range</span>
            <span>&middot;</span>
            <span>Fri/Sat shaded as KSA weekend</span>
            <span>&middot;</span>
            <span>Arrow (&rarr;) indicates an overnight shift</span>
            <span>&middot;</span>
            <span className="inline-flex items-center gap-1">
              <span style={{
                background: '#EEF0FA',
                color: '#3B4279',
                border: '1px solid #C7CFE5',
                borderRadius: 3,
                fontSize: 9,
                padding: '1px 5px',
                fontWeight: 700,
                letterSpacing: '0.06em',
              }}>OFF</span>
              = manager-marked off-day
            </span>
          </div>
        </>
        );
      })()}

      {/* Rich hover tooltip — anchored to the hovered cell. Positioned
          fixed so it can escape the grid's overflow-x: auto clipping.
          Auto-flips below the cell when the cell is near the top of
          the viewport so the tooltip never gets pushed off-screen. */}
      {hoverTip && (() => {
        const flipBelow = hoverTip.yTop < 180;
        const tipPosStyle = flipBelow
          ? { top: hoverTip.yBottom + 6, transform: 'translateX(-50%)' }
          : { top: hoverTip.yTop - 6,    transform: 'translate(-50%, -100%)' };
        // Header colour — same priority order as before. Night shifts
        // override with a deep twilight indigo so the time row reads
        // as "this is overnight" before the user even finishes
        // glancing at the rest of the card.
        const headerColor =
          hoverTip.isOvernight           ? '#3B4279'
          : hoverTip.status === 'declined' ? '#A32D2D'
          : hoverTip.isAccepted            ? '#0F4C2A'
          :                                  '#854F0B';
        // Card background, border, divider — three palettes:
        //
        //   Night shift (any status) → twilight indigo. Distinct from
        //     all three day-shift palettes because overnight is a
        //     materially different mode of work and deserves its own
        //     visual signal. Status is still conveyed by the badge
        //     inside the card; the card colour says "this is night",
        //     the badge says "and it's accepted/pending/declined".
        //
        //   Day shift accepted → pale evergreen
        //   Day shift pending  → pale amber
        //   Day shift declined → pale rose
        //
        // All four palettes match the legend / status-badge family
        // they're tied to, lightened to remain a readable card surface.
        const cardStyle =
          hoverTip.isOvernight
            ? { background: '#EEF0FA', border: '1px solid #B8BFD9', divider: '1px solid #D2D5E8' }
          : hoverTip.status === 'declined'
            ? { background: '#FCEFEF', border: '1px solid #E8B5B0', divider: '1px solid #F2D6D2' }
          : hoverTip.isAccepted
            ? { background: '#ECFDF3', border: '1px solid #A7D8B7', divider: '1px solid #C9E8D2' }
            : { background: '#FEF6E2', border: '1px solid #E8C896', divider: '1px solid #F2DDB1' };
        const statusBadgeStyle =
          hoverTip.status === 'declined' ? { background: '#FCEBEB', color: '#791F1F', border: '1px solid #A32D2D' }
          : hoverTip.isAccepted          ? { background: '#0F4C2A', color: '#FFFFFF', border: '1px solid #0F4C2A' }
          :                                { background: '#FAEEDA', color: '#854F0B', border: '1px solid #BA7517' };
        const statusLabel =
          hoverTip.isAccepted          ? 'Accepted & locked'
          : hoverTip.status === 'pending'  ? 'Pending acknowledgment'
          : hoverTip.status === 'declined' ? 'Declined'
          : hoverTip.status;
        const statusDetail =
          hoverTip.isAccepted          ? 'Final and locked. HR uses this time to check punch-in and punch-out.'
          : hoverTip.status === 'pending'  ? 'Waiting for staff to acknowledge.'
          : hoverTip.status === 'declined' ? 'Manager will follow up.'
          : '';
        return (
          <div
            role="tooltip"
            style={{
              position: 'fixed',
              left: hoverTip.x,
              ...tipPosStyle,
              zIndex: 100,
              pointerEvents: 'none',
              minWidth: 220,
              maxWidth: 280,
              background: cardStyle.background,
              border: cardStyle.border,
              borderRadius: 10,
              boxShadow: '0 8px 24px rgba(15, 23, 42, 0.18)',
              padding: '10px 12px',
              fontSize: 12,
              lineHeight: 1.45,
              color: '#0A0A0A',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 13, color: '#0A0A0A', marginBottom: 1 }}>
              {hoverTip.empName}
            </div>
            <div style={{ fontSize: 11, color: '#0A0A0A', opacity: 0.65, fontVariantNumeric: 'tabular-nums', marginBottom: 8 }}>
              {hoverTip.empPsn} &middot; {hoverTip.dateStr}
            </div>
            <div style={{
              fontSize: 14,
              fontWeight: 600,
              color: headerColor,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '0.01em',
            }}>
              {hoverTip.startStr} {hoverTip.isOvernight ? '\u2192' : '\u2013'} {hoverTip.endStr}
              {hoverTip.isOvernight && (
                <span style={{ fontSize: 10, fontWeight: 500, marginLeft: 6, opacity: 0.85 }}>
                  next day
                </span>
              )}
            </div>
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              color: hoverTip.isOvernight ? '#3B4279' : '#0A0A0A',
              opacity: hoverTip.isOvernight ? 1 : 0.85,
              marginTop: 2,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}>
              {hoverTip.isOvernight ? 'Night shift \u2014 starts evening, ends next morning' : 'Day shift'}
            </div>
            <div style={{
              borderTop: cardStyle.divider,
              marginTop: 8,
              paddingTop: 8,
            }}>
              <div style={{
                display: 'inline-block',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                padding: '2px 8px',
                borderRadius: 999,
                ...statusBadgeStyle,
              }}>
                {statusLabel}
              </div>
              {statusDetail && (
                <div style={{
                  fontSize: 11,
                  color: '#0A0A0A',
                  opacity: 0.8,
                  marginTop: 6,
                  lineHeight: 1.5,
                }}>
                  {statusDetail}
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </section>
  );
}
