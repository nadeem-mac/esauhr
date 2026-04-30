import React, { useState, useMemo } from 'react';
import { supabase } from '../supabaseClient.js';
import { X, AlertTriangle, Sunrise, Sunset, Loader2 } from 'lucide-react';
import { logAction } from '../lib/audit.js';
import { checkExceeds, summariseMonth, PERMISSION_QUOTA, PERMISSION_TYPES, reasonsFor } from '../lib/permissionLogic.js';

export default function PermissionRequestModal({ me, type = 'late_arrival', monthRows = [], onClose, onSubmitted }) {
  const today = new Date().toISOString().slice(0, 10);
  const [date,    setDate]    = useState(type === 'late_arrival' ? today : today);
  const [hours,   setHours]   = useState(1);
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

  const summary = summariseMonth(monthRows);
  const exceeds = useMemo(() => checkExceeds(monthRows, hours), [monthRows, hours]);
  const Icon    = type === 'late_arrival' ? Sunrise : Sunset;
  const cfg     = PERMISSION_TYPES[type];

  async function submit(e) {
    e.preventDefault();
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
        reason:          finalReason,
        exceeds_quota:   exceeds.willExceed,
        requested_by:    me.id,
      }).select().single();
      if (error) throw error;
      logAction(me, 'permission_create', {
        targetType: 'permission_request',
        targetId: data?.id,
        targetLabel: `${cfg.label} · ${date} · ${hours}h${exceeds.willExceed ? ' (FLAGGED)' : ''}`,
        details: { type, hours, exceeds_quota: exceeds.willExceed, reason: finalReason },
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

          {/* Hours */}
          <div>
            <label className="block text-[10px] tracking-[0.25em] opacity-60 mb-2">HOURS</label>
            <div className="grid grid-cols-3 gap-2">
              {[1, 2, 3].map(h => (
                <button key={h} type="button" onClick={() => setHours(h)}
                  className="px-4 py-3 rounded-xl border text-sm transition-all"
                  style={{
                    borderColor: hours === h ? 'var(--ink)' : 'var(--border)',
                    background: hours === h ? 'var(--ink)' : 'transparent',
                    color: hours === h ? 'var(--paper)' : 'var(--ink)',
                  }}>
                  {h} hour{h !== 1 ? 's' : ''}
                </button>
              ))}
            </div>
            <div className="text-[11px] opacity-60 mt-2">
              Each request is normally 1 hour. Picking 2 or 3 uses more of your monthly quota in a single request.
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
