// =============================================================================
// UnauthorizedDigestModal
//
// Bashaier-facing digest sender. Lists every staff member with at least
// one unauthorized_absence violation that hasn't been notified yet
// (email_sent_at IS NULL), and walks her through dispatching each one's
// personalized notification email.
//
// FLOW
//   1. Modal opens with N tiles, one per affected staff. Each tile
//      shows: name, declaration date range, count of unauthorized
//      days, and a status pill (PENDING / SENT).
//   2. Bashaier clicks a tile → preview pane on the right shows the
//      pre-built email (To/Cc/Subject/Body).
//   3. Clicking "Open in mail & log" opens the user's mail client AND
//      stamps email_sent_at on the relevant attendance_violations rows
//      so the staff is removed from the digest queue.
//   4. After the last staff is sent, the modal can be closed and the
//      parent (PendingSickCertsCard) re-fetches via onChanged.
//
// WHY ONE-AT-A-TIME (vs. bcc batch)
//   Each staff gets a personalized email — different declaration dates,
//   different day counts. A single bcc'd email would lose that
//   personalisation and look impersonal for what is a serious notice.
//   The walk-through pattern keeps the per-staff context intact while
//   minimising clicks (one button per send + auto-advance).
//
// MAILTO HAND-OFF
//   Same pattern as SendReminderModal and the rest of the app's email
//   surfaces — we generate a mailto: URL and `window.location.href = ...`.
//   The portal cannot actually send email; the audit trail records
//   Bashaier's INTENT to send (email_sent_at gets stamped) which is
//   accurate — even if she never clicks Send in her mail client, she
//   has dispatched the notification.
// =============================================================================

import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, Send, AlertTriangle, Loader2, CheckCircle2 } from 'lucide-react';
import { directPatch } from '../supabaseClient.js';
import { buildUnauthorizedAbsenceDigestEmail } from '../lib/sickReminderEmail.js';
import { logAction } from '../lib/audit.js';

