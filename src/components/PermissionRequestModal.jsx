import React, { useState, useMemo, useEffect } from 'react';
import { supabase, directGet, directPost } from '../supabaseClient.js';
import { X, AlertTriangle, Sunrise, Sunset, Loader2, History, Clock } from 'lucide-react';
import { logAction } from '../lib/audit.js';
import { checkExceeds, summariseMonth, PERMISSION_QUOTA, PERMISSION_TYPES, reasonsFor } from '../lib/permissionLogic.js';
import { getMinPermissionDate, isRetroactive, MAX_RETROACTIVE_DAYS } from '../lib/retroactivePermissions.js';
import { initialApprovalStage } from '../lib/leaveLogic.js';

export default function PermissionRequestModal({ me, type = 'late_arrival', monthRows = [], employees = [], onClose, onSubmitted }) {
  const today = new Date().toISOString().slice(0, 10);
  // Earliest date the staff can pick — today minus MAX_RETROACTIVE_DAYS.
  // The HTML date input enforces this client-side via `min`. The DB
  // accepts any date (the column is `date not null` with no check),
  // so this is the only enforcement point. If staff bypass via dev
  // tools, the request still goes through — caught later by Bashaier
  // at HR review.
  const minDate = useMemo(() => getMinPermissionDate(new Date()), []);
  const [date,    setDate]    = useState(type === 'late_arrival' ? today : today);
  const isBackdated = isRetroactive(date, today);
  // Time window — required as of the bilingual form rollout. Defaults are
  // typical office hours so the staff member can adjust by a few clicks
  // rather than starting from blank fields.
  //   • Late Arrival: 'from' = scheduled start, 'to' = when they actually
  //     arrived. Default 08:00 → 09:00 (1 hr late).
  //   • Early Leave: 'from' = when they actually left, 'to' = scheduled
  //     end. Default 16:00 → 17:00 (1 hr early).
  const [timeFrom, setTimeFrom] = useState(type === 'late_arrival' ? '08:00' : '16:00');
  const [timeTo,   setTimeTo]   = useState(type === 'late_arrival' ? '09:00' : '17:00');
  // hours is now derived from the time window — kept as state because the
  // quota-check helper expects a single hours value. Recomputed via
  // useMemo whenever timeFrom/timeTo change.
  // Reason is now a curated dropdown (set per-type via reasonsFor) plus a
  // small free-text input that only appears when 'Other' is selected. The
  // final string saved to permission_requests.reason is composed at submit
  // time. Free-text was removed because HR couldn't bucket the data
  // meaningfully when every staff phrased "doctor" / "medical" / "clinic"
  // differently.
  const [reasonCategory, setReasonCategory] = useState('');
  const [reasonOther,    setReasonOther]    = useState('');
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState('');

  const reasonOptions = reasonsFor(type);
  const isOther       = reasonCategory === 'Other';

  // Duration in minutes — derived from timeFrom / timeTo. Returns NaN if
  // either string is empty or malformed; surrounding code treats NaN as
  // 'invalid' for validation and disables the submit button.
  const durationMin = useMemo(() => {
    const toMin = (s) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
      if (!m) return NaN;
      return Number(m[1]) * 60 + Number(m[2]);
    };
    const a = toMin(timeFrom), b = toMin(timeTo);
    if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
    return b - a;
  }, [timeFrom, timeTo]);

  // hours = duration / 60. Round to 1 decimal so the numeric(3,1) column
  // accepts it (0.5, 1.0, etc.).
  const hours = useMemo(() => {
    if (Number.isNaN(durationMin) || durationMin <= 0) return 0;
    return Math.round((durationMin / 60) * 10) / 10;
  }, [durationMin]);

  const summary = summariseMonth(monthRows);
  // Allowance already fully used this month → block new requests.
  const quotaCompleted = summary.atQuota;
  const exceeds = useMemo(() => checkExceeds(monthRows, hours), [monthRows, hours]);
  const Icon    = type === 'late_arrival' ? Sunrise : Sunset;
  const cfg     = PERMISSION_TYPES[type];

  // Quick-pick chips from this employee's last 3 approved permissions
  // of the same type. Saves them re-typing the same time window every
  // week. Click a chip to pre-fill from-time and to-time.
  // Distinct windows only — if they always request 08:00-09:00, a
  // single chip covers it. Falls back silently to no chips if the
  // fetch fails or there's no history.
  const [recentPicks, setRecentPicks] = useState([]);
  useEffect(() => {
    if (!me?.id || !type) return;
    let cancelled = false;
    (async () => {
      try {
        // Last 90 days, approved, same type. Order by most recent so
        // the chips reflect current habits rather than ancient history.
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);
        const cutoffIso = cutoff.toISOString().slice(0, 10);
        const data = await directGet(
          'permission_requests?select=time_from,time_to,permission_date'
          + '&employee_id=eq.' + encodeURIComponent(me.id)
          + '&type=eq.' + type
          + '&stage=eq.approved'
          + '&permission_date=gte.' + cutoffIso
          + '&order=permission_date.desc&limit=10'
        );
        if (cancelled) return;
        // Distinct time windows only
        const seen = new Set();
        const distinct = [];
        (data || []).forEach(p => {
          if (!p.time_from || !p.time_to) return;
          const f = String(p.time_from).slice(0, 5);
          const t = String(p.time_to).slice(0, 5);
          const key = f + '|' + t;
          if (seen.has(key)) return;
          seen.add(key);
          distinct.push({ from: f, to: t, lastUsed: p.permission_date });
          if (distinct.length >= 3) return;
        });
        setRecentPicks(distinct);
      } catch (e) {
        console.warn('[Permission auto-suggest] fetch failed:', e?.message || e);
      }
    })();
    return () => { cancelled = true; };
  }, [me?.id, type]);

  const applyPick = (pick) => {
    setTimeFrom(pick.from);
    setTimeTo(pick.to);
  };

  // Validation flags — used to disable the submit button + show inline
  // hint text. Matches ESAU policy: each request 15–60 mins, must be a
  // valid forward window.
  const timeError =
    Number.isNaN(durationMin) ? 'Pick a start and end time.' :
    durationMin <= 0           ? 'End time must be after start time.' :
    durationMin < 15           ? 'Minimum permission window is 15 minutes.' :
    durationMin > 60           ? 'Each request must not exceed 60 minutes (company policy).' :
    '';

  async function submit(e) {
    e.preventDefault();
    if (quotaCompleted) {
      setError(`You have completed your monthly permission allowance (${PERMISSION_QUOTA.monthlyOccurrences} permissions / ${PERMISSION_QUOTA.monthlyHours} hours). No further requests can be submitted this month.`);
      return;
    }
    if (timeError) {
      setError(timeError);
      return;
    }
    // Validate reason — category required, and if 'Other' the staff must
    // specify what 'Other' means. Without these checks HR ends up with
    // empty or meaningless reasons that block reconciliation.
    if (!reasonCategory) {
      setError('Please pick a reason from the list.');
      return;
    }
    if (isOther && !reasonOther.trim()) {
      setError('You picked "Other" — please specify the reason in a few words.');
      return;
    }
    const finalReason = isOther
      ? `Other — ${reasonOther.trim()}`
      : reasonCategory;
    setBusy(true);
    setError('');
    try {
      // CRITICAL — use directPost, not supabase.from().insert(). The
      // supabase-js builder chain silently wedges in this project (see
      // architectural rule). The previous version used the broken path
      // and rows would intermittently never persist, leaving the staff
      // member thinking they submitted but no one downstream saw it.
      // Per Nadeem (2026-05-06): "I made an early leave request from
      // Bashaier but it still did not appear in Fahad screen" — this
      // is the fix.
      const newStage = initialApprovalStage(me, employees);
      const row = {
        employee_id:     me.id,
        type,
        permission_date: date,
        hours,
        time_from:       timeFrom,
        time_to:         timeTo,
        reason:          finalReason,
        exceeds_quota:   exceeds.willExceed,
        // Stamp requested_at explicitly — same reason as leave_requests.
        // MyApplicationsCard's 90-day window filter sorts and filters
        // by this column; without it, the row sorts to epoch 0 and
        // gets excluded from the staff's visible list.
        requested_at:    new Date().toISOString(),
        requested_by:    me.id,
        // Stage routing — managers (anyone with direct reports) skip
        // the manager-approval step and go straight to HR. Non-managers
        // start at 'pending_manager' as usual.
        stage:           newStage,
      };
      const created = await directPost('permission_requests', row, { timeoutMs: 10000 });
      const data = Array.isArray(created) ? created[0] : created;
      logAction(me, 'permission_create', {
        targetType: 'permission_request',
        targetId: data?.id,
        targetLabel: `${cfg.label} · ${date} · ${timeFrom}–${timeTo} (${durationMin}m)${exceeds.willExceed ? ' (FLAGGED)' : ''}`,
        details: { type, hours, time_from: timeFrom, time_to: timeTo, exceeds_quota: exceeds.willExceed, reason: finalReason, stage: newStage },
      });
      onSubmitted?.();
    } catch (err) {
      setError(err?.message || 'Could not submit. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
      style={{ background: 'rgba(8,24,16,0.7)' }}>
      <div className="w-full max-w-lg rounded-t-3xl sm:rounded-3xl overflow-hidden"
        style={{ background: 'var(--paper)', maxHeight: '90vh' }}>

        <div className="flex items-center justify-between px-6 py-5 border-b"
          style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{ background: 'var(--evergreen-800)' }}>
              <Icon className="w-5 h-5" style={{ color: '#F2F2F2' }}/>
            </div>
            <div>
              <div className="serif text-xl leading-none" style={{ fontWeight: 600 }}>{cfg.label}</div>
              <div className="text-[10px] tracking-[0.25em] opacity-60 mt-1">PERMISSION REQUEST</div>
            </div>
          </div>
          <button onClick={onClose} className="opacity-60 hover:opacity-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={submit} className="p-6 space-y-5 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 80px)' }}>

          {/* Quota strip */}
          <div className="rounded-xl p-4 text-xs"
            style={{ background: 'var(--paper-2)', border: '1px solid var(--border-soft)' }}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="opacity-70">This month so far</span>
              <span className="font-mono">{summary.hoursUsed}h / {PERMISSION_QUOTA.monthlyHours}h · {summary.occurrences} / {PERMISSION_QUOTA.monthlyOccurrences}</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(15,40,24,0.08)' }}>
              <div className="h-full rounded-full" style={{
                width: `${Math.min(100, (summary.hoursUsed / PERMISSION_QUOTA.monthlyHours) * 100)}%`,
                background: summary.overQuota ? 'var(--clay)' : 'var(--evergreen-500)',
              }}/>
            </div>
            <div className="opacity-60 mt-2">
              Combined cap covers BOTH late arrival and early leaving.
              {summary.overQuota && ' Already over quota — flagged for evaluation.'}
            </div>
          </div>

          {/* Date — accepts dates up to MAX_RETROACTIVE_DAYS back so
              staff can file a backdated permission for a late arrival
              or early departure that already happened. The HR Department's
              attendance violation emails (sent the next morning) tell
              staff to file retroactively for yesterday's punch — this
              date input is the entry point for that flow. */}
          <div>
            <label className="block text-[10px] tracking-[0.25em] opacity-60 mb-2">DATE</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              required min={minDate} max={today}
              className="w-full px-4 py-3 rounded-xl border bg-transparent text-sm"
              style={{ borderColor: 'var(--border)' }}/>
            {/* Backdated notice — appears only when the staff picks a
                past date. Confirms the system is treating this as a
                retroactive submission so they're not surprised when
                their manager / HR see a "BACKDATED" pill on the row. */}
            {isBackdated && (
              <div className="mt-2 rounded-lg px-3 py-2 text-[11px] flex items-start gap-2"
                   style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #F59E0B' }}>
                <Clock className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <div>
                  <span style={{ fontWeight: 600 }}>Backdated request.</span>{' '}
                  This permission is for a date that has already passed. It still counts against your monthly quota and goes through the same manager + HR approval flow. You can file up to {MAX_RETROACTIVE_DAYS} days back.
                </div>
              </div>
            )}
          </div>

          {/* Time window — From / To clock times. The duration in mins
              is auto-computed and shown read-only. Each request must be
              between 15 and 60 mins per company policy (validated above
              + enforced server-side via row-level check). */}
          <div>
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <label className="text-[10px] tracking-[0.25em]"
                style={{ color: '#1F1B16', fontWeight: 700 }}>
                TIME · ARABIC الوقت
              </label>
              {/* Quick-pick chips from history. Surfaces only when
                  the employee has prior approved permissions of this
                  type — one click pre-fills the form from a recent
                  pattern. Saves re-typing the same window every week. */}
              {recentPicks.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[9px] tracking-wider opacity-60 inline-flex items-center gap-1"
                    style={{ color: '#1F1B16', fontWeight: 700 }}>
                    <History className="w-3 h-3"/> RECENT
                  </span>
                  {recentPicks.map((p, i) => (
                    <button key={i} type="button" onClick={() => applyPick(p)}
                      className="text-[10px] font-mono px-2 py-1 rounded-full border hover:bg-black/5 transition-colors"
                      style={{ borderColor: 'var(--border)', color: '#1F1B16' }}
                      title={`Last used ${new Date(p.lastUsed).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}>
                      {p.from}–{p.to}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[10px] mb-1" style={{ color: '#1F1B16', opacity: 0.7 }}>From · من</div>
                <input type="time" value={timeFrom} onChange={e => setTimeFrom(e.target.value)}
                  required step="60"
                  className="w-full px-3 py-3 rounded-xl border bg-transparent text-sm font-mono"
                  style={{ borderColor: 'var(--border)' }}/>
              </div>
              <div>
                <div className="text-[10px] mb-1" style={{ color: '#1F1B16', opacity: 0.7 }}>To · إلى</div>
                <input type="time" value={timeTo} onChange={e => setTimeTo(e.target.value)}
                  required step="60"
                  className="w-full px-3 py-3 rounded-xl border bg-transparent text-sm font-mono"
                  style={{ borderColor: 'var(--border)' }}/>
              </div>
            </div>
            <div className="text-[11px] mt-2" style={{ color: timeError ? '#B91C1C' : '#1F1B16' }}>
              {timeError || (
                <>Duration: <span className="font-mono" style={{ fontWeight: 600 }}>{durationMin} mins</span> · uses {hours} {hours === 1 ? 'hour' : 'hours'} of your monthly bucket. Each request must not exceed 60 minutes (company policy).</>
              )}
            </div>
          </div>

          {/* Reason — curated dropdown. The list is type-specific (different
              framing for late vs early) and tailored to what HR most often
              sees and can act on. 'Other' opens a small specifier input
              underneath, which becomes required when picked. */}
          <div>
            <label className="block text-[10px] tracking-[0.25em] mb-2" style={{ color: '#1F1B16', fontWeight: 700 }}>
              REASON
            </label>
            <select
              value={reasonCategory}
              onChange={e => setReasonCategory(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-xl border bg-white text-sm"
              style={{ borderColor: 'var(--border)', color: '#1F1B16' }}
            >
              <option value="">— Select a reason —</option>
              {reasonOptions.map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            {isOther && (
              <div className="mt-2">
                <label className="block text-[10px] tracking-[0.25em] mb-1.5" style={{ color: '#1F1B16', fontWeight: 700 }}>
                  PLEASE SPECIFY
                </label>
                <input
                  type="text"
                  value={reasonOther}
                  onChange={e => setReasonOther(e.target.value)}
                  placeholder="A few words so HR understands the context"
                  required
                  maxLength={120}
                  className="w-full px-4 py-2.5 rounded-xl border bg-white text-sm"
                  style={{ borderColor: 'var(--border)', color: '#1F1B16' }}
                />
              </div>
            )}
          </div>

          {/* Quota completed — hard block */}
          {quotaCompleted && (
            <div className="rounded-xl p-4 flex items-start gap-3 text-sm"
              style={{ background: 'rgba(184,74,62,0.10)', border: '1px solid var(--clay)' }}>
              <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--clay)' }} />
              <div>
                <div className="font-medium mb-1" style={{ color: 'var(--clay)' }}>
                  Monthly permission quota completed
                </div>
                <div className="opacity-80 text-xs leading-relaxed">
                  You have used {summary.hoursUsed}h / {summary.occurrences} permission(s) — the limit is
                  {' '}{PERMISSION_QUOTA.monthlyHours}h · {PERMISSION_QUOTA.monthlyOccurrences} permissions.
                  No further requests can be submitted this month. For a genuine emergency, please contact your manager or HR directly.
                </div>
              </div>
            </div>
          )}

          {/* Quota warning — this request would tip over, but not yet full */}
          {!quotaCompleted && exceeds.willExceed && (
            <div className="rounded-xl p-4 flex items-start gap-3 text-sm"
              style={{ background: 'rgba(184,74,62,0.08)', border: '1px solid var(--clay)' }}>
              <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--clay)' }} />
              <div>
                <div className="font-medium mb-1" style={{ color: 'var(--clay)' }}>
                  Will exceed your monthly quota
                </div>
                <div className="opacity-80 text-xs leading-relaxed">{exceeds.reason}</div>
              </div>
            </div>
          )}

          {error && (
            <div className="text-xs px-4 py-2 rounded-lg"
              style={{ background: 'rgba(184,74,62,0.1)', color: 'var(--clay)' }}>
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-5 py-2.5 rounded-full text-sm opacity-70 hover:opacity-100">
              Cancel
            </button>
            <button type="submit" disabled={busy || quotaCompleted}
              title={quotaCompleted ? 'Monthly permission quota already completed' : undefined}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm disabled:opacity-50"
              style={{
                background: (exceeds.willExceed || quotaCompleted) ? 'var(--clay)' : 'var(--ink)',
                color: 'var(--paper)',
              }}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {busy ? 'Submitting…' : quotaCompleted ? 'Quota completed' : exceeds.willExceed ? 'Submit anyway (will be flagged)' : 'Submit request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
