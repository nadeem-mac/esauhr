import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase, directGet } from '../supabaseClient.js';
import {
  Calendar, Clock, Plus, AlertTriangle, Sun, Sunrise, Sunset,
  CheckCircle2, XCircle, Loader2, Users, Plane, Mail
} from 'lucide-react';
import { fmtDate, calculateBalance, fmtDateShort, getInitials, avatarColor } from '../lib/leaveLogic.js';
import { summariseMonth, PERMISSION_QUOTA } from '../lib/permissionLogic.js';
import PendingSubstitutionsCard from './PendingSubstitutionsCard.jsx';
import MyApplicationsCard from './MyApplicationsCard.jsx';
import { downloadVacationFormForRequest } from '../lib/vacationForm.js';
import { Download } from 'lucide-react';

// Staff personal dashboard. Compact colorful gradient tiles.
export default function PersonalDashboard({
  me,
  leaveTypes,
  empMap,
  // Optional — when AppShell passes these in, we use them directly so
  // the global refresh button and realtime sub on AppShell propagate
  // straight into MyApplicationsCard. When NOT passed (older callers),
  // we fall back to the local fetch below.
  requests:    requestsProp,
  permissions: permissionsProp,
  pendingShifts,        // employee_shifts rows with status='pending' for me
  onOpenShiftAck,       // callback that opens the ShiftAcknowledgmentModal
  onOpenNewRequest,
}) {
  const [adjustments, setAdjustments] = useState({});
  // Local fetch state used only when the parent didn't pass the data in.
  // When AppShell DOES pass requests/permissions, these slots stay [].
  const [localRequests,    setLocalRequests]    = useState([]);
  const [localPermissions, setLocalPermissions] = useState([]);
  const [loading,     setLoading]     = useState(true);

  // The arrays we actually render with — props win when present, scoped
  // to me.id because AppShell hands us the whole table. Server-side
  // filtering happens in directGet for the local-fetch fallback path,
  // but we filter again here defensively in case AppShell passes an
  // unscoped global list.
  const requests = useMemo(() => {
    const src = Array.isArray(requestsProp) ? requestsProp : localRequests;
    return src.filter(r => r.employee_id === me?.id);
  }, [requestsProp, localRequests, me?.id]);
  const permissions = useMemo(() => {
    const src = Array.isArray(permissionsProp) ? permissionsProp : localPermissions;
    return src.filter(p => p.employee_id === me?.id);
  }, [permissionsProp, localPermissions, me?.id]);

  const load = useCallback(async () => {
    if (!me?.id) return;
    setLoading(true);
    try {
      const year  = new Date().getFullYear();
      const month = new Date().toISOString().slice(0, 7);
      // directGet (raw fetch + timeout) avoids supabase-js wedge after sign-in.
      const safe = (p) => p.catch((err) => { console.warn('PD load failed:', err); return null; });
      // Skip the leaves/permissions fetch when the parent passed them
      // in — AppShell is the source of truth for those, and re-fetching
      // here would just waste round-trips. We always need balances
      // because AppShell doesn't load those.
      const skipLeaves = Array.isArray(requestsProp);
      const skipPerms  = Array.isArray(permissionsProp);
      const [bal, reqs, perms] = await Promise.all([
        safe(directGet('leave_balances',     `select=*&employee_id=eq.${me.id}&year=eq.${year}&leave_type_id=eq.annual&limit=1`, { timeoutMs: 10000 })),
        skipLeaves ? Promise.resolve(null) :
          safe(directGet('leave_requests',     `select=*&employee_id=eq.${me.id}&order=start_date.desc&limit=20`, { timeoutMs: 10000 })),
        skipPerms ? Promise.resolve(null) :
          safe(directGet('permission_requests',`select=*&employee_id=eq.${me.id}&permission_date=gte.${month}-01&order=permission_date.desc`, { timeoutMs: 10000 })),
      ]);
      setAdjustments(Array.isArray(bal) && bal.length > 0 ? bal[0] : {});
      if (!skipLeaves) setLocalRequests(Array.isArray(reqs) ? reqs : []);
      if (!skipPerms)  setLocalPermissions(Array.isArray(perms) ? perms : []);
    } catch (err) {
      console.warn('PersonalDashboard load failed:', err);
    } finally { setLoading(false); }
  }, [me?.id, requestsProp, permissionsProp]);

  useEffect(() => { load(); }, [load]);

  // Realtime — re-run load whenever leave_requests OR permission_requests
  // change anywhere in the table. The previous version of this code
  // wedged the supabase-js client, but we've since standardised on this
  // lighter pattern (see PendingSubstitutionsCard) which works reliably:
  //   • Channel keyed on me.id so multiple tabs don't collide
  //   • One subscription per table, both wired to the same load()
  //   • Cleanup via removeChannel on unmount/me change
  // Filtering is done client-side rather than via filter:'employee_id=eq…'
  // because the latter has occasionally dropped events in our testing —
  // load() already filters server-side via directGet's eq on me.id, so
  // an extra refetch when someone else's row changes is cheap and safe.
  useEffect(() => {
    if (!me?.id) return undefined;
    const channels = [
      supabase
        .channel(`pd-leaves-${me.id}`)
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'leave_requests' },
            () => { load(); })
        .subscribe(),
      supabase
        .channel(`pd-perms-${me.id}`)
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'permission_requests' },
            () => { load(); })
        .subscribe(),
    ];
    return () => {
      for (const c of channels) {
        try { supabase.removeChannel(c); } catch {}
      }
    };
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

      {/* TILE GRID — 3 cols. Row 1: leave-context tiles (annual / next /
          pending). Row 2: permission tiles (late / early adjacent) +
          evaluation flag. Late + Early sit beside each other so the
          combined-quota story reads naturally. */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        <ColorTile
          accent="#008C9E"
          label="ANNUAL LEAVE" icon={Calendar}
          stat={remaining} unit=" days"
          desc={`Of your ${totalEntitlement}-day yearly entitlement.`}
          progress={100 - usedPct}
        />
        <ColorTile
          accent="#4F46E5"
          label="NEXT VACATION" icon={Plane}
          stat={nextLeave ? labelForType(nextLeave.leave_type_id, leaveTypes).split(' ')[0] : 'None'}
          desc={nextLeave
            ? `${fmtDate(new Date(nextLeave.start_date))} — ${fmtDate(new Date(nextLeave.end_date))}`
            : 'Plan your next break — request anytime.'}
          smallStat
        />
        <ColorTile
          accent="#F97316"
          label="PENDING REQUESTS" icon={Clock}
          stat={pendingCount} unit=""
          desc={pendingCount === 0 ? 'Queue is clear.' : 'Awaiting decision.'}
        />
        <ColorTile
          accent="#FF4E6A"
          label="LATE ARRIVAL" icon={Sunrise}
          stat={lateUsed} unit={`h / ${PERMISSION_QUOTA.monthlyHours}h`}
          desc="Combined cap: late + early. 3 occurrences."
          progress={Math.min(100, (lateUsed/PERMISSION_QUOTA.monthlyHours)*100)}
        />
        <ColorTile
          accent="#DB2777"
          label="EARLY LEAVING" icon={Sunset}
          stat={earlyUsed} unit="h used"
          desc="Shared bucket with late arrivals this month."
          progress={Math.min(100, (earlyUsed/PERMISSION_QUOTA.monthlyHours)*100)}
        />
        <FlagTile monthSummary={monthSummary} />
      </section>

      {/* SHIFT SCHEDULE — manager has assigned shifts awaiting my acknowledgment.
          The card replaces the old auto-popping fairy modal. Tap anywhere on
          the card to open the acknowledgment dialog where the staff member can
          accept all listed shifts at once or decline (with a reason picked
          from a short dropdown). The card disappears the moment the rows
          are no longer pending — realtime sub on AppShell pushes the empty
          set down and we re-render. */}
      {Array.isArray(pendingShifts) && pendingShifts.length > 0 && (
        <section
          role="button"
          tabIndex={0}
          aria-label="Open shift schedule for acknowledgment"
          onClick={() => { if (typeof onOpenShiftAck === 'function') onOpenShiftAck(); }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && typeof onOpenShiftAck === 'function') {
              e.preventDefault();
              onOpenShiftAck();
            }
          }}
          className="rounded-2xl overflow-hidden cursor-pointer transition-transform hover:scale-[1.005] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          style={{
            background: 'linear-gradient(135deg, #E8F5EE 0%, #C9E6D5 100%)',
            border: '1px solid #8FB39A',
          }}
        >
          <div className="px-5 py-4 flex items-center gap-3"
               style={{ borderBottom: '1px solid rgba(46, 95, 63, 0.2)' }}>
            <Calendar className="w-4 h-4" style={{ color: '#1F4530' }} />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm" style={{ color: '#1F4530' }}>
                Shift schedule — awaiting your acknowledgment
              </div>
              <div className="text-xs mt-0.5" style={{ color: '#1F4530' }}>
                {(() => {
                  const setBy = empMap?.[pendingShifts[0]?.set_by];
                  const supName = setBy?.name ? setBy.name.split(' ')[0] : 'Your manager';
                  const n = pendingShifts.length;
                  return `${supName} has assigned ${n} shift${n === 1 ? '' : 's'} for you. Tap to review and respond.`;
                })()}
              </div>
            </div>
            <span className="text-xs font-semibold px-3 py-1.5 rounded-full"
                  style={{ background: '#1F4530', color: '#fff' }}>
              Review →
            </span>
          </div>
          {/* Compact list of the dates so the card carries enough info to
              be useful even before the user opens the modal. Cap at 3 rows
              with an N more line so a five-shift week doesn't make the card
              tower over the rest of the dashboard. */}
          <ul className="divide-y" style={{ borderColor: 'rgba(46, 95, 63, 0.15)' }}>
            {pendingShifts.slice(0, 3).map(s => {
              const [y, m, d] = String(s.shift_date).split('-').map(n => parseInt(n, 10));
              const dt = new Date(y, m - 1, d);
              const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()];
              const pretty = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
              const trim = (t) => String(t || '').slice(0, 5);
              return (
                <li key={s.id} className="px-5 py-2.5 flex items-center gap-3 text-sm" style={{ color: '#1F4530' }}>
                  <span className="font-medium" style={{ minWidth: 56 }}>{dow} {pretty}</span>
                  <span className="opacity-80 tabular-nums">{trim(s.start_time)} – {trim(s.end_time)}</span>
                </li>
              );
            })}
            {pendingShifts.length > 3 && (
              <li className="px-5 py-2 text-xs" style={{ color: '#1F4530' }}>
                + {pendingShifts.length - 3} more shift{pendingShifts.length - 3 === 1 ? '' : 's'} — open to see all
              </li>
            )}
          </ul>
        </section>
      )}

      {/* SUBSTITUTION REQUESTS — colleagues asking ME to cover for them.
          Stays on its own (yellow card) because it's an action surface
          for OTHERS' requests, not a status readout of my own. */}
      <PendingSubstitutionsCard me={me} empMap={empMap} />

      {/* YOUR APPLICATIONS — unified card replacing four previous cards
          (PermissionStatusCard 'Your applications', StaffShiftStatusCard
          'Recent activity', LeaveSubstituteWaitCard, and the legacy
          RECENT LEAVE REQUESTS list). One row per item, leave or
          permission, with inline status pill and per-substitute progress
          where relevant. Click any row to open the matching timeline
          modal. */}
      <div className="flex justify-end -mb-2">
        <button onClick={onOpenNewRequest}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs"
          style={{ background:'var(--ink)', color:'var(--paper)' }}>
          <Plus className="w-3 h-3" /> Request leave
        </button>
      </div>
      {/* HR-only weekly digest — visible to anyone with HR/admin
          flags. Hidden for regular staff. Shows a 7-day summary of
          decisions + quota status with an Email digest button. */}
      {(me?.is_admin || me?.is_hr_reviewer) && (
        <WeeklyDigestCard
          me={me}
          requests={requests}
          permissions={permissions}
        />
      )}
      <TodayBanner
        me={me}
        requests={requests}
        permissions={permissions}
        leaveTypes={leaveTypes}
      />
      <MyApplicationsCard
        me={me}
        requests={requests}
        permissions={permissions}
        empMap={empMap}
        leaveTypes={leaveTypes}
      />
    </div>
  );
}

