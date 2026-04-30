import React, { useEffect, useState, useCallback } from 'react';
import { supabase, directGet } from '../supabaseClient.js';
import {
  Calendar, Clock, Plus, AlertTriangle, Sun, Sunrise, Sunset,
  CheckCircle2, XCircle, Loader2, Users, Plane
} from 'lucide-react';
import { UserCheck, ThumbsUp, ThumbsDown } from 'lucide-react';
import { fmtDate, calculateBalance, fmtDateShort, getInitials, avatarColor } from '../lib/leaveLogic.js';
import { summariseMonth, PERMISSION_QUOTA } from '../lib/permissionLogic.js';
import PermissionStatusCard from './PermissionStatusCard.jsx';
import StaffShiftStatusCard from './StaffShiftStatusCard.jsx';
import { downloadVacationFormForRequest } from '../lib/vacationForm.js';
import { Download } from 'lucide-react';

// Staff personal dashboard. Compact colorful gradient tiles.
export default function PersonalDashboard({
  me,
  leaveTypes,
  empMap,
  pendingShifts,        // employee_shifts rows with status='pending' for me
  onOpenShiftAck,       // callback that opens the ShiftAcknowledgmentModal
  onOpenNewRequest,
}) {
  const [adjustments, setAdjustments] = useState({});
  const [requests,    setRequests]    = useState([]);
  const [permissions, setPermissions] = useState([]);
  // Substitution requests where THIS user is one of the proposed substitutes
  // and the request is still waiting on substitute decisions.
  const [subRequests, setSubRequests] = useState([]);
  const [loading,     setLoading]     = useState(true);

  const load = useCallback(async () => {
    if (!me?.id) return;
    setLoading(true);
    try {
      const year  = new Date().getFullYear();
      const month = new Date().toISOString().slice(0, 7);
      // directGet (raw fetch + timeout) avoids supabase-js wedge after sign-in.
      const safe = (p) => p.catch((err) => { console.warn('PD load failed:', err); return null; });
      const [bal, reqs, perms, subs] = await Promise.all([
        safe(directGet('leave_balances',     `select=*&employee_id=eq.${me.id}&year=eq.${year}&leave_type_id=eq.annual&limit=1`, { timeoutMs: 10000 })),
        safe(directGet('leave_requests',     `select=*&employee_id=eq.${me.id}&order=start_date.desc&limit=20`,                    { timeoutMs: 10000 })),
        safe(directGet('permission_requests',`select=*&employee_id=eq.${me.id}&permission_date=gte.${month}-01&order=permission_date.desc`, { timeoutMs: 10000 })),
        safe(directGet('leave_requests',     `select=*&substitute_ids=cs.{${me.id}}&stage=eq.pending_substitutes&order=start_date.asc`, { timeoutMs: 10000 })),
      ]);
      setAdjustments(Array.isArray(bal) && bal.length > 0 ? bal[0] : {});
      setRequests(Array.isArray(reqs) ? reqs : []);
      setPermissions(Array.isArray(perms) ? perms : []);
      // Filter to only requests where MY decision is still 'pending'
      setSubRequests((Array.isArray(subs) ? subs : []).filter(r => {
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

      {/* SHIFT STATUS — recent activity card. Renders only when the staff
          member has accepted or declined any shift in the last 30 days, so
          they can track the status of decisions they've already made (e.g.
          accepted shift waiting for SUP final approval, or declined shift
          waiting for manager follow-up). The card itself decides whether
          to render based on its own data fetch — pass-through here is
          deliberately minimal. */}
      {/* Permission application history — sits ABOVE the shift status card
          because permissions are the more frequent staff-side activity
          (multiple applications per month vs. shifts which are mostly
          weekly). Self-hides when the staff has no permission activity in
          the last 30 days. */}
      <PermissionStatusCard me={me} />

      <StaffShiftStatusCard me={me} />

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
            {recent.map(r => {
              const isApproved = r.status === 'approved' || r.stage === 'approved';
              const canDownload = isApproved && empMap;
              return (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2.5"
                  style={{ borderColor:'var(--border-soft)' }}>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{labelForType(r.leave_type_id, leaveTypes)}</div>
                  <div className="text-xs opacity-60">
                    {fmtDate(new Date(r.start_date))} — {fmtDate(new Date(r.end_date))} · {r.days} day{r.days !== 1 ? 's' : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <StatusPill status={r.status} />
                  {canDownload && (
                    <button
                      onClick={async () => {
                        try {
                          await downloadVacationFormForRequest(r, empMap);
                        } catch (err) {
                          alert('Could not generate the form: ' + (err?.message || err));
                        }
                      }}
                      title="Download approved vacation form"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg"
                      style={{ background: 'rgba(45,95,63,0.08)', color: '#2D5F3F', border: '1px solid rgba(45,95,63,0.25)' }}>
                      <Download className="w-3 h-3" /> Form
                    </button>
                  )}
                </div>
              </li>
            );})}
          </ul>
        )}
      </section>
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
