import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { HeartPulse, X, Loader2, AlertTriangle, FileText, Check, Upload, RefreshCw } from 'lucide-react';
import { directPost, directGet, directPatch } from '../supabaseClient.js';
import { extractFromPdf } from '../lib/sehhatyPdfExtract.js';
import { initialApprovalStage } from '../lib/leaveLogic.js';
import { getExtendableDeclaration, buildExtensionPatch, formatDeclarationRange, MAX_DECLARATION_SPAN_DAYS } from '../lib/sickDeclaration.js';

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

export default function SickLeaveModal({
  employee,
  employees = [],
  onClose,
  onCreated,
  declaredVia = 'staff',
  isOnBehalf = false,
  forceCertPath = false,
  myDeclarations = [],
}) {
  // path: always either 'declare' (front-door declaration) or 'submit'
  // (cert upload). Pre-2026-05-10 this started as null and the staff
  // picked one via a fork at the top of the modal. Per Nadeem the
  // fork was confusing — every normal sick day starts the same way
  // (declare first; upload cert later via the dedicated button on
  // MyApplicationsCard), and the only time 'submit' is appropriate is
  // the soft-block escape hatch (forceCertPath=true). So now there's
  // no choice to make on entry: forceCertPath determines the path,
  // and once chosen it never changes — derived const, not state.
  const path = forceCertPath ? 'submit' : 'declare';

  // Path A state — declare-now flow
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  // End date is only meaningful when the staff picks 'A few days' — for
  // 'Today only' and 'Not sure' we record a single-day declaration and
  // they can extend later. Defaults to startDate + 2 days; the user can
  // bump it forward up to startDate + 7. The 7-day cap keeps multi-day
  // declarations reasonable; longer absences should land via Path B
  // (Sehhaty cert) which can specify any duration the cert covers.
  const [endDate,   setEndDate]   = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 2);
    return d.toISOString().slice(0, 10);
  });
  const [duration,  setDuration]  = useState('today_only');
  const [reasonId,  setReasonId]  = useState('');
  const [otherNote, setOtherNote] = useState('');

  // When the user picks 'A few days', the SICK FROM input is the start
  // date and the EXPECTED RETURN is the end date. For 'today_only' and
  // 'unsure', the row is a single day (end_date = start_date).
  const declarationStart = startDate;
  const declarationEnd   = duration === 'few_days' ? endDate : startDate;
  const declarationDays  = (() => {
    if (duration !== 'few_days') return 1;
    const a = new Date(declarationStart);
    const b = new Date(declarationEnd);
    const diff = Math.round((b - a) / 86_400_000) + 1;
    return Math.max(1, diff);
  })();

  // If the user toggles to 'few_days' AFTER picking a backdated start,
  // the default endDate (today + 2) might be BEFORE startDate. Re-anchor
  // endDate to startDate + 2 whenever startDate changes so the picker
  // always offers a sensible default within the valid window.
  useEffect(() => {
    if (duration !== 'few_days') return;
    const a = new Date(startDate);
    const b = new Date(endDate);
    if (b < a) {
      const next = new Date(a); next.setDate(next.getDate() + 2);
      setEndDate(next.toISOString().slice(0, 10));
    }
  }, [startDate, duration]);  // eslint-disable-line react-hooks/exhaustive-deps

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
        // Find recent sick row from this employee that's still in flight
        // and missing a cert — this used to gate on stage='pending_certificate'
        // but Path A now starts at pending_manager (per "ALL STAFF →
        // MANAGER → BASHAIER" routing), so we look up by the cert
        // column instead. This way Path B's "attach to prior" prompt
        // still finds the right row regardless of which stage it's
        // sitting at.
        const rows = await directGet(
          'leave_requests',
          `select=id,start_date,end_date,reason,sick_declared_at,stage&employee_id=eq.${employee.id}` +
          `&leave_type_id=eq.sick` +
          `&sehhaty_code=is.null` +
          `&sick_cert_exempt=eq.false` +
          `&stage=in.(pending_certificate,pending_manager,pending_hr)` +
          `&order=sick_declared_at.desc&limit=1`,
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

  // Extension — if the staff has a recent pending_certificate row that
  // doesn't already cover today and isn't blocking, surface an extend-
  // by-1-day option BEFORE the Path A form. Most "I'm still sick today"
  // sequences should extend the existing record rather than create a
  // duplicate row, which keeps the cert obligation tied to a single
  // illness (and prevents fragmenting the audit trail).
  //
  // The extension is hidden when:
  //   • forceCertPath is true (user is on the cert-only escape route)
  //   • path !== 'declare' (only shown on Path A — Path B doesn't need it)
  //   • The user has explicitly chosen 'No, this is a new illness'
  //     (extensionDismissed)
  //
  // NOTE: Hooks must run unconditionally — these go ABOVE the
  // `if (!employee) return null` early return below.
  const extendable = useMemo(
    () => forceCertPath ? null : getExtendableDeclaration(myDeclarations),
    [myDeclarations, forceCertPath],
  );
  const [extensionDismissed, setExtensionDismissed] = useState(false);
  const [extending, setExtending] = useState(false);

  if (!employee) return null;
  const showExtensionPrompt = path === 'declare' && extendable && !extensionDismissed;

  async function handleExtendDeclaration() {
    if (extending || !extendable) return;
    setExtending(true);
    setError('');
    try {
      const patch = buildExtensionPatch(extendable);
      // Append a small note to the reason so the audit trail records
      // that this row was extended (and to what end_date). The original
      // reason is preserved and the extension marker is appended.
      const todayStr = patch.end_date;
      const extensionNote = `Extended to ${todayStr} via portal`;
      const newReason = extendable.reason
        ? `${extendable.reason} · ${extensionNote}`
        : extensionNote;
      const fullPatch = { ...patch, reason: newReason };
      await directPatch('leave_requests', 'id', extendable.id, fullPatch, { timeoutMs: 12000 });
      // Pass _extended=true so AppShell's onCreated handler renders
      // the extension-specific toast instead of the new-submission one.
      onCreated?.({ ...extendable, ...fullPatch, _extended: true });
    } catch (e) {
      setError(e?.message || 'Could not extend your declaration. Please try again.');
    } finally {
      setExtending(false);
    }
  }

  // Path A submit guard
  const reasonObj = REASON_OPTIONS.find(r => r.id === reasonId);
  const isOther   = reasonId === 'OTHER';
  // When 'A few days' is selected, the end date must be present and
  // strictly after the start date (the EXPECTED RETURN picker enforces
  // this via min/max but a defensive check protects against a user
  // typing into the input directly).
  const fewDaysOk = duration !== 'few_days' || (
    !!endDate &&
    new Date(endDate) > new Date(declarationStart) &&
    declarationDays >= 2 && declarationDays <= 8
  );
  const canSubmitA = !!reasonId && !!startDate && (!isOther || !!otherNote.trim()) && fewDaysOk;

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

      // requested_at is REQUIRED for the row to surface in the staff's
      // own MyApplicationsCard — that view filters by a 90-day window
      // anchored on requested_at (via sortKey). The DB column may have
      // a default of now() but we set it explicitly so:
      //   1. The row is consistent regardless of DB defaults
      //   2. We control the timezone (always UTC ISO)
      //   3. New tables created without a default also work
      const nowIso = new Date().toISOString();
      const row = {
        employee_id:        employee.id,
        leave_type_id:      'sick',
        start_date:         declarationStart,
        end_date:           declarationEnd,
        days:               declarationDays,
        is_half_day:        false,
        // Stage routing — Per Nadeem (2026-05-06): "ALL STAFF →
        // MANAGER → BASHAIER" applies to sick leave too. The old
        // 'pending_certificate' holding state was HR-only and skipped
        // the manager step entirely, so Sadakath had no idea his
        // staff was sick today. We now route Path A declarations
        // through the same initialApprovalStage path as everything
        // else: Nadeem's sick → pending_manager (Sadakath approves
        // operationally, "yes, X is out today"), Fahad's sick →
        // pending_hr (Bashaier directly, manager-bypass).
        //
        // Cert tracking still works via the sehhaty_code IS NULL
        // filter — Bashaier sees sick rows missing certs in her
        // dashboard regardless of stage. The cert reminder system
        // and extension flow look up rows by the same column.
        stage:              initialApprovalStage(employee, employees),
        reason:             reasonText,
        requested_at:       nowIso,
        sick_declared_at:   nowIso,
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
          // Stage routing — managers (anyone with direct reports)
          // skip the manager-approval step and go straight to HR.
          // Non-managers: normal pending_manager flow.
          stage:                  initialApprovalStage(employee, employees),
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
          // Same manager-bypass rule as Branch 1 — managers' sick
          // leaves go straight to HR (Bashaier).
          stage:                  initialApprovalStage(employee, employees),
          // Set requested_at explicitly — same reason as Path A. Without
          // it, MyApplicationsCard's 90-day window filter excludes the
          // row from the staff's own visible list.
          requested_at:           new Date().toISOString(),
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
          background: '#FFFFFF',
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
        {/* Picker removed 2026-05-10 — single flow on entry. The
            forceCertPath prop pre-routes to Path B (cert upload) for
            the soft-block escape hatch; everyone else lands directly
            in Path A (declare-now). Staff who want to upload a cert
            for an already-declared sick day click the dedicated
            'Upload certificate' button on MyApplicationsCard, which
            sets forceCertPath=true on entry. */}

        {/* PATH A — declare-now flow */}
        {path === 'declare' && (
          <div className="px-6 py-5 space-y-4">
            {/* Extension prompt — surfaces when there's a recent
                pending_certificate row that doesn't already cover today
                and the staff probably wants to extend it rather than
                create a fresh record. Tapping "Yes, extend" PATCHes the
                existing row's end_date forward to today (one continuous
                illness, one row, audit trail preserved). Tapping "No,
                this is new" dismisses the prompt and falls through to
                the normal declare-new form below. */}
            {showExtensionPrompt && (() => {
              const todayStr = new Date().toISOString().slice(0, 10);
              const projected = buildExtensionPatch(extendable, todayStr);
              return (
                <div className="rounded-xl border p-4"
                     style={{ background: '#FFFBEB', borderColor: '#FCD34D' }}>
                  <div className="flex items-start gap-2 mb-3">
                    <HeartPulse className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: '#92400E' }} />
                    <div className="flex-1">
                      <div className="text-[12px] font-semibold mb-0.5" style={{ color: '#0A0A0A' }}>
                        Still unwell from your declaration on {extendable.start_date}?
                      </div>
                      <div className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.85 }}>
                        Existing declaration: {formatDeclarationRange(extendable)}.
                        Extending it to today ({todayStr}) keeps your record as
                        one continuous illness — total {projected.days} day{projected.days === 1 ? '' : 's'}.
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <button
                      type="button"
                      onClick={handleExtendDeclaration}
                      disabled={extending}
                      className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-[12px] font-semibold disabled:opacity-50"
                      style={{ background: '#92400E', color: '#FFFFFF' }}
                    >
                      {extending
                        ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Extending…</>
                        : <>Yes, extend by 1 day</>}
                    </button>
                    <button
                      type="button"
                      onClick={() => setExtensionDismissed(true)}
                      disabled={extending}
                      className="flex-1 px-3 py-2 rounded-lg text-[12px] border bg-white disabled:opacity-50"
                      style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}
                    >
                      No, this is a new illness
                    </button>
                  </div>
                  {extending && error && (
                    <div className="mt-2 px-3 py-2 rounded-lg text-[11px]"
                         style={{ background: '#FEE2E2', color: '#991B1B' }}>
                      {error}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Span-cap notice — when the staff has already used up
                the 7-day total declaration window, the extendable
                helper returns null but we still want to be transparent
                about why no extension is offered. This block surfaces
                only when there's a recent pending_certificate row but
                its span has already hit the cap. */}
            {!showExtensionPrompt && !extensionDismissed && (() => {
              const today = new Date().toISOString().slice(0, 10);
              const recent = (myDeclarations || [])
                .filter(d => d.stage === 'pending_certificate' && !d.sick_cert_exempt)
                .filter(d => d.end_date && d.end_date < today)
                .sort((a, b) => (b.end_date || '').localeCompare(a.end_date || ''))[0];
              if (!recent) return null;
              const start = new Date(recent.start_date);
              const todayD = new Date(today);
              const span = Math.round((todayD - start) / 86_400_000) + 1;
              if (span <= MAX_DECLARATION_SPAN_DAYS) return null;
              return (
                <div className="rounded-xl border px-4 py-3 text-[11px]"
                     style={{ background: '#FEF2F2', borderColor: '#FCA5A5', color: '#0A0A0A' }}>
                  Your existing declaration from {recent.start_date} has reached
                  the {MAX_DECLARATION_SPAN_DAYS}-day cap for cert-less sick leave.
                  For a longer absence, please use "Yes, I have it" above and
                  upload your Sehhaty certificate.
                </div>
              );
            })()}

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

              {/* Expected return date — only shown when 'A few days' is
                  picked. The other two duration options are single-day
                  records and they extend each morning if needed.
                  We cap the window at start + 7 days so a Path A
                  declaration can't claim a long absence without a cert
                  (longer absences should land via Path B with a
                  Sehhaty cert that covers the period). */}
              {duration === 'few_days' && (() => {
                const minD = (() => {
                  const a = new Date(declarationStart);
                  a.setDate(a.getDate() + 1);
                  return a.toISOString().slice(0, 10);
                })();
                const maxD = (() => {
                  const a = new Date(declarationStart);
                  a.setDate(a.getDate() + 7);
                  return a.toISOString().slice(0, 10);
                })();
                return (
                  <div className="mt-3 px-3 py-3 rounded-lg border"
                       style={{ background: '#FEF2F2', borderColor: '#FCA5A5' }}>
                    <label className="text-[11px] tracking-wider font-bold mb-1.5 block" style={{ color: '#0A0A0A' }}>
                      EXPECTED RETURN <span style={{ color: '#B91C1C' }}>*</span>
                    </label>
                    <input
                      type="date"
                      value={endDate}
                      min={minD}
                      max={maxD}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border text-sm"
                      style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', color: '#0A0A0A' }}
                    />
                    <div className="text-[10px] mt-1.5" style={{ color: '#0A0A0A', opacity: 0.75 }}>
                      Total: <strong>{declarationDays} day{declarationDays === 1 ? '' : 's'}</strong>
                      {' '}({declarationStart} → {declarationEnd}). You can extend later if you're still unwell.
                    </div>
                  </div>
                );
              })()}
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
                  The PDF is read on your device — only the Leave ID and Iqama are submitted to HR.
                </div>
                <div className="text-[10px] mt-2" style={{ color: '#0A0A0A', opacity: 0.55 }}>
                  Original PDF from Seha.sa only. Photos and screenshots aren't accepted.
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(e) => {
                    handlePdfFile(e.target.files?.[0]);
                    // Reset so re-selecting the same PDF (e.g. user
                    // hit cancel/back in the modal then re-picked
                    // the same Sehhaty PDF) still fires onChange.
                    e.target.value = '';
                  }}
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
                    Certificate read on your device
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
                    <RefreshCw className="w-3 h-3" /> Use a different file
                  </button>
                </div>
                <div className="p-3 space-y-3 text-[11px]">
                  {/* Name — sanity-check that this is the staff's own cert.
                      Read-only display. The matchStatus badge flags any
                      mismatch with the employee record so staff can spot
                      "wrong PDF picked" mistakes before submitting. */}
                  <PreviewField
                    label="Name"
                    value={extracted.name || '—'}
                    wide
                    matchStatus={nameMatchStatus}
                  />

                  {/* Leave ID — the Sehhaty service code. Editable so OCR
                      misreads can be corrected on the spot. This is the
                      key value HR uses to look up the cert on Sehhaty. */}
                  <div>
                    <div className="text-[9px] tracking-[0.18em] mb-1" style={{ color: '#0A0A0A', opacity: 0.7, fontWeight: 700 }}>
                      LEAVE ID <span style={{ color: '#B91C1C' }}>*</span>
                    </div>
                    <input
                      type="text"
                      value={extracted.leaveId || ''}
                      onChange={(e) => setExtracted({ ...extracted, leaveId: e.target.value.trim() })}
                      placeholder="SLXXXXXXXXXX"
                      className="w-full px-3 py-2 rounded-lg text-[14px] focus:outline-none focus:ring-2"
                      style={{
                        border: '1px solid #A7F3D0',
                        fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                        fontWeight: 600,
                        color: '#0A0A0A',
                      }}
                    />
                  </div>

                  {/* Iqama / National ID — the staff's identity number.
                      Editable for the same reason. HR uses this with the
                      Leave ID to look up the cert on Sehhaty. */}
                  <div>
                    <div className="text-[9px] tracking-[0.18em] mb-1" style={{ color: '#0A0A0A', opacity: 0.7, fontWeight: 700 }}>
                      IQAMA / NATIONAL ID
                    </div>
                    <input
                      type="text"
                      value={extracted.idNumber || ''}
                      onChange={(e) => setExtracted({ ...extracted, idNumber: e.target.value.trim() })}
                      placeholder="1XXXXXXXXX"
                      className="w-full px-3 py-2 rounded-lg text-[14px] focus:outline-none focus:ring-2"
                      style={{
                        border: '1px solid #A7F3D0',
                        fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                        fontWeight: 600,
                        color: '#0A0A0A',
                      }}
                    />
                  </div>
                </div>
                {nameMatchStatus === 'mismatch' && (
                  <div className="mx-3 mb-3 px-3 py-2 rounded-lg text-[11px] flex items-start gap-2"
                       style={{ background: '#FEF3C7', color: '#92400E' }}>
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <div>
                      The name on the certificate doesn't appear to match your profile name (<strong>{employee?.name}</strong>). HR will verify this on Sehhaty when they review. If you picked the wrong PDF, click "Use a different file" above.
                    </div>
                  </div>
                )}
                <div className="px-3 pb-3 text-[10px]" style={{ color: '#0A0A0A', opacity: 0.6 }}>
                  Your PDF stays on this device — only the Leave ID and Iqama are submitted. HR will verify on the official Sehhaty portal.
                </div>

                {/* TEMPORARY DIAGNOSTIC PANEL.
                    Shows the raw text the matchers worked with, so
                    if a field is wrong we can copy this and use it
                    to fix the matcher with concrete data instead of
                    guessing. Hidden by default; click the link to
                    expand. The Copy button copies just the rawText
                    for easy pasting. Will be removed in a follow-up
                    once extraction is reliable. */}
                {extracted.rawText && (
                  <details className="mx-3 mb-3 text-[10px]"
                           style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 6 }}>
                    <summary className="px-2 py-1.5 cursor-pointer select-none"
                             style={{ color: '#0A0A0A', fontWeight: 600 }}>
                      🛠 Show raw extracted text (for debugging)
                    </summary>
                    <div className="p-2 border-t" style={{ borderColor: '#E5E7EB' }}>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(extracted.rawText);
                        }}
                        className="mb-2 px-2 py-1 rounded text-[10px]"
                        style={{ background: '#0A0A0A', color: '#FFFFFF', fontWeight: 600 }}
                      >
                        Copy raw text
                      </button>
                      <pre
                        style={{
                          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                          fontSize: 10,
                          color: '#0A0A0A',
                          background: '#FFFFFF',
                          border: '1px solid #E5E7EB',
                          borderRadius: 4,
                          padding: 8,
                          maxHeight: 240,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >{extracted.rawText}</pre>
                    </div>
                  </details>
                )}
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
      {/* Bilingual values come through as 'Latin\nArabic' — render
          each line as its own row with appropriate script direction.
          Both lines get the same size for visual balance; the Arabic
          line uses a slightly lighter weight so the English reads
          as the primary identifier without dominating. */}
      {typeof value === 'string' && value.includes('\n') ? (
        <div style={{ wordBreak: 'break-word' }}>
          {value.split('\n').map((line, i) => {
            const isArabic = /[\u0600-\u06FF\uFB50-\uFEFC]/.test(line);
            return (
              <div
                key={i}
                // dir attribute keeps each script's INTERNAL reading
                // order correct (Arabic words flow right-to-left as
                // a unit, Latin words flow left-to-right).
                dir={isArabic ? 'rtl' : 'ltr'}
                style={{
                  fontSize: '13px',
                  fontFamily: mono ? 'ui-monospace, SFMono-Regular, monospace' : 'inherit',
                  fontWeight: i === 0 ? 600 : 500,
                  color: '#0A0A0A',
                  // Both lines start at the SAME left edge of the cell
                  // for tidy visual stacking. The Arabic line still
                  // reads right-to-left as a connected text block —
                  // textAlign:left controls where the BLOCK sits
                  // within its container, not the script direction.
                  // unicode-bidi: plaintext keeps the bidi algorithm
                  // working correctly within the block.
                  textAlign: 'left',
                  unicodeBidi: 'plaintext',
                  lineHeight: 1.5,
                  // Render Arabic in a sans Arabic font when available
                  // for cleaner weight matching with the Latin font.
                  fontFamilyFallback: isArabic ? '"Noto Sans Arabic", "Tahoma", sans-serif' : undefined,
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
