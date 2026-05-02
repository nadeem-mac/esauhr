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
//     • duration_hint = 'today_only' | 'few_days' | 'unsure' (free-text in note)
//
// Why no end_date estimate field:
//   At 7am with a fever, staff don't know how long. Asking for false
//   precision creates bad data. The "duration_hint" is purely informational
//   for HR. The actual end_date evolves through the extend-by-1-day flow
//   each morning the staff is still out.
//
// Manager and HR see the row immediately (realtime subscription) — no
// email chain needed.
// =============================================================================

const DURATION_OPTIONS = [
  { id: 'today_only', label: 'Today only',  hint: 'Back at work tomorrow' },
  { id: 'few_days',   label: 'A few days',  hint: 'Will extend each morning' },
  { id: 'unsure',     label: 'Not sure yet', hint: 'See how I feel tomorrow' },
];

export default function SickDeclarationModal({ employee, onClose, onCreated, declaredVia = 'staff', isOnBehalf = false }) {
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [duration,  setDuration]  = useState('today_only');
  const [note,      setNote]      = useState('');
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState('');

  if (!employee) return null;

  async function handleSubmit() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      // Compose the leave row. duration_hint is folded into the note so
      // we don't need a dedicated column; the tracker UI parses it back
      // out for display.
      const hintLabel = DURATION_OPTIONS.find(d => d.id === duration)?.label || '';
      const composedNote = [
        `Declared via portal · ${hintLabel}`,
        note.trim() ? `Staff note: ${note.trim()}` : null,
      ].filter(Boolean).join('\n');

      const row = {
        employee_id:        employee.id,
        leave_type_id:      'sick',
        start_date:         startDate,
        end_date:           startDate,   // extended via extend-by-1-day
        days:               1,
        is_half_day:        false,
        stage:              'pending_certificate',
        notes:              composedNote,
        sick_declared_at:   new Date().toISOString(),
        sick_declared_via:  declaredVia,
        // No Sehhaty code yet; that gets filled when the certificate
        // is uploaded later. The cross-check verification flow only
        // engages once a code exists.
      };

      // directPost is the project's mandatory data-write helper —
      // supabase-js's builder chain is broken on this project (see
      // claude memory: gotrue-js Web Lock + lazy builder issue).
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

          {/* Optional note */}
          <div>
            <label className="text-[11px] tracking-wider font-bold mb-1.5 block" style={{ color: '#0A0A0A' }}>
              NOTE FOR HR <span style={{ opacity: 0.5, fontWeight: 400 }}>(optional)</span>
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="e.g. fever, going to clinic this afternoon"
              className="w-full px-3 py-2 rounded-lg border text-sm resize-none"
              style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', color: '#0A0A0A' }}
            />
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
            disabled={busy || !startDate}
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
