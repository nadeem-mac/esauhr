import React, { useState, useCallback, useEffect } from 'react';
import { X, Check, Loader2, Download, Mail, Calendar, Users, FileText, AlertTriangle, ShieldCheck, ExternalLink, Clipboard, Image as ImageIcon, Sparkles } from 'lucide-react';
import { supabase, directPatch } from '../supabaseClient.js';
import { fmtDate } from '../lib/leaveLogic.js';
import { logAction } from '../lib/audit.js';
import { generateVacationFormBlob, buildEmailDraft, buildSickLeaveApprovalEmailDraft, downloadBlob } from '../lib/vacationForm.js';
import { SEHHATY_VERIFY_URL, classifySickLeaveBracket, diagnoseSehhatyCode, crossCheckSehhaty } from '../lib/sehhaty.js';
import { markLeaveDaysAttendance } from '../lib/markLeaveAttendance.js';

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
export default function HrApprovalModal({ request, employee, manager, substitutes, me, allRequests, empMap, onClose, onApproved, onReject }) {
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
  // open so she doesn't have to click a specific zone first. 2026-05-16
  // (Nadeem): broadened from confirmOpen-only to the entire review
  // step for sick leaves — she should be able to paste the Sehhaty
  // screenshot the moment she opens the modal, not after manually
  // clicking 'I've verified this on Sehhaty' first.
  useEffect(() => {
    const listening = confirmOpen || (step === 'review' && isSick && (request?.sehhaty_code || verifiedAt));
    if (!listening) return undefined;
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
  }, [confirmOpen, step, isSick, request?.sehhaty_code, verifiedAt, applyOcrToForm]);

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
    // Reset the input so re-selecting the same screenshot fires
    // onChange again. Without this, if Bashaier picks a screenshot,
    // realises it was the wrong one but then re-picks the same file
    // after correcting (e.g. cropping in another tool to overwrite),
    // the input sees the value unchanged and skips the OCR rerun.
    if (e.target) e.target.value = '';
  }, [applyOcrToForm]);

  // Apply the verification — called from the confirmation modal
  // after Bashaier explicitly says yes. Writes the verification
  // timestamp, verifier, the cross-check fields she typed in (the
  // structured certificate data she saw on Sehhaty), and the
  // optional note. Refuses to write if the cross-check has any
  // 'block' severity mismatches.
  // Verify the cert: write the cross-check fields back to the row,
  // stamp sehhaty_verified_at + sehhaty_verified_by, and (if
  // chainApprove=true) immediately proceed to the final approve step.
  // Bashaier's flow is a single Verify-and-approve click — verification
  // and approval should not be two separate decisions for her, since
  // she's already cross-checked the cert against Sehhaty by the time
  // the verify button is enabled.
  const applyVerification = useCallback(async ({ chainApprove = false } = {}) => {
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
      // Build the canonical patch payload once and re-use both for the
      // directPatch AND for the chained approve() so the email body
      // doesn't depend on React state having flushed. Earlier the
      // chained approve() was reading verifiedAt + seen* from closure,
      // which was stale because setTimeout(...,0) fires before React
      // commits the state updates, leaving 'Verified on: —' and an
      // empty CERTIFICATE DETAILS block in the email.
      const verificationPatch = {
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
      };
      await directPatch('leave_requests', 'id', request.id, verificationPatch, { timeoutMs: 10000 });
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
      // Chain into approve if requested. Pass the merged request data
      // directly so approve() doesn't depend on React state having
      // flushed — verifiedAt + seen_* would still be the pre-OCR values
      // in approve's closure when setTimeout fires.
      if (chainApprove) {
        const mergedRequest = { ...request, ...verificationPatch };
        setTimeout(() => approve({ fromVerify: true, mergedRequest }), 0);
      }
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
  //
  // Exception (per Nadeem 2026-05-10): the approval flow for sick
  // 2026-05-10 final architecture (Nadeem): Bashaier cannot approve
  // a sick row from this modal without a Sehhaty cert. The new flow
  // requires the cert before HR closes the case — short of admin SQL,
  // there is no in-app bypass. AND once the cert is in, she must
  // verify it on Sehhaty before approving (the Verify & approve flow).
  //
  // Two flavours of "blocked":
  //   • isSickWithoutCert  — sick row with no cert at all. Approve
  //                          button is HIDDEN entirely (only Reject /
  //                          Close available). Staff must upload first.
  //   • isSickNeedsVerify  — sick row WITH cert but not yet verified.
  //                          Approve button shows 'Verify & approve';
  //                          clicking it opens the verify confirm panel.
  //                          On successful verification, the patch
  //                          chains directly into approve() so it's
  //                          a single click for Bashaier.
  const isSickWithoutCert  = isSick && !request.sehhaty_code && !request.sick_cert_exempt;
  const isSickNeedsVerify  = isSick && request.sehhaty_code && !verifiedAt;
  const approvalBlocked    = isSickWithoutCert || isSickNeedsVerify;

  const approveAsCertExempt = useCallback(async () => {
    setStep('approving');
    setError('');
    try {
      const now = new Date().toISOString();
      await directPatch('leave_requests', 'id', request.id, {
        sick_cert_exempt: true,
        // Stamp a note so the audit trail records why this was
        // approved without a cert. Pulled from the verification
        // note field if Bashaier typed something, otherwise a
        // standard placeholder.
        sehhaty_verification_note: (confirmNote && confirmNote.trim())
          || 'Approved as cert-exempt — no Sehhaty cert required for this declaration.',
        stage: 'approved',
        hr_decided_at: now,
        hr_decided_by: me?.auth_user_id || me?.id || null,
      }, { timeoutMs: 15000 });

      try {
        logAction(me, 'leave_request_decide', {
          targetType: 'leave_request',
          targetId: request.id,
          targetLabel: `${employee?.name || request.employee_id} · approved (cert-exempt)`,
          details: { stage: 'approved', action: 'approved', cert_exempt: true },
        });
      } catch { /* audit log is best-effort */ }

      setDraft(buildSickLeaveApprovalEmailDraft({
        request: {
          ...request,
          sick_cert_exempt: true,
          sehhaty_verification_note: (confirmNote && confirmNote.trim()) || 'Approved as cert-exempt',
        },
        employee,
        manager,
        hrApprover: me,
        payBracketLabel: sickBracket?.endBracket?.label,
        badria: empMap?.['H94458'] || null,
        fahad:  empMap?.['H94712'] || null,
      }));
      setStep('done');
    } catch (err) {
      setError(err?.message || String(err));
      setStep('review');
    }
  }, [request, employee, manager, me, sickBracket, empMap, confirmNote]);

  const approve = useCallback(async ({ fromVerify = false, mergedRequest = null } = {}) => {
    setStep('approving');
    setError('');
    try {
      const now = new Date().toISOString();
      // Use directPatch (raw fetch) instead of supabase-js to avoid the wedge
      // pattern where the lazy query builder never executes the network call.
      await directPatch('leave_requests', 'id', request.id, {
        stage: 'approved',
        status: 'approved',  // explicit status sync (the status column is legacy but used by some filters)
        hr_decided_at: now,
        hr_decided_by: me?.auth_user_id || me?.id || null,
      }, { timeoutMs: 15000 });

      try {
        logAction(me, 'leave_request_decide', {
          targetType: 'leave_request',
          targetId: request.id,
          targetLabel: `${employee?.name || request.employee_id} · approved`,
          details: { stage: 'approved', action: 'approved', fromVerify: !!fromVerify },
        });
      } catch { /* audit log is best-effort */ }

      // 2026-05-10 (Nadeem): mark attendance_daily for the approved
      // leave days. Without this, a sick row stays marked 'present'
      // (from a back-at-work attendance upload) or 'absent' (no
      // upload yet) on the monthly grid even though it's an approved
      // leave. Best-effort — failures don't unwind the approval.
      try {
        const attResult = await markLeaveDaysAttendance(request);
        console.info(
          `Attendance updated for leave ${request.id}:`,
          `${attResult.updated} day(s) marked, ${attResult.skipped} weekend(s) skipped, ${attResult.errors} error(s)`,
        );
      } catch (e) {
        console.warn('Attendance update failed (non-fatal):', e?.message || e);
      }

      setDraft(isSick
        ? buildSickLeaveApprovalEmailDraft({
            // When chained from applyVerification, mergedRequest carries
            // the just-written verification data (sehhaty_verified_at +
            // sehhaty_seen_*). Use it directly so the email body shows
            // 'Verified on: <timestamp>' and the full CERTIFICATE DETAILS
            // block. Without this, the React closure for verifiedAt and
            // seen* would still be the pre-OCR values (setTimeout fires
            // before React commits state updates).
            request: mergedRequest || {
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
      // 2026-05-10 (Nadeem): switched to the new leaveApplicationPdf module
      // shipped in c997920. Same A4 form layout but with type-specific
      // enriched sections per leave_type_id (Medical Certificate block for
      // sick, Maternity Details for maternity, Hajj Details for hajj, etc.)
      // and KSA Labor Law citations matched to the leave type. Replaces
      // the older vacationFormPdf which had only the annual-leave layout.
      // Dynamic import keeps the jspdf + qrcode bundle out of the modal's
      // initial chunk.
      const { generateLeaveApplicationPdfBlob } = await import('../lib/leaveApplicationPdf.js');
      // Promote legacy sick-leave fields from the top-level request into
      // type_details so the new MEDICAL CERTIFICATE section is populated
      // even for rows created before type_details was introduced. The
      // expanded set (GS code, date range, specialty, patient cross-
      // check) lets HR verify the cert end-to-end. Nadeem 2026-05-18.
      const td = { ...(request.type_details || {}) };
      if (request.leave_type_id === 'sick') {
        td.cert_ref          = td.cert_ref          || request.sehhaty_cert_id;
        td.cert_code         = td.cert_code         || request.sehhaty_code;
        td.cert_date         = td.cert_date         || request.sehhaty_issued_at || request.sehhaty_issue_date;
        td.facility          = td.facility          || request.sehhaty_facility || request.sehhaty_clinic;
        td.doctor_name       = td.doctor_name       || request.sehhaty_doctor;
        td.specialty         = td.specialty         || request.sehhaty_seen_specialty;
        td.diagnosis         = td.diagnosis         || request.sehhaty_diagnosis;
        td.fit_to_return     = td.fit_to_return     || request.sehhaty_fit_date;
        td.seen_start        = td.seen_start        || request.sehhaty_seen_start;
        td.seen_end          = td.seen_end          || request.sehhaty_seen_end;
        td.seen_days         = td.seen_days         || request.sehhaty_seen_days;
        td.seen_patient_name = td.seen_patient_name || request.sehhaty_seen_name;
        td.seen_patient_id   = td.seen_patient_id   || request.sehhaty_seen_id_number;
        td.verified_at       = td.verified_at       || request.sehhaty_verified_at;
        td.verified_by       = td.verified_by       || request.sehhaty_verified_by;
      }
      const blob = await generateLeaveApplicationPdfBlob({
        request: { ...request, type_details: td },
        employee,
        position: {
          designation: employee?.designation,
          department:  employee?.department,
          location:    employee?.location,
        },
        substitutes: (substitutes || []).map(s => ({
          name:      s?.name,
          psn:       s?.id || s?.psn,
          signature: s?.signature || 'accepted_online',
          date:      s?.accepted_at || s?.date,
        })),
        manager,
        hrName: me?.name,
      });
      const safeName = (employee?.name || request.employee_id).replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
      const typeLabel = (request.leave_type_id || 'Leave').toUpperCase();
      const filename = `${typeLabel}_LEAVE_${safeName}_${request.start_date}.pdf`;
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
                  Two layouts depending on whether a service code is
                  on file:
                    • Has code  → full cross-check + verify flow
                    • No code   → simplified panel asking a single
                                  yes/no question: short illness?
                                  approve as exempt OR reject. */}
              {isSick && !request.sehhaty_code && !verifiedAt && (
                <div className="rounded-xl p-4"
                  style={{
                    background: request.sick_cert_exempt ? '#F0FDF4' : '#FEF2F2',
                    border: '1px solid ' + (request.sick_cert_exempt ? '#86EFAC' : '#FCA5A5'),
                  }}>
                  <div className="flex items-center gap-2 mb-2">
                    <ShieldCheck className="w-4 h-4" style={{ color: request.sick_cert_exempt ? '#047857' : '#B91C1C' }}/>
                    <div className="text-xs tracking-widest" style={{ fontWeight: 700, color: request.sick_cert_exempt ? '#047857' : '#B91C1C' }}>
                      {request.sick_cert_exempt ? 'CERT-EXEMPT (LEGACY)' : 'AWAITING SEHHATY CERT'}
                    </div>
                  </div>
                  {request.sick_cert_exempt ? (
                    <div className="text-[12px]" style={{ color: '#14532D' }}>
                      ✓ This row was marked exempt under the old flow. Approve below to finalise.
                    </div>
                  ) : (
                    <div className="text-[12px]" style={{ color: '#7F1D1D' }}>
                      The staff hasn't uploaded the Sehhaty certificate yet. You'll see this row again
                      in your main approval queue once the cert is in. From here you can <strong>send
                      a reminder</strong> via the Pending Certificates card on the dashboard, or
                      <strong> reject</strong> if the declaration is invalid.
                    </div>
                  )}
                  {sickBracket && (
                    <div className="mt-2 text-[10px]" style={{ color: '#7F1D1D' }}>
                      YTD usage: {sickBracket.startTotal}/120 → {sickBracket.endTotal} after this ({sickBracket.endBracket?.label})
                    </div>
                  )}
                </div>
              )}

              {isSick && (request.sehhaty_code || verifiedAt) && (
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

                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <div className="text-[9px] tracking-wider opacity-70 mb-0.5">SERVICE CODE</div>
                      <div className="font-mono text-sm" style={{ fontWeight: 700 }}>
                        {request.sehhaty_code || <span className="opacity-50 italic">not provided</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] tracking-wider opacity-70 mb-0.5">IQAMA / NATIONAL ID</div>
                      <div className="font-mono text-sm" style={{ fontWeight: 700 }}>
                        {employee?.iqama_id || <span className="opacity-50 italic">not on file</span>}
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
                    <div>
                      <div className="text-[9px] tracking-wider opacity-70 mb-0.5">PERIOD ON FILE</div>
                      <div className="text-sm">
                        {request.days || '—'} day{request.days === 1 ? '' : 's'}
                        {request.start_date && (
                          <span className="opacity-70 ml-1">
                            ({fmtDate(new Date(request.start_date))}
                            {request.end_date && request.end_date !== request.start_date
                              ? ' → ' + fmtDate(new Date(request.end_date))
                              : ''})
                          </span>
                        )}
                      </div>
                    </div>
                    {request.sehhaty_clinic && (
                      <div className="col-span-2">
                        <div className="text-[9px] tracking-wider opacity-70 mb-0.5">CLINIC</div>
                        <div className="text-sm">{request.sehhaty_clinic}</div>
                      </div>
                    )}
                  </div>

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

                  {!verifiedAt && (
                    <>
                      <div className="text-[11px] mb-2 opacity-80">
                        Open Sehhaty, search by either the service code or the Iqama above, then paste a screenshot of the result here. The system will read the screenshot, cross-check against this request, and let you verify and approve in one click.
                      </div>

                      {/* Inline paste / drop zone — accepts a Sehhaty
                          screenshot directly from clipboard (Cmd+V),
                          drag-and-drop, or file picker. OCR runs
                          locally in the browser; the image never
                          leaves the device. */}
                      <div
                        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        onDrop={onDropImage}
                        className="rounded-lg p-3 mb-2"
                        style={{
                          background: '#FFFFFF',
                          border: '1.5px dashed ' + (ocrLastRun ? '#86EFAC' : '#FCD34D'),
                          cursor: 'pointer',
                        }}
                        onClick={() => document.getElementById('hr-ocr-file-input')?.click()}
                        title="Click to choose a file, drop one here, or just press Cmd+V to paste"
                      >
                        <input id="hr-ocr-file-input" type="file" accept="image/*"
                          style={{ display: 'none' }} onChange={onPickImage} />
                        {!ocrThumb && !ocrBusy && (
                          <div className="flex items-center gap-3">
                            <div style={{
                              width: 40, height: 40, borderRadius: 8,
                              background: '#FEF3C7', display: 'flex',
                              alignItems: 'center', justifyContent: 'center',
                              flexShrink: 0,
                            }}>
                              <Mail className="w-5 h-5" style={{ color: '#B45309' }}/>
                            </div>
                            <div className="text-[11px]">
                              <div style={{ fontWeight: 700, color: '#0A0A0A' }}>
                                Paste the Sehhaty screenshot here
                              </div>
                              <div style={{ color: '#1F1B16', opacity: 0.7 }}>
                                Press Cmd+V (or Ctrl+V), drop an image, or click to choose a file.
                              </div>
                            </div>
                          </div>
                        )}
                        {ocrBusy && (
                          <div className="flex items-center gap-3 text-[11px]">
                            <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#B45309' }}/>
                            <span style={{ color: '#0A0A0A' }}>Reading screenshot…</span>
                          </div>
                        )}
                        {ocrThumb && !ocrBusy && (
                          <div className="flex items-start gap-3">
                            <img src={ocrThumb} alt="screenshot preview"
                              style={{
                                width: 80, height: 80, objectFit: 'cover',
                                borderRadius: 6, border: '1px solid var(--border-soft, #E8E5D8)',
                                flexShrink: 0,
                              }}/>
                            <div className="text-[11px] flex-1 min-w-0">
                              {ocrLastRun ? (
                                <>
                                  <div style={{ fontWeight: 700, color: '#0A0A0A' }}>
                                    Extracted: {ocrLastRun.fieldsFound.join(', ') || 'no fields'}
                                  </div>
                                  <div style={{ color: '#1F1B16', opacity: 0.7 }}>
                                    OCR confidence: {Math.round((ocrLastRun.confidence || 0))}%.
                                    {' '}Paste a different image to re-run.
                                  </div>
                                </>
                              ) : (
                                <div style={{ color: '#1F1B16', opacity: 0.7 }}>
                                  Preview only — could not read structured fields.
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      {ocrError && (
                        <div className="text-[10px] mt-1 mb-2 px-2 py-1.5 rounded"
                          style={{ background: '#FEE2E2', color: '#7F1D1D', border: '1px solid #FCA5A5' }}>
                          ⚠ {ocrError}
                        </div>
                      )}

                      {/* Extracted-field summary — only shown after a
                          successful OCR pass. Bashaier can see at a
                          glance what was read and cross-check it
                          against the request before approving. */}
                      {ocrLastRun && ocrLastRun.fieldsFound.length > 0 && (
                        <div className="rounded-lg p-2.5 mb-2 text-[11px]"
                          style={{ background: '#FFFFFF', border: '1px solid var(--border-soft, #E8E5D8)' }}>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                            {seenName && (
                              <div><span className="opacity-60">Name:</span> <strong>{seenName}</strong></div>
                            )}
                            {seenIdNumber && (
                              <div>
                                <span className="opacity-60">Iqama:</span>{' '}
                                <strong className="font-mono">{seenIdNumber}</strong>
                                {employee?.iqama_id && (
                                  seenIdNumber === employee.iqama_id
                                    ? <span style={{ color: '#047857' }}> ✓</span>
                                    : <span style={{ color: '#B91C1C' }}> ✗ mismatch</span>
                                )}
                              </div>
                            )}
                            {seenStart && (
                              <div>
                                <span className="opacity-60">From:</span> <strong>{seenStart}</strong>
                                {request.start_date && (
                                  seenStart === request.start_date
                                    ? <span style={{ color: '#047857' }}> ✓</span>
                                    : <span style={{ color: '#B91C1C' }}> ✗</span>
                                )}
                              </div>
                            )}
                            {seenEnd && (
                              <div>
                                <span className="opacity-60">To:</span> <strong>{seenEnd}</strong>
                                {request.end_date && (
                                  seenEnd === request.end_date
                                    ? <span style={{ color: '#047857' }}> ✓</span>
                                    : <span style={{ color: '#B91C1C' }}> ✗</span>
                                )}
                              </div>
                            )}
                            {seenDays && (
                              <div>
                                <span className="opacity-60">Days:</span> <strong>{seenDays}</strong>
                                {request.days != null && (
                                  Number(seenDays) === Number(request.days)
                                    ? <span style={{ color: '#047857' }}> ✓</span>
                                    : <span style={{ color: '#B91C1C' }}> ✗</span>
                                )}
                              </div>
                            )}
                            {seenDoctor && (
                              <div><span className="opacity-60">Doctor:</span> {seenDoctor}</div>
                            )}
                            {seenSpecialty && (
                              <div><span className="opacity-60">Specialty:</span> {seenSpecialty}</div>
                            )}
                            {seenIssueDate && (
                              <div><span className="opacity-60">Issued:</span> {seenIssueDate}</div>
                            )}
                          </div>
                          {crossCheck.mismatches.length > 0 && (
                            <div className="mt-2 pt-2 border-t text-[10px]" style={{ borderColor: 'var(--border-soft, #E8E5D8)' }}>
                              {crossCheck.mismatches.map((m, i) => (
                                <div key={i} style={{
                                  color: m.severity === 'error' ? '#B91C1C' : '#92400E',
                                }}>
                                  {m.severity === 'error' ? '✗' : '⚠'} {m.message || m.field}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="flex flex-wrap gap-2">
                        <a href={SEHHATY_VERIFY_URL} target="_blank" rel="noopener noreferrer"
                          className="text-[11px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border"
                          style={{ borderColor: '#B45309', background: '#FFFFFF', color: '#B45309', fontWeight: 600 }}>
                          <ExternalLink className="w-3 h-3"/> Open Sehhaty
                        </a>
                        {/* Primary action: only enabled when OCR has
                            populated the seen-* fields AND the
                            cross-check produced no blocking errors.
                            Single click writes the verification +
                            chains into the final approval + email
                            draft (same flow as 'Verify & approve'
                            from the legacy confirm modal). */}
                        <button
                          onClick={() => applyVerification({ chainApprove: true })}
                          disabled={!ocrLastRun || !crossCheck.allOk || verifying}
                          title={
                            !ocrLastRun
                              ? 'Paste the Sehhaty screenshot first'
                              : (!crossCheck.allOk
                                  ? 'Resolve the mismatches above'
                                  : 'Verify the cert and approve this leave')
                          }
                          className="text-[11px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full"
                          style={{
                            background: '#0F4C2A', color: '#FFFFFF',
                            opacity: (!ocrLastRun || !crossCheck.allOk || verifying) ? 0.45 : 1,
                            cursor: (!ocrLastRun || !crossCheck.allOk || verifying) ? 'not-allowed' : 'pointer',
                            fontWeight: 600,
                          }}
                        >
                          {verifying
                            ? <><Loader2 className="w-3 h-3 animate-spin"/> Approving…</>
                            : <><Check className="w-3 h-3"/> Verify & approve from screenshot</>}
                        </button>
                        {/* Fallback: opens the legacy confirm modal
                            so Bashaier can edit fields by hand if the
                            OCR mis-read something. Hidden once OCR
                            has produced clean cross-check, since at
                            that point the primary button does the job. */}
                        {(!ocrLastRun || !crossCheck.allOk) && (
                          <button onClick={openVerifyConfirm}
                            disabled={codeDiag.severity === 'error'}
                            title={codeDiag.severity === 'error' ? codeDiag.messages[0] : 'Open the cross-check form to type values manually'}
                            className="text-[11px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border"
                            style={{
                              borderColor: 'var(--border-soft, #E8E5D8)',
                              background: '#FFFFFF', color: '#1F1B16',
                              opacity: (codeDiag.severity === 'error') ? 0.5 : 1,
                              cursor: (codeDiag.severity === 'error') ? 'not-allowed' : 'pointer',
                            }}>
                            Cross-check manually
                          </button>
                        )}
                      </div>
                      {request.sehhaty_code && codeDiag.severity === 'warn' && (
                        <div className="text-[10px] mt-2 px-2 py-1.5 rounded"
                          style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FCD34D' }}>
                          ⚠ {codeDiag.messages.join(' ')}
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

              <div className="flex items-center justify-between gap-2 pt-2">
                <div className="flex items-center gap-2">
                  {/* Reject — opens the rejection-with-comment modal.
                      Per Nadeem (2026-05-06): Bashaier should be able
                      to reject without leaving this view. The parent
                      panel passes onReject which closes this modal
                      and opens RejectLeaveModal on the same row. */}
                  {onReject && (
                    <button onClick={onReject}
                            className="px-4 py-2 rounded-full text-xs font-semibold border"
                            style={{ borderColor: '#FCA5A5', background: '#FEF2F2', color: '#991B1B' }}>
                      ✗ Reject
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={onClose}
                          className="px-4 py-2 rounded-full text-xs font-semibold border"
                          style={{ borderColor: 'var(--border-soft, #E8E5D8)' }}>
                    {isSickWithoutCert ? 'Close' : 'Cancel'}
                  </button>
                  {!isSickWithoutCert && (
                    <button onClick={() => {
                              // 2026-05-10 (Nadeem): cert-exempt path removed.
                              // For sick rows the new flow requires the cert
                              // before Bashaier sees the row for verification.
                              // She either verifies + approves (cert is in),
                              // approves directly (non-sick), or rejects.
                              if (approvalBlocked) {
                                openVerifyConfirm();
                              } else {
                                approve();
                              }
                            }}
                            className="inline-flex items-center gap-1.5 px-5 py-2 rounded-full text-xs font-semibold"
                            style={{
                              background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)',
                              color: '#fff',
                              cursor: 'pointer',
                            }}>
                      <Check className="w-3.5 h-3.5" />
                      {approvalBlocked
                        ? 'Verify & approve'
                        : 'Approve & continue'}
                    </button>
                  )}
                </div>
              </div>
              {isSickWithoutCert && (
                <div className="text-[10px] text-right" style={{ color: '#B91C1C', fontWeight: 600 }}>
                  Approve becomes available once the staff uploads the Sehhaty certificate.
                </div>
              )}
              {!isSickWithoutCert && approvalBlocked && (
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
              <h3 className="text-lg pr-10" style={{ fontFamily: 'inherit', color: '#0A0A0A', fontWeight: 500 }}>
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
                <button onClick={() => applyVerification({ chainApprove: true })}
                  disabled={verifying || codeDiag.severity === 'error' || !crossCheck.allOk}
                  title={!crossCheck.allOk ? 'Resolve mismatches first' : 'Verifies the cert and finalises the approval in one step.'}
                  className="text-[11px] inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full"
                  style={{
                    background: (codeDiag.severity === 'error' || !crossCheck.allOk) ? '#9CA3AF' : '#0F4C2A',
                    color: '#FFFFFF',
                    fontWeight: 700,
                    cursor: (verifying || codeDiag.severity === 'error' || !crossCheck.allOk) ? 'not-allowed' : 'pointer',
                    opacity: (verifying || codeDiag.severity === 'error' || !crossCheck.allOk) ? 0.7 : 1,
                  }}>
                  {verifying
                    ? <><Loader2 className="w-3 h-3 animate-spin"/> Verifying & approving…</>
                    : <><Check className="w-3 h-3"/> Verify & approve</>}
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
