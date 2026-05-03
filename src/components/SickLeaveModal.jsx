import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { HeartPulse, X, Loader2, AlertTriangle, FileText, Check, Upload, RefreshCw } from 'lucide-react';
import { directPost, directGet, directPatch } from '../supabaseClient.js';
import { extractFromPdf } from '../lib/sehhatyPdfExtract.js';

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

  // Path B state — submit-with-cert flow.
  //   pdfFile        — the File the staff dropped/picked (kept in memory only,
  //                    never uploaded; we extract fields and discard per the
  //                    privacy decision).
  //   extracted      — the structured fields the extractor returned, or null.
  //                    Locked once set: the staff cannot edit individual
  //                    fields — if extraction is wrong, they re-upload.
  //   extractError   — error from a failed extraction, surfaced inline.
  //   extracting     — true while the PDF is being read. Disables UI.
  //   attachToPrior  — staff's choice when a priorPending exists: true
  //                    means PATCH that row, false means create a fresh
  //                    sick leave anyway. Defaults true (single-illness-
  //                    single-record is the integrity-preserving default).
  const [pdfFile,       setPdfFile]       = useState(null);
  const [extracted,     setExtracted]     = useState(null);
  const [extractError,  setExtractError]  = useState('');
  const [extracting,    setExtracting]    = useState(false);
  const [attachToPrior, setAttachToPrior] = useState(true);
  const fileInputRef = useRef(null);

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

  // ─── Path B handlers ────────────────────────────────────────────────────

  /** Read the picked/dropped File, run the extractor, surface result or error. */
  async function handlePdfFile(file) {
    if (!file) return;
    setPdfFile(file);
    setExtracted(null);
    setExtractError('');
    setExtracting(true);
    try {
      const result = await extractFromPdf(file);
      // Log extraction details to the browser console so we have
      // visibility into what the matchers saw vs. what the PDF
      // actually contained. When a field comes up empty in the
      // preview, the user can open DevTools console, copy the
      // [sehhaty] entry, and send it back so we can fix the
      // matcher with concrete data instead of guessing.
      // eslint-disable-next-line no-console
      console.log('[sehhaty] PDF extraction complete:', {
        source:    result.source,
        fields:    {
          leaveId:   result.leaveId,
          idNumber:  result.idNumber,
          startDate: result.startDate,
          endDate:   result.endDate,
          days:      result.days,
          issueDate: result.issueDate,
          name:      result.name,
          doctor:    result.doctor,
          specialty: result.specialty,
        },
        rawText:   result.rawText,
      });
      setExtracted(result);
    } catch (e) {
      // The extractor throws with .code so we can show the right message.
      // Generic fallback covers the case of an unknown error.
      setExtractError(e?.message || 'Could not read this PDF. Please try again with the original Sehhaty certificate.');
      setPdfFile(null);
    } finally {
      setExtracting(false);
    }
  }

  /** Reset upload state — staff clicked "Looks wrong? Upload another". */
  function handleResetExtraction() {
    setPdfFile(null);
    setExtracted(null);
    setExtractError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  /** Drag-and-drop handlers for the upload zone. */
  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
  }
  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer?.files?.[0];
    if (file) handlePdfFile(file);
  }

  // True when Path B is ready to submit: an extraction has completed
  // successfully (leave ID found at minimum). Other fields might still
  // be null — that's OK because Bashaier validates against Sehhaty itself.
  const canSubmitB = !!extracted?.leaveId && !extracting;

  // Compare the extracted patient name against the logged-in
  // employee's name. Returns:
  //   'match'    — names overlap meaningfully (>= 2 shared name parts)
  //   'mismatch' — extraction succeeded but no overlap with employee
  //   'na'       — no extracted name yet, or no employee name on file
  //
  // Why fuzzy and not strict:
  //   • Saudi names have 4-5 parts. Cert and HR systems sometimes
  //     transliterate them differently (Mohammed vs Mohamed, Al-Saud
  //     vs AlSaud vs Al Saud).
  //   • Order of name parts can differ between cert and HR record.
  //   • Either side may have Arabic-only or Latin-only.
  //   We require AT LEAST two shared name parts (case + diacritics
  //   normalised). One shared part is too weak (common given names).
  //   Three+ shared parts is a strong match. Two is the cutoff.
  //
  // The result drives a soft UI warning, never a block — Bashaier
  // verifies on Seha.sa anyway and legitimate edge cases exist.
  const nameMatchStatus = useMemo(() => {
    if (!extracted?.name || !employee?.name) return 'na';
    const norm = (s) => String(s || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')   // strip Latin diacritics
      .replace(/[\u064B-\u0652]/g, '')   // strip Arabic diacritics
      .toUpperCase()
      .replace(/[^\p{L}\s]/gu, ' ')      // non-letters → space
      .replace(/\s+/g, ' ')
      .trim();
    const certParts = norm(extracted.name).split(' ').filter(p => p.length >= 2);
    const empParts  = norm(employee.name).split(' ').filter(p => p.length >= 2);
    if (!certParts.length || !empParts.length) return 'na';
    const empSet = new Set(empParts);
    const overlap = certParts.filter(p => empSet.has(p)).length;
    return overlap >= 2 ? 'match' : 'mismatch';
  }, [extracted?.name, employee?.name]);

  /** Submit Path B. Two branches:
   *
   *  1) Prior pending_certificate row exists AND staff said "yes, attach":
   *     PATCH that row with the extracted fields. Stage transitions from
   *     'pending_certificate' to 'pending_manager' so it enters the normal
   *     review flow. The original declaration's reason is preserved. If
   *     the cert dates extend beyond the original declaration, end_date
   *     is updated silently — Bashaier sees the change in the audit trail.
   *
   *  2) No prior row, OR staff said "no, this is separate":
   *     INSERT a fresh leave_requests row in 'pending_manager' stage with
   *     the extracted fields. Acts like a normal sick-leave submission
   *     except no manual typing was required.
   */
  async function handleSubmitWithCert() {
    if (busy || !canSubmitB) return;
    setBusy(true);
    setError('');
    try {
      const ex = extracted;
      // Compute days from start/end if the extractor didn't directly
      // return it. End date may equal start date for single-day certs.
      const startDate = ex.startDate || new Date().toISOString().slice(0, 10);
      const endDate   = ex.endDate || startDate;
      const days = ex.days || (() => {
        const a = new Date(startDate); const b = new Date(endDate);
        const diff = Math.round((b - a) / 86400000) + 1;
        return diff > 0 ? diff : 1;
      })();

      // Compose a reason note that records the source of the data.
      // Bashaier sees this in the leave row and the approval email so
      // it's clear the staff submitted via the PDF flow vs. manual entry.
      const reasonText = `Submitted via Sehhaty PDF · extracted ${ex.source === 'text_layer' ? 'from PDF text layer' : 'via OCR fallback'}`;

      const useAttach = !!(priorPending && attachToPrior);

      if (useAttach) {
        // Branch 1: PATCH the prior pending_certificate row.
        const patch = {
          stage:                  'pending_manager',
          sehhaty_code:           ex.leaveId,
          start_date:             startDate,
          end_date:               endDate,
          days:                   days,
          // Cross-check fields — same shape Bashaier types into the
          // HrApprovalModal cross-check view. Pre-populating these from
          // the staff-side extraction means Bashaier's cross-check is
          // already filled in when she opens the row, and she just
          // confirms against Sehhaty.
          sehhaty_seen_name:      ex.name      || null,
          sehhaty_seen_id_number: ex.idNumber  || null,
          sehhaty_seen_start:     ex.startDate || null,
          sehhaty_seen_end:       ex.endDate   || null,
          sehhaty_seen_days:      ex.days      ?? null,
          sehhaty_seen_issue_date: ex.issueDate || null,
          sehhaty_seen_doctor:    ex.doctor    || null,
          sehhaty_seen_specialty: ex.specialty || null,
          // Append the submission note to the existing reason without
          // overwriting the staff's original declared reason. The audit
          // trail can reconstruct exactly what happened.
          reason: priorPending.reason
            ? `${priorPending.reason} · ${reasonText}`
            : reasonText,
        };
        await directPatch('leave_requests', 'id', priorPending.id, patch, { timeoutMs: 12000 });
        onCreated?.({ ...priorPending, ...patch });
      } else {
        // Branch 2: fresh sick leave submission.
        const row = {
          employee_id:            employee.id,
          leave_type_id:          'sick',
          start_date:             startDate,
          end_date:               endDate,
          days:                   days,
          is_half_day:            false,
          stage:                  'pending_manager',
          reason:                 reasonText,
          sehhaty_code:           ex.leaveId,
          sehhaty_seen_name:      ex.name      || null,
          sehhaty_seen_id_number: ex.idNumber  || null,
          sehhaty_seen_start:     ex.startDate || null,
          sehhaty_seen_end:       ex.endDate   || null,
          sehhaty_seen_days:      ex.days      ?? null,
          sehhaty_seen_issue_date: ex.issueDate || null,
          sehhaty_seen_doctor:    ex.doctor    || null,
          sehhaty_seen_specialty: ex.specialty || null,
          // No sick_declared_at on this branch — this is a normal
          // submission that came in WITH the cert, never went through
          // the pending_certificate stage.
        };
        const created = await directPost('leave_requests', row, { timeoutMs: 12000 });
        onCreated?.(created);
      }
    } catch (e) {
      setError(e?.message || 'Could not submit your sick leave. Please try again.');
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

        {/* PATH B — submit with Sehhaty PDF.
            Three sub-states based on extraction progress:
              1. No file picked yet → upload zone (drag-drop or click)
              2. Extracting → loader with "Reading your certificate…"
              3. Extracted successfully → locked field preview + reset btn
            Errors from extraction render inline above the zone. */}
        {path === 'submit' && (
          <div className="px-6 py-5 space-y-4">
            {/* Prior-declaration banner.
                When a pending_certificate row exists, we surface it AND let
                the staff opt out of attaching ('No, this is a separate
                illness'). Default is to attach because that preserves
                single-illness-single-record integrity, which is what we
                want 95% of the time. */}
            {priorPending && (
              <div className="rounded-lg p-3 space-y-2 text-[11px]"
                   style={{ background: '#DBEAFE', color: '#1E3A8A', border: '1px solid #BFDBFE' }}>
                <div>
                  <strong>You declared sick on {priorPending.start_date}.</strong>{' '}
                  Is this the certificate for that declaration?
                </div>
                <div className="flex gap-2">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      checked={attachToPrior === true}
                      onChange={() => setAttachToPrior(true)}
                      style={{ accentColor: '#1E3A8A' }}
                    />
                    <span>Yes, attach to my declaration</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      checked={attachToPrior === false}
                      onChange={() => setAttachToPrior(false)}
                      style={{ accentColor: '#1E3A8A' }}
                    />
                    <span>No, this is separate</span>
                  </label>
                </div>
              </div>
            )}

            {/* Extraction error — strict failure as per design. */}
            {extractError && (
              <div className="rounded-lg p-3 text-[11px] flex items-start gap-2"
                   style={{ background: '#FEE2E2', color: '#991B1B', border: '1px solid #FCA5A5' }}>
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <div>{extractError}</div>
              </div>
            )}

            {/* State 1 — empty upload zone */}
            {!pdfFile && !extracting && (
              <div
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
                className="rounded-lg p-8 text-center cursor-pointer transition-colors hover:bg-amber-50"
                style={{ background: '#FFFFFF', border: '2px dashed #FCA5A5' }}
              >
                <Upload className="w-10 h-10 mx-auto mb-3" style={{ color: '#B91C1C' }} />
                <div className="text-sm" style={{ fontWeight: 600, color: '#0A0A0A' }}>
                  Drop your Sehhaty PDF here, or click to choose
                </div>
                <div className="text-[11px] mt-1.5" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                  The system will read the leave ID, dates, and doctor automatically.
                </div>
                <div className="text-[10px] mt-2" style={{ color: '#0A0A0A', opacity: 0.55 }}>
                  Original PDF from Seha.sa only. Photos and screenshots aren't accepted.
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(e) => handlePdfFile(e.target.files?.[0])}
                  className="hidden"
                />
              </div>
            )}

            {/* State 2 — extracting */}
            {extracting && (
              <div className="rounded-lg p-8 text-center"
                   style={{ background: '#FFFFFF', border: '2px dashed #FCA5A5' }}>
                <Loader2 className="w-10 h-10 mx-auto mb-3 animate-spin" style={{ color: '#B91C1C' }} />
                <div className="text-sm" style={{ fontWeight: 600, color: '#0A0A0A' }}>
                  Reading your certificate…
                </div>
                <div className="text-[10px] mt-1" style={{ color: '#0A0A0A', opacity: 0.6 }}>
                  Usually takes a couple of seconds.
                </div>
              </div>
            )}

            {/* State 3 — extracted successfully, show locked preview */}
            {extracted && !extracting && (
              <div className="rounded-lg overflow-hidden"
                   style={{ background: '#FFFFFF', border: '1px solid #A7F3D0' }}>
                <div className="flex items-center justify-between px-3 py-2 border-b"
                     style={{ background: '#ECFDF5', borderColor: '#A7F3D0' }}>
                  <div className="flex items-center gap-2 text-[11px]" style={{ color: '#065F46', fontWeight: 600 }}>
                    <Check className="w-3.5 h-3.5" />
                    Certificate read successfully
                    {extracted.source === 'ocr_fallback' && (
                      <span className="text-[9px] tracking-wider opacity-70">VIA OCR</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={handleResetExtraction}
                    disabled={busy}
                    className="text-[10px] inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-white"
                    style={{ color: '#065F46' }}
                  >
                    <RefreshCw className="w-3 h-3" /> Looks wrong? Upload another
                  </button>
                </div>
                <div className="p-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
                  {/* Patient name appears first so the staff can
                      immediately verify the cert belongs to them.
                      Spans both columns since Saudi names are typically
                      4-5 words long.
                      The 'matchEmployee' prop turns on a small badge:
                        ✓ green = name on cert matches the logged-in
                                  employee (case/diacritic-insensitive)
                        ⚠ amber = no match found — soft warning, NOT
                                  a block; legitimate edge cases exist
                                  (recently changed name, OCR misread,
                                  staff submitting on behalf of family
                                  member in some private setups). */}
                  <PreviewField
                    label="Name"
                    value={extracted.name || '—'}
                    wide
                    matchStatus={nameMatchStatus}
                  />
                  <PreviewField label="Leave ID"   value={extracted.leaveId} mono required />
                  <PreviewField label="Iqama / ID" value={extracted.idNumber || '—'} mono />
                  <PreviewField label="Start"      value={extracted.startDate || '—'} />
                  <PreviewField label="End"        value={extracted.endDate || '—'} />
                  <PreviewField label="Days"       value={extracted.days || '—'} />
                  <PreviewField label="Issue date" value={extracted.issueDate || '—'} />
                  <PreviewField label="Doctor"     value={extracted.doctor || '—'} wide />
                  <PreviewField label="Specialty"  value={extracted.specialty || '—'} wide />
                </div>
                {nameMatchStatus === 'mismatch' && (
                  <div className="mx-3 mb-3 px-3 py-2 rounded-lg text-[11px] flex items-start gap-2"
                       style={{ background: '#FEF3C7', color: '#92400E' }}>
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <div>
                      The name on the certificate doesn't appear to match your profile name (<strong>{employee?.name}</strong>). HR will verify this when they review your submission. If you uploaded the wrong PDF, click "Upload another" above.
                    </div>
                  </div>
                )}
                <div className="px-3 pb-3 text-[10px]" style={{ color: '#0A0A0A', opacity: 0.6 }}>
                  These values are read from the PDF and cannot be edited. If anything looks wrong, click "Upload another" above.
                </div>
              </div>
            )}

            {error && (
              <div className="px-3 py-2 rounded-lg text-[11px]" style={{ background: '#FEE2E2', color: '#991B1B' }}>
                {error}
              </div>
            )}
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
              onClick={handleSubmitWithCert}
              disabled={busy || !canSubmitB}
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm transition-colors disabled:opacity-50"
              style={{ background: '#0F4C2A', color: '#FFFFFF', fontWeight: 600 }}
              title={canSubmitB ? 'Submit this certificate to HR for review' : 'Upload your Sehhaty PDF first'}
            >
              {busy
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</>
                : <><Check className="w-4 h-4" /> Submit sick leave for HR review</>}
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

// PreviewField — single read-only field row in the Path B extracted-
// preview card. Label above value, value rendered as plain text (not
// an input) to make it visually clear this is locked.
//   wide        — cell spans both columns (long names)
//   mono        — monospace font for IDs/codes
//   required    — green check badge if value is present (used on
//                 the leave ID; signals "this is the critical field")
//   matchStatus — driven by the parent for the Name field:
//                   'match'    → green ✓ next to label
//                   'mismatch' → amber ⚠ next to label
//                   'na'/null  → no badge
function PreviewField({ label, value, mono, wide, required, matchStatus }) {
  // Pick a status badge for the label row, in priority order:
  //   1. matchStatus from parent (Name field)
  //   2. required+present (Leave ID — always green when value exists)
  let badge = null;
  if (matchStatus === 'match') {
    badge = { ico: '✓', bg: '#D1FAE5', col: '#065F46' };
  } else if (matchStatus === 'mismatch') {
    badge = { ico: '⚠', bg: '#FEF3C7', col: '#92400E' };
  } else if (required && value && value !== '—') {
    badge = { ico: '✓', bg: '#D1FAE5', col: '#065F46' };
  }
  return (
    <div style={wide ? { gridColumn: 'span 2' } : undefined}>
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-[9px] tracking-wider font-bold"
              style={{ color: '#0A0A0A', opacity: 0.55 }}>
          {label}
        </span>
        {badge && (
          <span className="inline-flex items-center justify-center w-3 h-3 rounded-full text-[8px] font-bold"
                style={{ background: badge.bg, color: badge.col }}>
            {badge.ico}
          </span>
        )}
      </div>
      {/* Value rendering. When the value contains a newline (used by
          the bilingual matchers — Latin on first line, Arabic on
          second), render each line as a separate row with appropriate
          script direction so RTL Arabic doesn't visually disrupt the
          left-aligned LTR Latin line above it. */}
      {typeof value === 'string' && value.includes('\n') ? (
        <div style={{ wordBreak: 'break-word' }}>
          {value.split('\n').map((line, i) => {
            const isArabic = /[\u0600-\u06FF\uFB50-\uFEFC]/.test(line);
            return (
              <div
                key={i}
                dir={isArabic ? 'rtl' : 'ltr'}
                style={{
                  fontSize: i === 0 ? '13px' : '12px',
                  fontFamily: mono ? 'ui-monospace, SFMono-Regular, monospace' : 'inherit',
                  fontWeight: i === 0 ? 600 : 500,
                  color: '#0A0A0A',
                  opacity: i === 0 ? 1 : 0.85,
                  textAlign: isArabic ? 'right' : 'left',
                  marginTop: i === 0 ? 0 : 2,
                }}
              >
                {line}
              </div>
            );
          })}
        </div>
      ) : (
        <div
          style={{
            fontSize: '13px',
            fontFamily: mono ? 'ui-monospace, SFMono-Regular, monospace' : 'inherit',
            fontWeight: 600,
            color: '#0A0A0A',
            wordBreak: 'break-word',
          }}
        >
          {value}
        </div>
      )}
    </div>
  );
}
