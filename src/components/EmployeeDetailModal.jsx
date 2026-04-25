import React, { useMemo } from 'react';
import { X, Building2, MapPin, Calendar, Briefcase } from 'lucide-react';
import { Avatar, Pill } from './Dashboard.jsx';
import {
  calculateBalance, fmtDate, fmtDateShort, yearsOfService, monthsOfService, LOCATION_LABELS,
} from '../lib/leaveLogic.js';

export default function EmployeeDetailModal({ employee, leaveTypes, requests, balances, typeMap, onClose }) {
  const year = new Date().getFullYear();

  const balByType = useMemo(() => {
    return leaveTypes.map(t => {
      const adj = balances.find(b => b.leave_type_id === t.id && b.year === year) || {};
      return { type: t, balance: calculateBalance({ employee, leaveType: t, year, requests, adjustments: adj }) };
    });
  }, [leaveTypes, balances, requests, employee, year]);

  const history = useMemo(() => {
    return [...requests].sort((a, b) =>
      new Date(b.requested_at || b.created_at) - new Date(a.requested_at || a.created_at)
    );
  }, [requests]);

  const yos = yearsOfService(employee.join_date);
  const mos = monthsOfService(employee.join_date) % 12;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
         style={{ background: 'rgba(15, 31, 26, 0.4)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="rounded-t-2xl sm:rounded-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto fade-in"
        style={{ background: 'var(--paper)' }}>
        <div className="sticky top-0 z-10 flex items-center justify-between p-5 border-b backdrop-blur"
             style={{ borderColor: 'var(--border-soft)', background: 'rgba(250, 247, 240, 0.95)' }}>
          <div className="flex items-center gap-4 min-w-0">
            <Avatar id={employee.id} name={employee.name} size="xl"/>
            <div className="min-w-0">
              <div className="text-[10px] tracking-[0.25em] opacity-50 mono">{employee.id}</div>
              <h2 className="serif text-2xl truncate" style={{ fontWeight: 500, letterSpacing: '-0.01em' }}>{employee.name}</h2>
              <div className="text-xs opacity-60 flex flex-wrap items-center gap-3 mt-1">
                <span className="flex items-center gap-1"><Building2 className="w-3 h-3"/>{employee.department}</span>
                <span className="flex items-center gap-1"><MapPin className="w-3 h-3"/>{LOCATION_LABELS[employee.location] || employee.location}</span>
                {employee.join_date && (
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3 h-3"/>
                    Joined {fmtDate(employee.join_date)} · {yos}y {mos}m
                  </span>
                )}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-black/5 flex-shrink-0">
            <X className="w-5 h-5"/>
          </button>
        </div>

        <div className="p-5 space-y-6">
          <div>
            <div className="text-xs tracking-widest opacity-60 mb-3">LEAVE BALANCES · {year}</div>
            <div className="grid sm:grid-cols-2 gap-3">
              {balByType.map(({ type, balance }) => {
                const total = balance.total || 0;
                const used = balance.used + balance.pending;
                const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
                return (
                  <div key={type.id} className="rounded-xl border p-4"
                       style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ background: type.color }}/>
                        <div className="text-sm" style={{ fontWeight: 500 }}>{type.name}</div>
                      </div>
                      <Pill color={type.color}>{balance.available} left</Pill>
                    </div>
                    {total > 0 && (
                      <div className="h-1.5 rounded-full overflow-hidden mb-2" style={{ background: 'var(--border-soft)' }}>
                        <div className="h-full" style={{
                          width: `${pct}%`,
                          background: pct > 80 ? 'var(--clay)' : type.color,
                        }}/>
                      </div>
                    )}
                    <div className="grid grid-cols-3 gap-1 text-[11px] opacity-70">
                      <div>Entitled: <strong>{balance.total}</strong></div>
                      <div>Used: <strong>{balance.used}</strong></div>
                      <div>Pending: <strong>{balance.pending}</strong></div>
                    </div>
                    {balance.accrualNote && <div className="text-[10px] opacity-50 mt-1">{balance.accrualNote}</div>}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-xs tracking-widest opacity-60 mb-3">LEAVE HISTORY</div>
            {history.length === 0 ? (
              <div className="rounded-xl border p-6 text-center text-sm opacity-60"
                   style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
                <Briefcase className="w-5 h-5 mx-auto mb-2"/>
                No leave records yet.
              </div>
            ) : (
              <ul className="rounded-xl border divide-y"
                  style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
                {history.map(r => {
                  const tp = typeMap[r.leave_type_id];
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: tp?.color }}/>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm" style={{ fontWeight: 500 }}>{tp?.name || r.leave_type_id}</div>
                        <div className="text-xs opacity-60">{fmtDateShort(r.start_date)} → {fmtDateShort(r.end_date)} · {r.days}d</div>
                      </div>
                      <Pill color={r.status === 'approved' ? 'var(--evergreen-500)' : r.status === 'rejected' ? 'var(--clay)' : 'var(--copper)'}>
                        {r.status}
                      </Pill>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
