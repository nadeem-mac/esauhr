import React, { useState, useCallback } from 'react';
import { X, Check, Loader2, Download, Mail, Calendar, Users, FileText, AlertTriangle } from 'lucide-react';
import { supabase, directPatch } from '../supabaseClient.js';
import { fmtDate } from '../lib/leaveLogic.js';
import { logAction } from '../lib/audit.js';
import { generateVacationFormBlob, buildEmailDraft, downloadBlob } from '../lib/vacationForm.js';

// Shown when an HR-final reviewer (Bashaier / admin) clicks Approve on a
// pending_hr leave request. Wraps the simple approve action with:
//   1. A summary review (employee, dates, substitutes, who already approved)
//   2. Final-approve action that writes stage='approved' to the DB
//   3. Bilingual EN/AR Vacation Form generation + download
//   4. mailto: composer pre-filled with To: requester, CC: manager + HR + CEO + Country Head
export default function HrApprovalModal({ request, employee, manager, substitutes, me, onClose, onApproved }) {
  const [step, setStep]     = useState('review');   // 'review' | 'approving' | 'done'
  const [error, setError]   = useState('');
  const [draft, setDraft]   = useState(null);
  const [formGenerating, setFormGenerating] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

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
                      Annual Leave · {fmtDate(new Date(request.start_date))} → {fmtDate(new Date(request.end_date))}
                      {' · '}{request.days} day{request.days === 1 ? '' : 's'}
                    </div>
                    {request.reason && (
                      <div className="text-xs opacity-80 mt-1 italic">"{request.reason}"</div>
                    )}
                  </div>
                </div>

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
                        className="inline-flex items-center gap-1.5 px-5 py-2 rounded-full text-xs font-semibold"
                        style={{ background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }}>
                  <Check className="w-3.5 h-3.5" /> Approve & continue
                </button>
              </div>
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
