import React, { useMemo, useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalIcon, Sunrise, Sunset, Briefcase, X, Sun } from 'lucide-react';
import { Card, Avatar, Pill, Empty } from './Dashboard.jsx';
import { toISO, todayISO, fmtDateShort, KSA_WEEKEND } from '../lib/leaveLogic.js';
import { directGet } from '../supabaseClient.js';

// ─────────────────────────────────────────────────────────────────────────
// CalendarView — month grid with overlays for every workforce signal:
//   • Holidays (existing)
//   • Approved leaves (existing — coloured chips per person)
//   • Approved permissions (new — small icons in the day cell footer)
//   • Shift assignments (new — corner badge with shift count)
//
// Filter chips above the grid let admin/HR scope by category. The
// per-person dropdown collapses every overlay to one employee — useful
// when investigating a specific staff member's pattern.
// ─────────────────────────────────────────────────────────────────────────

export default function CalendarView({ requests, permissions: permsProp, empMap, typeMap, holidays }) {
  const [viewDate, setViewDate] = useState(new Date());
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const monthName = viewDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startDow = firstDay.getDay();

  const [showLeaves, setShowLeaves]           = useState(true);
  const [showPermissions, setShowPermissions] = useState(true);
  const [showShifts, setShowShifts]           = useState(false);
  const [showHolidays, setShowHolidays]       = useState(true);
  const [personFilter, setPersonFilter]       = useState('all');
  // Hovered cell — used for the rich preview tooltip that appears
  // anchored to the cell. Stored as the ISO date so we can derive
  // the per-cell event lists at render time without a re-fetch.
  const [hoveredISO, setHoveredISO] = useState(null);
  // Clicked cell — opens the day detail modal grouped by person.
  const [clickedISO, setClickedISO] = useState(null);

  // Permissions: prefer the prop but fall back to a self-fetch so the
  // calendar still works on routes that don't pre-load permissions.
  const [permsLocal, setPermsLocal] = useState([]);
  useEffect(() => {
    if (Array.isArray(permsProp)) return;
    let cancelled = false;
    (async () => {
      try {
        const monthStart = toISO(firstDay);
        const monthEnd   = toISO(lastDay);
        const data = await directGet(
          'permission_requests?select=id,employee_id,type,permission_date,time_from,time_to,hours,stage'
          + '&stage=eq.approved'
          + '&permission_date=gte.' + monthStart
          + '&permission_date=lte.' + monthEnd
          + '&order=permission_date.asc'
        );
        if (!cancelled) setPermsLocal(data || []);
      } catch (e) {
        if (!cancelled) setPermsLocal([]);
      }
    })();
    return () => { cancelled = true; };
  }, [permsProp, year, month]);
  const permissions = Array.isArray(permsProp) ? permsProp : permsLocal;

  // Shifts: self-fetch the visible month.
  const [shifts, setShifts] = useState([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const monthStart = toISO(firstDay);
        const monthEnd   = toISO(lastDay);
        const data = await directGet(
          'employee_shifts?select=id,employee_id,shift_date,shift_start,shift_end,status'
          + '&shift_date=gte.' + monthStart
          + '&shift_date=lte.' + monthEnd
          + '&order=shift_date.asc'
        );
        if (!cancelled) setShifts(data || []);
      } catch (e) {
        if (!cancelled) setShifts([]);
      }
    })();
    return () => { cancelled = true; };
  }, [year, month]);

  const holidayMap = useMemo(() => {
    const m = {};
    (holidays || []).forEach(h => { m[h.date] = h; });
    return m;
  }, [holidays]);

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const leavesOnDay = (day) => {
    if (!day || !showLeaves) return [];
    const iso = toISO(new Date(year, month, day));
    return requests.filter(r =>
      r.status === 'approved'
      && r.start_date <= iso && r.end_date >= iso
      && (personFilter === 'all' || r.employee_id === personFilter)
    );
  };
  const permissionsOnDay = (day) => {
    if (!day || !showPermissions) return [];
    const iso = toISO(new Date(year, month, day));
    return permissions.filter(p =>
      p.permission_date === iso
      && (personFilter === 'all' || p.employee_id === personFilter)
    );
  };
  const shiftsOnDay = (day) => {
    if (!day || !showShifts) return [];
    const iso = toISO(new Date(year, month, day));
    return shifts.filter(s =>
      s.shift_date === iso
      && (personFilter === 'all' || s.employee_id === personFilter)
    );
  };

  const todayStr = todayISO();

  const peopleInMonth = useMemo(() => {
    const ids = new Set();
    const monthStart = toISO(firstDay);
    const monthEnd   = toISO(lastDay);
    requests.forEach(r => {
      if (r.status === 'approved' && !(r.end_date < monthStart || r.start_date > monthEnd)) {
        ids.add(r.employee_id);
      }
    });
    permissions.forEach(p => { if (p.permission_date >= monthStart && p.permission_date <= monthEnd) ids.add(p.employee_id); });
    shifts.forEach(s     => { if (s.shift_date      >= monthStart && s.shift_date      <= monthEnd) ids.add(s.employee_id); });
    return Array.from(ids).map(id => empMap[id]).filter(Boolean).sort((a,b) =>
      String(a.name||'').localeCompare(String(b.name||''))
    );
  }, [requests, permissions, shifts, empMap, year, month]);

  const monthLeaves = useMemo(() => {
    const monthStart = toISO(firstDay);
    const monthEnd = toISO(lastDay);
    return requests
      .filter(r => r.status === 'approved' && !(r.end_date < monthStart || r.start_date > monthEnd))
      .filter(r => personFilter === 'all' || r.employee_id === personFilter)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
  }, [requests, year, month, personFilter]);

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] tracking-[0.25em] mb-2" style={{ color: '#0A0A0A' }}>CALENDAR</div>
          <h1 className="serif text-3xl sm:text-4xl" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>{monthName}</h1>
        </div>
        <div className="flex gap-1">
          <button onClick={() => setViewDate(new Date(year, month - 1, 1))}
            className="p-2 rounded-full border" style={{ borderColor: 'var(--border-soft)' }}
            aria-label="Previous month">
            <ChevronLeft className="w-4 h-4"/>
          </button>
          <button onClick={() => setViewDate(new Date())}
            className="px-4 py-2 rounded-full border text-sm"
            style={{ borderColor: 'var(--border-soft)' }}>Today</button>
          <button onClick={() => setViewDate(new Date(year, month + 1, 1))}
            className="p-2 rounded-full border" style={{ borderColor: 'var(--border-soft)' }}
            aria-label="Next month">
            <ChevronRight className="w-4 h-4"/>
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          <FilterChip active={showLeaves}      onClick={() => setShowLeaves(v => !v)}      label="Leaves"      dot="#0F4C2A" />
          <FilterChip active={showPermissions} onClick={() => setShowPermissions(v => !v)} label="Permissions" dot="#1D4ED8" />
          <FilterChip active={showShifts}      onClick={() => setShowShifts(v => !v)}      label="Shifts"      dot="#9333EA" />
          <FilterChip active={showHolidays}    onClick={() => setShowHolidays(v => !v)}    label="Holidays"    dot="#C49B61" />
        </div>
        {peopleInMonth.length > 1 && (
          <select value={personFilter} onChange={e => setPersonFilter(e.target.value)}
            className="text-xs px-3 py-1.5 rounded-full border ml-auto"
            style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', color: '#0A0A0A' }}>
            <option value="all">All people</option>
            {peopleInMonth.map(p => (
              <option key={p.id} value={p.id}>{p.name} · {p.id}</option>
            ))}
          </select>
        )}
      </div>

      <div className="rounded-xl border overflow-hidden"
           style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
        <div className="grid grid-cols-7 text-[10px] tracking-widest border-b"
             style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}>
          {['SUN','MON','TUE','WED','THU','FRI','SAT'].map(d => (
            <div key={d} className="px-2 py-2 text-center">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((d, i) => {
            const dow = i % 7;
            const iso = d ? toISO(new Date(year, month, d)) : null;
            const isToday = iso === todayStr;
            const isWeekend = KSA_WEEKEND.includes(dow);
            const holiday = (iso && showHolidays) ? holidayMap[iso] : null;
            const leaves = leavesOnDay(d);
            const perms  = permissionsOnDay(d);
            const dayShifts = shiftsOnDay(d);

            let bg = 'transparent';
            if (!d) bg = 'rgba(247,243,234,0.5)';
            else if (isToday) bg = 'rgba(45,95,63,0.08)';
            else if (holiday) bg = 'rgba(196,155,97,0.12)';
            else if (isWeekend) bg = 'rgba(247,243,234,0.5)';

            return (
              <div key={i}
                onMouseEnter={() => d && setHoveredISO(iso)}
                onMouseLeave={() => setHoveredISO(prev => prev === iso ? null : prev)}
                onClick={() => {
                  if (!d) return;
                  const hasAny = leaves.length + perms.length + dayShifts.length > 0 || !!holiday;
                  if (hasAny) setClickedISO(iso);
                }}
                className={"min-h-[88px] sm:min-h-[112px] border-r border-b p-1.5 relative transition-colors " +
                  (d ? "cursor-pointer hover:bg-black/[0.02]" : "")}
                   style={{ borderColor: 'var(--border-soft)', background: bg }}>
                {d && (
                  <>
                    <div className="flex items-center justify-between mb-1 gap-1">
                      <div className="text-xs" style={{
                        fontWeight: isToday ? 600 : 400,
                        color: isToday ? 'var(--evergreen-500)' : '#0A0A0A',
                      }}>{d}</div>
                      <div className="flex items-center gap-1">
                        {dayShifts.length > 0 && showShifts && (
                          <span className="text-[9px] px-1 rounded font-bold tracking-wider"
                            style={{ background: 'rgba(147,51,234,0.15)', color: '#7E22CE' }}>
                            {dayShifts.length}S
                          </span>
                        )}
                        {holiday && (
                          <div className="text-[9px] uppercase tracking-wider" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                            HOLIDAY
                          </div>
                        )}
                      </div>
                    </div>
                    {holiday && (
                      <div className="text-[10px] leading-tight mb-1 truncate" style={{ color: '#0A0A0A', opacity: 0.85 }}>
                        {holiday.name}
                      </div>
                    )}
                    <div className="space-y-0.5">
                      {leaves.slice(0, 3).map(r => {
                        const emp = empMap[r.employee_id]; const tp = typeMap[r.leave_type_id];
                        if (!emp) return null;
                        return (
                          <div key={r.id}
                            className="text-[10px] px-1.5 py-0.5 rounded truncate"
                            style={{ background: (tp?.color || '#000') + '25', color: tp?.color }}>
                            {emp.name.split(' ')[0]}
                          </div>
                        );
                      })}
                      {leaves.length > 3 && (
                        <div className="text-[10px] px-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>+{leaves.length - 3} more</div>
                      )}
                    </div>
                    {perms.length > 0 && (
                      <div className="flex items-center gap-0.5 mt-1 flex-wrap">
                        {perms.slice(0, 4).map(p => {
                          const Icon = p.type === 'late_arrival' ? Sunrise : Sunset;
                          const color = p.type === 'late_arrival' ? '#1D4ED8' : '#A16207';
                          return (
                            <span key={p.id}
                              className="inline-flex items-center justify-center w-4 h-4 rounded-full"
                              style={{ background: color + '18' }}>
                              <Icon className="w-2.5 h-2.5" style={{ color: color }}/>
                            </span>
                          );
                        })}
                        {perms.length > 4 && (
                          <span className="text-[9px]" style={{ color: '#0A0A0A', opacity: 0.6 }}>+{perms.length - 4}</span>
                        )}
                      </div>
                    )}

                    {/* Hover preview — anchored to this cell, shows
                        every event for the day grouped by type. The
                        cell that owns the tooltip is the only one
                        rendering it (hoveredISO === iso) so React
                        only paints one floating layer at a time.
                        Click anywhere on the cell opens the detail
                        modal with the same data plus per-person
                        grouping and richer formatting. */}
                    {hoveredISO === iso && (leaves.length + perms.length + dayShifts.length > 0 || holiday) && (
                      <HoverTooltip
                        iso={iso}
                        leaves={leaves}
                        perms={perms}
                        shifts={dayShifts}
                        holiday={holiday}
                        empMap={empMap}
                        typeMap={typeMap}
                        // Position above the cell when in the bottom
                        // half of the grid, otherwise below — keeps
                        // the tooltip from getting clipped by the
                        // calendar's bottom edge.
                        anchorAbove={Math.floor(i / 7) >= Math.floor(cells.length / 7) - 2}
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Day detail modal — opens on cell click. Shows every event for
          the day grouped by person, with full type/time/duration text. */}
      {clickedISO && (
        <DayDetailModal
          iso={clickedISO}
          leaves={requests.filter(r => r.status === 'approved' && r.start_date <= clickedISO && r.end_date >= clickedISO && (personFilter === 'all' || r.employee_id === personFilter))}
          perms={permissions.filter(p => p.permission_date === clickedISO && (personFilter === 'all' || p.employee_id === personFilter))}
          shifts={shifts.filter(s => s.shift_date === clickedISO && (personFilter === 'all' || s.employee_id === personFilter))}
          holiday={holidayMap[clickedISO] || null}
          empMap={empMap}
          typeMap={typeMap}
          onClose={() => setClickedISO(null)}
        />
      )}

      <Card title="Approved leaves this month" subtitle={monthLeaves.length + ' entries'}>
        {monthLeaves.length === 0 ? (
          <Empty icon={CalIcon} message="No approved leaves this month."/>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--border-soft)' }}>
            {monthLeaves.map(r => {
              const emp = empMap[r.employee_id]; const tp = typeMap[r.leave_type_id];
              if (!emp) return null;
              return (
                <li key={r.id} className="flex items-center gap-3 py-2.5 flex-wrap">
                  <Avatar id={emp.id} name={emp.name}/>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate" style={{ fontWeight: 500, color: '#0A0A0A' }}>{emp.name}</div>
                    <div className="text-xs" style={{ color: '#0A0A0A', opacity: 0.75 }}>{emp.department} · {emp.location}</div>
                  </div>
                  <div className="text-right">
                    <Pill color={tp?.color}>{tp?.name}</Pill>
                    <div className="text-xs mt-1" style={{ color: '#0A0A0A', opacity: 0.75 }}>{fmtDateShort(r.start_date)} → {fmtDateShort(r.end_date)} · {r.days}d</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function FilterChip({ active, onClick, label, dot }) {
  return (
    <button onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs transition-colors"
      style={{
        borderColor: active ? '#0A0A0A' : 'var(--border-soft)',
        background: active ? '#FFFFFF' : 'transparent',
        color: '#0A0A0A',
        fontWeight: active ? 600 : 400,
        opacity: active ? 1 : 0.55,
      }}
      title={(active ? 'Hide ' : 'Show ') + label.toLowerCase()}>
      <span className="inline-block w-2 h-2 rounded-full" style={{ background: dot }}/>
      {label}
    </button>
  );
}

// ─── HoverTooltip ───────────────────────────────────────────────────────
// Floating preview anchored to a calendar cell. Shows every event for
// the day grouped by type with the responsible staff member's name.
// Compact — one line per event — so a busy day stays scannable.
//
// Positioning: by default appears below the cell. If anchorAbove is
// true (cell is in the bottom two rows), it flips to above. Always
// horizontally centred on the cell with overflow guards via min/max
// width.
//
// Pointer-events disabled so the tooltip never intercepts clicks
// — the underlying cell stays clickable for the detail modal.
function HoverTooltip({ iso, leaves, perms, shifts, holiday, empMap, typeMap, anchorAbove }) {
  const dateLabel = new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const totalCount = leaves.length + perms.length + shifts.length;

  return (
    <div className="absolute z-50 pointer-events-none"
      style={{
        ...(anchorAbove
          ? { bottom: '100%', marginBottom: '6px' }
          : { top: '100%', marginTop: '6px' }),
        left: '50%',
        transform: 'translateX(-50%)',
        minWidth: '240px',
        maxWidth: '320px',
      }}>
      <div className="rounded-xl shadow-lg p-3"
        style={{
          background: '#FFFDF7',
          border: '1px solid var(--border-soft)',
          boxShadow: '0 8px 24px rgba(31, 27, 22, 0.12)',
        }}>
        <div className="text-[10px] tracking-widest mb-2"
          style={{ color: '#0A0A0A', fontWeight: 700, opacity: 0.7 }}>
          {dateLabel.toUpperCase()}
          {totalCount > 0 && <span style={{ marginLeft: '6px' }}>· {totalCount} event{totalCount === 1 ? '' : 's'}</span>}
        </div>

        {holiday && (
          <div className="text-xs mb-2 px-2 py-1 rounded inline-block"
            style={{ background: 'rgba(196,155,97,0.18)', color: '#0A0A0A', fontWeight: 600 }}>
            {holiday.name}
          </div>
        )}

        {leaves.length > 0 && (
          <div className="mb-2">
            <div className="text-[9px] tracking-wider mb-1"
              style={{ color: '#0A0A0A', fontWeight: 700, opacity: 0.6 }}>
              LEAVES · {leaves.length}
            </div>
            <ul className="space-y-1">
              {leaves.map(r => {
                const emp = empMap[r.employee_id];
                const tp  = typeMap[r.leave_type_id];
                return (
                  <li key={r.id} className="flex items-center gap-1.5 text-[11px]" style={{ color: '#0A0A0A' }}>
                    <span className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ background: tp?.color || '#000' }}/>
                    <span style={{ fontWeight: 600 }}>{emp?.name || r.employee_id}</span>
                    <span style={{ opacity: 0.7 }}>· {tp?.name || r.leave_type_id}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {perms.length > 0 && (
          <div className="mb-2">
            <div className="text-[9px] tracking-wider mb-1"
              style={{ color: '#0A0A0A', fontWeight: 700, opacity: 0.6 }}>
              PERMISSIONS · {perms.length}
            </div>
            <ul className="space-y-1">
              {perms.map(p => {
                const emp = empMap[p.employee_id];
                const Icon = p.type === 'late_arrival' ? Sunrise : Sunset;
                const color = p.type === 'late_arrival' ? '#1D4ED8' : '#A16207';
                const label = p.type === 'late_arrival' ? 'Late arrival' : 'Early leave';
                return (
                  <li key={p.id} className="flex items-center gap-1.5 text-[11px]" style={{ color: '#0A0A0A' }}>
                    <Icon className="w-3 h-3 flex-shrink-0" style={{ color }}/>
                    <span style={{ fontWeight: 600 }}>{emp?.name || p.employee_id}</span>
                    <span style={{ opacity: 0.7 }}>
                      · {label} · {String(p.time_from || '').slice(0,5)}–{String(p.time_to || '').slice(0,5)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {shifts.length > 0 && (
          <div className="mb-1">
            <div className="text-[9px] tracking-wider mb-1"
              style={{ color: '#0A0A0A', fontWeight: 700, opacity: 0.6 }}>
              SHIFTS · {shifts.length}
            </div>
            <ul className="space-y-1">
              {shifts.map(s => {
                const emp = empMap[s.employee_id];
                return (
                  <li key={s.id} className="flex items-center gap-1.5 text-[11px]" style={{ color: '#0A0A0A' }}>
                    <Briefcase className="w-3 h-3 flex-shrink-0" style={{ color: '#7E22CE' }}/>
                    <span style={{ fontWeight: 600 }}>{emp?.name || s.employee_id}</span>
                    <span style={{ opacity: 0.7 }}>
                      {s.shift_start && s.shift_end
                        ? ` · ${String(s.shift_start).slice(0,5)}–${String(s.shift_end).slice(0,5)}`
                        : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="text-[9px] mt-2 pt-2 border-t" style={{ color: '#0A0A0A', opacity: 0.5, borderColor: 'var(--border-soft)' }}>
          Click for full detail
        </div>
      </div>
    </div>
  );
}

// ─── DayDetailModal ─────────────────────────────────────────────────────
// Opens when a calendar cell is clicked. Shows every event for that
// day grouped by person — each staff member gets their own row with
// all their events (leaves + permissions + shifts) accumulated.
// Sorted alphabetically by name so the order is stable across opens.
function DayDetailModal({ iso, leaves, perms, shifts, holiday, empMap, typeMap, onClose }) {
  const dateLabel = new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  // Group every event by employee_id so each staff member's events
  // sit together in the modal. byEmp shape:
  //   key: 'H94590'
  //   value: { employee, leaves: [], perms: [], shifts: [] }
  const byEmp = useMemo(() => {
    const m = new Map();
    const ensure = (empId) => {
      if (!m.has(empId)) {
        m.set(empId, {
          employee: empMap[empId] || { id: empId, name: '(unknown)', department: '', location: '' },
          leaves: [],
          perms: [],
          shifts: [],
        });
      }
      return m.get(empId);
    };
    leaves.forEach(r => ensure(r.employee_id).leaves.push(r));
    perms.forEach(p  => ensure(p.employee_id).perms.push(p));
    shifts.forEach(s => ensure(s.employee_id).shifts.push(s));
    return m;
  }, [leaves, perms, shifts, empMap]);

  // Stable sort by name. People with their own events show up in the
  // same order every time the modal opens.
  const sortedEntries = useMemo(() => {
    return Array.from(byEmp.values()).sort((a, b) =>
      String(a.employee.name || '').localeCompare(String(b.employee.name || ''))
    );
  }, [byEmp]);

  const totalEvents = leaves.length + perms.length + shifts.length;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '40px 16px', overflowY: 'auto',
      }}>
      <div
        className="w-full max-w-2xl rounded-2xl border"
        style={{
          borderColor: 'var(--border-soft)',
          background: '#FFFDF7',
          boxShadow: '0 12px 40px rgba(31,27,22,0.18)',
        }}>
        {/* Header */}
        <div className="flex items-start justify-between px-5 sm:px-6 py-4 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div>
            <div className="text-[10px] tracking-[0.25em] mb-1" style={{ fontWeight: 700, color: '#0A0A0A' }}>
              CALENDAR · DAY DETAIL
            </div>
            <h2 style={{ fontFamily: 'Georgia, serif', fontSize: '20px', color: '#0A0A0A', fontWeight: 500 }}>
              {dateLabel}
            </h2>
            <div className="text-xs mt-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>
              {totalEvents === 0
                ? (holiday ? holiday.name : 'No events recorded.')
                : `${sortedEntries.length} ${sortedEntries.length === 1 ? 'person' : 'people'} · ${totalEvents} event${totalEvents === 1 ? '' : 's'}`}
            </div>
          </div>
          <button onClick={onClose}
            className="p-1.5 rounded-full hover:bg-black/5 transition-colors"
            aria-label="Close">
            <X className="w-4 h-4" style={{ color: '#0A0A0A' }}/>
          </button>
        </div>

        {/* Holiday banner */}
        {holiday && (
          <div className="mx-5 sm:mx-6 mt-4 px-3 py-2 rounded-lg flex items-center gap-2"
            style={{ background: 'rgba(196,155,97,0.18)', border: '1px solid rgba(196,155,97,0.4)' }}>
            <Sun className="w-4 h-4 flex-shrink-0" style={{ color: '#92400E' }}/>
            <div>
              <div className="text-[10px] tracking-wider font-bold" style={{ color: '#0A0A0A' }}>HOLIDAY</div>
              <div className="text-sm" style={{ color: '#0A0A0A', fontWeight: 500 }}>{holiday.name}</div>
            </div>
          </div>
        )}

        {/* Per-person rows */}
        <div className="p-5 sm:p-6">
          {sortedEntries.length === 0 ? (
            <div className="text-center py-6 text-sm" style={{ color: '#0A0A0A', opacity: 0.7 }}>
              {holiday
                ? 'No staff events on this day — only the public holiday.'
                : 'No events on this day.'}
            </div>
          ) : (
            <ul className="space-y-3">
              {sortedEntries.map(({ employee, leaves: empLeaves, perms: empPerms, shifts: empShifts }) => (
                <li key={employee.id}
                  className="rounded-xl p-3 sm:p-4"
                  style={{ background: '#FFFFFF', border: '1px solid var(--border-soft)' }}>
                  {/* Person header */}
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="text-[11px] font-mono px-1.5 py-0.5 rounded"
                      style={{ background: '#F4F4EE', color: '#0A0A0A' }}>
                      {employee.id}
                    </span>
                    <span className="text-sm" style={{ color: '#0A0A0A', fontWeight: 700 }}>
                      {employee.name}
                    </span>
                    {(employee.department || employee.location) && (
                      <span className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                        · {[employee.department, employee.location].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </div>

                  {/* Person's events */}
                  <ul className="space-y-1.5">
                    {empLeaves.map(r => {
                      const tp = typeMap[r.leave_type_id];
                      const dayNum = (() => {
                        const start = new Date(r.start_date);
                        const here  = new Date(iso);
                        return Math.round((here - start) / 86_400_000) + 1;
                      })();
                      return (
                        <li key={r.id} className="flex items-start gap-2 text-[12px]" style={{ color: '#0A0A0A' }}>
                          <span className="inline-block w-2 h-2 rounded-full mt-1.5 flex-shrink-0"
                            style={{ background: tp?.color || '#000' }}/>
                          <div>
                            <span style={{ fontWeight: 600 }}>{tp?.name || r.leave_type_id}</span>
                            <span style={{ opacity: 0.75 }}>
                              {' · '}{r.days} day{r.days === 1 ? '' : 's'} ({fmtDateShort(r.start_date)} → {fmtDateShort(r.end_date)})
                              {r.days > 1 && ` · day ${dayNum} of ${r.days}`}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                    {empPerms.map(p => {
                      const Icon = p.type === 'late_arrival' ? Sunrise : Sunset;
                      const color = p.type === 'late_arrival' ? '#1D4ED8' : '#A16207';
                      const label = p.type === 'late_arrival' ? 'Late arrival permission' : 'Early leave permission';
                      return (
                        <li key={p.id} className="flex items-start gap-2 text-[12px]" style={{ color: '#0A0A0A' }}>
                          <Icon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color }}/>
                          <div>
                            <span style={{ fontWeight: 600 }}>{label}</span>
                            <span style={{ opacity: 0.75 }}>
                              {' · '}{String(p.time_from || '').slice(0,5)}–{String(p.time_to || '').slice(0,5)}
                              {p.hours ? ` · ${p.hours}h` : ''}
                            </span>
                            {p.reason && (
                              <div className="text-[11px] italic mt-0.5" style={{ opacity: 0.7 }}>
                                "{p.reason}"
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                    {empShifts.map(s => (
                      <li key={s.id} className="flex items-start gap-2 text-[12px]" style={{ color: '#0A0A0A' }}>
                        <Briefcase className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: '#7E22CE' }}/>
                        <div>
                          <span style={{ fontWeight: 600 }}>Shift assignment</span>
                          <span style={{ opacity: 0.75 }}>
                            {s.shift_start && s.shift_end
                              ? ` · ${String(s.shift_start).slice(0,5)}–${String(s.shift_end).slice(0,5)}`
                              : ''}
                            {s.status ? ` · ${s.status}` : ''}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 sm:px-6 py-3 border-t flex items-center justify-end" style={{ borderColor: 'var(--border-soft)', background: '#FAF6EC' }}>
          <button onClick={onClose}
            className="text-xs px-4 py-2 rounded-full"
            style={{ background: '#0A0A0A', color: '#FFFDF7', fontWeight: 500 }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
