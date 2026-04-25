import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabaseClient.js';
import {
  Calendar, Clock, Plus, AlertTriangle, ArrowRight, Sun, Sunrise, Sunset, CheckCircle2, XCircle, Loader2
} from 'lucide-react';
import { fmtDate } from '../lib/leaveLogic.js';
import { summariseMonth, PERMISSION_QUOTA, PERMISSION_TYPES } from '../lib/permissionLogic.js';
import PermissionRequestModal from './PermissionRequestModal.jsx';

// Shown to non-admin staff.  Six tiles + quick actions.
//
// Tiles:
//   1.  My balance (annual leave entitlement vs used)
//   2.  My next vacation (next approved leave)
//   3.  My recent requests (last 5)
//   4.  Late-arrival permissions (this month, X / 3 hrs)
//   5.  Early-leaving permissions (this month, X / 3 hrs)
//   6.  Combined evaluation flag if total > 3hrs

export default function PersonalDashboard({ me, leaveTypes, onOpenNewRequest }) {
  const [balance,     setBalance]     = useState(null);
  const [requests,    setRequests]    = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [permModal,   setPermModal]   = useState(null); // null | 'late_arrival' | 'early_leave'

  const load = useCallback(async () => {
    if (!me?.id) return;
    setLoading(true);
    try {
      const year = new Date().getFullYear();
      const month = new Date().toISOString().slice(0, 7); // 'YYYY-MM'

      const [bal, reqs, perms] = await Promise.all([
        supabase.from('leave_balances').select('*')
          .eq('employee_id', me.id).eq('year', year).maybeSingle(),
        supabase.from('leave_requests').select('*')
          .eq('employee_id', me.id).order('start_date', { ascending: false }).limit(8),
        supabase.from('permission_requests').select('*')
          .eq('employee_id', me.id)
          .gte('permission_date', `${month}-01`)
          .order('permission_date', { ascending: false }),
      ]);
      setBalance(bal.data || null);
      setRequests(reqs.data || []);
      setPermissions(perms.data || []);
    } catch (err) {
      console.warn('PersonalDashboard load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [me?.id]);

  useEffect(() => { load(); }, [load]);

  // Realtime — refresh when my own rows change
  useEffect(() => {
    if (!me?.id) return;
    const ch = supabase.channel(`me-${me.id}`)
      .on('postgres_changes',
          { event: '*', schema: 'public', table: 'leave_requests', filter: `employee_id=eq.${me.id}` },
          load)
      .on('postgres_changes',
          { event: '*', schema: 'public', table: 'permission_requests', filter: `employee_id=eq.${me.id}` },
          load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [me?.id, load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <div className="text-center opacity-60">
          <Loader2 className="w-6 h-6 mx-auto animate-spin mb-3" />
          <div className="text-xs tracking-widest">LOADING</div>
        </div>
      </div>
    );
  }

  const lateRows  = permissions.filter(p => p.type === 'late_arrival');
  const earlyRows = permissions.filter(p => p.type === 'early_leave');
  // Combined monthly bucket — covers BOTH late + early
  const monthSummary = summariseMonth(permissions);
  const lateUsed  = lateRows .filter(r => r.status === 'pending' || r.status === 'approved').reduce((s, r) => s + Number(r.hours || 0), 0);
  const earlyUsed = earlyRows.filter(r => r.status === 'pending' || r.status === 'approved').reduce((s, r) => s + Number(r.hours || 0), 0);

  const nextLeave = requests.find(r => r.status === 'approved' && new Date(r.start_date) >= startOfDay(new Date()));
  const recent    = requests.slice(0, 5);

  const totalEntitlement = balance?.entitlement || 21;
  const used             = balance?.used || 0;
  const remaining        = Math.max(0, totalEntitlement - used);

  return (
    <div className="space-y-8">
      {/* ─────────── HERO ─────────── */}
      <section>
        <div className="text-xs tracking-[0.25em] opacity-50 mb-2">— OVERVIEW</div>
        <h1 className="serif text-5xl md:text-6xl leading-[1.02]" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>
          Hello, <span className="italic" style={{ color: 'var(--evergreen-500)' }}>{firstName(me?.name)}.</span>
        </h1>
        <p className="text-base opacity-70 mt-3">
          {nextLeave
            ? `You're off on ${fmtDate(new Date(nextLeave.start_date))} — that's in ${daysFromNow(nextLeave.start_date)}.`
            : 'No upcoming approved leave on the books.'}
        </p>
      </section>

      {/* ─────────── PRIMARY TILES ─────────── */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">

        {/* Balance card */}
        <div className="rounded-2xl p-6 border" style={{ borderColor: 'var(--border-soft)', background: 'var(--paper-2)' }}>
          <div className="flex items-center justify-between">
            <div className="text-[10px] tracking-[0.25em] opacity-60">ANNUAL LEAVE</div>
            <Calendar className="w-4 h-4 opacity-50" />
          </div>
          <div className="serif text-6xl mt-3" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>
            {remaining}
          </div>
          <div className="text-xs opacity-60 mt-1">of {totalEntitlement} days remaining</div>
          <div className="h-1.5 mt-4 rounded-full overflow-hidden" style={{ background: 'rgba(15,40,24,0.08)' }}>
            <div className="h-full rounded-full" style={{
              width: `${Math.min(100, (used / totalEntitlement) * 100)}%`,
              background: 'var(--evergreen-500)'
            }}/>
          </div>
          <div className="text-[10px] opacity-50 mt-2">{used} used · resets Jan 1</div>
        </div>

        {/* Next vacation */}
        <div className="rounded-2xl p-6 border" style={{ borderColor: 'var(--border-soft)', background: 'var(--paper-2)' }}>
          <div className="flex items-center justify-between">
            <div className="text-[10px] tracking-[0.25em] opacity-60">NEXT VACATION</div>
            <Sun className="w-4 h-4 opacity-50" />
          </div>
          {nextLeave ? (
            <>
              <div className="serif text-2xl mt-3 leading-tight" style={{ fontWeight: 500 }}>
                {labelForType(nextLeave.leave_type_id, leaveTypes)}
              </div>
              <div className="text-sm opacity-70 mt-1">
                {fmtDate(new Date(nextLeave.start_date))} — {fmtDate(new Date(nextLeave.end_date))}
              </div>
              <div className="text-xs mt-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
                style={{ background: 'rgba(45,95,63,0.15)', color: 'var(--evergreen-500)' }}>
                <CheckCircle2 className="w-3 h-3" /> Approved
              </div>
            </>
          ) : (
            <div className="opacity-60 text-sm mt-6">Nothing scheduled. Plan a break?</div>
          )}
        </div>

        {/* My requests count */}
        <div className="rounded-2xl p-6 border" style={{ borderColor: 'var(--border-soft)', background: 'var(--paper-2)' }}>
          <div className="flex items-center justify-between">
            <div className="text-[10px] tracking-[0.25em] opacity-60">MY REQUESTS</div>
            <Clock className="w-4 h-4 opacity-50" />
          </div>
          <div className="serif text-6xl mt-3" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>
            {requests.filter(r => r.status === 'pending').length}
          </div>
          <div className="text-xs opacity-60 mt-1">awaiting decision</div>
          <div className="text-[10px] opacity-50 mt-3">
            {requests.filter(r => r.status === 'approved').length} approved · {requests.filter(r => r.status === 'rejected').length} rejected (lifetime)
          </div>
        </div>
      </section>

      {/* ─────────── PERMISSIONS ROW ─────────── */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <PermissionTile
          icon={Sunrise}
          title="LATE ARRIVAL"
          hint="3hr / mo · 8:15 cutoff"
          hoursUsed={lateUsed}
          rows={lateRows}
          monthSummary={monthSummary}
          onRequest={() => setPermModal('late_arrival')}
        />
        <PermissionTile
          icon={Sunset}
          title="EARLY LEAVING"
          hint="3hr / mo · combined cap"
          hoursUsed={earlyUsed}
          rows={earlyRows}
          monthSummary={monthSummary}
          onRequest={() => setPermModal('early_leave')}
        />
        <FlagTile monthSummary={monthSummary} />
      </section>

      {/* ─────────── RECENT LEAVE REQUESTS ─────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] tracking-[0.25em] opacity-60">RECENT LEAVE REQUESTS</div>
          <button onClick={onOpenNewRequest}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs"
            style={{ background: 'var(--ink)', color: 'var(--paper)' }}>
            <Plus className="w-3 h-3" /> Request leave
          </button>
        </div>
        {recent.length === 0 ? (
          <div className="rounded-xl p-6 text-center text-sm opacity-60 border"
            style={{ borderColor: 'var(--border-soft)' }}>
            No leave requests yet. Tap "Request leave" above to start.
          </div>
        ) : (
          <ul className="rounded-xl border overflow-hidden divide-y" style={{ borderColor: 'var(--border-soft)' }}>
            {recent.map(r => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3"
                  style={{ background: 'var(--paper-2)' }}>
                <div className="flex-1 min-w-0">
                  <div className="text-sm">{labelForType(r.leave_type_id, leaveTypes)}</div>
                  <div className="text-xs opacity-60">
                    {fmtDate(new Date(r.start_date))} — {fmtDate(new Date(r.end_date))} · {r.days} day{r.days !== 1 ? 's' : ''}
                  </div>
                </div>
                <StatusPill status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {permModal && (
        <PermissionRequestModal
          me={me}
          type={permModal}
          monthRows={permissions}
          onClose={() => setPermModal(null)}
          onSubmitted={() => { setPermModal(null); load(); }}
        />
      )}
    </div>
  );
}

/* ─────────── small components ─────────── */

function PermissionTile({ icon: Icon, title, hint, hoursUsed, rows, monthSummary, onRequest }) {
  const flagged = monthSummary.overQuota;
  const pct = Math.min(100, (hoursUsed / PERMISSION_QUOTA.monthlyHours) * 100);
  const color = flagged ? 'var(--clay)' : 'var(--evergreen-500)';
  return (
    <div className="rounded-2xl p-6 border flex flex-col" style={{ borderColor: 'var(--border-soft)', background: 'var(--paper-2)' }}>
      <div className="flex items-center justify-between">
        <div className="text-[10px] tracking-[0.25em] opacity-60">{title}</div>
        <Icon className="w-4 h-4 opacity-50" />
      </div>
      <div className="serif text-5xl mt-3 leading-none" style={{ fontWeight: 500, letterSpacing: '-0.02em', color }}>
        {hoursUsed}<span className="text-xl opacity-50">h</span>
      </div>
      <div className="text-xs opacity-60 mt-1">
        of {PERMISSION_QUOTA.monthlyHours}h this month · {hint}
      </div>
      <div className="h-1.5 mt-4 rounded-full overflow-hidden" style={{ background: 'rgba(15,40,24,0.08)' }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }}/>
      </div>
      <div className="text-[10px] opacity-50 mt-2">
        {rows.length} request{rows.length !== 1 ? 's' : ''} this month
      </div>
      <button onClick={onRequest}
        className="mt-4 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-full text-xs border self-start"
        style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}>
        <Plus className="w-3 h-3" /> Request {title.toLowerCase()}
      </button>
    </div>
  );
}

function FlagTile({ monthSummary }) {
  const flagged = monthSummary.overQuota;
  return (
    <div className="rounded-2xl p-6 border flex flex-col"
      style={{
        borderColor: flagged ? 'var(--clay)' : 'var(--border-soft)',
        background: flagged ? 'rgba(184,74,62,0.06)' : 'var(--paper-2)',
      }}>
      <div className="flex items-center justify-between">
        <div className="text-[10px] tracking-[0.25em] opacity-60">EVALUATION FLAG</div>
        <AlertTriangle className="w-4 h-4 opacity-50" />
      </div>
      <div className="serif text-2xl mt-3 leading-tight" style={{ fontWeight: 500, color: flagged ? 'var(--clay)' : 'inherit' }}>
        {flagged ? 'Flagged this month' : 'Within quota'}
      </div>
      <div className="text-xs opacity-70 mt-2 leading-relaxed">
        {flagged ? (
          <>You exceeded the combined 3-hour permission cap this month
            ({monthSummary.hoursUsed}h, {monthSummary.occurrences} occurrence{monthSummary.occurrences !== 1 ? 's' : ''}).
            This is recorded for your personal evaluation.</>
        ) : (
          <>Combined late + early cap is 3 hours / 3 occurrences per month.
            Going over flags you in personal evaluation.</>
        )}
      </div>
      <div className="text-[10px] opacity-50 mt-3">
        {monthSummary.hoursUsed}h used · {monthSummary.occurrences} times · {monthSummary.hoursRemaining}h left
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const cfg = {
    pending:   { bg: 'rgba(196,155,97,0.15)', fg: 'var(--copper)',         label: 'Pending',   Icon: Clock },
    approved:  { bg: 'rgba(45,95,63,0.15)',   fg: 'var(--evergreen-500)',  label: 'Approved',  Icon: CheckCircle2 },
    rejected:  { bg: 'rgba(184,74,62,0.15)',  fg: 'var(--clay)',           label: 'Rejected',  Icon: XCircle },
    cancelled: { bg: 'rgba(15,40,24,0.08)',   fg: 'var(--ink-soft)',       label: 'Cancelled', Icon: XCircle },
  }[status] || { bg: '#eee', fg: '#000', label: status, Icon: Clock };
  const { Icon } = cfg;
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full whitespace-nowrap"
      style={{ background: cfg.bg, color: cfg.fg }}>
      <Icon className="w-3 h-3" /> {cfg.label}
    </span>
  );
}

/* ─────────── helpers ─────────── */
function firstName(name) {
  if (!name) return 'there';
  return name.split(' ')[0].replace(/[^a-zA-Z]/g, '') || name;
}
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function daysFromNow(date) {
  const d = Math.round((startOfDay(new Date(date)) - startOfDay(new Date())) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'tomorrow';
  return `${d} days`;
}
function labelForType(id, types) {
  return types?.find(t => t.id === id)?.name || id;
}
