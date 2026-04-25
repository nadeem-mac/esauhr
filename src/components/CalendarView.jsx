import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalIcon } from 'lucide-react';
import { Card, Avatar, Pill, Empty } from './Dashboard.jsx';
import { toISO, todayISO, fmtDateShort, KSA_WEEKEND } from '../lib/leaveLogic.js';

export default function CalendarView({ requests, empMap, typeMap, holidays }) {
  const [viewDate, setViewDate] = useState(new Date());
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const monthName = viewDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startDow = firstDay.getDay(); // 0 = Sunday

  const holidayMap = useMemo(() => {
    const m = {};
    (holidays || []).forEach(h => { m[h.date] = h; });
    return m;
  }, [holidays]);

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const leavesOnDay = (day) => {
    if (!day) return [];
    const iso = toISO(new Date(year, month, day));
    return requests.filter(r => r.status === 'approved' && r.start_date <= iso && r.end_date >= iso);
  };

  const todayStr = todayISO();

  const monthLeaves = useMemo(() => {
    const monthStart = toISO(firstDay);
    const monthEnd = toISO(lastDay);
    return requests
      .filter(r => r.status === 'approved' && !(r.end_date < monthStart || r.start_date > monthEnd))
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
  }, [requests, year, month]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] tracking-[0.25em] opacity-50 mb-2">CALENDAR</div>
          <h1 className="serif text-4xl" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>{monthName}</h1>
        </div>
        <div className="flex gap-1">
          <button onClick={() => setViewDate(new Date(year, month - 1, 1))}
            className="p-2 rounded-full border" style={{ borderColor: 'var(--border-soft)' }}>
            <ChevronLeft className="w-4 h-4"/>
          </button>
          <button onClick={() => setViewDate(new Date())}
            className="px-4 py-2 rounded-full border text-sm"
            style={{ borderColor: 'var(--border-soft)' }}>Today</button>
          <button onClick={() => setViewDate(new Date(year, month + 1, 1))}
            className="p-2 rounded-full border" style={{ borderColor: 'var(--border-soft)' }}>
            <ChevronRight className="w-4 h-4"/>
          </button>
        </div>
      </div>

      <div className="rounded-xl border overflow-hidden"
           style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
        <div className="grid grid-cols-7 text-[10px] tracking-widest opacity-60 border-b"
             style={{ borderColor: 'var(--border-soft)' }}>
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
            const holiday = iso ? holidayMap[iso] : null;
            const leaves = leavesOnDay(d);

            let bg = 'transparent';
            if (!d) bg = 'rgba(247,243,234,0.5)';
            else if (isToday) bg = 'rgba(45,95,63,0.08)';
            else if (holiday) bg = 'rgba(196,155,97,0.12)';
            else if (isWeekend) bg = 'rgba(247,243,234,0.5)';

            return (
              <div key={i} className="min-h-[96px] border-r border-b p-1.5"
                   style={{ borderColor: 'var(--border-soft)', background: bg }}>
                {d && (
                  <>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-xs" style={{
                        fontWeight: isToday ? 600 : 400,
                        color: isToday ? 'var(--evergreen-500)' : 'inherit',
                      }}>{d}</div>
                      {holiday && (
                        <div className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--copper)' }} title={holiday.name}>
                          HOLIDAY
                        </div>
                      )}
                      {isToday && !holiday && <div className="w-1 h-1 rounded-full" style={{ background: 'var(--evergreen-500)' }}/>}
                    </div>
                    {holiday && (
                      <div className="text-[10px] opacity-75 leading-tight mb-1" style={{ color: 'var(--copper)' }}>
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
                            title={`${emp.name} · ${tp?.name}`}
                            style={{ background: `${tp?.color}25`, color: tp?.color }}>
                            {emp.name.split(' ')[0]}
                          </div>
                        );
                      })}
                      {leaves.length > 3 && (
                        <div className="text-[10px] opacity-60 px-1">+{leaves.length - 3} more</div>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <Card title="Approved leaves this month" subtitle={`${monthLeaves.length} entries`}>
        {monthLeaves.length === 0 ? (
          <Empty icon={CalIcon} message="No approved leaves this month."/>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--border-soft)' }}>
            {monthLeaves.map(r => {
              const emp = empMap[r.employee_id]; const tp = typeMap[r.leave_type_id];
              if (!emp) return null;
              return (
                <li key={r.id} className="flex items-center gap-3 py-2.5">
                  <Avatar id={emp.id} name={emp.name}/>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate" style={{ fontWeight: 500 }}>{emp.name}</div>
                    <div className="text-xs opacity-60">{emp.department} · {emp.location}</div>
                  </div>
                  <div className="text-right">
                    <Pill color={tp?.color}>{tp?.name}</Pill>
                    <div className="text-xs opacity-60 mt-1">{fmtDateShort(r.start_date)} → {fmtDateShort(r.end_date)} · {r.days}d</div>
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