/* === Today banner — day-of reminder for approved permission/leave === */
// Surfaces a friendly reminder the morning of an approved permission or
// the first day of an approved leave, so the staff member doesn't forget.
// Auto-hides if there's nothing relevant for today.
function TodayBanner({ me, requests, permissions, leaveTypes }) {
  const today = new Date().toISOString().slice(0, 10);
  const todayPerms = (permissions || []).filter(p =>
    p.employee_id === me?.id
    && p.stage === 'approved'
    && p.permission_date === today,
  );
  const todayLeave = (requests || []).filter(r =>
    r.employee_id === me?.id
    && r.stage === 'approved'
    && r.start_date === today,
  );
  if (todayPerms.length === 0 && todayLeave.length === 0) return null;

  const ltMap = Object.fromEntries((leaveTypes || []).map(t => [t.code, t]));

  return (
    <div className="esau-card p-4" style={{
      background: 'linear-gradient(180deg, rgba(45,95,63,0.06) 0%, var(--paper) 100%)',
      borderLeft: '4px solid var(--evergreen-500, #2D5F3F)',
    }}>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-[10px] tracking-[0.2em] font-semibold" style={{ color: 'var(--evergreen-700, #1F4530)' }}>TODAY</span>
        <span className="text-xs opacity-60">·</span>
        <span className="text-xs opacity-70">friendly reminder</span>
      </div>
      <div className="space-y-2 text-sm">
        {todayPerms.map(p => (
          <div key={`p-${p.id}`}>
            <span className="font-semibold">
              {p.type === 'late_arrival' ? 'Late Arrival' : 'Early Departure'}
            </span>
            <span className="opacity-70"> approved for </span>
            {p.time_from && p.time_to
              ? <span className="font-mono text-xs">{p.time_from}–{p.time_to}</span>
              : <span className="opacity-60">today</span>}
            {p.reason && <span className="opacity-60 text-xs"> · {p.reason}</span>}
          </div>
        ))}
        {todayLeave.map(r => {
          const lt = ltMap[r.leave_type];
          return (
            <div key={`l-${r.id}`}>
              <span className="font-semibold">{lt?.name || r.leave_type}</span>
              <span className="opacity-70"> starts today</span>
              {r.end_date && r.end_date !== r.start_date && (
                <span className="opacity-60 text-xs"> · through {r.end_date}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* === Colorful gradient tile === */
// Paper-chrome tile — matches the canonical .esau-card look (rounded-xl,
// #FFFDF7 background, soft warm border, gentle hover lift). Keeps a small
// dose of brand color via the accent dot in the header and the optional
// progress bar fill, but the surrounding chrome is the same as every other
// card on the page.
//
// Color is now passed as `accent` (a single hex/var) instead of `gradient`.
// The accent threads through:
//   • the small dot at the start of the header row
//   • the progress bar fill
function ColorTile({ accent = '#1F1B16', label, icon: Icon, stat, unit = '', desc, progress, onClick, smallStat = false }) {
  return (
    <div onClick={onClick}
      className={`rounded-xl border p-5 esau-card flex flex-col justify-between ${onClick ? 'cursor-pointer' : ''}`}
      style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7', minHeight: '140px' }}>
      {/* Header — accent dot + label on the left, icon on the right */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: accent }} />
          <span className="text-[10px]" style={{ color: '#1F1B16', letterSpacing: '0.22em', fontWeight: 700 }}>
            {label}
          </span>
        </div>
        {Icon && <Icon className="w-4 h-4" style={{ color: accent }} />}
      </div>
      {/* Body — big serif stat, unit, description, optional progress bar */}
      <div>
        <div
          style={{
            fontFamily: "Georgia, 'Times New Roman', serif",
            fontSize: smallStat ? '24px' : '38px',
            color: '#1F1B16',
            lineHeight: 1.05,
            marginTop: '8px',
            fontWeight: 500,
            letterSpacing: '-0.02em',
          }}
        >
          {stat}{unit && (
            <span className="font-normal" style={{ fontSize: '14px', color: '#1F1B16', marginLeft: '3px' }}>
              {unit}
            </span>
          )}
        </div>
        {desc && (
          <div className="text-[11px] mt-1 leading-snug" style={{ color: '#1F1B16' }}>
            {desc}
          </div>
        )}
        {progress !== undefined && (
          <div className="h-1 rounded-full overflow-hidden mt-2.5" style={{ background: 'rgba(31,27,22,0.08)' }}>
            <div className="h-full rounded-full" style={{ width: progress + '%', background: accent }} />
          </div>
        )}
      </div>
    </div>
  );
}

function FlagTile({ monthSummary }) {
  const flagged = monthSummary.overQuota;
  const accent = flagged ? '#B91C1C' : 'var(--evergreen-600)';
  return (
    <div
      className="rounded-xl border p-5 esau-card flex flex-col justify-between"
      style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7', minHeight: '140px' }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: accent }} />
          <span className="text-[10px]" style={{ color: '#1F1B16', letterSpacing: '0.22em', fontWeight: 700 }}>
            EVALUATION FLAG
          </span>
        </div>
        <AlertTriangle className="w-4 h-4" style={{ color: accent }} />
      </div>
      <div>
        <div
          style={{
            fontFamily: "Georgia, 'Times New Roman', serif",
            fontSize: '24px',
            color: '#1F1B16',
            lineHeight: 1.05,
            marginTop: '8px',
            fontWeight: 500,
            letterSpacing: '-0.02em',
          }}
        >
          {flagged ? 'Flagged' : 'Within quota'}
        </div>
        <div className="text-[11px] mt-1 leading-snug" style={{ color: '#1F1B16' }}>
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

// =============================================================================
// WEEKLY DIGEST CARD — HR-only summary of the trailing 7 days
// =============================================================================
function WeeklyDigestCard({ me, requests = [], permissions = [] }) {
  const stats = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffMs = cutoff.getTime();
    const inWindow = (iso) => iso ? new Date(iso).getTime() >= cutoffMs : false;

    const permsThisWeek = (permissions || []).filter(p =>
      inWindow(p.hr_decided_at) && (p.stage === 'approved' || p.stage === 'rejected_by_hr'),
    );
    const leavesThisWeek = (requests || []).filter(r =>
      inWindow(r.hr_decided_at) && (r.stage === 'approved' || r.stage === 'rejected_by_hr'),
    );

    const permApproved  = permsThisWeek.filter(p => p.stage === 'approved').length;
    const permRejected  = permsThisWeek.filter(p => p.stage === 'rejected_by_hr').length;
    const leaveApproved = leavesThisWeek.filter(r => r.stage === 'approved').length;
    const leaveRejected = leavesThisWeek.filter(r => r.stage === 'rejected_by_hr').length;

    const now = new Date();
    const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthPerms = (permissions || []).filter(p =>
      p.permission_date?.startsWith(currentYM)
      && (p.stage === 'approved' || p.stage === 'pending_manager' || p.stage === 'pending_hr'),
    );
    const byEmp = {};
    for (const p of monthPerms) {
      if (!byEmp[p.employee_id]) byEmp[p.employee_id] = [];
      byEmp[p.employee_id].push(p);
    }
    const quotaSummaries = Object.values(byEmp).map(rows => summariseMonth(rows));
    const atQuota   = quotaSummaries.filter(s => s.atQuota && !s.overQuota).length;
    const overQuota = quotaSummaries.filter(s => s.overQuota).length;

    const reasonBuckets = {};
    for (const p of permsThisWeek.filter(p => p.stage === 'approved')) {
      const r = (p.reason || '').toLowerCase();
      let cat = 'Other';
      if (/medical|doctor|clinic|hospital|sick/.test(r))                 cat = 'Medical';
      else if (/government|iqama|bank|financial|paperwork|official/.test(r)) cat = 'Government / Bank';
      else if (/family|emergency|urgent|personal/.test(r))                cat = 'Family / Emergency';
      else if (/school|child|pickup|drop[\s-]?off/.test(r))               cat = 'School / Childcare';
      else if (/traffic|transport|road|commute/.test(r))                  cat = 'Traffic / Transport';
      reasonBuckets[cat] = (reasonBuckets[cat] || 0) + 1;
    }
    const topReasons = Object.entries(reasonBuckets).sort((a, b) => b[1] - a[1]).slice(0, 3);

    return {
      permApproved, permRejected, leaveApproved, leaveRejected,
      atQuota, overQuota, topReasons,
      windowStart: cutoff, windowEnd: now,
    };
  }, [requests, permissions]);

  const buildEmailBody = useCallback(() => {
    const fmt = (d) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const lines = [
      `Weekly HR digest — ${fmt(stats.windowStart)} to ${fmt(stats.windowEnd)}`, '',
      'Approvals this week',
      `  • Permissions: ${stats.permApproved} approved, ${stats.permRejected} rejected`,
      `  • Leave: ${stats.leaveApproved} approved, ${stats.leaveRejected} rejected`, '',
      'Quota status (current month)',
      `  • At quota cap (3h used): ${stats.atQuota} staff`,
      `  • Over quota: ${stats.overQuota} staff`, '',
    ];
    if (stats.topReasons.length > 0) {
      lines.push('Top reasons for permission this week');
      stats.topReasons.forEach(([label, count]) => lines.push(`  • ${label}: ${count}`));
      lines.push('');
    }
    lines.push('— ESAU HR · Leave Desk');
    lines.push('https://esauhr.netlify.app');
    return lines.join('\n');
  }, [stats]);

  const openEmailDraft = useCallback(() => {
    const subject = `HR weekly digest · ${stats.windowEnd.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`;
    const params = new URLSearchParams();
    params.set('subject', subject);
    params.set('body', buildEmailBody());
    window.location.href = `mailto:?${params.toString().replace(/\+/g, '%20')}`;
  }, [stats, buildEmailBody]);

  const totalDecisions = stats.permApproved + stats.permRejected + stats.leaveApproved + stats.leaveRejected;
  if (totalDecisions === 0 && stats.atQuota === 0 && stats.overQuota === 0) return null;

  return (
    <section className="rounded-2xl border bg-white p-4 sm:p-5"
             style={{ borderColor: 'var(--border-soft)' }}>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div>
          <div className="text-[10px] tracking-[0.25em] opacity-60">WEEKLY DIGEST · LAST 7 DAYS</div>
          <div className="text-xs opacity-70 mt-0.5">
            {totalDecisions} decision{totalDecisions === 1 ? '' : 's'} acted on
            {stats.overQuota > 0 && (
              <span className="ml-2 inline-flex items-center gap-1" style={{ color: '#B83A2E' }}>
                · <AlertTriangle className="w-3 h-3" /> {stats.overQuota} over quota
              </span>
            )}
          </div>
        </div>
        <button type="button" onClick={openEmailDraft}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs"
          style={{ background: 'var(--ink)', color: 'var(--paper)' }}
          title="Open an email draft with this digest pre-filled">
          <Mail className="w-3 h-3" /> Email digest
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <DigestStat label="Permissions" primary={`${stats.permApproved} approved`} secondary={`${stats.permRejected} rejected`} color="#2D5F3F" />
        <DigestStat label="Leave"       primary={`${stats.leaveApproved} approved`} secondary={`${stats.leaveRejected} rejected`} color="#5A8A9A" />
        <DigestStat label="At quota"    primary={`${stats.atQuota} staff`}  secondary="3h used this month" color="#9D6B53" />
        <DigestStat label="Over quota"  primary={`${stats.overQuota} staff`} secondary={stats.overQuota > 0 ? 'Needs follow-up' : 'All within limits'} color={stats.overQuota > 0 ? '#B83A2E' : '#737373'} />
      </div>

      {stats.topReasons.length > 0 && (
        <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="text-[10px] tracking-[0.2em] opacity-60 mb-2">TOP REASONS THIS WEEK</div>
          <div className="flex flex-wrap gap-2">
            {stats.topReasons.map(([label, count]) => (
              <span key={label} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px]"
                    style={{ background: 'rgba(45,95,63,0.08)', color: '#1F1B16' }}>
                <span className="font-semibold">{count}</span>
                <span className="opacity-80">{label}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function DigestStat({ label, primary, secondary, color }) {
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--paper-soft, #F4F4EE)' }}>
      <div className="text-[10px] tracking-[0.2em] opacity-60 mb-1">{label.toUpperCase()}</div>
      <div className="text-sm font-semibold" style={{ color }}>{primary}</div>
      <div className="text-[10px] opacity-60 mt-0.5">{secondary}</div>
    </div>
  );
}
