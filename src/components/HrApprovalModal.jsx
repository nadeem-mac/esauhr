import React, { useState, useCallback, useEffect } from 'react';
import { X, Check, Loader2, Download, Mail, Calendar, Users, FileText, AlertTriangle, ShieldCheck, ExternalLink, Clipboard, Image as ImageIcon, Sparkles } from 'lucide-react';
import { supabase, directPatch } from '../supabaseClient.js';
import { fmtDate } from '../lib/leaveLogic.js';
import { logAction } from '../lib/audit.js';
import { generateVacationFormBlob, buildEmailDraft, buildSickLeaveApprovalEmailDraft, downloadBlob } from '../lib/vacationForm.js';
import { SEHHATY_VERIFY_URL, classifySickLeaveBracket, diagnoseSehhatyCode, crossCheckSehhaty } from '../lib/sehhaty.js';

// Friendly label for a leave type id. Falls back to title-casing the
// id when we don't have a curated name. The leaveTypes table stores
// proper names but ReviewerPanel doesn't currently pass them — so
// we keep this small map in sync with the seeded types in schema.sql
// rather than threading the prop through.
const LEAVE_TYPE_LABELS = {
  annual:    'Annual Leave',
  sick:      'Sick Leave',
  unpaid:    'Unpaid Leave',
  maternity: 'Maternity Leave',
  paternity: 'Paternity Leave',
  bereavement: 'Bereavement Leave',
  hajj:      'Hajj Leave',
  other:     'Other Leave',
};
const labelFor = (id) => LEAVE_TYPE_LABELS[id]
  || (id ? id.charAt(0).toUpperCase() + id.slice(1) + ' Leave' : 'Leave');

