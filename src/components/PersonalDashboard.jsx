import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabaseClient.js';
import {
  Calendar, Clock, Plus, AlertTriangle, Sun, Sunrise, Sunset,
  CheckCircle2, XCircle, Loader2, Users, Plane
} from 'lucide-react';
import { UserCheck, ThumbsUp, ThumbsDown } from 'lucide-react';
import { fmtDate, calculateBalance, fmtDateShort, getInitials, avatarColor } from '../lib/leaveLogic.js';
import { summariseMonth, PERMISSION_QUOTA } from '../lib/permissionLogic.js';
import PermissionRequestModal from './PermissionRequestModal.jsx';

// Staff personal dashboard. Compact colorful gradient tiles.
export default function PersonalDashboard({ me, leaveTypes, onOpenNewRequest }) {
  const [adjustments, setAdjustments] = useState({});
  const [requests,    setRequests]    = useState([]);
  const [permissions, setPermissions] = useState([]);
  // Substitution requests where THIS user is one of the proposed substitutes
  // and the request is still waiting on substitute decisions.
  const [subRequests, setSubRequests] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [permModal,   setPermModal]   = useState(null);

  const load = useCallback(async () => {
    if (!me?.id) return;
    setLoading(true);
    try {
      const year  = new Date().getFullYear();
      const month = new Date().toISOString().slice(0, 7);
      const [bal, reqs, perms, subs] = await Promise.all([
        supabase.from('leave_balances').select('*')
          .eq('employee_id', me.id).eq('year', year).eq('leave_type_id', 'annual').maybeSingle(),
        supabase.from('leave_requests').select('*')
          .eq('employee_id', me.id).order('start_date', { ascending: false }).limit(20),
        supabase.from('permission_requests').select('*')
          .eq('employee_id', me.id)
          .gte('permission_date', `${month}-01`)
          .order('permission_date', { ascending: false }),
        // Requests where I'm a proposed substitute and the request is still pending substitutes
        supabase.from('leave_requests').select('*')
          .contains('substitute_ids', [me.id])
          .eq('stage', 'pending_substitutes')
          .order('start_date', { ascending: true }),
      ]);
      setAdjustments(bal.data || {});
      setRequests(reqs.data || []);
      setPermissions(perms.data || []);
      // Filter to only requests where MY decision is still 'pending'
      setSubRequests((subs.data || []).filter(r => {
        const d = r.substitute_decisions?.[me.id];
        if (!d) return true;
        const dec = typeof d === 'string' ? d : d.decision;
        return dec !== 'accepted' && dec !== 'declined';
      }));
    } catch (err) {
      console.warn('PersonalDashboard load failed:', err);
    } finally { setLoading(false); }
  }, [me?.id]);

  useEffect(() => { load(); }, [load]);

  // Substitute response handler at COMPONENT scope (was previously trapped inside
  // a useEffect by a bad earlier patch).
  // The Postgres trigger advance_stage_on_substitute_decision will auto-advance
  // the request stage to 'pending_manager' (if all accepted) or
  // 'rejected_by_substitute' (if anyone declined).
  const respondToSubstitution = useCallback(async (request, decision) => {
    if (!me?.id) return;
    const merged = {
      ...(request.substitute_decisions || {}),
      [me.id]: { decision, at: new Date().toISOString() }
    };
    try {
      const updatePromise = supabase
        .from('leave_requests')
        .update({ substitute_decisions: merged })
        .eq('id', request.id);
      // 10s timeout so a hung supabase-js client doesn't lock the UI
      const { error } = await Promise.race([
        Promise.resolve(updatePromise),
        new Promise((_, rej) => setTimeout(() => rej(new Error('decision update timed out')), 10000)),
      ]);
      if (error) throw error;
      await load();
    } catch (err) {
      console.warn('substitute decision failed:', err);
      alert('Could not record your decision: ' + (err.message || err));
    }
  }, [me?.id, load]);

  // Realtime subscription removed — it was wedging the supabase-js client. Users
  // can refresh the page or it will reload when they navigate back to the dashboard.

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
  const monthSummary = summariseMonth(permissions);
  const lateUsed  = lateRows .filter(r => r.status === 'pending' || r.status === 'approved').reduce((s,r) => s + Number(r.hours||0), 0);
  const earlyUsed = earlyRows.filter(r => r.status === 'pending' || r.status === 'approved').reduce((s,r) => s + Number(r.hours||0), 0);
  const nextLeave = requests.find(r => r.status === 'approved' && new Date(r.start_date) >= startOfDay(new Date()));
  const recent    = requests.slice(0, 5);
  const pendingCount = requests.filter(r => r.status === 'pending').length;

  const annualType = (leaveTypes || []).find(t => t.id === 'annual');
  const bal = annualType
    ? calculateBalance({ employee: me, leaveType: annualType, year: new Date().getFullYear(), requests, adjustments })
    : { entitlement: 0, used: 0, available: 0, total: 0 };
  const totalEntitlement = bal.total || bal.entitlement || 21;
  const used = bal.used || 0;
  const remaining = bal.available != null ? Math.max(0, bal.available) : Math.max(0, totalEntitlement - used);
  const usedPct = Math.min(100, (used / Math.max(1,totalEntitlement)) * 100);

  return (
    <div className="space-y-6">
      {/* HERO */}
      <section>
        <div className="text-[10px] tracking-[0.3em] opacity-50 mb-2 flex items-center gap-2">
          <span className="inline-block w-7 h-px bg-current" />OVERVIEW
        </div>
        <h1 className="serif text-5xl leading-none" style={{ fontWeight: 600, letterSpacing:'-0.025em' }}>
          Hello, <span className="italic" style={{ color:'var(--evergreen-500)', fontWeight: 400 }}>{firstName(me?.name)}.</span>
        </h1>
        <p className="text-sm opacity-70 mt-2">
          {nextLeave
            ? `You're off on ${fmtDate(new Date(nextLeave.start_date))} — that's in ${daysFromNow(nextLeave.start_date)}.`
            : 'No upcoming approved leave on the books.'}
        </p>
      </section>

      {/* COLORFUL TILE GRID — 3 cols */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        <ColorTile
          gradient="linear-gradient(135deg, #00D4C0 0%, #008C9E 100%)"
          label="ANNUAL LEAVE" icon={Calendar}
          stat={remaining} unit=" days"
          desc={`Of your ${totalEntitlement}-day yearly entitlement.`}
          progress={100 - usedPct}
        />
        <ColorTile
          gradient="linear-gradient(135deg, #FF8A4D 0%, #FF4E6A 100%)"
          label="LATE ARRIVAL" icon={Sunrise}
          stat={lateUsed} unit={`h / ${PERMISSION_QUOTA.monthlyHours}h`}
          desc="Combined cap: late + early. 3 occurrences."
          progress={Math.min(100, (lateUsed/PERMISSION_QUOTA.monthlyHours)*100)}
          onClick={() => setPermModal('late_arrival')}
        />
        <ColorTile
          gradient="linear-gradient(135deg, #8B5CF6 0%, #4F46E5 100%)"
          label="NEXT VACATION" icon={Plane}
          stat={nextLeave ? labelForType(nextLeave.leave_type_id, leaveTypes).split(' ')[0] : 'None'}
          desc={nextLeave
            ? `${fmtDate(new Date(nextLeave.start_date))} — ${fmtDate(new Date(nextLeave.end_date))}`
            : 'Plan your next break — request anytime.'}
          smallStat
        />
        <ColorTile
          gradient="linear-gradient(135deg, #F472B6 0%, #DB2777 100%)"
          label="EARLY LEAVING" icon={Sunset}
          stat={earlyUsed} unit="h used"
          desc="Shared bucket with late arrivals this month."
          progress={Math.min(100, (earlyUsed/PERMISSION_QUOTA.monthlyHours)*100)}
          onClick={() => setPermModal('early_leave')}
        />
        <ColorTile
          gradient="linear-gradient(135deg, #FBBF24 0%, #F97316 100%)"
          label="PENDING REQUESTS" icon={Clock}
          stat={pendingCount} unit=""
          desc={pendingCount === 0 ? 'Queue is clear.' : 'Awaiting decision.'}
        />
        <FlagTile monthSummary={monthSummary} />
      </section>

      {/* SUBSTITUTION REQUESTS — colleagues asking ME to cover for them */}
      {subRequests.length > 0 && (
        <section className="rounded-2xl overflow-hidden"
                 style={{ background: 'linear-gradient(135deg, #FFF8E7 0%, #FFE8B8 100%)', border: '1px solid #E8C97A' }}>
          <div className="px-5 py-4 flex items-center gap-2"
               style={{ borderBottom: '1px solid #E8C97A' }}>
            <UserCheck className="w-4 h-4" style={{ color: '#8B6914' }} />
            <div className="font-semibold text-sm" style={{ color: '#5C4406' }}>
              {subRequests.length === 1 ? 'A colleague needs you to cover' : `${subRequests.length} colleagues need you to cover`}
            </div>
          </div>
          <ul className="divide-y" style={{ borderColor: 'rgba(139,105,20,0.2)' }}>
            {subRequests.map(req => {
              const initials = getInitials(req.employee_id);
              return (
                <li key={req.id} className="px-5 py-3 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                       style={{ background: avatarColor(req.employee_id) }}>
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate" style={{ color: '#5C4406' }}>
                      {req.employee_id}
                    </div>
                    <div className="text-xs opacity-80" style={{ color: '#5C4406' }}>
                      {fmtDateShort(req.start_date)} → {fmtDateShort(req.end_date)} · {req.days} day{req.days !== 1 ? 's' : ''}
                      {req.reason ? ' · ' + req.reason : ''}
                    </div>
                  </div>
                  <button onClick={() => respondToSubstitution(req, 'declined')}
                    className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-full"
                    style={{ background: '#fff', color: '#B83A2E', border: '1px solid #B83A2E' }}>
                    <ThumbsDown className="w-3 h-3" /> Decline
                  </button>
                  <button onClick={() => respondToSubstitution(req, 'accepted')}
                    className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-full"
                    style={{ background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }}>
                    <ThumbsUp className="w-3 h-3" /> Accept
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* RECENT */}
      <section className="rounded-2xl border bg-white p-5" style={{ borderColor:'var(--border-soft)' }}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] tracking-[0.3em] opacity-60">RECENT LEAVE REQUESTS</div>
          <button onClick={onOpenNewRequest}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs"
            style={{ background:'var(--ink)', color:'var(--paper)' }}>
            <Plus className="w-3 h-3" /> Request leave
          </button>
        </div>
        {recent.length === 0 ? (
          <div className="text-sm opacity-60 py-3 text-center">No leave requests yet.</div>
        ) : (
          <ul className="divide-y" style={{ borderColor:'var(--border-soft)' }}>
            {recent.map(r => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2.5"
                  style={{ borderColor:'var(--border-soft)' }}>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{labelForType(r.leave_type_id, leaveTypes)}</div>
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

/* === Colorful gradient tile === */
function ColorTile({ gradient, label, icon: Icon, stat, unit = '', desc, progress, onClick, smallStat = false }) {
  return (
    <div onClick={onClick}
      className={`relative rounded-2xl p-4 text-white overflow-hidden flex flex-col justify-between transition-transform hover:-translate-y-1 ${onClick ? 'cursor-pointer' : ''}`}
      style={{ background: gradient, minHeight: '140px', boxShadow:'0 8px 22px rgba(15,40,24,0.10)' }}>
      <div className="absolute rounded-full pointer-events-none"
        style={{ top:'-36px', right:'-36px', width:'120px', height:'120px', background:'rgba(255,255,255,0.13)' }} />
      <div className="relative flex items-center justify-between">
        <span className="text-[9px] tracking-[0.25em] font-semibold opacity-90">{label}</span>
        {Icon && <Icon className="w-4 h-4 opacity-90" />}
      </div>
      <div className="relative">
        <div className={smallStat ? "text-2xl font-bold leading-tight mt-2" : "font-bold leading-none mt-2"}
             style={{ fontSize: smallStat ? undefined : '40px', letterSpacing:'-0.03em' }}>
          {stat}{unit && <span className="font-medium opacity-70" style={{ fontSize:'15px', marginLeft:'2px' }}>{unit}</span>}
        </div>
        <div className="text-[11px] opacity-90 mt-1 leading-snug">{desc}</div>
        {progress !== undefined && (
          <div className="h-1 rounded-full overflow-hidden mt-2" style={{ background:'rgba(255,255,255,0.25)' }}>
            <div className="h-full rounded-full" style={{ width: progress + '%', background:'rgba(255,255,255,0.95)' }} />
          </div>
        )}
      </div>
    </div>
  );
}

function FlagTile({ monthSummary }) {
  const flagged = monthSummary.overQuota;
  const gradient = flagged
    ? 'linear-gradient(135deg, #EF4444 0%, #B91C1C 100%)'
    : 'linear-gradient(135deg, #34D399 0%, #059669 100%)';
  return (
    <div className="relative rounded-2xl p-4 text-white overflow-hidden flex flex-col justify-between"
      style={{ background: gradient, minHeight: '140px', boxShadow:'0 8px 22px rgba(15,40,24,0.10)' }}>
      <div className="absolute rounded-full pointer-events-none"
        style={{ top:'-36px', right:'-36px', width:'120px', height:'120px', background:'rgba(255,255,255,0.13)' }} />
      <div className="relative flex items-center justify-between">
        <span className="text-[9px] tracking-[0.25em] font-semibold opacity-90">EVALUATION FLAG</span>
        <AlertTriangle className="w-4 h-4 opacity-90" />
      </div>
      <div className="relative">
        <div className="text-xl font-bold leading-tight mt-2">
          {flagged ? 'Flagged' : 'Within quota'}
        </div>
        <div className="text-[11px] opacity-90 mt-1 leading-snug">
          {flagged
            ? `${monthSummary.hoursUsed}h used in ${monthSummary.occurrences} occurrence${monthSummary.occurrences !== 1 ? 's' : ''} — exceeds 3hr cap.`
            : `Combined cap: 3hr / 3 times per month. ${monthSummary.hoursRemaining}h left.`}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const cfg = {
    pending:   { bg:'rgba(196,155,97,0.18)',  fg:'#B07F2F', label:'Pending',   Icon:Clock },
    approved:  { bg:'rgba(45,95,63,0.15)',    fg:'#2D5F3F', label:'Approved',  Icon:CheckCircle2 },
    rejected:  { bg:'rgba(184,74,62,0.15)',   fg:'#B84A3E', label:'Rejected',  Icon:XCircle },
    cancelled: { bg:'rgba(15,40,24,0.08)',    fg:'#5a6d5e', label:'Cancelled', Icon:XCircle },
  }[status] || { bg:'#eee', fg:'#000', label:status, Icon:Clock };
  const { Icon } = cfg;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full whitespace-nowrap font-medium"
      style={{ background: cfg.bg, color: cfg.fg }}>
      <Icon className="w-3 h-3" /> {cfg.label}
    </span>
  );
}

function firstName(name) {
  if (!name) return 'there';
  const PREFIX_NAMES = ['MOHAMMED','MOHAMMAD','MUHAMMAD','MOHD','ABDULLAH','ABDUL','ABDULRAHMAN','AHMED','AHMAD'];
  const titleCase = (w) => w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : '';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && PREFIX_NAMES.includes(parts[0].toUpperCase())) {
    return titleCase(parts[1].replace(/[^a-zA-Z]/g, ''));
  }
  return titleCase((parts[0] || name).replace(/[^a-zA-Z]/g, ''));
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
