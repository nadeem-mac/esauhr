import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalIcon, Sunrise, Sunset, Briefcase, X, Sun } from 'lucide-react';
import { Card, Avatar, Pill, Empty } from './Dashboard.jsx';
import { toISO, todayISO, fmtDateShort, KSA_WEEKEND } from '../lib/leaveLogic.js';
import { directGet, supabase } from '../supabaseClient.js';

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

export default function CalendarView({ me, requests, permissions: permsProp, empMap, typeMap, holidays }) {
  const [viewDate, setViewDate] = useState(new Date());
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const monthName = viewDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  // Access scope. Bashaier (HR reviewer) and Nadeem (admin) see every
  // staff member's events — that's the workforce-wide visibility the
  // calendar was built for. Regular staff see only their own events
  // (their own leaves, their own permissions, their own shifts) so
  // colleague absences and time-off remain private.
  // Defense in depth: enforced here AND inside the self-fetch queries
  // below, so even if a future change passes unfiltered props the
  // CalendarView never renders other people's data to a regular user.
  const canSeeAll = Boolean(me?.is_admin || me?.is_hr_reviewer);
  const scopeId   = me?.id || null;

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
  // Last-selected cell. Persists past modal close so the user can
  // see which day they just inspected when they review the calendar
  // in sequence (close modal → glance at next day → click).
  // Cleared by clicking an empty cell or pressing Esc on the grid.
  const [selectedISO, setSelectedISO] = useState(null);

  // Permissions: prefer the prop but fall back to a self-fetch so the
  // calendar still works on routes that don't pre-load permissions.
  const [permsLocal, setPermsLocal] = useState([]);
  const refetchPermsLocal = useCallback(async () => {
    if (Array.isArray(permsProp)) return;
    try {
      const monthStart = toISO(firstDay);
      const monthEnd   = toISO(lastDay);
      // For regular staff, scope the query to their own PSN so
      // we never even pull other people's permissions over the
      // wire — defense in depth on top of the client-side filter.
      const scopeQs = (!canSeeAll && scopeId)
        ? '&employee_id=eq.' + encodeURIComponent(scopeId)
        : '';
      const data = await directGet(
        'permission_requests?select=id,employee_id,type,permission_date,time_from,time_to,hours,stage'
        + '&stage=eq.approved'
        + '&permission_date=gte.' + monthStart
        + '&permission_date=lte.' + monthEnd
        + scopeQs
        + '&order=permission_date.asc'
      );
      setPermsLocal(data || []);
    } catch (e) {
      setPermsLocal([]);
    }
  }, [permsProp, year, month, canSeeAll, scopeId]);
  useEffect(() => { refetchPermsLocal(); }, [refetchPermsLocal]);

  // When the parent passes permissions and the user can't see all,
  // clip the prop to the user's own rows so we don't leak even via
  // accidentally-broad parent fetches.
  const permissions = useMemo(() => {
    const source = Array.isArray(permsProp) ? permsProp : permsLocal;
    if (canSeeAll || !scopeId) return source;
    return source.filter(p => p.employee_id === scopeId);
  }, [permsProp, permsLocal, canSeeAll, scopeId]);

  // Shifts: self-fetch the visible month, scoped to the user when
  // they're not allowed to see everyone's.
  const [shifts, setShifts] = useState([]);
  const refetchShifts = useCallback(async () => {
    try {
      const monthStart = toISO(firstDay);
      const monthEnd   = toISO(lastDay);
      const scopeQs = (!canSeeAll && scopeId)
        ? '&employee_id=eq.' + encodeURIComponent(scopeId)
        : '';
      const data = await directGet(
        'employee_shifts?select=id,employee_id,shift_date,shift_start,shift_end,status'
        + '&shift_date=gte.' + monthStart
        + '&shift_date=lte.' + monthEnd
        + scopeQs
        + '&order=shift_date.asc'
      );
      setShifts(data || []);
    } catch (e) {
      setShifts([]);
    }
  }, [year, month, canSeeAll, scopeId]);
  useEffect(() => { refetchShifts(); }, [refetchShifts]);

  // Realtime updates. Subscribes to the three tables that drive the
  // calendar (leaves, permissions, shifts) and refetches any time
  // a row changes. Supabase's free tier has fairly tight realtime
  // budgets so we debounce: at most one refetch every 800ms even if
  // multiple changes land back-to-back.
  //
  // Leaves arrive via the `requests` prop maintained by AppShell —
  // AppShell already runs its own realtime subscription, so we just
  // listen for permission and shift changes here. The brief catch-up
  // (refetch even if AppShell has already updated state) is cheap
  // and avoids the 'I just approved this and it didn't show' moment.
  useEffect(() => {
    let lastRun = 0;
    let pending = null;
    const trigger = (refetch) => {
      const now = Date.now();
      const since = now - lastRun;
      const delay = since < 800 ? 800 - since : 0;
      clearTimeout(pending);
      pending = setTimeout(() => {
        lastRun = Date.now();
        refetch();
      }, delay);
    };

    const channel = supabase
      .channel('calendar-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'permission_requests' },
        () => { if (!Array.isArray(permsProp)) trigger(refetchPermsLocal); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'employee_shifts' },
        () => trigger(refetchShifts))
      .subscribe();

    return () => {
      clearTimeout(pending);
      supabase.removeChannel(channel);
    };
  }, [refetchPermsLocal, refetchShifts, permsProp]);

  // Leaves come in as a pre-loaded prop — filter them client-side
  // for non-admin/HR users. Memoised so the lookup helpers below
  // stay stable.
  const scopedRequests = useMemo(() => {
    if (canSeeAll || !scopeId) return requests;
    return (requests || []).filter(r => r.employee_id === scopeId);
  }, [requests, canSeeAll, scopeId]);

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
    return scopedRequests.filter(r =>
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
    scopedRequests.forEach(r => {
      if (r.status === 'approved' && !(r.end_date < monthStart || r.start_date > monthEnd)) {
        ids.add(r.employee_id);
      }
    });
    permissions.forEach(p => { if (p.permission_date >= monthStart && p.permission_date <= monthEnd) ids.add(p.employee_id); });
    shifts.forEach(s     => { if (s.shift_date      >= monthStart && s.shift_date      <= monthEnd) ids.add(s.employee_id); });
    return Array.from(ids).map(id => empMap[id]).filter(Boolean).sort((a,b) =>
      String(a.name||'').localeCompare(String(b.name||''))
    );
  }, [scopedRequests, permissions, shifts, empMap, year, month]);

  const monthLeaves = useMemo(() => {
    const monthStart = toISO(firstDay);
    const monthEnd = toISO(lastDay);
    return scopedRequests
      .filter(r => r.status === 'approved' && !(r.end_date < monthStart || r.start_date > monthEnd))
      .filter(r => personFilter === 'all' || r.employee_id === personFilter)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
  }, [scopedRequests, year, month, personFilter]);

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] tracking-[0.25em] mb-2 inline-flex items-center gap-2"
            style={{ color: '#0F4C2A', fontWeight: 700 }}>
            <span className="inline-block w-7 h-px" style={{ background: '#0F4C2A' }}/>
            CALENDAR
          </div>
          <h1 className="serif text-3xl sm:text-4xl" style={{ fontWeight: 500, letterSpacing: '-0.02em', color: '#0A0A0A' }}>
            {monthName}
          </h1>
        </div>
        <div className="flex gap-1">
          <button onClick={() => setViewDate(new Date(year, month - 1, 1))}
            className="p-2 rounded-full border transition-colors hover:bg-black/5"
            style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', color: '#0A0A0A' }}
            aria-label="Previous month">
            <ChevronLeft className="w-4 h-4"/>
          </button>
          <button onClick={() => setViewDate(new Date())}
            className="px-4 py-2 rounded-full text-sm transition-colors"
            style={{ background: '#0F4C2A', color: '#FFFFFF', fontWeight: 600 }}>
            Today
          </button>
          <button onClick={() => setViewDate(new Date(year, month + 1, 1))}
            className="p-2 rounded-full border transition-colors hover:bg-black/5"
            style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', color: '#0A0A0A' }}
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
          <FilterChip active={showHolidays}    onClick={() => setShowHolidays(v => !v)}    label="Holidays"    dot="#B45309" />
        </div>
        {canSeeAll && peopleInMonth.length > 1 && (
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

      {/* Calendar grid container — soft drop shadow + warm cream
          background gives the whole month a sense of depth, like a
          paper page. Rounded corners + subtle border keep the overall
          feel close to the rest of the app. */}
      <div className="rounded-2xl overflow-hidden"
           style={{
             border: '1px solid #E8DEC4',
             background: '#FFFFFF',
             boxShadow: '0 4px 16px rgba(31,27,22,0.06), 0 1px 3px rgba(31,27,22,0.04)',
           }}>
        {/* Day-of-week header — slight evergreen tint so it stands
            apart from the cells below. Bolder labels with brand
            colour anchor the whole grid visually. */}
        <div className="grid grid-cols-7 text-[10px] tracking-widest"
             style={{
               background: '#F4EFDC',
               borderBottom: '1px solid #E8DEC4',
               color: '#0F4C2A',
               fontWeight: 700,
             }}>
          {['SUN','MON','TUE','WED','THU','FRI','SAT'].map((d, i) => (
            <div key={d} className="px-2 py-2.5 text-center"
              style={{ borderRight: i < 6 ? '1px solid #E8DEC4' : 'none' }}>
              {d}
            </div>
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
            const totalEvents = leaves.length + perms.length + dayShifts.length;
            const hasEvents = totalEvents > 0 || !!holiday;

            // Cell background — layered logic so today, holidays,
            // weekends, and empty-fill cells each have a distinct
            // identity. Today wins, then holiday, then weekend, then
            // a neutral cream for filled days.
            let bg = '#FFFFFF';
            let topAccent = null;
            if (!d) {
              bg = '#F8F1DD'; // out-of-month filler — clearly muted
            } else if (isToday) {
              bg = '#F0F9F4'; // soft brand-green tint — today pops
              topAccent = '#0F4C2A';
            } else if (holiday) {
              bg = '#FEF3E0'; // warm copper-cream for holidays
              topAccent = '#B45309';
            } else if (isWeekend) {
              bg = '#FAF5E8'; // distinctly tinted weekend
            }

            const isSelected = selectedISO === iso;

            return (
              <div key={i}
                onMouseEnter={() => d && setHoveredISO(iso)}
                onMouseLeave={() => setHoveredISO(prev => prev === iso ? null : prev)}
                onClick={() => {
                  if (!d) return;
                  // Always remember which day was clicked for the
                  // persistent highlight; only open the modal when
                  // there's something to show.
                  setSelectedISO(iso);
                  if (hasEvents) setClickedISO(iso);
                }}
                className={"min-h-[64px] sm:min-h-[78px] p-1.5 relative transition-all duration-150 " +
                  (d && hasEvents ? "cursor-pointer hover:shadow-md hover:z-10" : d ? "cursor-default" : "")}
                style={{
                  borderRight:  dow < 6 ? '1px solid #E8DEC4' : 'none',
                  borderBottom: '1px solid #E8DEC4',
                  background: bg,
                  // Persistent highlight on the last-clicked cell —
                  // an inset ring in brand green. Survives modal
                  // close so Bashaier can see which day she just
                  // reviewed when scanning sequentially.
                  boxShadow: isSelected
                    ? 'inset 0 0 0 2px #0F4C2A'
                    : undefined,
                  zIndex: isSelected ? 5 : undefined,
                }}>
                {/* Top accent stripe — coloured bar at the top of the
                    cell when it's today or a holiday. Quick visual
                    cue without taking vertical space from event chips. */}
                {topAccent && (
                  <div aria-hidden style={{
                    position: 'absolute', top: 0, left: 0, right: 0, height: '3px',
                    background: topAccent,
                  }}/>
                )}
                {d && (
                  <>
                    <div className="flex items-center justify-between gap-1">
                      {/* Date number — circular for today; coloured for
                          weekend/holiday. Tighter sizing for the smaller
                          cell footprint. */}
                      {isToday ? (
                        <div className="flex items-center justify-center w-6 h-6 rounded-full text-[11px]"
                          style={{
                            background: 'linear-gradient(135deg, #0F4C2A 0%, #047857 100%)',
                            color: '#FFFFFF', fontWeight: 700,
                            boxShadow: '0 2px 4px rgba(15,76,42,0.3)',
                          }}>
                          {d}
                        </div>
                      ) : (
                        <div className="text-[12px]" style={{
                          fontWeight: holiday ? 700 : isWeekend ? 600 : 500,
                          color: holiday ? '#B45309' : isWeekend ? '#7C5E2E' : '#0A0A0A',
                        }}>{d}</div>
                      )}
                      {totalEvents > 0 && (
                        <span className="text-[9px] px-1.5 rounded-full font-bold leading-tight"
                          style={{
                            background: '#0F4C2A', color: '#FFFFFF',
                            minWidth: '16px', textAlign: 'center', paddingTop: '2px', paddingBottom: '2px',
                          }}
                          title={`${totalEvents} event${totalEvents === 1 ? '' : 's'}`}>
                          {totalEvents}
                        </span>
                      )}
                    </div>

                    {/* Colour-density dot row — one tiny dot per event,
                        coloured by type. Gives the cell instant visual
                        identity even when there's no room for full
                        chips. Same colour palette as the filter chips
                        so they cross-reference at a glance. */}
                    {(leaves.length + perms.length + dayShifts.length) > 0 && (
                      <div className="flex items-center gap-0.5 mt-1 flex-wrap">
                        {leaves.slice(0, 6).map(r => {
                          const tp = typeMap[r.leave_type_id];
                          return (
                            <span key={'l-' + r.id}
                              className="inline-block w-1.5 h-1.5 rounded-full"
                              style={{ background: tp?.color || '#0F4C2A' }}/>
                          );
                        })}
                        {perms.slice(0, 6).map(p => (
                          <span key={'p-' + p.id}
                            className="inline-block w-1.5 h-1.5 rounded-full"
                            style={{ background: p.type === 'late_arrival' ? '#1D4ED8' : '#D97706' }}/>
                        ))}
                        {dayShifts.slice(0, 6).map(s => (
                          <span key={'s-' + s.id}
                            className="inline-block w-1.5 h-1.5 rounded-full"
                            style={{ background: '#9333EA' }}/>
                        ))}
                      </div>
                    )}

                    {/* Holiday label — compact one-line copper text */}
                    {holiday && (
                      <div className="text-[9px] leading-tight mt-1 truncate"
                        style={{ color: '#B45309', fontWeight: 700 }}>
                        {holiday.name}
                      </div>
                    )}

                    {/* One leave chip max in compact view — solid
                        colour with white text. The rest collapse to
                        a small +N indicator. Click cell for full list. */}
                    {leaves.length > 0 && (
                      <div className="mt-1">
                        {leaves.slice(0, 1).map(r => {
                          const emp = empMap[r.employee_id]; const tp = typeMap[r.leave_type_id];
                          if (!emp) return null;
                          const tpColor = tp?.color || '#0F4C2A';
                          return (
                            <div key={r.id}
                              className="text-[9px] px-1.5 py-0.5 rounded truncate"
                              style={{
                                background: tpColor,
                                color: '#FFFFFF',
                                fontWeight: 600,
                                boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
                              }}>
                              {emp.name.split(' ')[0]}
                              {leaves.length > 1 && <span style={{ opacity: 0.85 }}> +{leaves.length - 1}</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Hover preview */}
                    {hoveredISO === iso && (leaves.length + perms.length + dayShifts.length > 0 || holiday) && (
                      <HoverTooltip
                        iso={iso}
                        leaves={leaves}
                        perms={perms}
                        shifts={dayShifts}
                        holiday={holiday}
                        empMap={empMap}
                        typeMap={typeMap}
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
          leaves={scopedRequests.filter(r => r.status === 'approved' && r.start_date <= clickedISO && r.end_date >= clickedISO && (personFilter === 'all' || r.employee_id === personFilter))}
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
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs transition-all"
      style={{
        borderColor: active ? dot : 'var(--border-soft)',
        background:  active ? dot + '14' : '#FFFFFF',
        color:       active ? dot : '#0A0A0A',
        fontWeight:  active ? 700 : 500,
        opacity:     active ? 1 : 0.65,
        boxShadow:   active ? `0 1px 3px ${dot}33` : 'none',
      }}
      title={(active ? 'Hide ' : 'Show ') + label.toLowerCase()}>
      <span className="inline-block w-2 h-2 rounded-full" style={{
        background: dot,
        boxShadow: active ? `0 0 0 2px ${dot}33` : 'none',
      }}/>
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
          background: '#FFFFFF',
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
          background: '#FFFFFF',
          boxShadow: '0 12px 40px rgba(31,27,22,0.18)',
        }}>
        {/* Header */}
        <div className="flex items-start justify-between px-5 sm:px-6 py-4 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div>
            <div className="text-[10px] tracking-[0.25em] mb-1" style={{ fontWeight: 700, color: '#0A0A0A' }}>
              CALENDAR · DAY DETAIL
            </div>
            <h2 style={{ fontFamily: 'inherit', fontSize: '20px', color: '#0A0A0A', fontWeight: 500 }}>
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
        <div className="px-5 sm:px-6 py-3 border-t flex items-center justify-end" style={{ borderColor: 'var(--border-soft)', background: '#F7F7F7' }}>
          <button onClick={onClose}
            className="text-xs px-4 py-2 rounded-full"
            style={{ background: '#0A0A0A', color: '#FFFFFF', fontWeight: 500 }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
