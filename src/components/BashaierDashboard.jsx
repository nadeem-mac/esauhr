import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../supabaseClient.js';
import {
  Clock, CheckCircle2, XCircle, AlertTriangle, Loader2,
  Sunrise, Sunset, Calendar
} from 'lucide-react';
import { fmtDate } from '../lib/leaveLogic.js';

// BASHAIER OVERSIGHT DASHBOARD
// ─────────────────────────────
// Shown when the signed-in user is a reviewer but not an admin
// (Bashaier and anyone else with can_review_leave or can_review_permissions).
//
// Three sections:
//   1. Hero greeting + colourful KPI tiles (filtered by today/week/month)
//   2. Pending-by-department breakdown (workload distribution)
//   3. Recent decisions feed (last 8 approve/reject actions)
//
// All data is realtime via supabase channels.

const RANGES = [
  { id: 'today', label: 'Today',      days: 1  },
  { id: 'week',  label: 'This week',  days: 7  },
  { id: 'month', label: 'This month', days: 30 },
];

export default function BashaierDashboard({ me, employees, leaveTypes, onOpenNewRequest }) {
  const [range, setRange]             = useState('week');
  const [requests, setRequests]       = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading]         = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [reqs, perms] = await Promise.all([
        supabase.from('leave_requests').select('*').order('requested_at', { ascending: false }),
        supabase.from('permission_requests').select('*').order('permission_date', { ascending: false }),
      ]);
      setRequests(reqs.data || []);
      setPermissions(perms.data || []);
    } catch (err) {
      console.warn('BashaierDashboard load failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const ch = supabase.channel('bashaier-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leave_requests' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'permission_requests' }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const cutoffISO = useMemo(() => {
    const days = RANGES.find(r => r.id === range)?.days || 7;
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(0,0,0,0);
    return d.toISOString();
  }, [range]);

  const all = [...requests, ...permissions];
  const pending = all.filter(r => r.status === 'pending');

  const inRange = useCallback((r) => {
    const ts = r.decided_at || r.requested_at || r.created_at;
    return ts && ts >= cutoffISO;
  }, [cutoffISO]);

  const approvedInRange = all.filter(r => r.status === 'approved' && inRange(r));
  const rejectedInRange = all.filter(r => r.status === 'rejected' && inRange(r));
  const flaggedInRange  = permissions.filter(p =>
    p.exceeds_quota && p.permission_date >= cutoffISO.slice(0,10)
  );

  const empMap = useMemo(
    () => Object.fromEntries(employees.map(e => [e.id, e])),
    [employees]
  );

  const pendingByDept = useMemo(() => {
    const m = {};
    for (const r of pending) {
      const e = empMap[r.employee_id];
      const dept = e?.department || 'Unknown';
      m[dept] = (m[dept] || 0) + 1;
    }
    return Object.entries(m).sort((a,b) => b[1] - a[1]);
  }, [pending, empMap]);

  const recentDecisions = all
    .filter(r => r.status === 'approved' || r.status === 'rejected')
    .sort((a,b) => {
      const ta = a.decided_at || a.requested_at || '';
      const tb = b.decided_at || b.requested_at || '';
      return tb.localeCompare(ta);
    })
    .slice(0, 8);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <div className="text-center opacity-60">
          <Loader2 className="w-6 h-6 mx-auto animate-spin mb-3" />
          <div className="text-xs tracking-widest">LOADING OVERSIGHT</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* HERO */}
      <section>
        <div className="text-[10px] tracking-[0.3em] opacity-50 mb-2 flex items-center gap-2">
          <span className="inline-block w-7 h-px bg-current" />OVERSIGHT
        </div>
        <h1 className="serif text-5xl leading-none" style={{ fontWeight: 600, letterSpacing: '-0.025em' }}>
          Hello, <span className="italic" style={{ color:'var(--evergreen-500)', fontWeight: 400 }}>{firstName(me?.name)}.</span>
        </h1>
        <p className="text-sm opacity-70 mt-2">
          {pending.length === 0
            ? 'The pipeline is clear — no pending requests company-wide.'
            : `${pending.length} request${pending.length !== 1 ? 's' : ''} pending across the company. Open the Reviews tab to act on them.`}
        </p>
      </section>

      {/* RANGE FILTER */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] tracking-[0.25em] opacity-60 mr-2">VIEW:</span>
        {RANGES.map(r => (
          <button key={r.id} onClick={() => setRange(r.id)}
            className="px-3 py-1.5 rounded-full text-xs font-semibold transition-colors"
            style={range === r.id
              ? { background: 'var(--ink)', color: 'var(--paper)' }
              : { background: 'rgba(15,40,24,0.06)', color: 'var(--ink)' }}>
            {r.label}
          </button>
        ))}
      </div>

      {/* KPI TILES */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <ColorTile
          gradient="linear-gradient(135deg, #FBBF24 0%, #F97316 100%)"
          label="PENDING"  icon={Clock}
          stat={pending.length}
          desc={pending.length === 0 ? 'Nothing waiting.' : 'Across all departments.'}
        />
        <ColorTile
          gradient="linear-gradient(135deg, #34D399 0%, #059669 100%)"
          label="APPROVED" icon={CheckCircle2}
          stat={approvedInRange.length}
          desc="In the selected range."
        />
        <ColorTile
          gradient="linear-gradient(135deg, #EF4444 0%, #B91C1C 100%)"
          label="REJECTED" icon={XCircle}
          stat={rejectedInRange.length}
          desc="In the selected range."
        />
        <ColorTile
          gradient="linear-gradient(135deg, #8B5CF6 0%, #4F46E5 100%)"
          label="FLAGGED" icon={AlertTriangle}
          stat={flaggedInRange.length}
          desc="Over-quota permissions."
        />
      </section>

      {/* PENDING BY DEPARTMENT */}
      <section className="rounded-2xl border bg-white p-5" style={{ borderColor: 'var(--border-soft)' }}>
        <div className="flex items-center justify-between mb-4">
          <div className="text-[10px] tracking-[0.3em] opacity-60">PENDING BY DEPARTMENT</div>
          <span className="text-xs opacity-60">{pending.length} total</span>
        </div>
        {pendingByDept.length === 0 ? (
          <div className="text-sm opacity-60 py-6 text-center">No pending requests.</div>
        ) : (
          <div className="space-y-2.5">
            {pendingByDept.map(([dept, n]) => (
              <div key={dept} className="flex items-center gap-3">
                <div className="text-[11px] tracking-[0.2em] font-bold opacity-80 w-28">{dept}</div>
                <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(15,40,24,0.08)' }}>
                  <div className="h-full rounded-full"
                    style={{ width: (n / pending.length * 100) + '%',
                             background: 'linear-gradient(90deg, #FBBF24, #F97316)' }} />
                </div>
                <div className="text-sm font-bold w-8 text-right">{n}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* RECENT DECISIONS */}
      <section className="rounded-2xl border bg-white p-5" style={{ borderColor: 'var(--border-soft)' }}>
        <div className="flex items-center justify-between mb-4">
          <div className="text-[10px] tracking-[0.3em] opacity-60">RECENT DECISIONS</div>
          <span className="text-xs opacity-60">Last 8 actions</span>
        </div>
        {recentDecisions.length === 0 ? (
          <div className="text-sm opacity-60 py-6 text-center">No decisions yet.</div>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--border-soft)' }}>
            {recentDecisions.map(r => {
              const emp     = empMap[r.employee_id];
              const decided = r.decided_at || r.requested_at;
              const isPerm  = !!r.type;
              const Icon    = r.status === 'approved' ? CheckCircle2 : XCircle;
              const color   = r.status === 'approved' ? 'var(--evergreen-500)' : 'var(--clay)';
              const Glyph   = isPerm
                ? (r.type === 'late_arrival' ? Sunrise : Sunset)
                : Calendar;
              return (
                <li key={(isPerm?'p':'l')+r.id} className="flex items-center gap-3 py-2.5">
                  <Glyph className="w-4 h-4 flex-shrink-0 opacity-60" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {emp?.name || r.employee_id}
                      <span className="opacity-60 text-xs ml-2">— {isPerm ? labelPerm(r.type) : 'Leave request'}</span>
                    </div>
                    <div className="text-xs opacity-60">
                      {decided ? fmtDate(new Date(decided)) : '—'}
                      {emp?.department && <span className="ml-2">· {emp.department}</span>}
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1 text-[10px] tracking-[0.2em] font-bold"
                    style={{ color }}>
                    <Icon className="w-3 h-3" />
                    {r.status.toUpperCase()}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ─── helpers ───────────────────────────── */

function ColorTile({ gradient, label, icon: Icon, stat, desc }) {
  return (
    <div className="relative rounded-2xl p-4 text-white overflow-hidden flex flex-col justify-between"
      style={{ background: gradient, minHeight: '140px', boxShadow: '0 8px 22px rgba(15,40,24,0.10)' }}>
      <div className="absolute rounded-full pointer-events-none"
        style={{ top:'-36px', right:'-36px', width:'120px', height:'120px',
                 background: 'rgba(255,255,255,0.13)' }} />
      <div className="relative flex items-center justify-between">
        <span className="text-[9px] tracking-[0.25em] font-semibold opacity-90">{label}</span>
        {Icon && <Icon className="w-4 h-4 opacity-90" />}
      </div>
      <div className="relative">
        <div className="font-bold leading-none mt-2"
          style={{ fontSize: '40px', letterSpacing: '-0.03em' }}>{stat}</div>
        <div className="text-[11px] opacity-90 mt-1 leading-snug">{desc}</div>
      </div>
    </div>
  );
}

function labelPerm(type) {
  return type === 'late_arrival' ? 'Late arrival'
       : type === 'early_leave'  ? 'Early leave'
       : 'Permission';
}

function firstName(name) {
  if (!name) return 'there';
  const PREFIX = ['MOHAMMED','MOHAMMAD','MUHAMMAD','MOHD','ABDULLAH','ABDUL','ABDULRAHMAN','AHMED','AHMAD'];
  const titleCase = (w) => w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : '';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && PREFIX.includes(parts[0].toUpperCase())) {
    return titleCase(parts[1].replace(/[^a-zA-Z]/g, ''));
  }
  return titleCase((parts[0] || name).replace(/[^a-zA-Z]/g, ''));
}
