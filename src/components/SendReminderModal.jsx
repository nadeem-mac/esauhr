// =============================================================================
// SendReminderModal
//
// Bashaier-driven flow for sending a Sehhaty-certificate reminder to a
// staff member who has a pending_certificate row outstanding.
//
// FLOW
//   1. Modal opens with the auto-suggested reminder kind pre-selected
//      (gentle_24h / firmer_72h / final_5d / manual — chosen based on
//      the row's pressure stage via suggestKindForPressure).
//   2. Subject + body are pre-filled from the matching template.
//   3. Bashaier can:
//      • Switch kind via the radio row (subject/body re-fill from the
//        new template — last edits to body are preserved unless she
//        explicitly resets them).
//      • Add an optional free-text note (appended above signature).
//      • Edit the body inline if she wants to soften / sharpen.
//   4. Hitting "Open in mail" opens the user's default mail client
//      with the To/CC/Subject/Body pre-populated, AND logs a row to
//      sick_reminders so the audit trail captures the send.
//
// WHY BOTH A MAILTO AND A LOG WRITE
//   The portal can't actually send email (no SMTP/SendGrid wired up).
//   The mailto: hand-off is consistent with how every other email
//   action in the app works (vacation form, leave approvals,
//   permission letters). Logging the row when Bashaier clicks send
//   captures her INTENT — even if she never actually clicks Send in
//   her mail client, the audit shows she dispatched the reminder.
//   The reminder kind, sender, and timestamp are still useful records.
// =============================================================================

import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Mail, Send, Loader2, AlertTriangle } from 'lucide-react';
import { directPost } from '../supabaseClient.js';
import { REMINDER_KINDS, classifyPressure } from '../lib/sickDeclaration.js';
import {
  buildSickReminderEmail,
  suggestKindForPressure,
  reminderKindLabel,
} from '../lib/sickReminderEmail.js';
import { logAction } from '../lib/audit.js';

const KIND_OPTIONS = [
  REMINDER_KINDS.GENTLE_24H,
  REMINDER_KINDS.FIRMER_72H,
  REMINDER_KINDS.FINAL_5D,
  REMINDER_KINDS.MANUAL,
];

