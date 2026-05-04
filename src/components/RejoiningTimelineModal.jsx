import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Check, X, Clock, ArrowLeftCircle, UserCheck, Crown, Briefcase } from 'lucide-react';
import { fmtDateShort } from '../lib/leaveLogic.js';

// =============================================================================
// RejoiningTimelineModal
//
// Read-only timeline showing the 3-step rejoining approval chain. Mirrors
// LeaveTimelineModal / PermissionTimelineModal exactly so staff get the
// same APPROVAL PROGRESS view they're used to seeing for their leave
// applications. Three steps:
//   1. Submitted by staff
//   2. Manager review
//   3. HR (SUP) final approval
//
// Each step status: complete (green tick), in-progress (amber clock),
// rejected (red cross), upcoming (neutral).
//
// Pure read of the leave_requests row's return_* fields — no fetches.
// =============================================================================

const fmtDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

export default function RejoiningTimelineModal({ request, empMap = {}, onClose }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  if (!request) return null;

  const stage = request.return_stage || null;

  const steps = [
    {
      key: 'submit',
      icon: Briefcase,
      titleEn: 'Submitted by staff',
      detail: request.return_submitted_at
        ? `${empMap[request.employee_id]?.name || request.employee_id} · ${fmtDateTime(request.return_submitted_at)}`
        : `${empMap[request.employee_id]?.name || request.employee_id} · returned ${fmtDateShort(request.actual_return_date)}`,
      status: 'done',
    },
    {
      key: 'manager',
      icon: UserCheck,
      titleEn: 'Manager review',
      detail: stage === 'pending_manager'      ? 'Your manager will review this next'
            : stage === 'rejected_by_manager'  ? `Sent back by manager · ${fmtDateTime(request.return_manager_decided_at)}${request.return_rejection_reason ? ` — "${request.return_rejection_reason}"` : ''}`
            : request.return_manager_decided_at ? `Approved by ${empMap[request.return_manager_decided_by]?.name || 'manager'} · ${fmtDateTime(request.return_manager_decided_at)}`
            : '—',
      status: stage === 'pending_manager'      ? 'now'
            : stage === 'rejected_by_manager'  ? 'rejected'
            : request.return_manager_decided_at ? 'done'
            : 'next',
    },
    {
      key: 'hr',
      icon: Crown,
      titleEn: 'HR (SUP) final approval',
      detail: stage === 'approved'         ? `Approved by ${empMap[request.return_hr_decided_by]?.name || 'HR'} · ${fmtDateTime(request.return_hr_decided_at)}`
            : stage === 'rejected_by_hr'   ? `Sent back by HR · ${fmtDateTime(request.return_hr_decided_at)}${request.return_rejection_reason ? ` — "${request.return_rejection_reason}"` : ''}`
            : stage === 'pending_hr'       ? 'HR will review this next'
            : 'HR reviews after manager approval',
      status: stage === 'approved'         ? 'done'
            : stage === 'rejected_by_hr'   ? 'rejected'
            : stage === 'pending_hr'       ? 'now'
            : 'next',
    },
  ];

  const headerSubtitle = `${(request.leave_type_id || 'leave').toUpperCase()} · ${fmtDateShort(request.start_date)} → ${fmtDateShort(request.end_date)} · returned ${fmtDateShort(request.actual_return_date)}`;

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
          background: '#FFFFFF',
          boxShadow: '0 12px 40px rgba(31,27,22,0.18)',
        }}
      >
        <div className="flex items-start justify-between px-6 py-5 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div>
            <div className="text-[10px] mb-1" style={{ color: '#1F1B16', letterSpacing: '0.25em', fontWeight: 700 }}>
              APPROVAL PROGRESS
            </div>
            <h2 className="serif text-lg flex items-center gap-2" style={{ fontWeight: 500, color: '#1F1B16' }}>
              <ArrowLeftCircle className="w-5 h-5" style={{ color: '#0F4C2A' }} />
              Rejoining request
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

        <ol className="px-6 py-5 space-y-1">
          {steps.map((s, i) => {
            const StepIcon = s.icon;
            const isLast   = i === steps.length - 1;
            const ringColor = s.status === 'done'     ? '#047857'
                            : s.status === 'now'      ? '#92400E'
                            : s.status === 'rejected' ? '#B91C1C'
                            : '#D1D5DB';
            const fillColor = s.status === 'done'     ? '#ECFDF5'
                            : s.status === 'now'      ? '#FEF3C7'
                            : s.status === 'rejected' ? '#FEE2E2'
                            : '#FFFFFF';
            const textColor = s.status === 'next' ? 'rgba(31,27,22,0.55)' : '#1F1B16';
            return (
              <li key={s.key} className="flex gap-3 pb-4 relative">
                {!isLast && (
                  <div className="absolute left-[15px] top-9 bottom-0 w-px"
                       style={{ background: '#E5E5E5' }} />
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
                  </div>
                  {s.detail && (
                    <div className="text-xs mt-0.5" style={{ color: textColor, opacity: 0.85 }}>
                      {s.detail}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>,
    document.body
  );
}
