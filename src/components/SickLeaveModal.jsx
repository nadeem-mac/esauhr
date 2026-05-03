import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { HeartPulse, X, Loader2, AlertTriangle, FileText, Check } from 'lucide-react';
import { directPost, directGet } from '../supabaseClient.js';

// =============================================================================
// SickLeaveModal
//
// Unified entry point for ALL sick-leave scenarios. Replaces the previous
// split between "I'm sick today" and "Submit sick leave" tiles.
//
// Two paths, one modal. The first thing the staff sees is the question
// that determines the rest of the flow:
//
//   "Do you have your Sehhaty certificate ready?"
//        ┌─────────────┐    ┌─────────────────┐
//        │  Not yet    │    │ Yes, I have it  │
//        └─────────────┘    └─────────────────┘
//             │                       │
//             ▼                       ▼
//      Path A: declare        Path B: submit
//      pending_certificate    with PDF (sub-commit B)
//      flow                   adds the upload zone
//
//
// Path A — "Not yet" (front-door declaration):
//   • Sick-from date (default today)
//   • Reason dropdown (13 KSA categories, required)
//   • Expected duration (today only / a few days / not sure)
//   • 48h banner reminder
//   • Submit creates leave_requests row in stage='pending_certificate',
//     sick_declared_at=now, sick_declared_via='staff'
//
// Path B — "Yes, I have it" (cert in hand):
//   • SUB-COMMIT B will add: PDF upload zone, OCR/text extraction,
//     locked auto-filled fields, prior-declaration banner ("attach
//     to existing pending_certificate row?")
//   • In sub-commit A, this path shows a placeholder ("PDF upload
//     coming") so the toggle works end-to-end while we ship Path A.
//
//
// IMPORTANT NOTES:
//   • The leave_requests column is `reason` (singular). Earlier code
//     mistakenly used `notes` and got PGRST204. Always `reason`.
//   • Sub-commit B will detect any open pending_certificate row for
//     this employee when they pick "Yes, I have it" and offer to
//     attach the cert to that row instead of creating a fresh sick
//     leave. This preserves single-illness-single-record integrity.
// =============================================================================

const DURATION_OPTIONS = [
  { id: 'today_only', label: 'Today only',  hint: 'Back at work tomorrow' },
  { id: 'few_days',   label: 'A few days',  hint: 'Will extend each morning' },
  { id: 'unsure',     label: 'Not sure yet', hint: 'See how I feel tomorrow' },
];

// KSA-common sick reason categories. CAPS formatting matches ESAU HR
// reporting convention. Used in Path A only — Path B doesn't ask
// reason because the certificate is the source of truth for the
// medical context.
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