// Shown when an HR-final reviewer (Bashaier / admin) clicks Approve on a
// pending_hr leave request. Wraps the simple approve action with:
//   1. A summary review (employee, dates, substitutes, who already approved)
//   2. Final-approve action that writes stage='approved' to the DB
//   3. Bilingual EN/AR Vacation Form generation + download
//   4. mailto: composer pre-filled with To: requester, CC: manager + HR + CEO + Country Head
//   5. For sick leaves: Sehhaty verification — HR opens the official
//      portal, manually checks the service code matches the request,
//      and toggles the request as verified. Approval is gated on
//      verification (or on an explicit override) so an unverified
//      sick leave never reaches the 'approved' stage by accident.
export default function HrApprovalModal({ request, employee, manager, substitutes, me, allRequests, empMap, onClose, onApproved }) {
  const [step, setStep]     = useState('review');   // 'review' | 'approving' | 'done'
  const [error, setError]   = useState('');
  const [draft, setDraft]   = useState(null);
  const [formGenerating, setFormGenerating] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  // Local mirror of verification state so the toggle reflects
  // immediately without waiting for ReviewerPanel to reload.
  const isSick = request?.leave_type_id === 'sick';
  const [verifiedAt, setVerifiedAt] = useState(request?.sehhaty_verified_at || null);
  const [verifying, setVerifying]   = useState(false);
  const [verifyError, setVerifyError] = useState('');
  // Confirmation modal state. When Bashaier clicks 'I've verified
  // on Sehhaty', we don't toggle immediately — we ask her to
  // explicitly confirm the reference matches a real certificate
  // and capture an optional verification note. This makes the
  // verification a deliberate act with a paper trail rather than
  // a single button click that's easy to misfire on.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmNote, setConfirmNote] = useState('');
  // Cross-check fields — what Bashaier reads off the Sehhaty
  // inquiry result and types in here. The system compares each
  // value against the request and refuses to verify if the
  // critical fields (start, end, days) don't match. Pre-populated
  // from the request itself so the happy path is just visual
  // confirmation and an Enter press; only mismatches need editing.
  const [seenName, setSeenName]           = useState('');
  const [seenIdNumber, setSeenIdNumber]   = useState('');
  const [seenStart, setSeenStart]         = useState('');
  const [seenEnd, setSeenEnd]             = useState('');
  const [seenDays, setSeenDays]           = useState('');
  const [seenIssueDate, setSeenIssueDate] = useState('');
  const [seenDoctor, setSeenDoctor]       = useState('');
  const [seenSpecialty, setSeenSpecialty] = useState('');

  // Format diagnostic for the request's stored code. Exposed to the
  // confirmation modal so Bashaier sees any soft warnings (too short,
  // looks like a phone number, etc.) before she clicks Yes.
  const codeDiag = request?.sehhaty_code
    ? diagnoseSehhatyCode(request.sehhaty_code)
    : { severity: 'error', messages: ['No code on this request.'], normalised: '' };

  // Cross-check result: compares the typed-in Sehhaty values
  // against the request fields. Updates live as Bashaier types.
  const crossCheck = isSick ? crossCheckSehhaty({
    request,
    employee,
    seen: {
      name: seenName,
      idNumber: seenIdNumber,
      start: seenStart,
      end: seenEnd,
      days: seenDays,
      issueDate: seenIssueDate,
      doctor: seenDoctor,
      specialty: seenSpecialty,
    },
  }) : { allOk: true, mismatches: [], notes: [] };

  // Saudi Labour Law sick-day running total + bracket warning.
  // allRequests prop is optional — when provided, we compute the
  // YTD figure for context. When absent we just hide the bracket
  // panel rather than guessing.
  const sickYTD = (() => {
    if (!isSick || !allRequests || !employee) return null;
    const yearStart = new Date().getFullYear() + '-01-01';
    return (allRequests || [])
      .filter(r => r.employee_id === employee.id
        && r.leave_type_id === 'sick'
        && r.id !== request.id // exclude the one being approved
        && (r.status === 'approved' || /^pending/.test(r.status || ''))
        && r.start_date >= yearStart)
      .reduce((sum, r) => sum + (Number(r.days) || 0), 0);
  })();
  const sickBracket = (sickYTD !== null) ? classifySickLeaveBracket(sickYTD, request?.days || 0) : null;

  // OCR-driven auto-fill from a pasted/dropped Sehhaty screenshot.
  // Saves Bashaier from typing 8 fields by hand. The image stays
  // entirely in the browser — Tesseract.js runs locally and the
  // raw image is never sent to any server. Fields that OCR is
  // confident about overwrite the pre-filled (from-request) values;
  // fields it doesn't find leave the existing values alone so the
  // happy path never gets worse.
  const [ocrBusy, setOcrBusy]       = useState(false);
  const [ocrError, setOcrError]     = useState('');
  const [ocrThumb, setOcrThumb]     = useState(null);   // data URL for preview
  const [ocrLastRun, setOcrLastRun] = useState(null);   // {confidence, fieldsFound}

  const applyOcrToForm = useCallback(async (imageBlob) => {
    if (!imageBlob) return;
    setOcrBusy(true);
    setOcrError('');
    setOcrLastRun(null);
    try {
      // Show preview thumbnail while OCR runs
      const reader = new FileReader();
      reader.onload = () => setOcrThumb(reader.result);
      reader.readAsDataURL(imageBlob);

      // Lazy-import to keep tesseract.js out of the main bundle
      const { extractFromImage } = await import('../lib/sehhatyOcr.js');
      const parsed = await extractFromImage(imageBlob);

      // Track which fields actually got values so the success
      // toast can say something useful instead of just 'done'.
      const found = [];

      if (parsed.startDate) { setSeenStart(parsed.startDate); found.push('start'); }
      if (parsed.endDate)   { setSeenEnd(parsed.endDate);     found.push('end'); }
      if (parsed.days != null) {
        setSeenDays(String(parsed.days));
        found.push('days');
      }
      if (parsed.issueDate) { setSeenIssueDate(parsed.issueDate); found.push('issue date'); }
      if (parsed.idNumber)  { setSeenIdNumber(parsed.idNumber);   found.push('Iqama'); }
      if (parsed.name)      { setSeenName(parsed.name);           found.push('name'); }
      if (parsed.doctor)    { setSeenDoctor(parsed.doctor);       found.push('doctor'); }
      if (parsed.specialty) { setSeenSpecialty(parsed.specialty); found.push('specialty'); }

      setOcrLastRun({
        confidence: parsed.confidence,
        fieldsFound: found,
      });

      // If OCR also pulled out a leave ID, sanity-check it against
      // the request's recorded code. We don't write it to a form
      // field (the leave ID is on the request itself, not in the
      // cross-check inputs) — but we surface a warning if they
      // differ, since that's a strong signal the screenshot is
      // for the wrong person or wrong leave.
      if (parsed.leaveId && request?.sehhaty_code) {
        const a = String(parsed.leaveId).replace(/\s+/g, '').toUpperCase();
        const b = String(request.sehhaty_code).replace(/\s+/g, '').toUpperCase();
        if (a !== b) {
          setOcrError(`Leave ID on screenshot (${a}) does not match the request (${b}). Confirm you pasted the right screenshot.`);
        }
      }
    } catch (err) {
      setOcrError(err?.message || String(err));
    } finally {
      setOcrBusy(false);
    }
  }, [request]);

  // Clipboard paste — Bashaier presses Cmd+V (or Ctrl+V) anywhere
  // in the modal. We listen on the document while the modal is
  // open so she doesn't have to click a specific zone first.
  useEffect(() => {
    if (!confirmOpen) return undefined;
    const onPaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            e.preventDefault();
            applyOcrToForm(blob);
            return;
          }
        }
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [confirmOpen, applyOcrToForm]);

  const onDropImage = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) {
      applyOcrToForm(file);
    }
  }, [applyOcrToForm]);

  const onPickImage = useCallback((e) => {
    const file = e.target?.files?.[0];
    if (file && file.type.startsWith('image/')) {
      applyOcrToForm(file);
    }
  }, [applyOcrToForm]);

  // Apply the verification — called from the confirmation modal
  // after Bashaier explicitly says yes. Writes the verification
  // timestamp, verifier, the cross-check fields she typed in (the
  // structured certificate data she saw on Sehhaty), and the
  // optional note. Refuses to write if the cross-check has any
  // 'block' severity mismatches.
  const applyVerification = useCallback(async () => {
    if (verifying) return;
    if (!crossCheck.allOk) {
      setVerifyError('Resolve mismatches above before saving.');
      return;
    }
    setVerifying(true);
    setVerifyError('');
    try {
      const now = new Date().toISOString();
      const note = confirmNote.trim();
      // Normalise empty strings to null so we don't store them.
      const nullIfEmpty = (s) => (s && String(s).trim()) ? String(s).trim() : null;
      await directPatch('leave_requests', 'id', request.id, {
        sehhaty_verified_at: now,
        sehhaty_verified_by: me?.id || me?.auth_user_id || null,
        sehhaty_verification_note: note || null,
        sehhaty_seen_name:       nullIfEmpty(seenName),
        sehhaty_seen_id_number:  nullIfEmpty(seenIdNumber),
        sehhaty_seen_start:      nullIfEmpty(seenStart),
        sehhaty_seen_end:        nullIfEmpty(seenEnd),
        sehhaty_seen_days:       seenDays === '' ? null : Number(seenDays),
        sehhaty_seen_issue_date: nullIfEmpty(seenIssueDate),
        sehhaty_seen_doctor:     nullIfEmpty(seenDoctor),
        sehhaty_seen_specialty:  nullIfEmpty(seenSpecialty),
      }, { timeoutMs: 10000 });
      setVerifiedAt(now);
      setConfirmOpen(false);
      try {
        logAction(me, 'sick_leave_verified', {
          targetType: 'leave_request',
          targetId: request.id,
          targetLabel: `${employee?.name || request.employee_id} · sick leave verified on Sehhaty`,
          details: {
            sehhaty_code: request.sehhaty_code,
            note: note || null,
            seen_doctor: nullIfEmpty(seenDoctor),
            warnings: crossCheck.mismatches.filter(m => m.severity === 'warn').map(m => m.field),
          },
        });
      } catch { /* audit best-effort */ }
    } catch (err) {
      setVerifyError(err?.message || String(err));
    } finally {
      setVerifying(false);
    }
  }, [request, me, employee, verifying, confirmNote, crossCheck,
      seenName, seenIdNumber, seenStart, seenEnd, seenDays, seenIssueDate, seenDoctor, seenSpecialty]);

  // Open the confirmation modal — used by both the inline 'Verify'
  // button and the 'Approve & continue' button as a pre-approval
  // gate when the leave is sick and not yet verified. Pre-populates
  // the cross-check fields with the request's own values so the
  // happy path (no discrepancies) is just visual confirmation.
  const openVerifyConfirm = useCallback(() => {
    setConfirmNote('');
    setVerifyError('');
    // Pre-fill from the request — if Sehhaty matches, Bashaier
    // doesn't have to retype anything; she just confirms each
    // field visually against the screen.
    setSeenName(employee?.name || '');
    setSeenIdNumber('');
    setSeenStart(request.start_date || '');
    setSeenEnd(request.end_date || '');
    setSeenDays(String(request.days || ''));
    setSeenIssueDate(request.start_date || '');
    setSeenDoctor('');
    setSeenSpecialty('');
    // Reset OCR state from any previous open of this modal
    setOcrBusy(false);
    setOcrError('');
    setOcrThumb(null);
    setOcrLastRun(null);
    setConfirmOpen(true);
  }, [request, employee]);

  // Approval gate: sick leaves must be verified before HR can finalise.
  // This is the policy enforcement — an unverified sick leave should
  // never reach 'approved' stage. HR can still see and review the
  // request; the Approve button is what's locked.
  const approvalBlocked = isSick && !verifiedAt;

  const approve = useCallback(async () => {
    setStep('approving');
    setError('');
    try {
      const now = new Date().toISOString();
      // Use directPatch (raw fetch) instead of supabase-js to avoid the wedge
      // pattern where the lazy query builder never executes the network call.
      await directPatch('leave_requests', 'id', request.id, {
        stage: 'approved',
        hr_decided_at: now,
        hr_decided_by: me?.auth_user_id || me?.id || null,
      }, { timeoutMs: 15000 });

      try {
        logAction(me, 'leave_request_decide', {
          targetType: 'leave_request',
          targetId: request.id,
          targetLabel: `${employee?.name || request.employee_id} · approved`,
          details: { stage: 'approved', action: 'approved' },
        });
      } catch { /* audit log is best-effort */ }

      setDraft(isSick
        ? buildSickLeaveApprovalEmailDraft({
            // Merge the verification-time data Bashaier typed in
            // into the request so the email body can render the
            // 'CERTIFICATE DETAILS (cross-checked on Sehhaty)' block.
            // After the directPatch in applyVerification these are
            // already persisted, but the prop hasn't reloaded yet,
            // so we layer the local state on top.
            request: {
              ...request,
              sehhaty_verified_at: verifiedAt || request.sehhaty_verified_at,
              sehhaty_verification_note: confirmNote.trim() || request.sehhaty_verification_note,
              sehhaty_seen_name:       seenName        || request.sehhaty_seen_name,
              sehhaty_seen_id_number:  seenIdNumber    || request.sehhaty_seen_id_number,
              sehhaty_seen_start:      seenStart       || request.sehhaty_seen_start,
              sehhaty_seen_end:        seenEnd         || request.sehhaty_seen_end,
              sehhaty_seen_days:       seenDays !== '' ? Number(seenDays) : request.sehhaty_seen_days,
              sehhaty_seen_issue_date: seenIssueDate   || request.sehhaty_seen_issue_date,
              sehhaty_seen_doctor:     seenDoctor      || request.sehhaty_seen_doctor,
              sehhaty_seen_specialty:  seenSpecialty   || request.sehhaty_seen_specialty,
            },
            employee,
            manager,
            hrApprover: me,
            payBracketLabel: sickBracket?.endBracket?.label,
            // HR deputies (Badria + Fahad SUP) — looked up from empMap
            // by their fixed PSNs. Used in CC alongside the manager
            // and exec routing so they're in the loop on every sick
            // leave approval. Falls back gracefully to null if the
            // PSN isn't in the directory (e.g. they leave the org).
            badria: empMap?.['H94458'] || null,
            fahad:  empMap?.['H94712'] || null,
          })
        : buildEmailDraft({ request, employee, manager, hrApprover: me, substitutes }));
      setStep('done');
    } catch (err) {
      setError(err?.message || String(err));
      setStep('review');
    }
  }, [request, employee, manager, substitutes, me, isSick, verifiedAt, sickBracket,
      confirmNote, seenName, seenIdNumber, seenStart, seenEnd, seenDays, seenIssueDate, seenDoctor, seenSpecialty]);

  const downloadForm = useCallback(async () => {
    setFormGenerating(true);
    try {
      const blob = await generateVacationFormBlob({ request, employee, manager, hrApprover: me, substitutes });
      const safeName = (employee?.name || request.employee_id).replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
      const filename = `Vacation_Form_${safeName}_${request.start_date}.docx`;
      downloadBlob(blob, filename);
      setDownloaded(true);
    } catch (err) {
      alert('Could not generate the form: ' + (err?.message || err));
    } finally {
      setFormGenerating(false);
    }
  }, [request, employee, manager, substitutes, me]);

  const closeAfterDone = useCallback(() => {
    if (onApproved) onApproved();
    onClose();
  }, [onApproved, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
         style={{ background: 'rgba(20, 30, 25, 0.55)', backdropFilter: 'blur(4px)' }}
         onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[92vh] overflow-y-auto shadow-2xl"
           onClick={(e) => e.stopPropagation()}
           style={{ border: '1px solid var(--border-soft)' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 sticky top-0 z-10"
             style={{ borderBottom: '1px solid var(--border-soft)', background: 'linear-gradient(135deg, #F5F2E8 0%, #FFFFFF 100%)' }}>
          <div>
            <div className="text-[10px] tracking-[0.25em] opacity-60">FINAL HR APPROVAL</div>
            <div className="text-lg font-semibold mt-0.5" style={{ color: '#1F4530' }}>
              {step === 'done' ? 'Leave approved' : 'Review & approve'}
            </div>
          </div>
          <button onClick={onClose}
                  className="opacity-50 hover:opacity-100 p-2 rounded-full transition"
                  aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">

          {step === 'review' && (
            <>
              <div className="rounded-xl p-4 space-y-3"
                   style={{ background: 'var(--paper-2, #FAF7EE)', border: '1px solid var(--border-soft, #E8E5D8)' }}>
                <div className="flex items-start gap-3">
                  <Calendar className="w-4 h-4 mt-0.5 opacity-70 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold">{employee?.name || request.employee_id}</div>
                    <div className="text-xs opacity-70 mt-0.5">
                      {employee?.id || request.employee_id}
                      {employee?.department ? ` · ${employee.department}` : ''}
                      {employee?.location ? ` · ${employee.location}` : ''}
                    </div>
                    <div className="text-xs mt-2">
                      {labelFor(request.leave_type_id)} · {fmtDate(new Date(request.start_date))} → {fmtDate(new Date(request.end_date))}
                      {' · '}{request.days} day{request.days === 1 ? '' : 's'}
                    </div>
                    {request.reason && (
                      <div className="text-xs opacity-80 mt-1 italic">"{request.reason}"</div>
                    )}
                  </div>
                </div>

                {/* Substitutes section — hidden for sick leaves
                    since they bypass the substitute stage entirely
                    (Option B in the workflow: you can't pre-arrange
                    illness coverage, so the request goes straight
                    to the manager). For sick leaves the manager
                    decides coverage themselves. */}
                {!isSick && (
                <div className="flex items-start gap-3 pt-3 border-t" style={{ borderColor: 'var(--border-soft, #E8E5D8)' }}>
                  <Users className="w-4 h-4 mt-0.5 opacity-70 flex-shrink-0" />
                  <div className="flex-1 text-xs">
                    <div className="opacity-70 mb-1.5">Coverage confirmed by:</div>
                    {(substitutes || []).length === 0 && (
                      <div className="opacity-60 italic">No substitute coverage on file</div>
                    )}
                    {/* Each substitute with their accept/decline status.
                        Reads request.substitute_decisions[psn] which is
                        either a string ('accepted'|'declined'|'pending')
                        or an object { decision, at } depending on when
                        the row was written. */}
                    {(substitutes || []).map(s => {
                      const raw = request?.substitute_decisions?.[s.id];
                      const dec = !raw ? 'pending' :
                                  typeof raw === 'string' ? raw : (raw.decision || 'pending');
                      const accepted = dec === 'accepted';
                      const declined = dec === 'declined';
                      const bg    = accepted ? '#ECFDF5' : declined ? '#FEE2E2' : '#FEF3C7';
                      const color = accepted ? '#0F4C2A' : declined ? '#B91C1C' : '#92400E';
                      const label = accepted ? 'ACCEPTED' : declined ? 'DECLINED' : 'PENDING';
                      return (
                        <div key={s.id} className="mt-1 flex items-center gap-2">
                          <span>{s.name} <span className="opacity-50">({s.id})</span></span>
                          <span className="px-1.5 py-0.5 rounded-full"
                                style={{ background: bg, color, fontSize: '9px', fontWeight: 700, letterSpacing: '0.1em' }}>
                            {label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                )}

                <div className="flex items-start gap-3 pt-3 border-t" style={{ borderColor: 'var(--border-soft, #E8E5D8)' }}>
                  <Check className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: '#2D5F3F' }} />
                  <div className="flex-1 text-xs">
                    <div>Department approval: <span className="font-semibold">{manager?.name || '—'}</span></div>
                    {request.manager_decided_at && (
                      <div className="opacity-50 mt-0.5">on {fmtDate(new Date(request.manager_decided_at))}</div>
                    )}
                  </div>
                </div>
              </div>

              {/* Sehhaty verification panel — only for sick leaves.
                  Approval is gated on verifiedAt being set; HR has
                  to open Sehhaty in a new tab, type the service
                  code, confirm it matches the request, and then
                  click 'I've verified this on Sehhaty' here. */}
              {isSick && (
                <div className="rounded-xl p-4"
                  style={{
                    background: verifiedAt ? '#F0FDF4' : '#FFFBEB',
                    border: '1px solid ' + (verifiedAt ? '#86EFAC' : '#FCD34D'),
                  }}>
                  <div className="flex items-center gap-2 mb-2">
                    <ShieldCheck className="w-4 h-4" style={{ color: verifiedAt ? '#047857' : '#B45309' }}/>
                    <div className="text-xs tracking-widest" style={{ fontWeight: 700, color: verifiedAt ? '#047857' : '#B45309' }}>
                      SEHHATY VERIFICATION
                    </div>
                    <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full font-bold"
                      style={{
                        background: verifiedAt ? '#047857' : '#B45309',
                        color: '#FFFFFF', letterSpacing: '0.05em',
                      }}>
                      {verifiedAt ? 'VERIFIED' : 'PENDING'}
                    </span>
                  </div>

                  {/* Certificate details — service code is mono +
                      large so HR can read it off the screen while
                      typing it into Sehhaty in another tab. */}
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <div className="text-[9px] tracking-wider opacity-70 mb-0.5">SERVICE CODE</div>
                      <div className="font-mono text-sm" style={{ fontWeight: 700 }}>
                        {request.sehhaty_code || <span className="opacity-50 italic">not provided</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] tracking-wider opacity-70 mb-0.5">ISSUED</div>
                      <div className="text-sm">
                        {request.sehhaty_issue_date
                          ? fmtDate(new Date(request.sehhaty_issue_date))
                          : <span className="opacity-50 italic">not provided</span>}
                      </div>
                    </div>
                    {request.sehhaty_clinic && (
                      <div className="col-span-2">
                        <div className="text-[9px] tracking-wider opacity-70 mb-0.5">CLINIC</div>
                        <div className="text-sm">{request.sehhaty_clinic}</div>
                      </div>
                    )}
                  </div>

                  {/* Saudi Labour Law bracket — pay-rate context
                      so HR can flag payroll if the request crosses
                      the 30-day or 90-day boundary. */}
                  {sickBracket && (
                    <div className="mb-3 rounded-lg p-2.5 text-[11px]"
                      style={{ background: '#FFFFFF', border: '1px solid var(--border-soft, #E8E5D8)' }}>
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span style={{ fontWeight: 700 }}>YTD: {sickBracket.startTotal} of 120</span>
                        <span className="font-mono">After: {sickBracket.endTotal} ({sickBracket.daysRemaining} left)</span>
                      </div>
                      <div>
                        Pay bracket: <span style={{ fontWeight: 700, color: sickBracket.endBracket?.color }}>
                          {sickBracket.endBracket?.label}
                        </span>
                        {sickBracket.crossesBoundary && (
                          <span style={{ color: '#B91C1C', marginLeft: '6px' }}>
                            — crosses bracket boundary; payroll split required
                          </span>
                        )}
                        {sickBracket.overQuota && (
                          <span style={{ color: '#7F1D1D', marginLeft: '6px' }}>— exceeds 120-day quota</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Verification action row — open Sehhaty in a
                      new tab, then come back and click 'verified'. */}
                  {!verifiedAt && (
                    <>
                      <div className="text-[11px] mb-2 opacity-80">
                        Open Sehhaty, enter the service code above, confirm the certificate matches this request, then click below.
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <a href={SEHHATY_VERIFY_URL} target="_blank" rel="noopener noreferrer"
                          className="text-[11px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border"
                          style={{ borderColor: '#B45309', background: '#FFFFFF', color: '#B45309', fontWeight: 600 }}>
                          <ExternalLink className="w-3 h-3"/> Open Sehhaty
                        </a>
                        <button onClick={openVerifyConfirm}
                          disabled={!request.sehhaty_code || codeDiag.severity === 'error'}
                          title={codeDiag.severity === 'error' ? codeDiag.messages[0] : 'Confirm the certificate is valid on Sehhaty'}
                          className="text-[11px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full"
                          style={{
                            background: '#0F4C2A', color: '#FFFFFF',
                            opacity: (!request.sehhaty_code || codeDiag.severity === 'error') ? 0.5 : 1,
                            cursor: (!request.sehhaty_code || codeDiag.severity === 'error') ? 'not-allowed' : 'pointer',
                            fontWeight: 600,
                          }}>
                          <Check className="w-3 h-3"/> I've verified this on Sehhaty
                        </button>
                      </div>
                      {/* Format diagnostic — surfaces soft warnings
                          on the code (too short, looks like a phone
                          number, etc.) before Bashaier even clicks
                          verify. Hard 'error' severity disables the
                          button above; 'warn' shows a yellow banner
                          here as a heads-up. */}
                      {request.sehhaty_code && codeDiag.severity === 'warn' && (
                        <div className="text-[10px] mt-2 px-2 py-1.5 rounded"
                          style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FCD34D' }}>
                          ⚠ {codeDiag.messages.join(' ')}
                        </div>
                      )}
                      {!request.sehhaty_code && (
                        <div className="text-[10px] mt-2" style={{ color: '#B91C1C' }}>
                          Cannot mark as verified — no service code on this request. Ask the requester to resubmit with the Sehhaty code.
                        </div>
                      )}
                    </>
                  )}
                  {verifiedAt && (
                    <div className="text-[11px]" style={{ color: '#047857' }}>
                      ✓ Verified on {fmtDate(new Date(verifiedAt))}
                      {request.sehhaty_verified_by && ` by ${request.sehhaty_verified_by}`}
                    </div>
                  )}
                  {verifyError && (
                    <div className="text-[10px] mt-2" style={{ color: '#B91C1C' }}>
                      Failed to save verification: {verifyError}
                    </div>
                  )}
                </div>
              )}

              <div className="text-xs opacity-70 leading-relaxed">
                Approving below records this leave as <strong>final approved</strong>. The {request.days} day{request.days === 1 ? '' : 's'}{' '}
                will be deducted from the employee's annual entitlement and will appear on their dashboard.
                You'll then be able to download the bilingual Vacation Form and open the approval email,
                which is pre-addressed to the employee with John Ho and James Q.J. Liu in CC.
              </div>

              {error && (
                <div className="rounded-lg p-3 text-xs flex items-start gap-2"
                     style={{ background: '#FEE2E2', color: '#991B1B' }}>
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <div>{error}</div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button onClick={onClose}
                        className="px-4 py-2 rounded-full text-xs font-semibold border"
                        style={{ borderColor: 'var(--border-soft, #E8E5D8)' }}>
                  Cancel
                </button>
                <button onClick={() => {
                          // For sick leaves not yet verified, the
                          // Approve button doubles as the verify
                          // entry point. This makes the flow:
                          //   click Approve → confirmation modal asks
                          //   'is the reference valid?' → on yes,
                          //   verification stamp lands and approval
                          //   continues. Cleaner than a hard-disabled
                          //   button with a separate verify step.
                          if (approvalBlocked) {
                            openVerifyConfirm();
                          } else {
                            approve();
                          }
                        }}
                        disabled={isSick && !request.sehhaty_code}
                        title={(isSick && !request.sehhaty_code)
                          ? 'No Sehhaty code on this request'
                          : approvalBlocked
                          ? 'Confirm the certificate on Sehhaty before approving'
                          : ''}
                        className="inline-flex items-center gap-1.5 px-5 py-2 rounded-full text-xs font-semibold"
                        style={{
                          background: (isSick && !request.sehhaty_code)
                            ? '#9CA3AF'
                            : 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)',
                          color: '#fff',
                          cursor: (isSick && !request.sehhaty_code) ? 'not-allowed' : 'pointer',
                          opacity: (isSick && !request.sehhaty_code) ? 0.7 : 1,
                        }}>
                  <Check className="w-3.5 h-3.5" />
                  {approvalBlocked ? 'Verify & approve' : 'Approve & continue'}
                </button>
              </div>
              {approvalBlocked && (
                <div className="text-[10px] text-right" style={{ color: '#B45309', fontWeight: 600 }}>
                  Approve will first ask you to confirm the Sehhaty certificate is valid.
                </div>
              )}
            </>
          )}

          {step === 'approving' && (
            <div className="py-12 text-center">
              <Loader2 className="w-7 h-7 mx-auto animate-spin mb-3 opacity-60" />
              <div className="text-xs tracking-widest opacity-60">RECORDING APPROVAL</div>
            </div>
          )}

          {step === 'done' && (
            <>
              <div className="rounded-xl p-5 text-center"
                   style={{ background: 'linear-gradient(135deg, #E8F4ED 0%, #D4ECDD 100%)', border: '1px solid #A7CFB3' }}>
                <div className="w-12 h-12 mx-auto rounded-full flex items-center justify-center mb-2"
                     style={{ background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)' }}>
                  <Check className="w-6 h-6 text-white" />
                </div>
                <div className="font-semibold text-sm" style={{ color: '#1F4530' }}>
                  {isSick
                    ? 'Sick leave approved · validated on Sehhaty'
                    : 'Leave approved · recorded in vacation history'}
                </div>
                <div className="text-xs opacity-70 mt-1">
                  {request.days} day{request.days === 1 ? '' : 's'}
                  {!isSick ? ' deducted from annual balance' : ''}
                </div>
              </div>

              {/* Instructions + actions diverge by leave kind. Sick
                  leaves don't use the bilingual vacation form, so we
                  show only the email composer; the user is told
                  explicitly to attach their Sehhaty screenshot to
                  the email before sending (mailto: links can't
                  carry attachments — that's a hard browser limit). */}
              {isSick ? (
                <>
                  <div className="text-xs leading-relaxed"
                    style={{ color: '#0A0A0A' }}>
                    Click <strong>Open email composer</strong> — the email opens with subject, recipients, and a structured verification record pre-filled.
                    The body lists every certificate field you cross-checked, so the email is self-contained proof — no attachment needed.
                  </div>
                  <div className="rounded-lg p-3 text-[11px]"
                    style={{ background: '#F0FDF4', color: '#047857', border: '1px solid #86EFAC' }}>
                    ✓ <strong>Self-contained verification record:</strong> patient name, dates, day count, doctor, and specialty are all in the email body. If you also want to attach the Sehhaty screenshot for extra evidence, capture with <code className="px-1 rounded" style={{ background: '#FFFFFF' }}>Cmd+Shift+4</code> (Mac) or <code className="px-1 rounded" style={{ background: '#FFFFFF' }}>Win+Shift+S</code> (Windows) and drag-drop into the email — but it's optional.
                  </div>
                  <div className="grid grid-cols-1 gap-3">
                    <a href={draft?.mailto || '#'}
                       className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold"
                       style={{ background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }}>
                      <Mail className="w-4 h-4" /> Open email composer
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <div className="text-xs opacity-70 leading-relaxed">
                    Two final steps. Click <strong>Download Vacation Form</strong> to save the bilingual EN/AR form to your computer,
                    then click <strong>Open email composer</strong> — your mail client will open with the approval email pre-filled.
                    Attach the form you just downloaded before sending.
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button onClick={downloadForm}
                            disabled={formGenerating}
                            className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold disabled:opacity-60"
                            style={{ background: 'var(--paper-2, #FAF7EE)', border: '1px solid var(--border-soft, #E8E5D8)', color: '#2A2620' }}>
                      {formGenerating
                        ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating…</>
                        : downloaded
                          ? <><FileText className="w-4 h-4" style={{ color: '#2D5F3F' }} /> Downloaded · regenerate</>
                          : <><Download className="w-4 h-4" /> Download Vacation Form</>}
                    </button>
                    <a href={draft?.mailto || '#'}
                       className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold"
                       style={{ background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }}>
                      <Mail className="w-4 h-4" /> Open email composer
                    </a>
                  </div>
                </>
              )}

              {draft && (
                <details className="text-xs">
                  <summary className="cursor-pointer opacity-70 select-none">Preview email recipients & subject</summary>
                  <div className="mt-2 p-3 rounded-lg space-y-1 font-mono text-[11px] leading-relaxed"
                       style={{ background: 'var(--paper-2, #FAF7EE)', border: '1px solid var(--border-soft, #E8E5D8)' }}>
                    <div><span className="opacity-50">To: </span>{draft.to}</div>
                    <div><span className="opacity-50">Cc: </span>{draft.cc || '—'}</div>
                    <div><span className="opacity-50">Subject: </span>{draft.subject}</div>
                  </div>
                </details>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button onClick={closeAfterDone}
                        className="px-5 py-2 rounded-full text-xs font-semibold"
                        style={{ background: '#1F4530', color: '#fff' }}>
                  Done
                </button>
              </div>
            </>
          )}

        </div>
      </div>

      {/* Confirmation modal — structured cross-check between what
          Bashaier sees on the Sehhaty inquiry result page and what
          the staff member submitted in the request. The Sehhaty
          page (seha.sa/#/inquiries/slenquiry) returns a card with
          patient name, dates, day count, issue date, doctor name,
          and specialty — Bashaier reads each value off the screen
          and types it in here. The system compares to the request
          and refuses to save when critical fields don't match.
          Once approved, these values become a self-contained
          verification record in the email body and the audit log,
          so the screenshot itself is no longer the proof — the
          structured fields are. */}
      {confirmOpen && (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4"
             style={{ background: 'rgba(15,31,26,0.55)' }}
             onClick={(e) => e.stopPropagation()}>
          {/* The stopPropagation on this outer wrapper is critical.
              The cross-check modal is rendered as a child inside the
              parent HrApprovalModal's outermost div, which has
              onClick={onClose} on its backdrop. Without stopping
              propagation here, every click anywhere in the cross-
              check modal would bubble up and close the entire
              parent — exactly what the user reported.
              Click-outside-to-close on this modal itself is also
              gone — closes only via Cancel, the X button in the
              header, or successful verify. */}
          <div className="bg-paper rounded-t-2xl sm:rounded-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto fade-in"
            style={{ boxShadow: '0 12px 40px rgba(31,27,22,0.2)' }}>
            <div className="px-5 py-4 border-b sticky top-0 z-10 relative" style={{ borderColor: 'var(--border-soft)', background: 'var(--paper)' }}>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                aria-label="Close"
                className="absolute top-3 right-3 w-8 h-8 rounded-full flex items-center justify-center hover:bg-black/5"
                style={{ color: '#0A0A0A' }}>
                <X className="w-4 h-4"/>
              </button>
              <div className="text-[10px] tracking-[0.25em] font-bold mb-1 pr-10" style={{ color: '#B45309' }}>
                CROSS-CHECK · SEHHATY CERTIFICATE
              </div>
              <h3 className="text-lg pr-10" style={{ fontFamily: 'Georgia, serif', color: '#0A0A0A', fontWeight: 500 }}>
                Cross-check the Sehhaty certificate
              </h3>
              <div className="text-[11px] mt-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                Paste your Sehhaty screenshot below and the system reads every field for you. Or type the values in by hand if you prefer. Either way, dates and day count must match the request to verify.
              </div>
            </div>

            <div className="px-5 py-4 space-y-4">
              {/* OCR auto-fill — paste or drop the Sehhaty screenshot
                  and the system reads every field. The image stays
                  in the browser; nothing is uploaded to a server.
                  Bashaier saves ~30 seconds of manual typing per
                  sick leave verification. */}
              <OcrPasteZone
                busy={ocrBusy}
                error={ocrError}
                thumb={ocrThumb}
                lastRun={ocrLastRun}
                onDrop={onDropImage}
                onPick={onPickImage}
              />

              {/* Sehhaty mirror — visually matches the inquiry result
                  page on seha.sa: top two boxes for the leave ID
                  (any Sehhaty prefix — GSL, PSL, etc.) and the
                  Iqama/National ID, then a gray rounded card with
                  the Arabic-labeled fields in a two-column RTL grid.
                  Each field is auto-filled by the OCR paste above
                  and stays click-to-edit if Bashaier needs to correct
                  anything. The four critical validation points
                  (leave ID, Iqama, dates, days) get inline match
                  badges so she can scan for any red at a glance. */}
              <SehhatyMirror
                request={request}
                employee={employee}
                seenName={seenName}              setSeenName={setSeenName}
                seenIdNumber={seenIdNumber}      setSeenIdNumber={setSeenIdNumber}
                seenStart={seenStart}            setSeenStart={setSeenStart}
                seenEnd={seenEnd}                setSeenEnd={setSeenEnd}
                seenDays={seenDays}              setSeenDays={setSeenDays}
                seenIssueDate={seenIssueDate}    setSeenIssueDate={setSeenIssueDate}
                seenDoctor={seenDoctor}          setSeenDoctor={setSeenDoctor}
                seenSpecialty={seenSpecialty}    setSeenSpecialty={setSeenSpecialty}
                codeDiag={codeDiag}
                crossCheck={crossCheck}
              />

              {/* Mismatch summary — appears when crossCheck flags
                  any blocker or warning. 'block' severity refuses
                  the save; 'warn' allows it but Bashaier sees the
                  yellow card. */}
              {crossCheck.mismatches.filter(m => m.severity === 'block').length > 0 && (
                <div className="rounded-lg p-3 text-[11px]"
                  style={{ background: '#FEE2E2', color: '#991B1B', border: '1px solid #FCA5A5' }}>
                  <div style={{ fontWeight: 700 }} className="mb-1">✕ Cannot verify — these fields don't match:</div>
                  <ul className="space-y-0.5">
                    {crossCheck.mismatches.filter(m => m.severity === 'block').map((m, i) => (
                      <li key={i}>
                        <strong>{m.field}:</strong> request says <code>{String(m.requested)}</code> but Sehhaty shows <code>{String(m.seen)}</code>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 opacity-80">
                    Either adjust the request (cancel and ask staff to resubmit) or correct the entry above if you mistyped.
                  </div>
                </div>
              )}
              {crossCheck.mismatches.filter(m => m.severity === 'warn').length > 0 && (
                <div className="rounded-lg p-3 text-[11px]"
                  style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FCD34D' }}>
                  <div style={{ fontWeight: 700 }} className="mb-1">⚠ Heads-up — these are unusual but allowed:</div>
                  <ul className="space-y-0.5">
                    {crossCheck.mismatches.filter(m => m.severity === 'warn').map((m, i) => (
                      <li key={i}>
                        <strong>{m.field}:</strong> {String(m.seen)} (request: {String(m.requested)})
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Optional note */}
              <div>
                <label className="text-[10px] tracking-wider font-bold opacity-70 mb-1 block">
                  VERIFICATION NOTE <span className="opacity-60 font-normal">(optional)</span>
                </label>
                <textarea value={confirmNote}
                  onChange={e => setConfirmNote(e.target.value)}
                  rows={2} maxLength={300}
                  placeholder="e.g. matched the doctor name on the certificate, ID number confirmed via Iqama"
                  className="w-full px-3 py-2 rounded-lg border text-sm bg-transparent focus:outline-none resize-none"
                  style={{ borderColor: 'var(--border-soft)' }}/>
                <div className="text-[9px] opacity-50 text-right mt-0.5">
                  {confirmNote.length}/300
                </div>
              </div>

              {verifyError && (
                <div className="rounded-lg p-2.5 text-[11px]"
                  style={{ background: '#FEE2E2', color: '#991B1B', border: '1px solid #FCA5A5' }}>
                  {verifyError}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t flex items-center justify-between gap-2 sticky bottom-0"
              style={{ borderColor: 'var(--border-soft)', background: '#F7F7F7' }}>
              <a href={SEHHATY_VERIFY_URL} target="_blank" rel="noopener noreferrer"
                className="text-[11px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border"
                style={{ borderColor: '#B45309', background: '#FFFFFF', color: '#B45309', fontWeight: 600 }}>
                <ExternalLink className="w-3 h-3"/> Re-open Sehhaty
              </a>
              <div className="flex gap-2">
                <button onClick={() => setConfirmOpen(false)}
                  disabled={verifying}
                  className="text-[11px] px-3 py-1.5 rounded-full border"
                  style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', color: '#0A0A0A' }}>
                  Cancel
                </button>
                <button onClick={applyVerification}
                  disabled={verifying || codeDiag.severity === 'error' || !crossCheck.allOk}
                  title={!crossCheck.allOk ? 'Resolve mismatches first' : ''}
                  className="text-[11px] inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full"
                  style={{
                    background: (codeDiag.severity === 'error' || !crossCheck.allOk) ? '#9CA3AF' : '#0F4C2A',
                    color: '#FFFFFF',
                    fontWeight: 700,
                    cursor: (verifying || codeDiag.severity === 'error' || !crossCheck.allOk) ? 'not-allowed' : 'pointer',
                    opacity: (verifying || codeDiag.severity === 'error' || !crossCheck.allOk) ? 0.7 : 1,
                  }}>
                  {verifying
                    ? <><Loader2 className="w-3 h-3 animate-spin"/> Saving…</>
                    : <><Check className="w-3 h-3"/> All matches — verify</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CrossRow ────────────────────────────────────────────────────────────────
// One row of the cross-check grid. Left column shows what the
// request says (read-only reference), right column hosts the
// input where Bashaier types in what she sees on Sehhaty. The
// row's left border tints red when this field has a 'block'
// mismatch and amber when it has a 'warn' so the eye lands on
// the issue without scanning the summary card.
function CrossRow({ label, requestValue, field, mismatches, isLast, children }) {
  const fieldMismatch = (mismatches || []).find(m =>
    m.field?.toLowerCase() === String(field).toLowerCase()
  );
  const accent = fieldMismatch?.severity === 'block' ? '#B91C1C'
               : fieldMismatch?.severity === 'warn'  ? '#B45309'
               : 'transparent';
  return (
    <div className="grid grid-cols-12 px-3 py-2 items-center gap-2 text-[12px]"
      style={{
        borderBottom: isLast ? 'none' : '1px solid var(--border-soft)',
        borderLeft: `3px solid ${accent}`,
        color: '#0A0A0A',
      }}>
      <div className="col-span-4 font-semibold">{label}</div>
      <div className="col-span-4 font-mono opacity-80" style={{ fontSize: '11px' }}>
        {requestValue}
      </div>
      <div className="col-span-4">{children}</div>
    </div>
  );
}

// ─── OcrPasteZone ────────────────────────────────────────────────────────────
// The paste-screenshot zone at the top of the cross-check modal.
// Three states:
//   idle    — empty zone, prompts the user to paste, drop, or pick
//             a file. Cmd/Ctrl+V works anywhere in the modal.
//   busy    — OCR running. Shows the thumbnail dimmed with a
//             spinner overlay so Bashaier sees progress.
//   done    — thumbnail still visible (so she can confirm she
//             pasted the right screenshot), with a green success
//             banner listing the fields that were filled.
//
// The 'fields filled' list is intentionally specific: 'days, start,
// end, doctor' tells Bashaier at a glance what to spot-check. If a
// critical field is missing from the list (e.g. start date didn't
// OCR), she knows to type it by hand or re-paste a clearer image.
function OcrPasteZone({ busy, error, thumb, lastRun, onDrop, onPick }) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = React.useRef(null);

  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };
  const onDropInner = (e) => {
    setDragOver(false);
    onDrop(e);
  };

  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '');
  const pasteShortcut = isMac ? '⌘V' : 'Ctrl+V';

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDropInner}
      className="rounded-lg p-4 transition-colors"
      style={{
        background: dragOver ? '#FEF3C7' : '#FFFEF7',
        border: dragOver ? '2px dashed #B45309' : '2px dashed #E8DEC4',
        cursor: thumb ? 'default' : 'pointer',
      }}
      onClick={(e) => {
        // Stop propagation so the click doesn't bubble up to any
        // ancestor modal that might interpret it as a backdrop
        // click (a click-outside-to-close pattern). Even though the
        // current modal no longer uses that pattern, this is
        // defensive against future regressions.
        e.stopPropagation();
        // Only trigger file picker when clicking empty zone, not
        // the thumbnail or buttons inside it.
        if (!thumb && e.target === e.currentTarget && fileInputRef.current) {
          fileInputRef.current.click();
        }
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPick}
      />

      <div className="flex items-start gap-3">
        {/* Thumbnail or icon */}
        {thumb ? (
          <div className="relative flex-shrink-0">
            <img
              src={thumb}
              alt="Sehhaty screenshot"
              className="rounded"
              style={{
                width: 96,
                height: 96,
                objectFit: 'cover',
                border: '1px solid var(--border-soft)',
                opacity: busy ? 0.5 : 1,
              }}
            />
            {busy && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin" style={{ color: '#B45309' }}/>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center"
            style={{ background: '#FEF3C7', color: '#B45309' }}>
            {busy
              ? <Loader2 className="w-5 h-5 animate-spin"/>
              : <Sparkles className="w-5 h-5"/>}
          </div>
        )}

        {/* Right side: instructions or status */}
        <div className="flex-1 min-w-0">
          <div className="text-[10px] tracking-[0.2em] font-bold mb-1" style={{ color: '#B45309' }}>
            {busy ? 'READING SCREENSHOT…' :
             lastRun ? 'AUTO-FILLED FROM SCREENSHOT' :
             'AUTO-FILL FROM SEHHATY SCREENSHOT'}
          </div>

          {!thumb && !busy && (
            <>
              <div className="text-[12px] mb-2" style={{ color: '#0A0A0A' }}>
                Press <kbd className="px-1.5 py-0.5 rounded font-mono text-[10px]" style={{ background: '#FFFFFF', border: '1px solid var(--border-soft)' }}>{pasteShortcut}</kbd> to paste a screenshot, drag a file here, or
                {' '}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                  className="underline"
                  style={{ color: '#B45309', fontWeight: 600 }}>
                  choose a file
                </button>
                .
              </div>
              <div className="text-[10px]" style={{ color: '#0A0A0A', opacity: 0.6 }}>
                Tip: take a screenshot of the Sehhaty inquiry result with{' '}
                <kbd className="px-1 py-0.5 rounded font-mono text-[9px]" style={{ background: '#FFFFFF', border: '1px solid var(--border-soft)' }}>{isMac ? '⌘⇧4' : 'Win+Shift+S'}</kbd>
                {' '}then paste it here. The image stays in your browser — nothing is uploaded.
              </div>
            </>
          )}

          {busy && (
            <div className="text-[12px]" style={{ color: '#0A0A0A' }}>
              Reading the certificate… (first run downloads ~4MB language data)
            </div>
          )}

          {!busy && lastRun && (
            <>
              <div className="text-[12px] flex items-center gap-1.5 mb-1" style={{ color: '#065F46', fontWeight: 600 }}>
                <Check className="w-3.5 h-3.5"/> Filled {lastRun.fieldsFound.length} field{lastRun.fieldsFound.length === 1 ? '' : 's'}: {lastRun.fieldsFound.join(', ')}
              </div>
              <div className="text-[10px]" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                Spot-check the values below — OCR isn't perfect. Re-paste a sharper screenshot if anything looks off.
              </div>
              {lastRun.fieldsFound.length === 0 && (
                <div className="text-[11px] mt-1 px-2 py-1 rounded inline-block"
                  style={{ background: '#FEF3C7', color: '#92400E' }}>
                  No fields recognised. The image may be too small or blurry — try a sharper screenshot.
                </div>
              )}
            </>
          )}

          {!busy && error && (
            <div className="text-[11px] mt-1 px-2 py-1 rounded inline-block"
              style={{ background: '#FEE2E2', color: '#991B1B' }}>
              <AlertTriangle className="w-3 h-3 inline-block mr-1 align-text-bottom"/> {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── SehhatyMirror ──────────────────────────────────────────────────────────
// Visual reproduction of the Seha.sa inquiry result page. Bashaier
// pastes her Sehhaty screenshot into the OCR zone above; this card
// then mirrors what she'd see on the actual Sehhaty website with
// the same Arabic labels, two-column RTL layout, and the GSL/Iqama
// boxes at the top.
//
// All values are click-to-edit so OCR misreads can be corrected
// without leaving the layout. Inline match badges appear on the
// four critical validation points:
//   • Leave ID — must equal request.sehhaty_code
//   • Iqama    — informational (no canonical Iqama on the leave row)
//   • Start    — must equal request.start_date
//   • End      — must equal request.end_date
//   • Days     — must equal request.days
// Mismatches show a small red X badge; matches show a small green
// check. The aggregate mismatch banner from crossCheck still drives
// the verify button enable/disable state below this component.
function SehhatyMirror({
  request, employee,
  seenName,       setSeenName,
  seenIdNumber,   setSeenIdNumber,
  seenStart,      setSeenStart,
  seenEnd,        setSeenEnd,
  seenDays,       setSeenDays,
  seenIssueDate,  setSeenIssueDate,
  seenDoctor,     setSeenDoctor,
  seenSpecialty,  setSeenSpecialty,
  codeDiag,
  crossCheck,
}) {
  // Match-status helpers. Each returns 'match' | 'mismatch' | 'na'.
  const dateMatch = (seen, expected) => {
    if (!seen) return 'na';
    return seen === expected ? 'match' : 'mismatch';
  };
  const numMatch = (seen, expected) => {
    if (seen === '' || seen == null) return 'na';
    return Number(seen) === Number(expected) ? 'match' : 'mismatch';
  };

  const idStatus      = 'na'; // Iqama not stored on leave row; record-only
  const startStatus   = dateMatch(seenStart,    request.start_date);
  const endStatus     = dateMatch(seenEnd,      request.end_date);
  const daysStatus    = numMatch(seenDays,      request.days);

  return (
    <div className="space-y-3">
      {/* Top: leave ID box (any Sehhaty prefix — value comes from
          the request and is validated against the OCR-extracted code
          in the OCR step itself) and Iqama box (typed/auto-filled,
          recorded for audit only). */}
      <div className="space-y-2">
        <SehhatyTopBox
          value={request?.sehhaty_code || ''}
          editable={false}
          monoLg
          status={codeDiag.severity === 'error' ? 'mismatch' : codeDiag.severity === 'warn' ? 'na' : 'match'}
          rightLabel="LEAVE ID (from request)"
        />
        <SehhatyTopBox
          value={seenIdNumber}
          onChange={setSeenIdNumber}
          placeholder="National ID / Iqama"
          monoLg
          status={idStatus}
          rightLabel="IQAMA"
        />
      </div>

      {/* The result card — English-only, ltr, clean. Mirrors the
          DATA layout of the Sehhaty page (two columns, same field
          ordering) but uses English labels for clarity. The actual
          Sehhaty website is Arabic-only; the cross-check view here
          presents the same information in the language Bashaier
          reads fastest, which is English in this org. */}
      <div className="rounded-lg p-5"
        style={{ background: '#F2F2EF', border: '1px solid #E5E5E0' }}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-5">
          {/* Row 1 — Name | Issue date */}
          <SehhatyField
            label="Name"
            value={seenName}
            onChange={setSeenName}
            placeholder="Patient name"
            isArabic
          />
          <SehhatyField
            label="Issue date"
            value={seenIssueDate}
            onChange={setSeenIssueDate}
            type="date"
          />

          {/* Row 2 — Start | End */}
          <SehhatyField
            label="Start date"
            value={seenStart}
            onChange={setSeenStart}
            type="date"
            status={startStatus}
          />
          <SehhatyField
            label="End date"
            value={seenEnd}
            onChange={setSeenEnd}
            type="date"
            status={endStatus}
          />

          {/* Row 3 — Days | Doctor */}
          <SehhatyField
            label="Days"
            value={seenDays}
            onChange={setSeenDays}
            type="number"
            status={daysStatus}
          />
          <SehhatyField
            label="Doctor"
            value={seenDoctor}
            onChange={setSeenDoctor}
            placeholder="Doctor name"
            isArabic
          />

          {/* Row 4 — Specialty | (empty) */}
          <SehhatyField
            label="Specialty"
            value={seenSpecialty}
            onChange={setSeenSpecialty}
            placeholder="e.g. Family Medicine"
            isArabic
          />
          <div /> {/* keeps the 2-column grid balanced */}
        </div>
      </div>
    </div>
  );
}

// ─── SehhatyTopBox ─────────────────────────────────────────────────────────
// Reproduces the rounded white input boxes that appear above the
// gray card on the actual Sehhaty page. Read-only when given the
// recorded leave ID from the request; editable for the Iqama input.
function SehhatyTopBox({ value, onChange, placeholder, editable = true, monoLg, status, rightLabel }) {
  const statusBadge = status === 'match'    ? { ico: '✓', bg: '#D1FAE5', col: '#065F46' }
                    : status === 'mismatch' ? { ico: '✕', bg: '#FEE2E2', col: '#991B1B' }
                    : null;
  return (
    <div className="rounded-lg flex items-center justify-between px-4 py-3 gap-3"
      style={{ background: '#FFFFFF', border: '1px solid #E5E5E0' }}>
      <div className="text-[9px] tracking-wider font-bold whitespace-nowrap" style={{ color: '#0A0A0A', opacity: 0.5 }}>
        {rightLabel}
        {statusBadge && (
          <span className="ml-2 inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold"
            style={{ background: statusBadge.bg, color: statusBadge.col }}>
            {statusBadge.ico}
          </span>
        )}
      </div>
      {editable ? (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="text-right bg-transparent focus:outline-none flex-1"
          style={{
            fontFamily: monoLg ? 'ui-monospace, SFMono-Regular, monospace' : 'inherit',
            fontSize: monoLg ? '15px' : '14px',
            fontWeight: 600,
            color: '#0A0A0A',
            direction: 'ltr',
            textAlign: 'right',
          }}
        />
      ) : (
        <div className="flex-1 text-right"
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, monospace',
            fontSize: '15px',
            fontWeight: 700,
            color: '#0A0A0A',
            wordBreak: 'break-all',
          }}>
          {value || '—'}
        </div>
      )}
    </div>
  );
}

// ─── SehhatyField ───────────────────────────────────────────────────────────
// One label+value cell inside the gray result card. Clean English-
// only header with optional match badge — no Arabic mixed in, no
// rtl direction tricks, no extra whitespace from competing labels.
//
// The value sits below as an inline-styled input — transparent
// border most of the time so it reads as a calm value, white box
// with amber focus border when clicked, so OCR misreads can be
// edited without leaving the layout.
//
// `isArabic` prop only controls input direction for content (e.g.
// when the user types or pastes Arabic text into Name / Doctor /
// Specialty, those should display rtl); it no longer changes the
// label rendering.
function SehhatyField({ label, value, onChange, placeholder, type, isArabic, status }) {
  const statusBadge = status === 'match'    ? { ico: '✓', bg: '#D1FAE5', col: '#065F46' }
                    : status === 'mismatch' ? { ico: '✕', bg: '#FEE2E2', col: '#991B1B' }
                    : null;

  // Input direction: dates and numbers are always ltr; text fields
  // that may contain Arabic content (Name, Doctor, Specialty) get
  // rtl so typed/pasted Arabic reads in its natural order.
  const inputDir = type === 'date' || type === 'number' ? 'ltr'
                 : isArabic ? 'rtl' : 'ltr';

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[12px]" style={{ color: '#0A0A0A', fontWeight: 600 }}>
          {label}
        </span>
        {statusBadge && (
          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold"
            style={{ background: statusBadge.bg, color: statusBadge.col }}>
            {statusBadge.ico}
          </span>
        )}
      </div>
      <input
        type={type || 'text'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent focus:outline-none focus:bg-white focus:border-amber-400 rounded px-2 py-1 transition-colors"
        style={{
          fontSize: '14px',
          color: '#0A0A0A',
          fontWeight: 500,
          direction: inputDir,
          textAlign: inputDir === 'rtl' ? 'right' : 'left',
          border: '1px solid transparent',
        }}
      />
    </div>
  );
}
