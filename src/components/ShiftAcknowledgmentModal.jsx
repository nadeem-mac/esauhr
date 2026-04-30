import React, { useState, useMemo } from 'react';
import { X, Check, AlertCircle, Loader2, Calendar, CalendarClock } from 'lucide-react';
import { supabase, directPatchQuery } from '../supabaseClient.js';
import { logAction } from '../lib/audit.js';

// ─────────────────────────────────────────────────────────────────────────────
// ShiftAcknowledgmentModal
// Phase 2 of the shift-staff workflow.
//
// Trigger
//   AppShell fetches employee_shifts where employee_id=me.id AND status='pending'.
//   If the result is non-empty, this modal renders.
//
// Behaviour
//   • Lists every pending shift (date, day-of-week, start–end times, who set it).
//   • Two paths:
//       — "I understand and accept" → updates ALL listed rows to status='accepted'
//       — "Decline" → opens an inline reason input → status='declined' + reason
//   • A small X / "I'll decide later" closes without action; the modal will
//     return on the next sign-in until the rows are no longer pending.
//
// Schema reference (employee_shifts):
//   accepted_at, declined_at, decline_reason, status
//   (status check constraint: 'pending' | 'accepted' | 'declined')
// ─────────────────────────────────────────────────────────────────────────────

const SMALL_TEXT = { color: '#1F1B16' };
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SAR_LOCALE = 'en-GB';

function trimTime(t) {
  if (!t) return '';
  return String(t).slice(0, 5);
}

function fmtDay(dateStr) {
  // dateStr is 'YYYY-MM-DD'. Parse without TZ drift.
  const [y, m, d] = dateStr.split('-').map(n => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  return {
    dow: DOW[dt.getDay()],
    pretty: dt.toLocaleDateString(SAR_LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }),
  };
}

