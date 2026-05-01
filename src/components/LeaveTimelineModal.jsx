import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Check, X, Clock, Users2, UserCheck, Briefcase, Crown } from 'lucide-react';
import { fmtDateShort } from '../lib/leaveLogic.js';

// =============================================================================
// LeaveTimelineModal
//
// Read-only timeline showing the full approval chain for a single leave
// request. Opens when a staff member clicks one of their own leave rows
// (e.g. on the PersonalDashboard recent list). Renders four ordered
// steps:
//   1. Submitted by staff
//   2. Substitutes — per-person accept/decline/pending pills
//   3. Manager review
//   4. HR (SUP) final approval
//
// Each step has a status: complete (green tick), in-progress (amber clock),
// rejected (red cross), or upcoming (neutral). Status is derived from the
// request's stage + decision timestamps so this is a pure read of the
// row — no extra fetches, no side effects.
//
// Portal-mounted to document.body with backdrop click-to-close + body
// scroll lock — same pattern as PermissionTimelineModal.
// =============================================================================

const fmtDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

export default function LeaveTimelineModal({ request, empMap = {}, leaveTypes = [], onClose }) {
  // Body scroll lock while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  if (!request) return null;

  const stage = request.stage || (request.status === 'approved' ? 'approved'
                              : request.status === 'rejected' ? 'rejected_by_manager'
                              : 'pending_manager');
  const ids = request.substitute_ids || [];
  const subDecisions = request.substitute_decisions || {};
  const allAccepted = ids.length > 0 && ids.every(sid => {
    const raw = subDecisions[sid];
    const dec = !raw ? 'pending' : typeof raw === 'string' ? raw : raw.decision;
    return dec === 'accepted';
  });
  const anyDeclined = ids.some(sid => {
    const raw = subDecisions[sid];
    const dec = !raw ? 'pending' : typeof raw === 'string' ? raw : raw.decision;
    return dec === 'declined';
  });

  // Step status — derived from stage + decisions. Each step is one of:
  //   'done'      → green tick (completed)
  //   'now'       → amber clock (currently waiting at this step)
  //   'rejected'  → red cross (this step rejected the request)
  //   'next'      → neutral dot (hasn't reached this step yet)
  //   'na'        → grey (skipped — e.g. no substitutes needed)
  const steps = [
    {
      key: 'submit',
      icon: Briefcase,
      titleEn: 'Submitted',
      detail: `${empMap[request.employee_id]?.name || request.employee_id} · ${fmtDateTime(request.requested_at)}`,
      status: 'done',
    },
    ...(ids.length > 0 ? [{
      key: 'subs',
      icon: Users2,
      titleEn: `Substitutes (${ids.length})`,
      detail: anyDeclined ? 'A substitute declined — request cancelled'
            : allAccepted  ? 'All substitutes confirmed coverage'
            : 'Waiting for substitutes to confirm coverage',
      status: stage === 'pending_substitutes' ? 'now'
            : anyDeclined                      ? 'rejected'
            : allAccepted                       ? 'done'
            : 'next',
      subs: ids.map(sid => {
        const raw = subDecisions[sid];
        const dec = !raw ? 'pending' : typeof raw === 'string' ? raw : raw.decision;
        return { id: sid, name: empMap[sid]?.name || sid, decision: dec };
      }),
    }] : [{
      key: 'subs',
      icon: Users2,
      titleEn: 'Substitutes',
      detail: 'No substitute coverage required',
      status: 'na',
    }]),
    {
      key: 'manager',
      icon: UserCheck,
      titleEn: 'Manager review',
      detail: stage === 'pending_manager'        ? 'Your manager will review this next'
            : stage === 'rejected_by_manager'    ? `Rejected by manager · ${fmtDateTime(request.manager_decided_at)}`
            : request.manager_decided_at         ? `Approved by ${empMap[request.manager_decided_by]?.name || 'manager'} · ${fmtDateTime(request.manager_decided_at)}`
            : 'Manager will review once substitutes confirm',
      status: stage === 'pending_manager'        ? 'now'
            : stage === 'rejected_by_manager'    ? 'rejected'
            : request.manager_decided_at         ? 'done'
            : 'next',
    },
    {
      key: 'hr',
      icon: Crown,
      titleEn: 'HR (SUP) final approval',
      detail: stage === 'approved'           ? `Approved by ${empMap[request.hr_decided_by]?.name || 'HR'} · ${fmtDateTime(request.hr_decided_at)}`
            : stage === 'rejected_by_hr'     ? `Rejected by HR · ${fmtDateTime(request.hr_decided_at)}`
            : stage === 'pending_hr'         ? 'HR will review this next'
            : 'HR reviews after manager approval',
      status: stage === 'approved'           ? 'done'
            : stage === 'rejected_by_hr'     ? 'rejected'
            : stage === 'pending_hr'         ? 'now'
            : 'next',
    },
  ];

  const leaveType = leaveTypes.find(t => t.id === request.leave_type_id);
  const headerSubtitle = `${leaveType?.name || 'Leave'} · ${fmtDateShort(request.start_date)} → ${fmtDateShort(request.end_date)} · ${request.days} day${request.days !== 1 ? 's' : ''}`;

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
        className="w-full max-w-xl rounded-2xl border"
        style={{
          borderColor: 'var(--border-soft)',
          background: '#FFFDF7',
          boxShadow: '0 12px 40px rgba(31,27,22,0.18)',
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div>
            <div className="text-[10px] mb-1" style={{ color: '#1F1B16', letterSpacing: '0.25em', fontWeight: 700 }}>
              APPROVAL PROGRESS
            </div>
            <h2 className="serif text-lg" style={{ fontWeight: 500, color: '#1F1B16' }}>
              {leaveType?.name || 'Leave request'}
            </h2>
            <div className="text-xs mt-1" style={{ color: '#1F1B16', opacity: 0.7 }}>
              {headerSubtitle}
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

        {/* Timeline */}
        <ol className="px-6 py-5 space-y-1">
          {steps.map((s, i) => {
            const StepIcon = s.icon;
            const isLast   = i === steps.length - 1;
            const ringColor = s.status === 'done'     ? '#047857'
                            : s.status === 'now'      ? '#92400E'
                            : s.status === 'rejected' ? '#B91C1C'
                            : s.status === 'na'       ? '#9CA3AF'
                            : '#D1D5DB';
            const fillColor = s.status === 'done'     ? '#ECFDF5'
                            : s.status === 'now'      ? '#FEF3C7'
                            : s.status === 'rejected' ? '#FEE2E2'
                            : '#FFFFFF';
            const textColor = s.status === 'next' || s.status === 'na' ? 'rgba(31,27,22,0.55)' : '#1F1B16';
            return (
              <li key={s.key} className="flex gap-3 pb-4 relative">
                {/* Connecting line */}
                {!isLast && (
                  <div className="absolute left-[15px] top-9 bottom-0 w-px"
                       style={{ background: '#E5E0D5' }} />
                )}
                <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center border-2"
                     style={{ borderColor: ringColor, background: fillColor }}>
                  {s.status === 'done'     ? <Check className="w-4 h-4" style={{ color: '#047857' }} />
                 : s.status === 'rejected' ? <X     className="w-4 h-4" style={{ color: '#B91C1C' }} />
                 : s.status === 'now'      ? <Clock className="w-4 h-4" style={{ color: '#92400E' }} />
                 :                            <StepIcon className="w-3.5 h-3.5" style={{ color: ringColor }} />}
                </div>
                <div className="flex-1 min-w-0 pt-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm" style={{ color: textColor, fontWeight: 600 }}>
                      {s.titleEn}
                    </span>
                    {s.status === 'now' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full"
                            style={{ background: '#FEF3C7', color: '#92400E', fontWeight: 700, letterSpacing: '0.1em' }}>
                        IN PROGRESS
                      </span>
                    )}
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: textColor, opacity: 0.85 }}>
                    {s.detail}
                  </div>
                  {/* Sub-list for substitutes */}
                  {s.subs && s.subs.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {s.subs.map(sub => {
                        const accepted = sub.decision === 'accepted';
                        const declined = sub.decision === 'declined';
                        const bg    = accepted ? '#ECFDF5' : declined ? '#FEE2E2' : '#FEF3C7';
                        const color = accepted ? '#0F4C2A' : declined ? '#B91C1C' : '#92400E';
                        const Icon  = accepted ? Check : declined ? X : Clock;
                        return (
                          <span key={sub.id}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
                            style={{ background: bg, color, fontSize: '11px', fontWeight: 500 }}
                            title={sub.decision.toUpperCase()}>
                            <Icon className="w-2.5 h-2.5" />
                            {sub.name}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {/* Reason footer */}
        {request.reason && (
          <div className="px-6 py-4 border-t text-xs" style={{ borderColor: 'var(--border-soft)', color: '#1F1B16' }}>
            <div style={{ opacity: 0.6, letterSpacing: '0.18em', fontSize: '10px', fontWeight: 700, marginBottom: '4px' }}>
              REASON
            </div>
            {request.reason}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
