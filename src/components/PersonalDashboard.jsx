import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { supabase, directGet, directPost, directPatch } from '../supabaseClient.js';
import {
  Calendar, Clock, Plus, AlertTriangle, Sun, Sunrise, Sunset,
  CheckCircle2, XCircle, Loader2, Users, Plane, Mail, HeartPulse
} from 'lucide-react';
import { fmtDate, calculateBalance, fmtDateShort, getInitials, avatarColor } from '../lib/leaveLogic.js';
import { summariseMonth, PERMISSION_QUOTA } from '../lib/permissionLogic.js';
import PendingSubstitutionsCard from './PendingSubstitutionsCard.jsx';
import MyApplicationsCard from './MyApplicationsCard.jsx';
import MyAttendanceCard from './MyAttendanceCard.jsx';
import MyShiftMonthCard from './MyShiftMonthCard.jsx';
import MyRejoiningCard from './MyRejoiningCard.jsx';
import SubstituteFreedCard from './SubstituteFreedCard.jsx';
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
  onUploadCert,         // (request) => void — opens cert upload modal for a pending_certificate sick declaration
}) {
  const [adjustments, setAdjustments] = useState({});
  // Local fetch state used only when the parent didn't pass the data in.
  // When AppShell DOES pass requests/permissions, these slots stay [].
  const [localRequests,    setLocalRequests]    = useState([]);
  const [localPermissions, setLocalPermissions] = useState([]);
  const [loading,     setLoading]     = useState(true);

  // 2026-05-10 fix (Nadeem): the page-flicker-every-20s bug on staff
  // dashboards was caused by `load` having requestsProp/permissionsProp
  // in its useCallback deps. AppShell's 20-second loadAll poll (plus
  // every realtime event) handed PersonalDashboard a NEW array
  // reference for those props every cycle — same content, different
  // identity. That bumped `load`'s identity, which made both useEffects
  // below (`[load]` and `[me?.id, load]`) re-fire. Each fire re-ran
  // load(), which started with setLoading(true), briefly showing a
  // loader before the fetch settled and setLoading(false) restored the
  // dashboard. Visually: a flicker every 20s + every realtime event.
  //
  // Admin/HR (Dashboard.jsx) and managers (ManagerDashboard.jsx) didn't
  // hit this — they don't run PersonalDashboard's load callback.
  //
  // Fix: stash the props in a ref so load can read them at runtime
  // without listing them as deps. load's identity now only changes
  // when me?.id changes. The two useEffects stay stable across re-
  // renders. Realtime subscriptions only refresh load() via direct
  // event handlers, never via cascading dep churn.
  //
  // Also: setLoading(true) is now skipped on follow-up loads (gated
  // on the loadedOnceRef). Initial mount still shows the loader; the
  // background polling/realtime-driven refreshes happen silently.
  const propsRef = useRef({ requestsProp, permissionsProp });
  const loadedOnceRef = useRef(false);
  useEffect(() => {
    propsRef.current = { requestsProp, permissionsProp };
  });

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
    // Only show the loader on the FIRST load. Subsequent refreshes
    // (polling, realtime, prop changes) happen silently in the
    // background so the dashboard doesn't flicker.
    if (!loadedOnceRef.current) setLoading(true);
    try {
      const year  = new Date().getFullYear();
      const month = new Date().toISOString().slice(0, 7);
      // directGet (raw fetch + timeout) avoids supabase-js wedge after sign-in.
      const safe = (p) => p.catch((err) => { console.warn('PD load failed:', err); return null; });
      // Skip the leaves/permissions fetch when the parent passed them
      // in — AppShell is the source of truth for those, and re-fetching
      // here would just waste round-trips. We always need balances
      // because AppShell doesn't load those. Read props from the ref
      // so this callback's identity stays stable across re-renders.
      const { requestsProp: rp, permissionsProp: pp } = propsRef.current;
      const skipLeaves = Array.isArray(rp);
      const skipPerms  = Array.isArray(pp);
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
    } finally {
      loadedOnceRef.current = true;
      setLoading(false);
    }
  }, [me?.id]);

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

  // ── Sick-leave hooks ─────────────────────────────────────────────
  // These useMemo / useState / useCallback hooks MUST live above the
  // `if (loading) return <Loader />` early return below. React hooks
  // must be called in the same order on every render; if we put any
  // hook after a conditional return, the render that takes the early
  // path skips them and the render that doesn't take the early path
  // suddenly creates them. React detects the mismatch and crashes the
  // component to a blank screen — which is exactly what happened in
  // the 2026-05-09 multi-staff blank-screen incident.
  //
  // Don't move these below `if (loading)`. Don't add new hooks below
  // it either. All hooks at the top, conditional render afterwards.

  // Saudi sick-leave entitlement tracker (Article 117) — YTD sick days
  // used + the entitlement tier the staff is in.
  // Tiers (Article 117):
  //   Days 1-30   →  100% pay (full)
  //   Days 31-90  →  75% pay  (partial)
  //   Days 91-120 →  unpaid
  //   Days 121+   →  grounds for medical termination
  // We count days from approved + pending sick leaves whose start_date
  // falls in the current calendar year.
  const sickYtd = useMemo(() => {
    const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
    const today     = new Date().toISOString().slice(0, 10);
    let total = 0;
    (requests || []).forEach(r => {
      if (r.leave_type_id !== 'sick') return;
      if (r.status === 'rejected' || r.status === 'cancelled') return;
      if (!r.start_date || r.start_date < yearStart) return;
      if (r.start_date > today) return;
      const startD = r.start_date;
      const endD   = r.end_date && r.end_date < today ? r.end_date : today;
      if (endD < startD) return;
      const a = new Date(startD + 'T00:00:00');
      const b = new Date(endD   + 'T00:00:00');
      const diff = Math.floor((b - a) / 86_400_000) + 1;
      total += Math.max(0, diff);
    });
    return total;
  }, [requests]);
  const sickTier = useMemo(() => {
    if (sickYtd <= 30)  return { label: 'Full pay tier',    paidPct: 100, daysLeft: 30 - sickYtd,  color: '#0F4C2A', bg: '#ECFDF5' };
    if (sickYtd <= 90)  return { label: 'Partial pay tier', paidPct: 75,  daysLeft: 90 - sickYtd,  color: '#A16207', bg: '#FEF3C7' };
    if (sickYtd <= 120) return { label: 'Unpaid tier',      paidPct: 0,   daysLeft: 120 - sickYtd, color: '#B91C1C', bg: '#FEE2E2' };
    return                       { label: 'Beyond entitlement', paidPct: 0, daysLeft: 0,           color: '#7F1D1D', bg: '#FEE2E2' };
  }, [sickYtd]);

  // Active sick leave detection — fuels the "Still sick? Extend" card.
  // Surfaces only when there's a sick leave whose end_date is today
  // or yesterday and whose status isn't terminal.
  const activeSick = useMemo(() => {
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    const yIso     = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
    return (requests || [])
      .filter(r =>
        r.leave_type_id === 'sick'
        && r.status !== 'rejected'
        && r.status !== 'cancelled'
        && (r.end_date === todayIso || r.end_date === yIso))
      .sort((a, b) => (b.requested_at || '').localeCompare(a.requested_at || ''))[0]
      || null;
  }, [requests]);

  const [extendBusy, setExtendBusy] = useState(false);
  const [extendErr,  setExtendErr]  = useState('');
  const handleExtend = useCallback(async () => {
    if (!activeSick || extendBusy) return;
    setExtendBusy(true);
    setExtendErr('');
    try {
      const cur     = new Date(activeSick.end_date + 'T00:00:00');
      const next    = new Date(cur.getTime() + 86_400_000);
      const newEnd  = next.toISOString().slice(0, 10);
      const newDays = (Number(activeSick.days) || 1) + 1;
      await directPatch(
        'leave_requests', 'id', activeSick.id,
        { end_date: newEnd, days: newDays },
        { timeoutMs: 9000 },
      );
      try {
        await directPost('attendance_daily', {
          employee_id:      activeSick.employee_id,
          attendance_date:  newEnd,
          status:           'sick_leave',
          leave_request_id: activeSick.id,
          source:           'self_declared',
          recorded_at:      new Date().toISOString(),
          notes:            'Sick leave extended via dashboard.',
        }, {
          upsert:     true,
          onConflict: 'employee_id,attendance_date',
          timeoutMs:  9000,
        });
      } catch (e) {
        console.warn('[handleExtend] attendance write failed (non-blocking)', e);
      }
      window.location.reload();
    } catch (e) {
      console.error('[handleExtend] failed', e);
      setExtendErr((e && (e.message || e.toString())) || 'Could not extend. Try again.');
      setExtendBusy(false);
    }
  }, [activeSick, extendBusy]);

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

      {/* ACTIVE SICK LEAVE — Extend flow.
          Surfaces ONLY when the staff member has a sick leave whose
          end_date is today or yesterday. Lets them roll the leave
          forward by one calendar day without re-running the full
          declare flow (which would create a second row and a second
          cert obligation). The same DB row gets its end_date pushed
          forward; today's attendance is already covered, the new
          day gets its attendance_daily row written by handleExtend. */}
      {activeSick && (() => {
        const todayIso = new Date().toISOString().slice(0, 10);
        const endingToday   = activeSick.end_date === todayIso;
        const endedYesterday = !endingToday;
        return (
          <section
            className="rounded-2xl border p-4 sm:p-5"
            style={{ background: '#FEF2F2', borderColor: '#FCA5A5' }}
          >
            <div className="flex items-start gap-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: '#FFFFFF', color: '#B91C1C', border: '1px solid #FCA5A5' }}
              >
                <HeartPulse className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold" style={{ color: '#7F1D1D' }}>
                  {endingToday ? 'You\'re on sick leave today' : 'Your sick leave ended yesterday'}
                </div>
                <div className="text-[12px] mt-0.5" style={{ color: '#7F1D1D', opacity: 0.85 }}>
                  Declared {fmtDate(new Date(activeSick.start_date))} &mdash; {fmtDate(new Date(activeSick.end_date))} ({activeSick.days} {activeSick.days === 1 ? 'day' : 'days'}).
                  {' '}Tap below if you're still sick.
                </div>
                {extendErr && (
                  <div className="mt-2 px-2.5 py-1.5 rounded-md text-[11px]"
                       style={{ background: '#FEE2E2', color: '#0A0A0A', border: '1px solid #FECACA' }}>
                    {extendErr}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleExtend}
                    disabled={extendBusy}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold transition-opacity disabled:opacity-50"
                    style={{ background: '#B91C1C', color: '#FFFFFF', border: 'none' }}
                  >
                    {extendBusy
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Extending…</>
                      : <>Still sick &mdash; extend by 1 day</>}
                  </button>
                </div>
              </div>
            </div>
          </section>
        );
      })()}

      {/* SICK LEAVE BALANCE — Article 117 entitlement ribbon.
          Surfaces only when the staff has used at least one sick day
          this year. Showing it for staff with zero sick days would be
          noise. Three-segment progress bar reflects the 30/60/30
          structure of the law: full pay → partial → unpaid. */}
      {sickYtd > 0 && (
        <section
          className="rounded-2xl border p-4 sm:p-5"
          style={{ background: sickTier.bg, borderColor: sickTier.color, borderWidth: '1px' }}
        >
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="text-[10px] tracking-[0.25em] font-bold" style={{ color: sickTier.color }}>
                SICK LEAVE BALANCE · {new Date().getFullYear()}
              </div>
              <div className="mt-1 text-sm" style={{ color: sickTier.color, fontWeight: 600 }}>
                {sickYtd} {sickYtd === 1 ? 'day' : 'days'} used
                <span style={{ opacity: 0.65, fontWeight: 500 }}> · {sickTier.label}</span>
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                {sickTier.paidPct === 100 && sickTier.daysLeft > 0 &&
                  `${sickTier.daysLeft} days remain at full pay (Article 117).`}
                {sickTier.paidPct === 75 && sickTier.daysLeft > 0 &&
                  `${sickTier.daysLeft} days remain at 75% pay before the unpaid tier.`}
                {sickTier.paidPct === 0 && sickTier.daysLeft > 0 &&
                  `${sickTier.daysLeft} days of unpaid sick entitlement remain.`}
                {sickTier.daysLeft === 0 &&
                  'You\'ve used your full annual sick entitlement under Article 117.'}
              </div>
            </div>
          </div>
          {/* Three-segment progress bar — visually maps the 30/60/30
              structure. Each segment fills to show consumption within
              its tier; saturated bars indicate tier exhaustion. */}
          <div className="mt-3 flex gap-1.5" style={{ height: 8 }}>
            <Segment used={Math.min(sickYtd, 30)}        cap={30} color="#0F4C2A" />
            <Segment used={Math.max(0, Math.min(sickYtd - 30, 60))} cap={60} color="#A16207" />
            <Segment used={Math.max(0, Math.min(sickYtd - 90, 30))} cap={30} color="#B91C1C" />
          </div>
          <div className="mt-1.5 flex justify-between text-[9px] tracking-wider" style={{ color: '#0A0A0A', opacity: 0.55 }}>
            <span>0</span><span>30 (full)</span><span>90 (partial)</span><span>120</span>
          </div>
        </section>
      )}
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

      {/* REJOINING — back-from-leave staff prompt. Shows when one of MY
          approved leaves has finished and I haven't submitted my
          rejoining yet (or it was sent back). Hides itself otherwise. */}
      <MyRejoiningCard me={me} employees={Object.values(empMap || {})} />

      {/* SUBSTITUTE FREED — when a colleague the user was covering for
          submits their rejoining, the DB trigger fires a notification
          and this card surfaces it. Hides itself when no unread. */}
      <SubstituteFreedCard me={me} />

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
        {/* Sick declarations are now inside the +Request leave picker
            (RequestTypePicker shows "I'm sick today" as the second
            tile). Keeps the dashboard chrome clean and consolidates
            all request entry through one button. */}
        <button onClick={onOpenNewRequest}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs"
          style={{ background:'var(--ink)', color:'var(--paper)' }}>
          <Plus className="w-3 h-3" /> Request leave
        </button>
      </div>
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
        onUploadCert={onUploadCert}
      />
      {/* Self-service attendance record. Auto-hides when there are no
          violations on file — clean records don't need this card. */}
      <MyAttendanceCard me={me} />
      {/* Personal shift month grid — shows assigned shifts for the
          visible month. Complements StaffShiftStatusCard's 30-day
          status list: list says "what got approved", calendar says
          "where am I working this month". Auto-hides via
          ShiftMonthGrid's empty-state when no shifts exist. */}
      <MyShiftMonthCard me={me} />
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
// #FFFFFF background, soft warm border, gentle hover lift). Keeps a small
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
      style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', minHeight: '140px' }}>
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
            fontFamily: 'inherit',
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
      style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', minHeight: '140px' }}
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
            fontFamily: 'inherit',
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

function DigestStat({ label, primary, secondary, color }) {
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--paper-soft, #F4F4EE)' }}>
      <div className="text-[10px] tracking-[0.2em] opacity-60 mb-1">{label.toUpperCase()}</div>
      <div className="text-sm font-semibold" style={{ color }}>{primary}</div>
      <div className="text-[10px] opacity-60 mt-0.5">{secondary}</div>
    </div>
  );
}

// Single segment of the sick-balance progress bar. Each segment maps
// to one Article 117 tier (full pay / partial pay / unpaid). The
// fill width reflects how much of that tier the staff has consumed.
function Segment({ used, cap, color }) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  return (
    <div
      style={{
        flex: cap, // tier widths reflect their day count proportionally
        background: '#FFFFFF',
        border: '1px solid rgba(10,10,10,0.08)',
        borderRadius: 4,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          background: color,
          transition: 'width 0.3s ease',
        }}
      />
    </div>
  );
}
