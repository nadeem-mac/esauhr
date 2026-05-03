import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { HeartPulse, X, Loader2, AlertTriangle } from 'lucide-react';
import { directPost } from '../supabaseClient.js';

// =============================================================================
// SickDeclarationModal
//
// The staff member's "I'm sick today" front door. Replaces the historical
// pattern of emailing HR — every sick declaration now creates a tracked
// record on the portal from minute one.
//
// What gets created:
//   A leave_requests row in stage='pending_certificate' with:
//     • leave_type_id = 'sick'
//     • start_date = today (or chosen date)
//     • end_date = same as start (gets extended later via "Extend by 1 day")
//     • days = 1 initially
//     • sick_declared_at = now()
//     • sick_declared_via = 'staff' (or 'hr_on_behalf' when Bashaier creates)
//     • sehhaty_code = null (gets filled when certificate arrives)
//     • reason = '<REASON_LABEL> — Declared via portal · <duration_hint>'
//
// IMPORTANT: the leave_requests column is `reason` (singular, no 's').
// An earlier version of this modal wrote to 'notes' which doesn't exist
// — PostgREST returned PGRST204 and the insert failed silently for users
// without console access. Always use `reason`.
//
// Why a fixed dropdown instead of free text:
//   Staff at 7am with a fever produce inconsistent free-text reasons
//   ('flu', 'feeling unwell', 'sick'), which gives HR no useful pattern
//   for tracking common illnesses. A standardised list lets us run
//   reports, spot clusters (e.g. several people reporting GI illness in
//   the same week could indicate food contamination at the office
//   pantry), and auto-translate cleanly for the Arabic-speaking side
//   of the org. Reasons are in CAPS to read clearly in the leave row
//   and to match the ESAU HR convention seen on attendance reports.
// =============================================================================

const DURATION_OPTIONS = [
  { id: 'today_only', label: 'Today only',  hint: 'Back at work tomorrow' },
  { id: 'few_days',   label: 'A few days',  hint: 'Will extend each morning' },
  { id: 'unsure',     label: 'Not sure yet', hint: 'See how I feel tomorrow' },
];

// KSA-common sick reason categories. Drawn from public health data on
// outpatient consultations in the Eastern Province and from common
// occupational-medicine categories used in Saudi corporate HR. CAPS
// formatting matches the ESAU report convention.
//
// 'OTHER' is intentionally last and surfaces a free-text input so we
// don't lose the long tail. Anything that doesn't fit one of the
// pre-set categories — chronic conditions, post-procedure recovery,
// mental health (which staff may prefer to describe in their own
// words), etc. — goes into OTHER with a note.
const REASON_OPTIONS = [
  { id: 'FEVER_FLU',          label: 'FEVER / FLU' },
  { id: 'COLD_RESPIRATORY',   label: 'COLD / RESPIRATORY INFECTION' },
  { id: 'GI_ILLNESS',         label: 'STOMACH / FOOD POISONING' },
  { id: 'HEADACHE_MIGRAINE',  label: 'HEADACHE / MIGRAINE' },
  { id: 'BACK_MUSCLE_PAIN',   label: 'BACK / MUSCLE PAIN' },
  { id: 'DENTAL',             label: 'DENTAL ISSUE' },
  { id: 'EYE_INFECTION',      label: 'EYE INFECTION / EYE STRAIN' },
  { id: 'INJURY',             label: 'INJURY / ACCIDENT' },
  { id: 'POST_SURGERY',       label: 'POST-SURGERY RECOVERY' },
  { id: 'PREGNANCY_RELATED',  label: 'PREGNANCY-RELATED' },
  { id: 'CHRONIC_FLARE',      label: 'CHRONIC CONDITION FLARE-UP' },
  { id: 'MENTAL_HEALTH',      label: 'MENTAL HEALTH' },
  { id: 'OTHER',              label: 'OTHER (DESCRIBE BELOW)' },
];

