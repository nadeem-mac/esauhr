import React, { useMemo } from 'react';
import { Check, ArrowRight, Palmtree, Calendar } from 'lucide-react';
import { todayISO, fmtDateShort, getInitials, avatarColor } from '../lib/leaveLogic.js';

export default function Dashboard({ employees, requests, typeMap, empMap, onGoToRequests, onNewRequest }) {
  const today = todayISO();

  const onLeaveToday = useMemo(
    () => requests.filter(r => r.status === 'approved' && r.start_date <= today && r.end_date >= today),
    [requests, today]
  );

  const pending = useMemo(
    () => requests.filter(r => r.status === 'pending').sort((a,b) => new Date(b.requested_at) - new Date(a.requested_at)),
    [requests]
  );

  const upcoming = useMemo(() => {
    return requests
      .filter(r => r.status === 'approved' && r.start_date > today)
      .sort((a,b) => a.start_date.localeCompare(b.start_date))
      .slice(0, 8);
  }, [requests, today]);

  const approvedThisMonth = useMemo(() => {
    const now = new Date();
    return requests.filter(r => {
      if (r.status !== 'approved') return false;
      const d = new Date(r.start_date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;
  }, [requests]);

  const byLocation = useMemo(() => {
    const m = { DMM: 0, JED: 0, RYD: 0 };
    employees.forEach(e => { m[e.location] = (m[e.location] || 0) + 1; });
    return m;
  }, [employees]);

  const byDept = useMemo(() => {
    const m = {};
    employees.forEach(e => { m[e.department] = (m[e.department] || 0) + 1; });
    return Object.entries(m).sort((a,b) => b[1] - a[1]);
  }, [employees]);

  return (
    <div className="space-y-8">
      {/* Hero */}
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-2 mb-3 text-xs tracking-[0.25em] opacity-50">
            <div className="w-6 h-px" style={{ background: 'var(--evergreen-500)' }}/>
            OVERVIEW
          </div>
          <h1 className="serif text-[clamp(2.5rem,5vw,4rem)] leading-[0.98]"
              style={{ fontWeight: 500, letterSpacing: '-0.025em' }}>
            Good day.
          </h1>
          <p className="text-base opacity-70 mt-4 max-w-xl">
            {pending.length > 0
              ? <>You have <span style={{ color: 'var(--clay)', fontWeight: 500 }}>{pending.length} pending {pending.length === 1 ? 'request' : 'requests'}</span> waiting on your decision, and <span style={{ fontWeight: 500 }}>{onLeaveToday.length}</span> {onLeaveToday.length === 1 ? 'person is' : 'people are'} out of office today.</>
              : <>Your queue is clear. <span style={{ fontWeight: 500 }}>{onLeaveToday.length}</span> {onLeaveToday.length === 1 ? 'person is' : 'people are'} out of office today.</>
            }
          </p>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Staff" value={employees.length}
                  sub={`${byLocation.DMM || 0} DMM · ${byLocation.JED || 0} JED · ${byLocation.RYD || 0} RYD`}/>
        <StatCard label="On Leave Today" value={onLeaveToday.length}
                  sub="Currently out of office" accent="var(--evergreen-500)"/>
        <StatCard label="Pending Approval" value={pending.length}
                  sub="Awaiting your decision" accent="var(--clay)" onClick={onGoToRequests}/>
        <StatCard label="Approved This Month" value={approvedThisMonth}
                  sub={new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}/>
      </div>

      {/* Three column summary */}
      <div className="grid lg:grid-cols-3 gap-5">
        <Card title="Out of office today" subtitle={`${onLeaveToday.length} ${onLeaveToday.length === 1 ? 'person' : 'people'}`}>
          {onLeaveToday.length === 0 ? (
            <Empty icon={Palmtree} message="Full house — nobody on leave today."/>
          ) : (
            <ul className="space-y-3">
              {onLeaveToday.map(r => {
                const emp = empMap[r.employee_id]; const tp = typeMap[r.leave_type_id];
                if (!emp) return null;
                return (
                  <li key={r.id} className="flex items-center gap-3">
                    <Avatar id={emp.id} name={emp.name}/>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate" style={{ fontWeight: 500 }}>{emp.name}</div>
                      <div className="text-xs opacity-60">{emp.department} · {emp.location}</div>
                    </div>
                    <div className="text-right">
                      <Pill color={tp?.color}>{tp?.name || r.leave_type_id}</Pill>
                      <div className="text-xs opacity-60 mt-1">until {fmtDateShort(r.end_date)}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Pending requests" subtitle={pending.length > 0 ? 'Needs action' : 'Queue is empty'} accent="var(--clay)">
          {pending.length === 0 ? (
            <Empty icon={Check} message="Nothing to approve — nice."/>
          ) : (
            <ul className="space-y-3">
              {pending.slice(0, 5).map(r => {
                const emp = empMap[r.employee_id]; const tp = typeMap[r.leave_type_id];
                if (!emp) return null;
                return (
                  <li key={r.id} className="flex items-center gap-3">
                    <Avatar id={emp.id} name={emp.name}/>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate" style={{ fontWeight: 500 }}>{emp.name}</div>
                      <div className="text-xs opacity-60">{tp?.name} · {r.days} {Number(r.days) === 1 ? 'day' : 'days'}</div>
                    </div>
                    <div className="text-xs opacity-60">{fmtDateShort(r.start_date)}</div>
                  </li>
                );
              })}
              {pending.length > 5 && (
                <li>
                  <button onClick={onGoToRequests} className="text-xs flex items-center gap-1 opacity-70 hover:opacity-100">
                    See {pending.length - 5} more <ArrowRight className="w-3 h-3"/>
                  </button>
                </li>
              )}
            </ul>
          )}
        </Card>

        <Card title="Upcoming leaves" subtitle="Next 8 approved">
          {upcoming.length === 0 ? (
            <Empty icon={Calendar} message="Nothing on the calendar yet."/>
          ) : (
            <ul className="space-y-3">
              {upcoming.map(r => {
                const emp = empMap[r.employee_id]; const tp = typeMap[r.leave_type_id];
                if (!emp) return null;
                return (
                  <li key={r.id} className="flex items-center gap-3">
                    <div className="w-10 text-center flex-shrink-0">
                      <div className="serif text-lg leading-none" style={{ fontWeight: 500 }}>
                        {new Date(r.start_date).getDate()}
                      </div>
                      <div className="text-[10px] uppercase tracking-wider opacity-50 mt-0.5">
                        {new Date(r.start_date).toLocaleDateString('en-GB', { month: 'short' })}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate" style={{ fontWeight: 500 }}>{emp.name}</div>
                      <div className="text-xs opacity-60">{tp?.name} · {r.days}d</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* Headcount by department */}
      <Card title="Headcount by department" subtitle={`${employees.length} active employees`}>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 pt-2">
          {byDept.map(([dept, count]) => (
            <div key={dept} className="p-4 rounded-lg border" style={{ borderColor: 'var(--border-soft)', background: 'var(--paper)' }}>
              <div className="text-[10px] tracking-widest opacity-60">{dept}</div>
              <div className="serif text-3xl mt-1" style={{ fontWeight: 500 }}>{count}</div>
              <div className="text-xs opacity-50 mt-1">{Math.round((count / employees.length) * 100)}%</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ──── small UI primitives shared across pages ──── */
export function Card({ title, subtitle, children, accent }) {
  return (
    <div className="rounded-xl border p-5" style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
      {(title || subtitle) && (
        <div className="flex items-baseline justify-between mb-4 pb-3 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-2">
            {accent && <div className="w-1.5 h-1.5 rounded-full" style={{ background: accent }}/>}
            <h3 className="serif text-lg" style={{ fontWeight: 500 }}>{title}</h3>
          </div>
          {subtitle && <div className="text-xs opacity-60">{subtitle}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function StatCard({ label, value, sub, accent = 'var(--ink)', onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick}
      className={`text-left rounded-xl border p-5 block w-full ${onClick ? 'hover:shadow-md transition-shadow cursor-pointer' : ''}`}
      style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
      <div className="text-[10px] tracking-widest opacity-60">{label.toUpperCase()}</div>
      <div className="serif text-[3rem] mt-2 leading-none" style={{ color: accent, fontWeight: 500, letterSpacing: '-0.02em' }}>{value}</div>
      <div className="text-xs opacity-60 mt-2">{sub}</div>
    </Tag>
  );
}

export function Avatar({ id, name, size = 'md' }) {
  const dim = { sm: 'w-7 h-7 text-[10px]', md: 'w-9 h-9 text-xs', lg: 'w-11 h-11 text-sm', xl: 'w-16 h-16 text-lg' }[size];
  return (
    <div className={`${dim} rounded-full flex items-center justify-center flex-shrink-0`}
         style={{ background: avatarColor(id), color: '#F4EEDF', fontWeight: 600, letterSpacing: '0.05em' }}>
      {getInitials(name)}
    </div>
  );
}

export function Pill({ color = 'var(--evergreen-500)', children }) {
  return (
    <span className="text-[11px] px-2 py-0.5 rounded-full inline-block"
          style={{ background: `${color}18`, color, fontWeight: 500 }}>
      {children}
    </span>
  );
}

export function Empty({ icon: Icon, message }) {
  return (
    <div className="text-center py-8 opacity-50">
      <Icon className="w-6 h-6 mx-auto mb-2"/>
      <div className="text-sm">{message}</div>
    </div>
  );
}