export default function UnauthorizedDigestModal({
  targets,        // [{ employeeId, count, declarationIds, violations, sampleDay }, ...]
  empMap,
  violations,     // all unauthorized_absence rows (including ones already sent)
  rows,           // pending_certificate leave_request rows currently visible
  me,             // HR sender
  onClose,
  onSent,         // () => void — fired after the last successful send so parent re-fetches
}) {
  // Index of the currently-selected target. Auto-advances after each
  // send so Bashaier can quickly walk the queue.
  const [selectedIdx, setSelectedIdx] = useState(0);
  // Per-target sent state — keyed by employeeId, true once email
  // dispatched + email_sent_at stamped. Local so the UI updates
  // without waiting for a parent re-fetch; parent will re-fetch on
  // modal close.
  const [sent, setSent] = useState({});
  // Local busy + error per send action.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Build a per-target email draft. Each target may span MULTIPLE
  // declarations (rare but possible — staff who declared two separate
  // illnesses, both went unauthorized). The email body lists every
  // affected day across all declarations.
  const draftFor = useMemo(() => {
    const map = {};
    for (const t of targets) {
      const employee = empMap?.[t.employeeId];
      // Map declaration ids to source rows. We pull from the visible
      // `rows` list first (currently-pending) and fall back to a
      // synthesized stub for declarations no longer in pending_cert
      // (cert was submitted, but unauthorized rows from the marking
      // window haven't been auto-undone yet because the sweep already
      // ran in this session).
      const declsForTarget = t.declarationIds.map(id => {
        const found = rows?.find(r => r.id === id);
        if (found) return found;
        // Synthesize from a violation row — we know the dates from
        // the source declaration via the violations list.
        const sample = t.violations.find(v => v.source_request_id === id);
        return {
          id,
          start_date: sample?.violation_date || null,
          end_date:   null,
        };
      });
      map[t.employeeId] = buildUnauthorizedAbsenceDigestEmail({
        employee,
        violations:   t.violations,
        declarations: declsForTarget,
        hrApprover:   me,
      });
    }
    return map;
  }, [targets, empMap, rows, me]);

  if (!targets || targets.length === 0) return null;

  const target = targets[selectedIdx] || targets[0];
  const employee = empMap?.[target.employeeId];
  const draft = draftFor[target.employeeId];
  const hasEmail = !!(employee?.email && employee.email.trim());
  const targetSent = !!sent[target.employeeId];

  async function handleSend() {
    if (!draft || busy || targetSent) return;
    setBusy(true);
    setError('');
    try {
      // Open the mail client. Same pattern as SendReminderModal —
      // single user gesture so popup blockers don't interfere.
      window.location.href = draft.mailto;

      // Stamp email_sent_at on every violation in this target's set.
      // The unique constraint on (employee_id, violation_date,
      // violation_type) means we don't expect duplicates here — each
      // row is a single physical violation.
      const nowIso = new Date().toISOString();
      const violationIds = target.violations.map(v => v.id);
      // Issue patches in parallel; failures are warned but don't
      // block the rest. Email_sent_at is the gate that removes a
      // staff from the digest queue, so partial failure means
      // Bashaier sees the same target again on her next dashboard
      // load — which is the right behaviour (errs on the side of
      // notifying again rather than silently failing).
      const results = await Promise.allSettled(
        violationIds.map(vid => directPatch(
          'attendance_violations', 'id', vid,
          { email_sent_at: nowIso },
          { timeoutMs: 8000 },
        ))
      );
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length) {
        console.warn('[unauthorized digest] some patches failed:', failures);
        // We still mark the target as sent locally — the user opened
        // the mail draft. The next dashboard load will re-fetch and
        // any unstamped violations will reappear in the digest queue.
      }

      try {
        await logAction(me, 'unauthorized_digest_sent', {
          targetType:  'employee',
          targetId:    target.employeeId,
          targetLabel: `${employee?.name || target.employeeId} · ${target.count} day${target.count === 1 ? '' : 's'}`,
          meta: {
            employee_id:     target.employeeId,
            day_count:       target.count,
            declaration_ids: target.declarationIds,
            violation_ids:   violationIds,
          },
        });
      } catch { /* audit failure is non-fatal */ }

      setSent(prev => ({ ...prev, [target.employeeId]: true }));

      // Auto-advance to the next unsent target so Bashaier can keep
      // moving without finding the next one manually.
      const nextIdx = targets.findIndex((t, i) => i > selectedIdx && !sent[t.employeeId]);
      if (nextIdx >= 0) setSelectedIdx(nextIdx);
    } catch (e) {
      setError(e?.message || 'Could not stamp the violations as notified. The mail draft was opened — please retry the log.');
    } finally {
      setBusy(false);
    }
  }

  function handleCloseModal() {
    if (busy) return;
    onSent?.();
    onClose();
  }

  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !busy) handleCloseModal(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '5vh 16px',
        overflowY: 'auto',
      }}
    >
      <div
        className="w-full rounded-2xl border"
        style={{
          background: 'var(--paper)',
          borderColor: 'var(--border-soft)',
          maxWidth: 880,
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b"
             style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" style={{ color: '#991B1B' }} />
            <div>
              <div className="text-[10px] tracking-[0.25em] opacity-60">— UNAUTHORIZED ABSENCE DIGEST</div>
              <div className="text-sm" style={{ fontWeight: 600, color: '#0A0A0A' }}>
                {targets.length} staff to notify
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCloseModal}
            disabled={busy}
            className="p-1.5 rounded-full hover:bg-black/5 transition-colors disabled:opacity-40"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body — two-column layout: queue on the left, preview on the right */}
        <div className="grid grid-cols-1 md:grid-cols-[260px_1fr]">
          {/* Queue */}
          <div className="border-r overflow-y-auto" style={{
            borderColor: 'var(--border-soft)',
            maxHeight: '60vh',
          }}>
            {targets.map((t, idx) => {
              const emp = empMap?.[t.employeeId];
              const isSelected = idx === selectedIdx;
              const isSent = !!sent[t.employeeId];
              return (
                <button
                  key={t.employeeId}
                  type="button"
                  onClick={() => setSelectedIdx(idx)}
                  className="w-full text-left px-4 py-3 border-b flex items-start gap-2 hover:bg-black/5 transition-colors"
                  style={{
                    borderColor: 'var(--border-soft)',
                    background: isSelected ? '#F8F5EE' : '#FFFFFF',
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-semibold truncate" style={{ color: '#0A0A0A' }}>
                      {emp?.name || t.employeeId}
                    </div>
                    <div className="text-[10px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.65 }}>
                      {t.count} day{t.count === 1 ? '' : 's'} · from {t.sampleDay}
                    </div>
                  </div>
                  {isSent ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold tracking-wider"
                          style={{ background: '#DCFCE7', color: '#0F4C2A' }}>
                      <CheckCircle2 className="w-2.5 h-2.5" />
                      SENT
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold tracking-wider"
                          style={{ background: '#FEF3C7', color: '#92400E' }}>
                      PENDING
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Preview */}
          <div className="px-6 py-5 space-y-4 overflow-y-auto" style={{ maxHeight: '60vh' }}>
            {!draft ? (
              <div className="text-[11px] opacity-60" style={{ color: '#0A0A0A' }}>
                Select a staff member from the queue to preview their notification.
              </div>
            ) : (
              <>
                <div className="rounded-lg p-3 text-[11px]"
                     style={{ background: '#F8F5EE', border: '1px solid var(--border-soft)' }}>
                  <div className="flex flex-wrap gap-x-4 gap-y-1" style={{ color: '#0A0A0A' }}>
                    <div>
                      <span style={{ opacity: 0.6 }}>To:</span>{' '}
                      <span style={{ fontWeight: 500 }}>{draft.to || '— no email on file —'}</span>
                    </div>
                  </div>
                  <div className="mt-1.5" style={{ color: '#0A0A0A' }}>
                    <span style={{ opacity: 0.6 }}>Subject:</span>{' '}
                    <span style={{ fontWeight: 500 }}>{draft.subject}</span>
                  </div>
                </div>

                <pre
                  className="text-[11px] p-3 rounded-lg border whitespace-pre-wrap font-mono"
                  style={{ background: '#FFFFFF', borderColor: 'var(--border-soft)', color: '#0A0A0A' }}
                >
                  {draft.body}
                </pre>

                {!hasEmail && (
                  <div className="rounded-lg p-3 text-[11px] flex items-start gap-2"
                       style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #F59E0B' }}>
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <div>
                      No email on file for this staff. Update the directory record before sending,
                      or copy the message above and send manually.
                    </div>
                  </div>
                )}

                {error && (
                  <div className="rounded-lg p-3 text-[11px]"
                       style={{ background: '#FEE2E2', color: '#991B1B', border: '1px solid #FCA5A5' }}>
                    {error}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="px-6 py-4 border-t flex flex-col-reverse sm:flex-row gap-2.5"
             style={{ borderColor: 'var(--border-soft)' }}>
          <button
            type="button"
            onClick={handleCloseModal}
            disabled={busy}
            className="flex-1 px-4 py-3 rounded-xl border text-sm transition-colors disabled:opacity-50"
            style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}
          >
            Done
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={!draft || !hasEmail || busy || targetSent}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm transition-colors disabled:opacity-50"
            style={{ background: '#991B1B', color: '#FFFFFF', fontWeight: 600 }}
          >
            {busy
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</>
              : targetSent
                ? <><CheckCircle2 className="w-4 h-4" /> Sent</>
                : <><Send className="w-4 h-4" /> Open in mail & log</>}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
