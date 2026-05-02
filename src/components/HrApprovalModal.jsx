import React, { useState, useCallback } from 'react';
import { X, Check, Loader2, Download, Mail, Calendar, Users, FileText, AlertTriangle, ShieldCheck, ExternalLink } from 'lucide-react';
import { supabase, directPatch } from '../supabaseClient.js';
import { fmtDate } from '../lib/leaveLogic.js';
import { logAction } from '../lib/audit.js';
import { generateVacationFormBlob, buildEmailDraft, downloadBlob } from '../lib/vacationForm.js';
import { SEHHATY_VERIFY_URL, classifySickLeaveBracket } from '../lib/sehhaty.js';

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
export default function HrApprovalModal({ request, employee, manager, substitutes, me, allRequests, onClose, onApproved }) {
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

  const verifySehhaty = useCallback(async () => {
    if (verifying) return;
    setVerifying(true);
    setVerifyError('');
    try {
      const now = new Date().toISOString();
      await directPatch('leave_requests', 'id', request.id, {
        sehhaty_verified_at: now,
        sehhaty_verified_by: me?.id || me?.auth_user_id || null,
      }, { timeoutMs: 10000 });
      setVerifiedAt(now);
      try {
        logAction(me, 'sick_leave_verified', {
          targetType: 'leave_request',
          targetId: request.id,
          targetLabel: `${employee?.name || request.employee_id} · sick leave verified on Sehhaty`,
          details: { sehhaty_code: request.sehhaty_code },
        });
      } catch { /* audit best-effort */ }
    } catch (err) {
      setVerifyError(err?.message || String(err));
    } finally {
      setVerifying(false);
    }
  }, [request, me, employee, verifying]);

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
        hr_decided_by: me?.auth_user_id || null,
      }, { timeoutMs: 15000 });

      try {
        logAction(me, 'leave_request_decide', {
          targetType: 'leave_request',
          targetId: request.id,
          targetLabel: `${employee?.name || request.employee_id} · approved`,
          details: { stage: 'approved', action: 'approved' },
        });
      } catch { /* audit log is best-effort */ }

      setDraft(buildEmailDraft({ request, employee, manager, hrApprover: me, substitutes }));
      setStep('done');
    } catch (err) {
      setError(err?.message || String(err));
      setStep('review');
    }
  }, [request, employee, manager, substitutes, me]);

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
                        <button onClick={verifySehhaty}
                          disabled={verifying || !request.sehhaty_code}
                          className="text-[11px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full"
                          style={{
                            background: '#0F4C2A', color: '#FFFFFF',
                            opacity: (verifying || !request.sehhaty_code) ? 0.5 : 1,
                            cursor: (verifying || !request.sehhaty_code) ? 'not-allowed' : 'pointer',
                            fontWeight: 600,
                          }}>
                          {verifying
                            ? <><Loader2 className="w-3 h-3 animate-spin"/> Saving…</>
                            : <><Check className="w-3 h-3"/> I've verified this on Sehhaty</>}
                        </button>
                      </div>
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
                <button onClick={approve}
                        disabled={approvalBlocked}
                        title={approvalBlocked ? 'Verify the certificate on Sehhaty before approving' : ''}
                        className="inline-flex items-center gap-1.5 px-5 py-2 rounded-full text-xs font-semibold"
                        style={{
                          background: approvalBlocked
                            ? '#9CA3AF'
                            : 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)',
                          color: '#fff',
                          cursor: approvalBlocked ? 'not-allowed' : 'pointer',
                          opacity: approvalBlocked ? 0.7 : 1,
                        }}>
                  <Check className="w-3.5 h-3.5" /> Approve & continue
                </button>
              </div>
              {approvalBlocked && (
                <div className="text-[10px] text-right" style={{ color: '#B45309', fontWeight: 600 }}>
                  Verify the certificate on Sehhaty first.
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
                  Leave approved · recorded in vacation history
                </div>
                <div className="text-xs opacity-70 mt-1">
                  {request.days} day{request.days === 1 ? '' : 's'} deducted from annual balance
                </div>
              </div>

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
                <a href={draft?.url || '#'}
                   target="_blank" rel="noreferrer"
                   className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold"
                   style={{ background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }}>
                  <Mail className="w-4 h-4" /> Open email composer
                </a>
              </div>

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
    </div>
  );
}
