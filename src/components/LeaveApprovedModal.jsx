import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Download, Mail, X, Loader2, AlertTriangle } from 'lucide-react';
import {
  buildEmailDraft,
  buildSickLeaveApprovalEmailDraft,
} from '../lib/vacationForm.js';
import { generateLeaveApplicationPdfBlob } from '../lib/leaveApplicationPdf.js';

// Helper: trigger a browser download for a Blob. Inlined so this file no
// longer depends on the legacy vacationForm download path.
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// =============================================================================
// LeaveApprovedModal
//
// Re-opens the post-approval action surface for an already-approved leave row
// in MY RECENT DECISIONS. Mirrors PermissionApprovedModal's shape so the
// re-send experience is the same regardless of leave type.
//
// Two actions:
//   1. Download leave form — the leave application PDF (native jsPDF, A4,
//      English-only, QR-verifiable, type-specific section per leave_type_id
//      — sick, maternity, hajj, study, etc.) that staff prints, gets signed
//      by their manager, and drops at the HR office. Replaces the older
//      docx flow per c997920.
//   2. Open email draft — mailto: pre-filled with To = staff,
//      CC = manager + (sick: Badria + Fahad SUP) + execs (CEO, Country Head).
//      Bashaier attaches the downloaded PDF before sending.
//
// Branches by request.leave_type_id:
//   • sick  → buildSickLeaveApprovalEmailDraft (Sehhaty cross-check block,
//             print/sign/stamp instructions, Badria + Fahad in CC)
//   • other → buildEmailDraft (substitute-aware standard approval)
//
// Read-only — submission/decision actions happen elsewhere; this is the
// post-decision artifact handoff. Used for both the immediate post-approval
// flow (when offered) and the later re-send via the history list.
// =============================================================================

