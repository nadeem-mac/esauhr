import React from 'react';
import { X, CheckCircle2, Clock, XCircle, AlertTriangle, Sunrise, Sunset } from 'lucide-react';
import { PERMISSION_TYPES } from '../lib/permissionLogic.js';

// =============================================================================
// PermissionTimelineModal
//
// Read-only progress view for a single permission_requests row. Shown when
// the staff taps a row in PermissionStatusCard. Renders the four-stage
// approval workflow with the current state highlighted:
//
//   1. Submitted          (always done — requested_at)
//   2. Manager review     (current if stage='pending_manager';
//                          done if manager_decided_at is set;
//                          stops here if rejected_by_manager)
//   3. HR review          (current if stage='pending_hr';
//                          done if hr_decided_at is set;
//                          stops here if rejected_by_hr)
//   4. Approved           (current if stage='approved'; final)
//
// Rejection terminates the timeline at the stage where it happened. The
// rejection note (if any) shows in red on that stage's card.
// =============================================================================

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtPermissionDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-').map(n => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()];
  return `${dow} ${dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

export default function PermissionTimelineModal({ row, employee, onClose }) {
  if (!row) return null;

  const cfg     = PERMISSION_TYPES[row.type] || PERMISSION_TYPES.late_arrival;
  const TypeIcon = row.type === 'early_leave' ? Sunset : Sunrise;
  const stage   = row.stage || 'pending_manager';

  // Build the four stages with their resolved state
  const stages = buildStages(row, stage);

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 90,
        background: 'rgba(15, 23, 42, 0.55)',
        backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '40px 16px', overflowY: 'auto',
      }}
    >
      <div
        className="w-full max-w-lg rounded-2xl border esau-card"
        style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-start gap-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ background: 'var(--evergreen-50)', border: '1px solid var(--evergreen-200)' }}
            >
              <TypeIcon className="w-5 h-5" style={{ color: 'var(--evergreen-600)' }} />
            </div>
            <div>
              <h2 className="serif text-lg" style={{ fontWeight: 500, color: '#1F1B16' }}>
                {cfg.label} permission
              </h2>
              <div className="text-xs mt-1" style={{ color: '#1F1B16' }}>
                {fmtPermissionDate(row.permission_date)} · {Number(row.hours)} hour{Number(row.hours) === 1 ? '' : 's'}
                {row.exceeds_quota && (
                  <span className="ml-2 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full"
                        style={{ background: '#FFEDD5', color: '#9A3412', fontWeight: 700, letterSpacing: '0.1em' }}>
                    <AlertTriangle className="w-2.5 h-2.5" /> OVER QUOTA
                  </span>
                )}
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

        {/* Reason summary */}
        {row.reason && (
          <div className="px-6 py-3 border-b text-xs" style={{ borderColor: 'var(--border-soft)', color: '#1F1B16' }}>
            <span style={{ fontWeight: 700, letterSpacing: '0.18em', fontSize: '10px' }}>REASON</span>
            <div className="mt-1">{row.reason}</div>
          </div>
        )}

        {/* Timeline */}
        <div className="px-6 py-5">
          <div className="text-[10px] mb-3" style={{ color: '#1F1B16', letterSpacing: '0.25em', fontWeight: 700 }}>
            APPROVAL PROGRESS
          </div>
          <ol className="relative">
            {stages.map((s, idx) => {
              const isLast = idx === stages.length - 1;
              return (
                <li key={s.id} className="relative pl-9 pb-5 last:pb-0">
                  {/* Vertical connector line — drawn from this dot to the
                      next, dimmed if the next stage hasn't happened yet. */}
                  {!isLast && (
                    <span
                      aria-hidden
                      className="absolute left-3 top-6 bottom-0 w-px"
                      style={{ background: stages[idx + 1].state === 'pending' ? 'rgba(31,27,22,0.15)' : '#1F1B16' }}
                    />
                  )}
                  {/* Stage dot */}
                  <span
                    className="absolute left-0 top-0 w-6 h-6 rounded-full flex items-center justify-center"
                    style={{
                      background: s.state === 'done'     ? 'var(--evergreen-600)'
                                : s.state === 'current'  ? '#1D4ED8'
                                : s.state === 'rejected' ? '#B91C1C'
                                                         : 'rgba(31,27,22,0.10)',
                      color: s.state === 'pending' ? '#1F1B16' : '#FFFFFF',
                    }}
                  >
                    {s.state === 'done'     && <CheckCircle2 className="w-3.5 h-3.5" />}
                    {s.state === 'current'  && <Clock        className="w-3.5 h-3.5" />}
                    {s.state === 'rejected' && <XCircle      className="w-3.5 h-3.5" />}
                    {s.state === 'pending'  && <span className="text-[10px] font-bold">{idx + 1}</span>}
                  </span>

                  {/* Stage body */}
                  <div className="text-sm" style={{ color: '#1F1B16', fontWeight: s.state === 'current' ? 600 : 500 }}>
                    {s.label}
                  </div>
                  {s.detail && (
                    <div className="text-[11px] mt-0.5" style={{ color: '#1F1B16' }}>
                      {s.detail}
                    </div>
                  )}
                  {s.timestamp && (
                    <div className="text-[10px] mt-0.5 tabular-nums" style={{ color: '#1F1B16' }}>
                      {fmtDateTime(s.timestamp)}
                    </div>
                  )}
                  {s.note && (
                    <div className="text-[11px] mt-1 px-2 py-1.5 rounded"
                         style={{ background: s.state === 'rejected' ? '#FEE2E2' : 'rgba(31,27,22,0.04)', color: '#1F1B16' }}>
                      <strong>Note:</strong> {s.note}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

// ── Stage builder ──────────────────────────────────────────────────────────

function buildStages(row, stage) {
  // Stage 1 — Submitted (always done if the record exists)
  const submitted = {
    id: 'submitted',
    label: 'Submitted',
    detail: 'You submitted this request',
    timestamp: row.requested_at || row.created_at,
    state: 'done',
  };

  // Stage 2 — Manager review
  let manager;
  if (stage === 'pending_manager') {
    manager = {
      id: 'manager',
      label: 'Pending manager approval',
      detail: 'Awaiting your direct manager',
      state: 'current',
    };
  } else if (stage === 'rejected_by_manager') {
    manager = {
      id: 'manager',
      label: 'Rejected by manager',
      timestamp: row.manager_decided_at,
      note: row.manager_note,
      state: 'rejected',
    };
  } else {
    // pending_hr / approved / rejected_by_hr — manager step is done
    manager = {
      id: 'manager',
      label: 'Approved by manager',
      timestamp: row.manager_decided_at,
      note: row.manager_note,
      state: 'done',
    };
  }

  // Stage 3 — HR review
  let hr;
  if (stage === 'pending_manager' || stage === 'rejected_by_manager') {
    hr = {
      id: 'hr',
      label: 'Pending HR approval',
      detail: 'Will move here once manager approves',
      state: 'pending',
    };
  } else if (stage === 'pending_hr') {
    hr = {
      id: 'hr',
      label: 'Pending HR approval',
      detail: 'Awaiting Bashaier (HR)',
      state: 'current',
    };
  } else if (stage === 'rejected_by_hr') {
    hr = {
      id: 'hr',
      label: 'Rejected by HR',
      timestamp: row.hr_decided_at,
      note: row.hr_note,
      state: 'rejected',
    };
  } else {
    // approved
    hr = {
      id: 'hr',
      label: 'Approved by HR',
      timestamp: row.hr_decided_at,
      note: row.hr_note,
      state: 'done',
    };
  }

  // Stage 4 — Final approval (terminal)
  let final;
  if (stage === 'approved') {
    final = {
      id: 'final',
      label: 'Final approval issued',
      detail: 'Your permission is confirmed.',
      state: 'done',
    };
  } else if (stage === 'rejected_by_manager' || stage === 'rejected_by_hr') {
    final = {
      id: 'final',
      label: 'Application closed',
      detail: 'Rejected — see note above. Speak to your manager / HR if you need to discuss.',
      state: 'rejected',
    };
  } else {
    final = {
      id: 'final',
      label: 'Final approval',
      detail: 'Confirmed once HR approves.',
      state: 'pending',
    };
  }

  return [submitted, manager, hr, final];
}
