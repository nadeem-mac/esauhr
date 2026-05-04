import React, { useMemo, useState } from 'react';
import { Search, Users } from 'lucide-react';
import { Avatar, Empty } from './Dashboard.jsx';
import { LOCATION_LABELS, calculateBalance } from '../lib/leaveLogic.js';

export default function Employees({ employees, leaveTypes, requests, balances, onSelect }) {
  const [search, setSearch] = useState('');
  const [location, setLocation] = useState('ALL');
  const [department, setDepartment] = useState('ALL');

  const locations = useMemo(() => ['ALL', ...Array.from(new Set(employees.map(e => e.location)))], [employees]);
  const departments = useMemo(() => ['ALL', ...Array.from(new Set(employees.map(e => e.department)))], [employees]);

  const filtered = useMemo(() => employees.filter(e => {
    if (location !== 'ALL' && e.location !== location) return false;
    if (department !== 'ALL' && e.department !== department) return false;
    if (search) {
      const s = search.toLowerCase();
      if (!e.name.toLowerCase().includes(s) && !e.id.toLowerCase().includes(s)) return false;
    }
    return true;
  }), [employees, location, department, search]);

  const annualType = leaveTypes.find(t => t.id === 'annual');

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[10px] tracking-[0.25em] opacity-50 mb-2">ROSTER</div>
        <h1 className="serif text-4xl" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>
          {filtered.length} {filtered.length === 1 ? 'person' : 'people'}
        </h1>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 opacity-40"/>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search name or ID…"
            className="w-full pl-9 pr-3 py-2 rounded-full text-sm border bg-transparent focus:outline-none"
            style={{ borderColor: 'var(--border-soft)' }}/>
        </div>
        <select value={location} onChange={e => setLocation(e.target.value)}
          className="px-3 py-2 rounded-full text-sm border bg-transparent"
          style={{ borderColor: 'var(--border-soft)' }}>
          {locations.map(l => <option key={l} value={l}>{l === 'ALL' ? 'All locations' : (LOCATION_LABELS[l] || l)}</option>)}
        </select>
        <select value={department} onChange={e => setDepartment(e.target.value)}
          className="px-3 py-2 rounded-full text-sm border bg-transparent"
          style={{ borderColor: 'var(--border-soft)' }}>
          {departments.map(d => <option key={d} value={d}>{d === 'ALL' ? 'All departments' : d}</option>)}
        </select>
      </div>

      <div className="rounded-xl border overflow-hidden"
           style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}>
        <div className="hidden md:grid grid-cols-12 gap-3 px-4 py-3 text-[10px] tracking-widest opacity-60 border-b"
             style={{ borderColor: 'var(--border-soft)' }}>
          <div className="col-span-5">NAME</div>
          <div className="col-span-2">ID</div>
          <div className="col-span-2">DEPT · LOCATION</div>
          <div className="col-span-3 text-right">ANNUAL LEAVE</div>
        </div>
        {filtered.length === 0 ? (
          <Empty icon={Users} message="No employees match your filters."/>
        ) : (
          filtered.map(emp => {
            const bal = annualType ? calculateBalance({
              employee: emp,
              leaveType: annualType,
              year: new Date().getFullYear(),
              requests,
              adjustments: balances.find(b => b.employee_id === emp.id && b.leave_type_id === 'annual' && b.year === new Date().getFullYear()) || {},
            }) : null;

            const pct = bal && bal.total > 0 ? Math.min(100, ((bal.used + bal.pending) / bal.total) * 100) : 0;

            return (
              <button key={emp.id} onClick={() => onSelect(emp)}
                className="w-full grid grid-cols-1 md:grid-cols-12 gap-3 px-4 py-3 text-left border-b hover:bg-black/[0.02] transition-colors"
                style={{ borderColor: 'var(--border-soft)' }}>
                <div className="col-span-5 flex items-center gap-3">
                  <Avatar id={emp.id} name={emp.name}/>
                  <div className="min-w-0">
                    <div className="text-sm truncate" style={{ fontWeight: 500 }}>{emp.name}</div>
                    <div className="text-xs opacity-50 md:hidden mono">{emp.id}</div>
                  </div>
                </div>
                <div className="col-span-2 hidden md:flex items-center text-sm mono opacity-70">{emp.id}</div>
                <div className="col-span-2 hidden md:flex items-center text-sm opacity-80">{emp.department} · {emp.location}</div>
                <div className="col-span-3 flex md:justify-end items-center gap-3">
                  {bal && (
                    <>
                      <div className="flex-1 md:flex-none md:w-24">
                        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border-soft)' }}>
                          <div className="h-full transition-all" style={{
                            width: `${pct}%`,
                            background: pct > 80 ? 'var(--clay)' : 'var(--evergreen-500)',
                          }}/>
                        </div>
                      </div>
                      <div className="text-right min-w-[70px]">
                        <div className="text-sm" style={{ fontWeight: 500 }}>
                          {bal.available}<span className="opacity-40 text-xs"> / {bal.total}</span>
                        </div>
                        <div className="text-xs opacity-50">days left</div>
                      </div>
                    </>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