export default function ShiftAcknowledgmentModal({ me, pendingShifts, employees, onClose, onResolved }) {
  const [step, setStep] = useState('review');           // 'review' | 'declining' | 'submitting' | 'done'
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  // Once the user commits, we lock in their choice for the done-state
  // copy so the success message can speak the right outcome — accepted
  // shifts route to SUP (Bashaier) for final approval, declined ones
  // route back to the manager. The original modal showed the same
  // generic 'Thank you' for both, which left the staff member uncertain
  // about what happens next.
  const [doneDecision, setDoneDecision] = useState(null); // 'accept' | 'decline'

  const setBy = useMemo(() => {
    if (!pendingShifts?.length) return null;
    const id = pendingShifts[0].set_by;
    return (employees || []).find(e => e.id === id) || null;
  }, [pendingShifts, employees]);

  const sortedShifts = useMemo(() => {
    return [...(pendingShifts || [])].sort((a, b) => a.shift_date.localeCompare(b.shift_date));
  }, [pendingShifts]);

  const dateRange = useMemo(() => {
    if (!sortedShifts.length) return '';
    const first = fmtDay(sortedShifts[0].shift_date).pretty;
    const last  = fmtDay(sortedShifts[sortedShifts.length - 1].shift_date).pretty;
    return first === last ? first : `${first} → ${last}`;
  }, [sortedShifts]);

  async function applyDecision(decision, reasonText = null) {
    if (!supabase || !sortedShifts.length) return;
    setStep('submitting');
    setError('');
    const ids = sortedShifts.map(s => s.id);
    const now = new Date().toISOString();
    const patch = decision === 'accept'
      ? { status: 'accepted', accepted_at: now, declined_at: null, decline_reason: null }
      : { status: 'declined', declined_at: now, accepted_at: null, decline_reason: reasonText || null };

    try {
      const idList = ids.map(i => `"${i}"`).join(',');
      await directPatchQuery(
        'employee_shifts',
        `id=in.(${idList})`,
        patch,
        { timeoutMs: 12000 }
      );

      try {
        logAction(me, 'shift_acknowledgment', {
          targetType: 'employee_shifts',
          targetId: ids.join(','),
          targetLabel: `${me?.name || me?.id} · ${decision} · ${ids.length} day(s)`,
          details: { decision, count: ids.length, reason: reasonText || undefined },
        });
      } catch { /* audit best-effort */ }

      setDoneDecision(decision);
      setStep('done');
      // Brief confirmation, then close so AppShell refreshes
      setTimeout(() => {
        if (onResolved) onResolved();
        onClose();
      }, 1100);
    } catch (e) {
      setError(e?.message || 'Could not save your decision. Please try again.');
      setStep(decision === 'decline' ? 'declining' : 'review');
    }
  }

  if (!sortedShifts.length) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(20, 30, 25, 0.55)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl max-w-xl w-full max-h-[92vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ border: '1px solid var(--border-soft)' }}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between px-6 pt-6 pb-4 sticky top-0 z-10 bg-white"
          style={{ borderBottom: '1px solid var(--border-soft)' }}
        >
          <div className="flex items-start gap-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
              style={{ background: 'var(--evergreen-50)', border: '1px solid var(--evergreen-200)' }}
            >
              <Calendar className="w-5 h-5" style={{ color: 'var(--evergreen-600)' }} />
            </div>
            <div>
              <h2
                className="text-lg"
                style={{ fontWeight: 600, letterSpacing: '-0.01em', color: '#1F1B16' }}
              >
                Shift schedule for your review
              </h2>
              <div className="text-xs mt-1" style={SMALL_TEXT}>
                Your manager has assigned the following shifts. Please confirm or decline each one.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={step === 'submitting'}
            aria-label="Close"
            className="p-1 rounded hover:bg-stone-100 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <X className="w-5 h-5" style={SMALL_TEXT} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {step === 'done' ? (
            <div className="flex flex-col items-center text-center py-6 gap-3 fade-in">
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center"
                style={{
                  background: doneDecision === 'decline'
                    ? 'rgba(184, 74, 62, 0.12)'
                    : 'var(--evergreen-100)',
                }}
              >
                <Check
                  className="w-6 h-6"
                  style={{
                    color: doneDecision === 'decline'
                      ? 'var(--clay)'
                      : 'var(--evergreen-600)',
                  }}
                />
              </div>
              <div className="text-lg" style={{ fontWeight: 600, color: '#1F1B16' }}>
                {doneDecision === 'decline' ? 'Decline recorded.' : 'Acceptance recorded.'}
              </div>
              <div className="text-sm max-w-sm" style={SMALL_TEXT}>
                {doneDecision === 'decline'
                  ? 'Your manager will be notified and will follow up with you to discuss the schedule.'
                  : 'Final approval is now pending with the SUP (Bashaier). You will see the status update on your dashboard once approved.'}
              </div>
            </div>
          ) : (
            <>
              {setBy?.name && (
                <p className="text-xs" style={SMALL_TEXT}>
                  Assigned by <strong>{setBy.name}</strong>
                  {dateRange ? <> · {dateRange}</> : null}.
                </p>
              )}

              {/* Shift rows */}
              <div className="space-y-1.5">
                {sortedShifts.map(s => {
                  const { dow, pretty } = fmtDay(s.shift_date);
                  return (
                    <div
                      key={s.id}
                      className="flex items-center gap-3 rounded border px-3 py-2.5"
                      style={{
                        borderColor: 'var(--evergreen-200)',
                        background: 'var(--evergreen-50)',
                      }}
                    >
                      <CalendarClock className="w-4 h-4 shrink-0" style={{ color: 'var(--evergreen-600)' }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium" style={{ color: '#1F1B16' }}>
                          {dow}, {pretty}
                        </div>
                      </div>
                      <div className="text-sm tabular-nums" style={{ color: '#1F1B16', fontWeight: 500 }}>
                        {trimTime(s.start_time)} – {trimTime(s.end_time)}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Decline reason field (when declining) — dropdown with two
                  curated reasons. Free text was removed to keep declines
                  comparable across staff and to spare the user from having
                  to compose anything in a stressful moment. The two options
                  cover the two legitimate HR reasons to decline a shift:
                  either the day clashes with already-approved leave, or
                  there's a personal commitment that can't be rescheduled.
                  A "" sentinel is the empty default so we can validate that
                  a reason was actually picked before allowing submit. */}
              {step === 'declining' && (
                <div className="space-y-2 pt-2">
                  <label className="text-[10px] tracking-[0.25em]" style={SMALL_TEXT}>
                    REASON FOR DECLINING
                  </label>
                  <select
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="w-full px-3 py-2 rounded border text-sm bg-white focus:outline-none"
                    style={{ borderColor: 'var(--border)', color: '#1F1B16' }}
                  >
                    <option value="">— Select a reason —</option>
                    <option value="Already on approved leave">
                      Already on approved leave
                    </option>
                    <option value="Personal commitment — unable to attend">
                      Personal commitment — unable to attend
                    </option>
                  </select>
                  <div className="text-xs" style={{ color: '#1F1B16', opacity: 0.7 }}>
                    Your manager will see your reason and reach out to discuss the schedule.
                  </div>
                </div>
              )}

              {/* Error */}
              {error && (
                <div
                  className="flex items-start gap-2 rounded p-3 text-sm"
                  style={{ background: '#FBE9E7', color: 'var(--clay)' }}
                >
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer / actions */}
        {step !== 'done' && (
          <div
            className="px-6 py-4 flex items-center justify-end gap-2 sticky bottom-0 bg-white"
            style={{ borderTop: '1px solid var(--border-soft)' }}
          >
            {step === 'declining' ? (
              <>
                <button
                  type="button"
                  onClick={() => { setStep('review'); setReason(''); setError(''); }}
                  className="px-4 py-2 rounded text-sm hover:bg-stone-50"
                  style={{ color: '#1F1B16', border: '1px solid var(--border)' }}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => applyDecision('decline', reason.trim())}
                  disabled={!reason}
                  className="px-4 py-2 rounded text-sm text-white flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: 'var(--clay)' }}
                >
                  Confirm decline
                </button>
              </>
            ) : step === 'submitting' ? (
              <div className="flex items-center gap-2 text-sm" style={SMALL_TEXT}>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving your decision…
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setStep('declining')}
                  className="px-4 py-2 rounded text-sm hover:bg-stone-50"
                  style={{ color: 'var(--clay)', border: '1px solid var(--border)' }}
                >
                  Decline
                </button>
                <button
                  type="button"
                  onClick={() => applyDecision('accept')}
                  className="px-4 py-2 rounded text-sm text-white flex items-center gap-2"
                  style={{ background: 'var(--evergreen-600)' }}
                >
                  <Check className="w-4 h-4" />
                  I understand and accept
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