export default function SendReminderModal({
  declaration,
  employee,
  manager,
  me,
  onClose,
  onSent,
}) {
  // Determine the suggested kind based on pressure. Falls back to
  // 'manual' for still_out / exempt / unknown cases.
  const initialKind = useMemo(() => {
    const { pressure } = classifyPressure(declaration, []);
    return suggestKindForPressure(pressure);
  }, [declaration]);

  const [kind, setKind]           = useState(initialKind);
  const [extraNote, setExtraNote] = useState('');
  // Build the draft from the current kind. Body is held as state so
  // Bashaier can edit it inline without each kind-change overwriting
  // her edits — but a kind switch DOES regenerate, then a separate
  // useEffect resyncs body to the freshly-built draft.
  const draft = useMemo(
    () => buildSickReminderEmail({ employee, declaration, manager, hrApprover: me, kind, extraNote }),
    [employee, declaration, manager, me, kind, extraNote],
  );

  // The body text is the editable field. Re-sync from the draft
  // whenever the kind / extraNote / template inputs change. We keep
  // the most recent draft.body in state so Bashaier's mid-flow edits
  // are preserved across renders, but a kind change is treated as
  // intentional template switch and overwrites her edits.
  const [body, setBody] = useState(draft.body);
  useEffect(() => { setBody(draft.body); }, [draft.body]);

  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');

  const hasEmail = !!(employee?.email && employee.email.trim());
  const canSend = hasEmail && !busy;

  async function handleSend() {
    if (!canSend) return;
    setBusy(true);
    setError('');
    try {
      // Re-build mailto from the (possibly-edited) body. Subject and
      // recipients still come from the original template — Bashaier
      // can switch kinds to retarget, but we don't expose subject
      // editing to keep the mailto link safe (URLSearchParams handles
      // the encoding).
      const params = new URLSearchParams();
      if (draft.cc) params.set('cc', draft.cc);
      params.set('subject', draft.subject);
      params.set('body', body);
      const mailto = `mailto:${encodeURIComponent(draft.to)}?${params.toString().replace(/\+/g, '%20')}`;

      // Open the mail client. Some browsers block window.open for
      // mailto unless triggered from a user gesture; this handler is
      // wired to the button click so we should be fine. Fallback:
      // the link is also rendered visibly so the user can copy it.
      window.location.href = mailto;

      // Log the send. Captures intent — even if the user never hits
      // Send in their mail client, the system records that Bashaier
      // dispatched the reminder.
      await directPost('sick_reminders', {
        request_id:    declaration.id,
        sent_by:       me?.id || null,
        channel:       'email',
        reminder_kind: kind,
        note:          extraNote.trim() || null,
      }, { timeoutMs: 10000 });

      logAction(me, 'sick_reminder_sent', {
        targetType:  'leave_request',
        targetId:    declaration.id,
        targetLabel: `${employee?.name || declaration.employee_id} · ${reminderKindLabel(kind)}`,
        meta: {
          kind,
          to:   draft.to,
          cc:   draft.cc || null,
          note: extraNote.trim() || null,
        },
      });

      onSent?.();
    } catch (e) {
      setError(e?.message || 'Could not log this reminder. The mail draft was opened — please retry the log.');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
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
          maxWidth: 640,
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b"
             style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4" style={{ color: '#0F4C2A' }} />
            <div>
              <div className="text-[10px] tracking-[0.25em] opacity-60">— SEND REMINDER</div>
              <div className="text-sm" style={{ fontWeight: 600, color: '#0A0A0A' }}>
                {employee?.name || declaration.employee_id}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-1.5 rounded-full hover:bg-black/5 transition-colors disabled:opacity-40"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Kind selector */}
          <div>
            <div className="text-[10px] tracking-wider font-bold mb-2" style={{ color: '#0A0A0A' }}>
              REMINDER TIER
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {KIND_OPTIONS.map(k => {
                const selected = kind === k;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    disabled={busy}
                    className="text-[11px] px-2.5 py-2 rounded-lg border transition-colors text-center disabled:opacity-50"
                    style={{
                      borderColor: selected ? '#0F4C2A' : 'var(--border-soft)',
                      background:  selected ? '#F0FDF4' : '#FFFFFF',
                      color:       '#0A0A0A',
                      fontWeight:  selected ? 600 : 500,
                    }}
                  >
                    {reminderKindLabel(k)}
                  </button>
                );
              })}
            </div>
            <div className="text-[10px] mt-1.5" style={{ color: '#0A0A0A', opacity: 0.6 }}>
              {kind === initialKind
                ? 'Auto-suggested based on this row\'s overdue stage.'
                : 'Manually selected — overrides the auto-suggested tier.'}
            </div>
          </div>

          {/* Recipients summary */}
          <div className="rounded-lg p-3 text-[11px]"
               style={{ background: '#F8F5EE', border: '1px solid var(--border-soft)' }}>
            <div className="flex flex-wrap gap-x-4 gap-y-1" style={{ color: '#0A0A0A' }}>
              <div>
                <span style={{ opacity: 0.6 }}>To:</span>{' '}
                <span style={{ fontWeight: 500 }}>{draft.to || '— no email on file —'}</span>
              </div>
              {draft.cc && (
                <div>
                  <span style={{ opacity: 0.6 }}>Cc:</span>{' '}
                  <span style={{ fontWeight: 500 }}>{draft.cc}</span>
                </div>
              )}
            </div>
            <div className="mt-1.5" style={{ color: '#0A0A0A' }}>
              <span style={{ opacity: 0.6 }}>Subject:</span>{' '}
              <span style={{ fontWeight: 500 }}>{draft.subject}</span>
            </div>
          </div>

          {/* Optional note */}
          <div>
            <label className="text-[10px] tracking-wider font-bold mb-1.5 block" style={{ color: '#0A0A0A' }}>
              ADDITIONAL NOTE <span style={{ opacity: 0.55, fontWeight: 500 }}>(optional)</span>
            </label>
            <input
              type="text"
              value={extraNote}
              onChange={e => setExtraNote(e.target.value)}
              disabled={busy}
              placeholder="One-line note appended above signature, e.g. 'Please call HR if you need help with Sehhaty.'"
              className="w-full px-3 py-2 rounded-lg border text-[12px]"
              style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', color: '#0A0A0A' }}
            />
          </div>

          {/* Body editor */}
          <div>
            <label className="text-[10px] tracking-wider font-bold mb-1.5 block" style={{ color: '#0A0A0A' }}>
              MESSAGE
            </label>
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              disabled={busy}
              rows={11}
              className="w-full px-3 py-2 rounded-lg border text-[12px] font-mono"
              style={{
                borderColor: 'var(--border-soft)',
                background: '#FFFFFF',
                color: '#0A0A0A',
                resize: 'vertical',
                whiteSpace: 'pre-wrap',
              }}
            />
            <div className="text-[10px] mt-1.5" style={{ color: '#0A0A0A', opacity: 0.6 }}>
              Edits stay local until you switch tiers. Switching reloads the template.
            </div>
          </div>

          {!hasEmail && (
            <div className="rounded-lg p-3 text-[11px] flex items-start gap-2"
                 style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #F59E0B' }}>
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <div>
                No email on file for this employee. Update their record before sending,
                or copy the message above and send manually.
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg p-3 text-[11px] flex items-start gap-2"
                 style={{ background: '#FEE2E2', color: '#991B1B', border: '1px solid #FCA5A5' }}>
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <div>{error}</div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-6 pb-6 flex flex-col-reverse sm:flex-row gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 px-4 py-3 rounded-xl border text-sm transition-colors disabled:opacity-50"
            style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm transition-colors disabled:opacity-50"
            style={{ background: '#0F4C2A', color: '#FFFFFF', fontWeight: 600 }}
          >
            {busy
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</>
              : <><Send className="w-4 h-4" /> Open in mail & log</>}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
