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
import { ChevronLeft, ChevronRight, RefreshCcw, Loader2 } from 'lucide-react';
import { directGet, supabase } from '../supabaseClient.js';

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
function styleForStatus(status) {
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
    off_roster: 'Worked off-roster',
    off_day: 'Off-day',
  })[status] || status;
}

export default function AttendanceMonthGrid({ employees }) {
  const today = useMemo(() => new Date(), []);
  const [year, setYear]   = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hoverTip, setHoverTip] = useState(null);

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
      const data = await directGet(
        'attendance_daily',
        `select=employee_id,attendance_date,status,first_punch,last_punch,` +
        `expected_start,expected_end,late_minutes,early_leave_minutes,notes` +
        `&attendance_date=gte.${ymd(firstDay)}` +
        `&attendance_date=lte.${ymd(lastDay)}` +
        `&order=attendance_date.asc`,
        { timeoutMs: 9000 }
      );
      setRecords(data || []);
    } catch (e) {
      console.warn('attendance_daily fetch failed:', e);
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, [firstDay, lastDay]);
  useEffect(() => { refetch(); }, [refetch]);

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

  // Filter to employees who have at least one record this month.
  // Otherwise the grid would render every employee in the directory
  // even if Bashaier never uploaded their data — defeats the
  // purpose of an "actively-tracked" view.
  const tracked = useMemo(() => {
    const have = new Set(records.map(r => r.employee_id));
    return (employees || [])
      .filter(e => have.has(e.id))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }, [employees, records]);

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
      else if (r.status === 'annual_leave' || r.status === 'sick_leave') cur.leave++;
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
    <div className="rounded-2xl border bg-white p-3 sm:p-5" style={{ borderColor: '#D4D4D4' }}>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <div className="text-[10px] mb-1" style={{ color: '#1F1B16', letterSpacing: '0.25em', fontWeight: 700 }}>
            MONTHLY ATTENDANCE
          </div>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 20, color: '#1F1B16' }}>
            {monthLabel}
          </div>
          <div className="text-xs mt-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>
            Live record built from your attendance uploads. Each cell shows that day's status; hover for punch times and details.
          </div>
        </div>
        <div className="flex items-center gap-1.5">
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

      {tracked.length === 0 ? (
        <div className="text-center py-10" style={{ color: '#0A0A0A', opacity: 0.5 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>No attendance records yet for {monthLabel}.</div>
          <div className="text-xs mt-1">Upload an attendance file above and the calendar will start filling in.</div>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: `220px repeat(${days.length}, minmax(28px, 1fr))`, gap: 1, minWidth: 'fit-content' }}>
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
                    background: isToday ? 'rgba(15,76,42,0.10)' : isWeekend ? '#F5F5F5' : '#FAFAFA',
                    padding: '4px 0',
                    fontSize: 9,
                    fontWeight: 700,
                    color: '#0A0A0A',
                    textAlign: 'center',
                    borderTop: isToday ? '2px solid #0F4C2A' : '1px solid transparent',
                  }}
                >
                  <div style={{ fontSize: 8, opacity: 0.6 }}>
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
                  <div
                    style={{
                      background: '#FFFFFF',
                      padding: '6px 8px',
                      borderTop: '1px solid var(--border-soft, #EFEFEF)',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'center',
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#0A0A0A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {emp.name || emp.id}
                    </div>
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
                  </div>
                  {days.map(d => {
                    const dStr = ymd(d);
                    const dow = d.getDay();
                    const isWeekend = dow === 5 || dow === 6;
                    const isToday = dStr === todayStr;
                    const isFuture = dStr > todayStr;
                    const r = recordIndex.get(`${emp.id}|${dStr}`);
                    const cellBg = isToday ? 'rgba(15,76,42,0.04)'
                                 : isFuture ? '#FAFAFA'
                                 : isWeekend ? '#F5F5F5' : 'transparent';
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
                    const sty = styleForStatus(r.status);
                    return (
                      <div
                        key={dStr}
                        style={{
                          background: cellBg,
                          borderTop: '1px solid var(--border-soft, #EFEFEF)',
                          borderLeft: '1px solid var(--border-soft, #EFEFEF)',
                          padding: '3px 2px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                        onMouseEnter={(e) => handleEnter(e, { record: r, employee: emp, dateStr: dStr, weekday: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow] })}
                        onMouseLeave={handleLeave}
                      >
                        <div
                          style={{
                            background: sty.bg,
                            color: sty.fg,
                            border: `1px solid ${sty.border}`,
                            borderRadius: 4,
                            width: '100%',
                            minHeight: 22,
                            fontSize: 9,
                            fontWeight: 700,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            letterSpacing: '0.04em',
                            cursor: 'default',
                          }}
                        >
                          {sty.label}
                        </div>
                      </div>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="text-[11px] mt-4 flex flex-wrap gap-2.5 items-center" style={{ color: '#0A0A0A', opacity: 0.85 }}>
        {[
          { st: 'present',      lbl: 'Present' },
          { st: 'late',         lbl: 'Late' },
          { st: 'short',        lbl: 'Short' },
          { st: 'absent',       lbl: 'Absent' },
          { st: 'annual_leave', lbl: 'Annual leave' },
          { st: 'sick_leave',   lbl: 'Sick leave' },
          { st: 'off_roster',   lbl: 'Off-roster work' },
          { st: 'off_day',      lbl: 'Off-day' },
        ].map(({ st, lbl }) => {
          const sty = styleForStatus(st);
          return (
            <span key={st} className="inline-flex items-center gap-1.5">
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
              {lbl}
            </span>
          );
        })}
      </div>

      {/* Hover tooltip */}
      {hoverTip && <HoverTooltip {...hoverTip} />}
    </div>
  );
}

// ─── Hover-tooltip panel ─────────────────────────────────────────────
function HoverTooltip({ x, yTop, yBottom, record, employee, dateStr, weekday }) {
  // Position above the cell when there's room, otherwise below
  const flipBelow = yTop < 140;
  const sty = styleForStatus(record.status);
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
      {minutesLine && <div style={{ fontSize: 10.5, color: '#FCD34D', marginTop: 2 }}>{minutesLine}</div>}
      {record.notes && <div style={{ fontSize: 10, opacity: 0.85, marginTop: 4, fontStyle: 'italic' }}>{record.notes}</div>}
    </div>
  );
}
