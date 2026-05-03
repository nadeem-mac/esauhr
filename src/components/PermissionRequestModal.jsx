import React, { useState, useMemo, useEffect } from 'react';
import { supabase, directGet } from '../supabaseClient.js';
import { X, AlertTriangle, Sunrise, Sunset, Loader2, History } from 'lucide-react';
import { logAction } from '../lib/audit.js';
import { checkExceeds, summariseMonth, PERMISSION_QUOTA, PERMISSION_TYPES, reasonsFor } from '../lib/permissionLogic.js';

export default function PermissionRequestModal({ me, type = 'late_arrival', monthRows = [], onClose, onSubmitted }) {
  const today = new Date().toISOString().slice(0, 10);
  const [date,    setDate]    = useState(type === 'late_arrival' ? today : today);
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
      const { data, error } = await supabase.from('permission_requests').insert({
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
        stage:           'pending_manager',
      }).select().single();
      if (error) throw error;
      logAction(me, 'permission_create', {
        targetType: 'permission_request',
        targetId: data?.id,
        targetLabel: `${cfg.label} · ${date} · ${timeFrom}–${timeTo} (${durationMin}m)${exceeds.willExceed ? ' (FLAGGED)' : ''}`,
        details: { type, hours, time_from: timeFrom, time_to: timeTo, exceeds_quota: exceeds.willExceed, reason: finalReason },
      });
      onSubmitted?.();
    } catch (err) {
      setError(err.message);
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
              <Icon className="w-5 h-5" style={{ color: '#F4EEDF' }}/>
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

          {/* Date */}
          <div>
            <label className="block text-[10px] tracking-[0.25em] opacity-60 mb-2">DATE</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              required min={today}
              className="w-full px-4 py-3 rounded-xl border bg-transparent text-sm"
              style={{ borderColor: 'var(--border)' }}/>
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

          {/* Quota warning */}
          {exceeds.willExceed && (
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
            <button type="submit" disabled={busy}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm disabled:opacity-50"
              style={{
                background: exceeds.willExceed ? 'var(--clay)' : 'var(--ink)',
                color: 'var(--paper)',
              }}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {busy ? 'Submitting…' : exceeds.willExceed ? 'Submit anyway (will be flagged)' : 'Submit request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