export default function LeaveApprovedModal({ request, employee, manager, hrApprover, empMap, substitutes = [], onClose, pdfGenerator }) {
  const [downloading, setDownloading] = useState(false);
  const [downloaded,  setDownloaded]  = useState(false);
  const [error,       setError]       = useState('');

  // Body scroll lock while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  if (!request) return null;

  const isSick = request.leave_type_id === 'sick';

  // Build the appropriate draft for this leave type. The sick draft
  // expects badria/fahad employee records resolved by their fixed
  // PSNs; we look them up from empMap so the CC list lines up with
  // what the initial approval email sent.
  const draft = isSick
    ? buildSickLeaveApprovalEmailDraft({
        employee, request, manager, hrApprover,
        payBracketLabel: null, // not recomputed on re-send; the
                               // line is conditionally rendered
        badria: empMap?.['H94458'] || null,
        fahad:  empMap?.['H94712'] || null,
      })
    : buildEmailDraft({ employee, request, manager, hrApprover, substitutes });

  // CC preview line: count of "extra" recipients beyond manager so
  // Bashaier sees at a glance how many people are being looped in.
  const ccCount = draft.cc ? draft.cc.split(',').filter(Boolean).length : 0;

  async function handleDownload() {
    setDownloading(true);
    setError('');
    try {
      // Map the leave_request + ambient context into the shape the new
      // PDF module expects. type_details holds the per-leave-type fields
      // (medical cert for sick, expected delivery for maternity, etc.)
      // — sourced from request.type_details for forward-looking flows,
      // or falling back to ad-hoc fields the request row may carry
      // (e.g. sehhaty_cert_id, sehhaty_diagnosis for legacy sick rows).
      const td = request.type_details || {};
      // Legacy sick-leave fields stored at the top level of the request
      // get promoted into type_details so the PDF's MEDICAL CERTIFICATE
      // section is populated even for rows created before type_details
      // was added. Now also includes the wider Sehhaty extraction set
      // (GS verification code, date range, specialty, patient cross-
      // check fields) so the PDF can show everything HR pulled from
      // the Sehhaty PDF. Nadeem 2026-05-18.
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
      // Position + employee enriched view so the PDF can render
      // department / location / manager properly.
      // Use the caller-supplied generator if any (Logbook passes the
      // stripped-down generateLogbookPdfBlob), otherwise fall back to
      // the canonical portal generator with QR + full timestamps.
      const generator = pdfGenerator || generateLeaveApplicationPdfBlob;
      const blob = await generator({
        request: { ...request, type_details: td },
        employee,
        position: {
          designation: employee?.designation,
          department:  employee?.department,
          location:    employee?.location,
        },
        substitutes: (substitutes || []).map(s => {
          // Acceptance timestamp comes from request.substitute_decisions[s.id]
          // ({ decision, at: ISO }), not from the employee record.
          // See HrApprovalModal for the matching fix. Nadeem 2026-05-18.
          const raw = request?.substitute_decisions?.[s?.id];
          const decAt = (raw && typeof raw === 'object') ? raw.at : null;
          return {
            name:      s?.name,
            psn:       s?.id || s?.psn,
            signature: s?.signature || 'accepted_online',
            date:      decAt || s?.accepted_at || s?.date,
          };
        }),
        manager,
        hrName: hrApprover?.name,
      });
      const safe = (employee?.name || request.employee_id || 'EMPLOYEE')
        .replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
      const typeLabel = (request.leave_type_id || 'Leave').toUpperCase();
      downloadBlob(blob, `${typeLabel}_LEAVE_${safe}_${request.start_date || 'date'}.pdf`);
      setDownloaded(true);
    } catch (e) {
      setError(e?.message || 'Could not generate the form. Please try again.');
    } finally {
      setDownloading(false);
    }
  }

  function handleOpenEmail() {
    // mailto: opens the user's default mail client with subject,
    // body, To and CC pre-filled. The PDF attachment is added
    // manually after — mailto: cannot carry attachments by spec.
    window.location.href = draft.mailto;
  }

  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
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
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b"
          style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-start gap-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ background: '#ECFDF5', border: '1px solid #A7F3D0' }}
            >
              <CheckCircle2 className="w-5 h-5" style={{ color: '#047857' }} />
            </div>
            <div>
              <h2 className="serif text-lg" style={{ fontWeight: 500, color: '#1F1B16' }}>
                {isSick ? 'Sick leave approved' : 'Leave approved'}
              </h2>
              <div className="text-xs mt-1" style={{ color: '#1F1B16' }}>
                Download the form and send the notification email.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-black/5 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" style={{ color: '#1F1B16' }} />
          </button>
        </div>

        {/* Email recipients preview */}
        <div className="px-6 py-4 border-b text-xs"
          style={{ borderColor: 'var(--border-soft)', color: '#1F1B16' }}>
          <div className="grid grid-cols-[60px_1fr] gap-x-3 gap-y-1.5">
            <span style={{ fontWeight: 700, letterSpacing: '0.18em', fontSize: '10px' }}>TO</span>
            <span>
              {employee?.name}{' '}
              {employee?.email
                ? <em style={{ opacity: 0.7 }}>&lt;{employee.email}&gt;</em>
                : <span style={{ color: '#B91C1C' }}>(no email on file)</span>}
            </span>

            <span style={{ fontWeight: 700, letterSpacing: '0.18em', fontSize: '10px' }}>CC</span>
            <span>
              {ccCount > 0
                ? <>{ccCount} {ccCount === 1 ? 'recipient' : 'recipients'} (manager{isSick ? ', Badria, Fahad' : ''}, executives)</>
                : <span style={{ opacity: 0.6 }}>(none)</span>}
            </span>

            <span style={{ fontWeight: 700, letterSpacing: '0.18em', fontSize: '10px' }}>SUBJECT</span>
            <span>{draft.subject}</span>
          </div>
          {ccCount === 0 && (
            <div className="mt-3 flex items-start gap-2 text-[11px] px-2.5 py-2 rounded"
              style={{ background: '#FEF3C7', color: '#92400E' }}>
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>No CC addresses resolved. Check that the manager and executive recipients have email addresses on file.</span>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="p-5 flex flex-col sm:flex-row gap-2.5">
          <button
            type="button"
            onClick={handleDownload}
            disabled={downloading}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl border text-sm transition-colors disabled:opacity-50"
            style={{
              background: downloaded ? '#ECFDF5' : '#FFFFFF',
              borderColor: downloaded ? '#A7F3D0' : 'var(--border-soft)',
              color: '#1F1B16',
              fontWeight: 500,
            }}
          >
            {downloading
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating…</>
              : downloaded
                ? <><CheckCircle2 className="w-4 h-4" style={{ color: '#047857' }} /> Form downloaded</>
                : <><Download className="w-4 h-4" /> Download form (PDF)</>
            }
          </button>
          <button
            type="button"
            onClick={handleOpenEmail}
            disabled={!employee?.email}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm transition-colors disabled:opacity-50"
            style={{
              background: 'var(--ink)', color: 'var(--paper)',
              fontWeight: 500,
            }}
          >
            <Mail className="w-4 h-4" /> Open email draft
          </button>
        </div>

        {error && (
          <div className="px-5 pb-4 text-xs" style={{ color: '#B91C1C' }}>
            {error}
          </div>
        )}

        {/* Tip */}
        <div className="px-5 pb-5 text-[11px]" style={{ color: '#1F1B16', opacity: 0.7 }}>
          Tip: download the form first, then open the email draft and attach the PDF before sending. Email attachments cannot be pre-filled by the browser.
        </div>
      </div>
    </div>,
    document.body
  );
}