export default function SickDeclarationModal({ employee, onClose, onCreated, declaredVia = 'staff', isOnBehalf = false }) {
  const [startDate,  setStartDate]  = useState(() => new Date().toISOString().slice(0, 10));
  const [duration,   setDuration]   = useState('today_only');
  const [reasonId,   setReasonId]   = useState('');
  const [otherNote,  setOtherNote]  = useState('');
  const [busy,       setBusy]       = useState(false);
  const [error,      setError]      = useState('');

  if (!employee) return null;

  const reasonObj = REASON_OPTIONS.find(r => r.id === reasonId);
  const isOther   = reasonId === 'OTHER';
  // Submit guard: a reason is required. If they pick OTHER, the free-
  // text field becomes required too — we don't want a mystery 'OTHER'
  // sitting in the database with no context.
  const canSubmit = !!reasonId && !!startDate && (!isOther || !!otherNote.trim());

  async function handleSubmit() {
    if (busy || !canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const hintLabel = DURATION_OPTIONS.find(d => d.id === duration)?.label || '';
      // Compose the reason text. Reason category goes first in CAPS so
      // it reads cleanly in any list view; duration hint is appended
      // as supplementary context. OTHER folds the user's free-text
      // note in alongside the OTHER category label.
      const reasonText = [
        isOther
          ? `OTHER: ${otherNote.trim()}`
          : reasonObj?.label || '',
        `Declared via portal · ${hintLabel}`,
      ].filter(Boolean).join(' · ');

      const row = {
        employee_id:        employee.id,
        leave_type_id:      'sick',
        start_date:         startDate,
        end_date:           startDate,   // extended via extend-by-1-day
        days:               1,
        is_half_day:        false,
        stage:              'pending_certificate',
        // Column is `reason` (singular) on leave_requests — `notes`
        // does not exist and writing to it returns PGRST204.
        reason:             reasonText,
        sick_declared_at:   new Date().toISOString(),
        sick_declared_via:  declaredVia,
      };

      const created = await directPost('leave_requests', row, { timeoutMs: 10000 });
      onCreated?.(created);
    } catch (e) {
      setError(e?.message || 'Could not save your sick declaration. Please try again.');
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
        padding: '40px 16px', overflowY: 'auto',
      }}
    >
      <div
        className="w-full max-w-lg rounded-2xl border"
        onClick={(e) => e.stopPropagation()}
        style={{
          borderColor: 'var(--border-soft)',
          background: '#FFFDF7',
          boxShadow: '0 12px 40px rgba(31,27,22,0.18)',
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-start gap-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ background: '#FEE2E2', border: '1px solid #FCA5A5' }}
            >
              <HeartPulse className="w-5 h-5" style={{ color: '#B91C1C' }} />
            </div>
            <div>
              <h2 className="serif text-lg" style={{ fontWeight: 500, color: '#1F1B16' }}>
                {isOnBehalf ? `Declare sick on behalf of ${employee.name?.split(' ')[0] || 'staff'}` : "I'm sick today"}
              </h2>
              <div className="text-xs mt-1" style={{ color: '#1F1B16', opacity: 0.75 }}>
                {isOnBehalf
                  ? "Logs the staff member's sick day. They still need to upload the Sehhaty certificate within 48h of return."
                  : "Your manager and HR will be notified. Please upload your Sehhaty certificate within 48 hours of returning to work."}
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
            <X className="w-4 h-4" style={{ color: '#1F1B16' }} />
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-5 space-y-4">
          {/* Start date */}
          <div>
            <label className="text-[11px] tracking-wider font-bold mb-1.5 block" style={{ color: '#0A0A0A' }}>
              SICK FROM
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
              className="w-full px-3 py-2 rounded-lg border text-sm"
              style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', color: '#0A0A0A' }}
            />
            <div className="text-[10px] mt-1" style={{ color: '#0A0A0A', opacity: 0.6 }}>
              Defaults to today. Backdating allowed if you forgot to declare in the morning.
            </div>
          </div>

          {/* Reason — required dropdown of KSA-common categories */}
          <div>
            <label className="text-[11px] tracking-wider font-bold mb-1.5 block" style={{ color: '#0A0A0A' }}>
              REASON <span style={{ color: '#B91C1C' }}>*</span>
            </label>
            <select
              value={reasonId}
              onChange={(e) => setReasonId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border text-sm"
              style={{
                borderColor: 'var(--border-soft)',
                background: '#FFFFFF',
                color: reasonId ? '#0A0A0A' : '#737373',
                fontWeight: reasonId ? 600 : 400,
                letterSpacing: reasonId ? '0.02em' : 'normal',
              }}
            >
              <option value="">— Select a reason —</option>
              {REASON_OPTIONS.map(opt => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
            {isOther && (
              <input
                type="text"
                value={otherNote}
                onChange={(e) => setOtherNote(e.target.value)}
                placeholder="Briefly describe the reason"
                className="w-full mt-2 px-3 py-2 rounded-lg border text-sm"
                style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', color: '#0A0A0A' }}
                maxLength={120}
              />
            )}
            <div className="text-[10px] mt-1" style={{ color: '#0A0A0A', opacity: 0.6 }}>
              Helps HR with reporting and identifying any office-wide health concerns.
            </div>
          </div>

          {/* Expected duration */}
          <div>
            <label className="text-[11px] tracking-wider font-bold mb-1.5 block" style={{ color: '#0A0A0A' }}>
              EXPECTED DURATION
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {DURATION_OPTIONS.map(opt => {
                const selected = duration === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setDuration(opt.id)}
                    className="text-left rounded-lg border px-3 py-2.5 transition-colors"
                    style={{
                      borderColor: selected ? '#B91C1C' : 'var(--border-soft)',
                      background:  selected ? '#FEF2F2' : '#FFFFFF',
                    }}
                  >
                    <div className="text-[12px]" style={{ fontWeight: 600, color: '#0A0A0A' }}>{opt.label}</div>
                    <div className="text-[10px]" style={{ color: '#0A0A0A', opacity: 0.6 }}>{opt.hint}</div>
                  </button>
                );
              })}
            </div>
            <div className="text-[10px] mt-1.5" style={{ color: '#0A0A0A', opacity: 0.6 }}>
              No firm commitment — you can extend each morning you're still out.
            </div>
          </div>

          {/* Reminder about the certificate obligation */}
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-[11px]"
               style={{ background: '#FEF3C7', color: '#92400E' }}>
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <div>
              <strong>Sehhaty certificate required.</strong> You'll need to upload your Sehhaty leave ID within 48 hours of returning to work. After that, new leave or permission requests will be blocked until the certificate is provided.
            </div>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg text-[11px]" style={{ background: '#FEE2E2', color: '#991B1B' }}>
              {error}
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
            style={{ borderColor: 'var(--border-soft)', color: '#1F1B16', background: '#FFFFFF', fontWeight: 500 }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy || !canSubmit}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm transition-colors disabled:opacity-50"
            style={{ background: '#B91C1C', color: '#FFFFFF', fontWeight: 600 }}
          >
            {busy
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</>
              : <><HeartPulse className="w-4 h-4" /> {isOnBehalf ? 'Log declaration' : 'Submit sick declaration'}</>}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