export default function SickLeaveModal({ employee, onClose, onCreated, declaredVia = 'staff', isOnBehalf = false }) {
  // path: null until the staff picks. 'declare' = Path A, 'submit' = Path B.
  // Forcing the user to make this choice first makes the consequence
  // of each path impossible to miss.
  const [path, setPath] = useState(null);

  // Path A state — declare-now flow
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [duration,  setDuration]  = useState('today_only');
  const [reasonId,  setReasonId]  = useState('');
  const [otherNote, setOtherNote] = useState('');

  // Shared state
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState('');

  // Sub-commit B will populate this. Currently null in sub-commit A.
  // When set in B, indicates the staff has an open pending_certificate
  // row that the new submission could attach to.
  const [priorPending, setPriorPending] = useState(null);

  // When the staff picks Path B, look up any open pending_certificate
  // row for them. Sub-commit B uses this to drive the "attach to
  // existing declaration" banner. We do this here in sub-commit A so
  // the look-up behaviour is observable end-to-end and we can verify
  // the query is correct before B builds on it.
  useEffect(() => {
    if (path !== 'submit' || !employee?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await directGet(
          'leave_requests',
          `select=id,start_date,end_date,reason,sick_declared_at&employee_id=eq.${employee.id}&stage=eq.pending_certificate&sick_cert_exempt=eq.false&order=sick_declared_at.desc&limit=1`,
          { timeoutMs: 8000 }
        );
        if (!cancelled && Array.isArray(rows) && rows.length) {
          setPriorPending(rows[0]);
        }
      } catch (e) {
        // Lookup failure is non-fatal — Path B can still run as a
        // fresh submission. Sub-commit B will surface this.
        console.warn('priorPending lookup failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [path, employee?.id]);

  if (!employee) return null;

  // Path A submit guard
  const reasonObj = REASON_OPTIONS.find(r => r.id === reasonId);
  const isOther   = reasonId === 'OTHER';
  const canSubmitA = !!reasonId && !!startDate && (!isOther || !!otherNote.trim());

  async function handleSubmitDeclaration() {
    if (busy || !canSubmitA) return;
    setBusy(true);
    setError('');
    try {
      const hintLabel = DURATION_OPTIONS.find(d => d.id === duration)?.label || '';
      const reasonText = [
        isOther ? `OTHER: ${otherNote.trim()}` : reasonObj?.label || '',
        `Declared via portal · ${hintLabel}`,
      ].filter(Boolean).join(' · ');

      const row = {
        employee_id:        employee.id,
        leave_type_id:      'sick',
        start_date:         startDate,
        end_date:           startDate,
        days:               1,
        is_half_day:        false,
        stage:              'pending_certificate',
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
        {/* Header — same regardless of path */}
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
                {isOnBehalf ? `Sick leave for ${employee.name?.split(' ')[0] || 'staff'}` : 'Sick leave'}
              </h2>
              <div className="text-xs mt-1" dir="rtl" style={{ color: '#1F1B16', opacity: 0.7 }}>
                إجازة مرضية
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

        {/* Path selector — first thing the staff sees. Big visual
            choice that drives the rest of the form. The previously-
            chosen path stays highlighted at the top so the staff can
            switch back if they realised they picked wrong. */}
        <div className="px-6 py-5 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="text-[11px] tracking-wider font-bold mb-2" style={{ color: '#0A0A0A' }}>
            DO YOU HAVE YOUR SEHHATY CERTIFICATE READY?
          </div>
          <div className="text-[10px] mb-3" dir="rtl" style={{ color: '#0A0A0A', opacity: 0.7 }}>
            هل لديك شهادة صحتي جاهزة؟
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <PathButton
              selected={path === 'declare'}
              accent="#B91C1C"
              onClick={() => { setPath('declare'); setError(''); }}
              title="Not yet"
              titleArabic="ليس بعد"
              hint="I'm declaring sick today — I'll upload the certificate later"
              icon={<HeartPulse className="w-4 h-4" />}
            />
            <PathButton
              selected={path === 'submit'}
              accent="#0F4C2A"
              onClick={() => { setPath('submit'); setError(''); }}
              title="Yes, I have it"
              titleArabic="نعم، لدي الشهادة"
              hint="I have my Sehhaty certificate PDF and I'm submitting it now"
              icon={<Check className="w-4 h-4" />}
            />
          </div>
        </div>

        {/* PATH A — declare-now flow */}
        {path === 'declare' && (
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

            {/* Reason — required dropdown */}
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

            {/* 48h cert obligation */}
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
        )}

        {/* PATH B — submit-with-cert (placeholder in sub-commit A;
            sub-commit B replaces this block with the PDF upload zone,
            extracted-fields preview, and prior-declaration banner). */}
        {path === 'submit' && (
          <div className="px-6 py-5 space-y-4">
            {priorPending && (
              <div className="rounded-lg p-3 text-[11px]"
                   style={{ background: '#DBEAFE', color: '#1E3A8A', border: '1px solid #BFDBFE' }}>
                <strong>You declared sick on {priorPending.start_date}.</strong>{' '}
                When you submit your certificate, it will be attached to that
                declaration so the system keeps a single record per illness.
              </div>
            )}
            <div className="rounded-lg p-6 text-center"
                 style={{ background: '#FFFFFF', border: '2px dashed #E5E5E0' }}>
              <FileText className="w-10 h-10 mx-auto mb-2" style={{ color: '#9CA3AF' }} />
              <div className="text-sm" style={{ fontWeight: 600, color: '#0A0A0A' }}>
                Sehhaty PDF upload — coming next
              </div>
              <div className="text-[11px] mt-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                The next portal update will let you drop your Sehhaty PDF here. The system reads the leave ID, dates, and doctor automatically — no typing.
              </div>
              <div className="text-[10px] mt-3" style={{ color: '#0A0A0A', opacity: 0.5 }}>
                For now, please use "Not yet" above and HR will reconcile the certificate when you provide it.
              </div>
            </div>
          </div>
        )}

        {/* Actions — vary by path */}
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
          {path === 'declare' && (
            <button
              type="button"
              onClick={handleSubmitDeclaration}
              disabled={busy || !canSubmitA}
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm transition-colors disabled:opacity-50"
              style={{ background: '#B91C1C', color: '#FFFFFF', fontWeight: 600 }}
            >
              {busy
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</>
                : <><HeartPulse className="w-4 h-4" /> Submit sick declaration</>}
            </button>
          )}
          {path === 'submit' && (
            <button
              type="button"
              disabled
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm opacity-50 cursor-not-allowed"
              style={{ background: '#0F4C2A', color: '#FFFFFF', fontWeight: 600 }}
              title="PDF upload available in the next portal update"
            >
              <Check className="w-4 h-4" /> Submit sick leave for HR review
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// Path selector button — the visual choice that drives the rest of
// the form. Selected state uses a coloured top border + tinted
// background so it reads clearly against the cream paper.
function PathButton({ selected, accent, onClick, title, titleArabic, hint, icon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-lg border-2 px-3.5 py-3 transition-all"
      style={{
        borderColor: selected ? accent : 'var(--border-soft)',
        background:  selected ? '#FEFAF3' : '#FFFFFF',
        boxShadow:   selected ? `0 0 0 4px ${accent}20` : 'none',
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: accent }}>{icon}</span>
        <span className="text-[13px]" style={{ fontWeight: 600, color: '#0A0A0A' }}>
          {title}
        </span>
      </div>
      <div className="text-[11px] mb-1" dir="rtl"
           style={{ color: '#0A0A0A', fontWeight: 500 }}>
        {titleArabic}
      </div>
      <div className="text-[10px]" style={{ color: '#0A0A0A', opacity: 0.65 }}>
        {hint}
      </div>
    </button>
  );
}
