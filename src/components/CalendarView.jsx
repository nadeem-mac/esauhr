import React, { useMemo, useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalIcon, Sunrise, Sunset } from 'lucide-react';
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
              <div key={i} className="min-h-[88px] sm:min-h-[112px] border-r border-b p-1.5"
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
                            style={{ background: 'rgba(147,51,234,0.15)', color: '#7E22CE' }}
                            title={dayShifts.length + ' shift(s) assigned'}>
                            {dayShifts.length}S
                          </span>
                        )}
                        {holiday && (
                          <div className="text-[9px] uppercase tracking-wider" style={{ color: '#0A0A0A', opacity: 0.7 }} title={holiday.name}>
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
                            title={emp.name + ' · ' + (tp?.name || '')}
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
                          const emp = empMap[p.employee_id];
                          const Icon = p.type === 'late_arrival' ? Sunrise : Sunset;
                          const color = p.type === 'late_arrival' ? '#1D4ED8' : '#A16207';
                          const tipName = (emp && emp.name) || p.employee_id;
                          const tipType = p.type === 'late_arrival' ? 'Late arrival' : 'Early leave';
                          return (
                            <span key={p.id}
                              className="inline-flex items-center justify-center w-4 h-4 rounded-full"
                              style={{ background: color + '18' }}
                              title={tipName + ' · ' + tipType + ' · ' + String(p.time_from || '').slice(0,5) + '–' + String(p.time_to || '').slice(0,5)}>
                              <Icon className="w-2.5 h-2.5" style={{ color: color }}/>
                            </span>
                          );
                        })}
                        {perms.length > 4 && (
                          <span className="text-[9px]" style={{ color: '#0A0A0A', opacity: 0.6 }}>+{perms.length - 4}</span>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

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
