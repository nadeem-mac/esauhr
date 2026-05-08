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

  // Access scope. Three tiers:
  //
  //   • admin / HR reviewer (Nadeem, Bashaier, Badria when added)
  //     → see every staff member's events. Workforce-wide visibility.
  //
  //   • manager (anyone with at least one direct report in empMap)
  //     → see their direct reports' events PLUS their own. Mirrors
  //       the ManagerDashboard's data scope. They need to plan around
  //       team absences and review shifts/permissions for their
  //       reports, while still seeing what THEY personally have on.
  //
  //   • regular staff
  //     → see only their own events. Colleague absences stay private.
  //
  // Defense in depth: the scope is enforced both in the self-fetch
  // queries below (server-side filter) AND in the client-side
  // filters, so even a future change to upstream props can't leak
  // unscoped data to a regular user.
  const canSeeAll = Boolean(me?.is_admin || me?.is_hr_reviewer);

  // Direct reports — derived from empMap. Anyone whose manager_id
  // points to me is on my team. Memoised so the dep-array stays
  // stable across renders that don't change the employee list.
  const directReportIds = useMemo(() => {
    if (!me?.id) return [];
    const ids = [];
    Object.values(empMap || {}).forEach(emp => {
      if (emp?.manager_id === me.id && emp?.id && emp.id !== me.id) {
        ids.push(emp.id);
      }
    });
    return ids;
  }, [empMap, me?.id]);

  // Final scope set: null means "see all", a Set means "filter to
  // these ids only". Admin/HR get null. Managers get a Set
  // containing themselves plus their reports. Regular staff get a
  // singleton Set with just themselves.
  const scopeSet = useMemo(() => {
    if (canSeeAll) return null;
    if (!me?.id) return null;
    const s = new Set([me.id]);
    directReportIds.forEach(id => s.add(id));
    return s;
  }, [canSeeAll, me?.id, directReportIds]);

  // Querystring fragment for server-side scoping. Empty string when
  // the user can see everything; otherwise an in.(...) filter
  // listing every id in the scope set. Encoded so PSNs with weird
  // characters don't break the URL.
  const scopeQs = useMemo(() => {
    if (!scopeSet) return '';
    const ids = Array.from(scopeSet);
    if (ids.length === 0) return '';
    return '&employee_id=in.(' + ids.map(encodeURIComponent).join(',') + ')';
  }, [scopeSet]);

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startDow = firstDay.getDay();

  // Default chip state: all four categories ON. Per Nadeem
  // (2026-05-09) the calendar is most useful when it shows the
  // full picture by default — toggling things off is the user's
  // call. Previously Shifts started off, which hid the most
  // operationally relevant category for managers.
  const [showLeaves, setShowLeaves]           = useState(true);
  const [showPermissions, setShowPermissions] = useState(true);
  const [showShifts, setShowShifts]           = useState(true);
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
      // Server-side scoping via the precomputed scopeQs (empty for
      // admin/HR, in.(self+reports) for managers, in.(self) for
      // regular staff). Defense in depth on top of the client-side
      // filter below.
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
  }, [permsProp, year, month, scopeQs]);
  useEffect(() => { refetchPermsLocal(); }, [refetchPermsLocal]);

  // When the parent passes permissions and the user can't see all,
  // clip the prop to the user's scope so we don't leak even via
  // accidentally-broad parent fetches.
  const permissions = useMemo(() => {
    const source = Array.isArray(permsProp) ? permsProp : permsLocal;
    if (!scopeSet) return source;
    return source.filter(p => scopeSet.has(p.employee_id));
  }, [permsProp, permsLocal, scopeSet]);

  // Shifts: self-fetch the visible month, scoped to the user when
  // they're not allowed to see everyone's.
  const [shifts, setShifts] = useState([]);
  const refetchShifts = useCallback(async () => {
    try {
      const monthStart = toISO(firstDay);
      const monthEnd   = toISO(lastDay);
      const data = await directGet(
        'employee_shifts?select=id,employee_id,shift_date,start_time,end_time,status'
        + '&shift_date=gte.' + monthStart
        + '&shift_date=lte.' + monthEnd
        + scopeQs
        + '&order=shift_date.asc'
      );
      setShifts(data || []);
    } catch (e) {
      setShifts([]);
    }
  }, [year, month, scopeQs]);
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
  // through the scopeSet for non-admin/HR users. Memoised so the
  // lookup helpers below stay stable.
  const scopedRequests = useMemo(() => {
    if (!scopeSet) return requests;
    return (requests || []).filter(r => scopeSet.has(r.employee_id));
  }, [requests, scopeSet]);

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
        <div className="grid grid-cols-7 text-[10px] tracking-wider"
             style={{
               background: '#FFFFFF',
               borderBottom: '1px solid #EEEAE0',
               color: '#7A7A7A',
               fontWeight: 500,
             }}>
          {['SUN','MON','TUE','WED','THU','FRI','SAT'].map((d, i) => (
            <div key={d} className="px-2 py-2.5 text-center"
              style={{ borderRight: i < 6 ? '1px solid #EEEAE0' : 'none' }}>
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

            // Cell background — minimal palette so the data does the
            // talking. Today gets a subtle green wash; everything else
            // is plain white. Holidays and weekends are signalled
            // through text colour, not background fill, which keeps
            // the grid feeling calm even on a busy month.
            let bg = '#FFFFFF';
            if (isToday) {
              bg = '#F1FBF7'; // very soft brand-green wash
            }
            // Out-of-month cells stay #FFFFFF so they vanish into the
            // grid chrome instead of forming a beige block at the top
            // or bottom of the month.

            const isSelected = selectedISO === iso;

            // Build event chips — text chips with the staff member's
            // first name + a context bit (shift time / leave type /
            // permission kind). Two chips visible inline; everything
            // else collapses to "+N more". Reads instantly compared to
            // colour-only dots, and the modal still shows full detail.
            const chips = [];
            for (const r of leaves) {
              const emp = empMap[r.employee_id];
              const tp  = typeMap[r.leave_type_id];
              if (!emp) continue;
              chips.push({
                key: 'l-' + r.id,
                label: emp.name.split(' ')[0],
                bg: '#FAECE7', fg: '#993C1D',
              });
            }
            for (const s of dayShifts) {
              const emp = empMap[s.employee_id];
              if (!emp) continue;
              const t = s.start_time
                ? ' · ' + String(s.start_time).slice(0, 5)
                : '';
              chips.push({
                key: 's-' + s.id,
                label: emp.name.split(' ')[0] + t,
                bg: '#EEEDFE', fg: '#534AB7',
              });
            }
            for (const p of perms) {
              const emp = empMap[p.employee_id];
              if (!emp) continue;
              chips.push({
                key: 'p-' + p.id,
                label: emp.name.split(' ')[0],
                bg: '#FAEEDA', fg: '#854F0B',
              });
            }
            const VISIBLE_CHIPS = 2;
            const visibleChips = chips.slice(0, VISIBLE_CHIPS);
            const chipOverflow = chips.length - visibleChips.length;

            return (
              <div key={i}
                onMouseEnter={() => d && setHoveredISO(iso)}
                onMouseLeave={() => setHoveredISO(prev => prev === iso ? null : prev)}
                onClick={() => {
                  if (!d) return;
                  setSelectedISO(iso);
                  if (hasEvents) setClickedISO(iso);
                }}
                className={"min-h-[78px] sm:min-h-[88px] p-2 relative transition-all duration-150 " +
                  (d && hasEvents ? "cursor-pointer hover:bg-[#FAFAF9]" : d ? "cursor-default" : "")}
                style={{
                  borderRight:  dow < 6 ? '1px solid #EEEAE0' : 'none',
                  borderBottom: '1px solid #EEEAE0',
                  background: bg,
                  // Selected cell — subtle 1px accent on the left edge
                  // instead of a heavy 2px inset ring. Still visible
                  // when scanning sequentially but doesn't dominate.
                  boxShadow: isSelected
                    ? 'inset 2px 0 0 0 #0F4C2A'
                    : undefined,
                }}>
                {d && (
                  <>
                    {/* Date number row — today gets a small green dot
                        before the number; weekends and out-of-month
                        days get a dimmer colour. No circular badge,
                        no event-count pill — chips below carry that
                        signal naturally. */}
                    <div className="flex items-center gap-1.5">
                      {isToday && (
                        <span aria-hidden style={{
                          width: '6px', height: '6px', borderRadius: '50%',
                          background: '#0F6E56', flexShrink: 0,
                        }}/>
                      )}
                      <span className="text-[12px]" style={{
                        fontWeight: isToday ? 600 : 500,
                        color: holiday
                          ? '#854F0B'
                          : isToday
                          ? '#0F6E56'
                          : isWeekend
                          ? '#A8A29A'
                          : '#0A0A0A',
                      }}>{d}</span>
                    </div>

                    {/* Holiday name — small amber text, no bg, no bold
                        so it sits quietly under the date. */}
                    {holiday && (
                      <div className="text-[10px] leading-tight mt-1 truncate"
                        style={{ color: '#854F0B', fontWeight: 500 }}>
                        {holiday.name}
                      </div>
                    )}

                    {/* Event chips — one per row, name + brief context.
                        Truncates with ellipsis so even long names stay
                        on a single line. */}
                    {visibleChips.length > 0 && (
                      <div className="mt-1.5 space-y-0.5">
                        {visibleChips.map(c => (
                          <div key={c.key}
                            className="text-[10px] px-1.5 py-px rounded truncate"
                            style={{
                              background: c.bg, color: c.fg,
                              fontWeight: 500, lineHeight: '1.4',
                            }}>
                            {c.label}
                          </div>
                        ))}
                        {chipOverflow > 0 && (
                          <div className="text-[10px] leading-tight"
                            style={{ color: '#7A7A7A', fontWeight: 500 }}>
                            +{chipOverflow} more
                          </div>
                        )}
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
                        anchorLeft={dow <= 1}
                        anchorRight={dow >= 5}
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
function HoverTooltip({ iso, leaves, perms, shifts, holiday, empMap, typeMap, anchorAbove, anchorLeft, anchorRight }) {
  const dateLabel = new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const totalCount = leaves.length + perms.length + shifts.length;

  // Horizontal anchoring — tooltip is up to 320px wide, so on the
  // Sun/Mon columns it overflows the grid's left edge if centred,
  // and on Fri/Sat it overflows the right edge. Detect via the
  // dow-derived anchorLeft/anchorRight flags from the caller and
  // pin to the cell edge instead. Centred anchoring stays as the
  // default for middle columns where there's room to spread.
  const hAnchor = anchorLeft
    ? { left: 0 }
    : anchorRight
    ? { right: 0 }
    : { left: '50%', transform: 'translateX(-50%)' };

  return (
    <div className="absolute z-50 pointer-events-none"
      style={{
        ...(anchorAbove
          ? { bottom: '100%', marginBottom: '6px' }
          : { top: '100%', marginTop: '6px' }),
        ...hAnchor,
        // Width sized to fit the longest realistic 'NAME → 11:00 – 20:00'
        // single-line case (e.g. ABDULRAHMAN NASSER AHMED ALGHAMDI →
        // 11:00 – 20:00, ~50 chars at 11px). Old cap of 320px forced
        // wraps. Also clamps to viewport on narrow screens so it
        // never overflows the grid edge.
        minWidth: '260px',
        maxWidth: 'min(480px, calc(100vw - 24px))',
        width: 'max-content',
      }}>
      <div className="rounded-xl shadow-lg p-3"
        style={{
          background: '#FFFFFF',
          // Stronger, brand-warm border so the tooltip reads as a
          // distinct floating surface against the calendar grid
          // (previously the soft grey border vanished against the
          // shadow). 1.5px in the dark warm-grey used for primary
          // text — visible without being heavy.
          border: '1.5px solid #1F1B16',
          boxShadow: '0 10px 28px rgba(31, 27, 22, 0.18)',
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
                const timeStr = `${String(p.time_from || '').slice(0,5)} – ${String(p.time_to || '').slice(0,5)}`;
                return (
                  // Inline row, same shape as shifts. Wrapping happens
                  // at the gap between name and detail when narrow;
                  // the 'Late arrival 08:00 – 08:30' detail itself is
                  // a single nowrap span so it never breaks mid-string.
                  <li key={p.id} className="flex items-start gap-1.5 text-[11px]" style={{ color: '#0A0A0A' }}>
                    <Icon className="w-3 h-3 flex-shrink-0" style={{ color, marginTop: 2 }}/>
                    <div className="flex-1 min-w-0" style={{ lineHeight: 1.5 }}>
                      <span style={{ fontWeight: 600 }}>{emp?.name || p.employee_id}</span>
                      <span style={{ opacity: 0.7, whiteSpace: 'nowrap' }}>{' → '}{label} {timeStr}</span>
                    </div>
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
                const timeStr = (s.start_time && s.end_time)
                  ? `${String(s.start_time).slice(0,5)} – ${String(s.end_time).slice(0,5)}`
                  : '';
                return (
                  // Single inline row: name → time. Wraps at word
                  // boundaries when narrow but the time itself is
                  // wrapped in a nowrap span so it never breaks
                  // mid-string (was '11:00-' / '20:00' before).
                  <li key={s.id} className="flex items-start gap-1.5 text-[11px]" style={{ color: '#0A0A0A' }}>
                    <Briefcase className="w-3 h-3 flex-shrink-0" style={{ color: '#7E22CE', marginTop: 2 }}/>
                    <div className="flex-1 min-w-0" style={{ lineHeight: 1.5 }}>
                      <span style={{ fontWeight: 600 }}>{emp?.name || s.employee_id}</span>
                      {timeStr && (
                        <span style={{ opacity: 0.7, whiteSpace: 'nowrap' }}>{' → '}{timeStr}</span>
                      )}
                    </div>
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
                            {s.start_time && s.end_time
                              ? ` · ${String(s.start_time).slice(0,5)}–${String(s.end_time).slice(0,5)}`
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
