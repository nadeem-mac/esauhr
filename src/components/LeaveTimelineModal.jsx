import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Check, X, Clock, Users2, UserCheck, Briefcase, Crown, HeartPulse } from 'lucide-react';
import { fmtDateShort } from '../lib/leaveLogic.js';

// =============================================================================
// LeaveTimelineModal
//
// Read-only timeline showing the full approval chain for a single leave
// request. Opens when a staff member clicks one of their own leave rows
// (e.g. on the PersonalDashboard recent list). Renders ordered steps:
//   1. Submitted by staff
//   2. Substitutes — per-person accept/decline/pending pills
//   3. Manager review
//   4. Sehhaty certificate (SICK LEAVES ONLY — inserted between Manager
//                            and HR steps so the staff sees the cert
//                            obligation as a discrete tracked step)
//   5. HR (SUP) final approval
//
// For non-sick leave types, step 4 is skipped and the timeline reads
// as a 4-step chain. For sick leaves the cert step shows:
//   • next      — manager hasn't approved yet
//   • now       — pending_certificate stage, awaiting staff upload
//   • done      — cert uploaded (sehhaty_code present)
//   • verified  — cert verified by HR on Sehhaty (sehhaty_verified_at)
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

export default function LeaveTimelineModal({ request, empMap = {}, leaveTypes = [], requesterIsHr = false, requesterIsManager = false, onClose }) {
  // Body scroll lock while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  if (!request) return null;

  // The DB constraint allows ten distinct stage values (see
  // migration_leave_stage_pending_certificate.sql). The renderer
  // explicitly handles all of them in the per-step builders below.
  // The legacy `status` fallback covers older rows that pre-date
  // the two-step migration and don't have a `stage` column populated.
  const rawStage = request.stage || (request.status === 'approved' ? 'approved'
                                  : request.status === 'rejected' ? 'rejected_by_manager'
                                  : 'pending_manager');
  // Defensive: if a stage value sneaks in that isn't on the canonical
  // list (data corruption, schema drift, manual DB edit, etc.),
  // treat it as pending_manager so the timeline display stays
  // internally consistent. Console-warn so the issue surfaces in the
  // dev console rather than silently producing a contradictory tile
  // arrangement.
  let stage = rawStage;
  if (!KNOWN_LEAVE_STAGES.has(rawStage)) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[LeaveTimeline] Unknown stage value:', rawStage, '— rendering as pending_manager');
    }
    stage = 'pending_manager';
  }

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
  //
  // Steps are built via per-step helpers (buildSubmitStep, buildSubsStep,
  // buildManagerStep, buildHrStep) defined below this component. Each
  // helper exhaustively handles every canonical stage value, eliminating
  // the cascading-ternary fallbacks that previously caused mismatched
  // tiles on unknown / cancelled stages.
  const steps = [
    buildSubmitStep(request, empMap),
    buildSubsStep(stage, ids, anyDeclined, allAccepted, subDecisions, empMap),
    buildManagerStep(stage, request, empMap),
    // Sehhaty cert step — sick leaves only. Slotted BETWEEN manager
    // and HR steps so the staff sees the cert obligation as its own
    // discrete tracked tile. Drives the "what should I do next" cue
    // when the row is in pending_certificate.
    ...(request.leave_type_id === 'sick'
      ? [buildCertStep(stage, request, empMap)]
      : []),
    buildHrStep(stage, request, empMap),
  ];

  // Adjust timeline for HR/manager self-applications.
  //
  // HR (Bashaier) applying for herself: there's no separate HR step
  // — her manager's approval IS the final decision. Drop the HR
  // tile and relabel the manager tile so the timeline reads
  // truthfully ("Final approval — your manager"). Without this fix,
  // her timeline shows a phantom "Awaiting Bashaier (HR)" step that
  // never resolves because the system rightly skips the HR self-step.
  //
  // Manager (e.g. Fahad) applying for himself: there's no manager
  // step — HR (Bashaier) is the only gate. Drop the manager tile.
  //
  // Auto-detect manager-self from the row when no flag is passed,
  // BUT only when the requester is not HR-EXCLUSIVE. The HR-self
  // collapse must mirror the actual approval-routing rule in
  // decideLeave/decidePerm exactly: it only applies to Bashaier
  // (is_hr_reviewer && !is_admin). Nadeem has is_hr_reviewer=true
  // AND is_admin=true, so his requests flow ALL STAFF → MANAGER →
  // BASHAIER and the timeline must show all 4 steps.
  const requesterEffectivelyHr = !!(
    requesterIsHr ||
    (empMap[request.employee_id]?.is_hr_reviewer && !empMap[request.employee_id]?.is_admin)
  );
  const autoDetectedManagerSelf = !requesterEffectivelyHr && (
    (stage === 'pending_hr' || stage === 'rejected_by_hr' || stage === 'approved')
    && !request.manager_decided_at
  );
  let displaySteps = steps;
  const requesterEffectivelyManager = !!(requesterIsManager || autoDetectedManagerSelf);
  if (requesterEffectivelyHr && !requesterEffectivelyManager) {
    // Keep [submit, subs, manager], drop [hr]. Annotate manager tile.
    displaySteps = steps.slice(0, 3).map((s, idx) => {
      if (idx !== 2 || !s) return s;
      // The manager tile becomes the final tile — extend its detail.
      return {
        ...s,
        title: s.title?.replace(/Manager review/, 'Final approval'),
        body: s.body || (s.state === 'now'
          ? 'Awaiting your direct manager — this is the final step.'
          : null),
      };
    });
  } else if (requesterEffectivelyManager && !requesterEffectivelyHr) {
    // Drop the manager step. HR is the only approval.
    displaySteps = [steps[0], steps[1], steps[3]].filter(Boolean);
  }

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
          background: '#FFFFFF',
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
          {displaySteps.map((s, i) => {
            const StepIcon = s.icon;
            const isLast   = i === displaySteps.length - 1;
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

// ── Stage validation + step builders ────────────────────────────────────────
//
// The leave_requests stage column has TEN canonical values per
// migration_leave_stage_pending_certificate.sql:
//
//   pending_manager          — submitted, awaiting line manager
//   pending_substitutes      — manager hasn't seen it yet because subs
//                              are still confirming coverage
//   pending_hr               — manager approved, awaiting HR (Bashaier)
//   pending_certificate      — sick declaration without a Sehhaty cert
//                              uploaded yet (commits 1-5 of the sick
//                              roadmap added this stage)
//   approved                 — final, HR approved
//   rejected_by_manager      — manager rejected
//   rejected_by_substitute   — a substitute declined → request closed
//   rejected_by_hr           — HR rejected
//   cancelled                — staff cancelled (or was cancelled by HR)
//   expired                  — auto-closed without a final decision
//
// Earlier the modal handled only 6 of these explicitly (pending_manager,
// pending_substitutes, pending_hr, approved, rejected_by_manager,
// rejected_by_hr). Unknown values (the other 4 + any data corruption)
// fell through ternary chains in unpredictable ways — see the
// PermissionTimelineModal commit 740f488 for the same class of bug
// that was observed in production for permissions.
//
// The refactor below makes every canonical value explicit. Each step
// builder is responsible for producing the FULL { detail, status, ... }
// for its tile, switching exhaustively over stage and falling through
// to a safe default for any value that slips past the upstream
// validation in the component.

const KNOWN_LEAVE_STAGES = new Set([
  'pending_manager',
  'pending_substitutes',
  'pending_hr',
  'pending_certificate',
  'approved',
  'rejected_by_manager',
  'rejected_by_substitute',
  'rejected_by_hr',
  'cancelled',
  'expired',
]);

// ── Step 1 — Submitted (always done) ────────────────────────────────────────
function buildSubmitStep(request, empMap) {
  return {
    key: 'submit',
    icon: Briefcase,
    titleEn: 'Submitted',
    detail: `${empMap[request.employee_id]?.name || request.employee_id} · ${fmtDateTime(request.requested_at)}`,
    status: 'done',
  };
}

// ── Step 2 — Substitutes (conditional on whether subs were assigned) ────────
function buildSubsStep(stage, ids, anyDeclined, allAccepted, subDecisions, empMap) {
  // No substitutes assigned — the step is irrelevant. Render as 'na'
  // (greyed out) so the user sees the chain is structurally complete
  // but no waiting on subs is expected.
  if (ids.length === 0) {
    return {
      key: 'subs',
      icon: Users2,
      titleEn: 'Substitutes',
      detail: 'No substitute coverage required',
      status: 'na',
    };
  }

  // Per-sub decision pills are always rendered when subs exist.
  const subs = ids.map(sid => {
    const raw = subDecisions[sid];
    const dec = !raw ? 'pending' : typeof raw === 'string' ? raw : raw.decision;
    return { id: sid, name: empMap[sid]?.name || sid, decision: dec };
  });

  // Determine the parent step's status. The order of checks matters —
  // a 'rejected_by_substitute' stage can coexist with all-accepted
  // decisions if a substitute later changed their mind, but the
  // stage value is the source of truth.
  let status, detail;
  if (stage === 'rejected_by_substitute') {
    status = 'rejected';
    detail = 'A substitute declined — request closed';
  } else if (anyDeclined) {
    // Decision arrived on the row but stage hasn't transitioned yet;
    // still surface the rejection visually.
    status = 'rejected';
    detail = 'A substitute declined — request cancelled';
  } else if (stage === 'pending_substitutes') {
    status = 'now';
    detail = 'Waiting for substitutes to confirm coverage';
  } else if (allAccepted) {
    status = 'done';
    detail = 'All substitutes confirmed coverage';
  } else if (stage === 'cancelled' || stage === 'expired') {
    // Terminal closure before all subs got back. Show as rejected
    // (red X) since the chain is closed without acceptance.
    status = 'rejected';
    detail = stage === 'cancelled'
      ? 'Cancelled before substitutes confirmed'
      : 'Expired before substitutes confirmed';
  } else {
    // Future-looking — covers stages that arrive AFTER subs without
    // having transited through pending_substitutes (e.g. all sub
    // decisions arrived before stage advanced). Treat as done if
    // we have at least one accepted, else as a soft 'next'.
    status = 'next';
    detail = 'Waiting for substitute decisions';
  }

  return {
    key: 'subs',
    icon: Users2,
    titleEn: `Substitutes (${ids.length})`,
    detail,
    status,
    subs,
  };
}

// ── Step 3 — Manager review ─────────────────────────────────────────────────
function buildManagerStep(stage, request, empMap) {
  const approverName = empMap[request.manager_decided_by]?.name || 'manager';
  let status, detail;

  switch (stage) {
    case 'pending_manager':
      status = 'now';
      detail = 'Your manager will review this next';
      break;

    case 'rejected_by_manager':
      status = 'rejected';
      detail = `Rejected by manager · ${fmtDateTime(request.manager_decided_at)}`;
      break;

    case 'pending_hr':
    case 'pending_certificate':
    case 'approved':
    case 'rejected_by_hr':
      // Manager has approved. In the new 2026-05-10 architecture,
      // sick leaves transit through pending_certificate AFTER the
      // manager has approved (manager_decided_at is stamped), so
      // pending_certificate joins the downstream-stages bucket here.
      // If the timestamp is missing for any reason, fall back to a
      // generic "approved" detail without dates.
      status = 'done';
      detail = request.manager_decided_at
        ? `Approved by ${approverName} · ${fmtDateTime(request.manager_decided_at)}`
        : `Approved by ${approverName}`;
      break;

    case 'pending_substitutes':
      status = 'next';
      detail = 'Manager will review once substitutes confirm';
      break;

    case 'rejected_by_substitute':
      status = 'next';
      detail = 'Not reviewed — closed at substitute step';
      break;

    case 'cancelled':
    case 'expired':
      // Terminal — surface any pre-closure decision if one was made,
      // else show as skipped.
      if (request.manager_decided_at) {
        status = 'done';
        detail = `Approved by ${approverName} (before ${stage === 'cancelled' ? 'cancellation' : 'expiry'}) · ${fmtDateTime(request.manager_decided_at)}`;
      } else {
        status = 'rejected';
        detail = stage === 'cancelled'
          ? 'Cancelled before manager review'
          : 'Expired before manager review';
      }
      break;

    default:
      // Unreachable — unknown stages are remapped to pending_manager
      // upstream. Keep an exhaustive default for future-proofing.
      status = 'next';
      detail = 'Manager review pending';
  }

  return {
    key: 'manager',
    icon: UserCheck,
    titleEn: 'Manager review',
    detail,
    status,
  };
}

// ── Step 4 — HR final approval ──────────────────────────────────────────────
// Sehhaty certificate step (sick leaves only). Shows where the cert
// is in its lifecycle:
//   • next      — manager hasn't approved yet (cert obligation isn't
//                  live yet; the staff doesn't need to upload while
//                  the manager is still reviewing)
//   • now       — pending_certificate stage (manager approved, ball
//                  is in the staff member's court to upload)
//   • done      — sehhaty_code present (cert uploaded). Shows the
//                  cert code as the detail.
//   • verified  — sehhaty_verified_at set (HR cross-checked the cert
//                  on Sehhaty). Same icon as 'done' but the detail
//                  notes the verification timestamp.
//   • rejected  — row rejected before cert was supplied. Reads
//                  'No certificate required (rejected)'.
function buildCertStep(stage, request, empMap) {
  const verifierName = empMap[request.sehhaty_verified_by]?.name || 'HR';
  let status, detail;

  // Verified beats everything else — once Bashaier cross-checked the
  // cert, the step is done regardless of what stage came after.
  if (request.sehhaty_verified_at) {
    status = 'done';
    detail = `Cross-checked on Sehhaty by ${verifierName} · ${fmtDateTime(request.sehhaty_verified_at)}`;
    if (request.sehhaty_code) {
      detail += ` · Code ${request.sehhaty_code}`;
    }
  } else if (request.sehhaty_code) {
    // Cert uploaded but HR hasn't verified yet — still 'done' from
    // the staff's perspective (they did their part).
    status = 'done';
    detail = `Certificate uploaded · Code ${request.sehhaty_code} · Awaiting HR verification`;
  } else if (stage === 'pending_certificate') {
    status = 'now';
    detail = 'Upload your Sehhaty certificate to continue';
  } else if (stage === 'rejected_by_manager' || stage === 'rejected_by_substitute') {
    status = 'rejected';
    detail = 'Not required (request was rejected before reaching this step)';
  } else if (stage === 'cancelled' || stage === 'expired') {
    status = 'rejected';
    detail = stage === 'cancelled'
      ? 'Not required (request was cancelled)'
      : 'Not required (request expired)';
  } else if (
    stage === 'pending_manager' ||
    stage === 'pending_substitutes'
  ) {
    status = 'next';
    detail = 'Sehhaty certificate due once manager approves';
  } else {
    // Fallback (approved with no cert — exempt-marked legacy rows,
    // or rejected_by_hr without ever supplying a cert).
    if (request.sick_cert_exempt) {
      status = 'done';
      detail = 'Marked cert-exempt';
    } else if (stage === 'approved') {
      status = 'done';
      detail = 'Approved without certificate (legacy)';
    } else {
      status = 'next';
      detail = 'Sehhaty certificate pending';
    }
  }

  return {
    key: 'cert',
    icon: HeartPulse,
    titleEn: 'Sehhaty certificate',
    detail,
    status,
  };
}

function buildHrStep(stage, request, empMap) {
  const hrName = empMap[request.hr_decided_by]?.name || 'HR';
  let status, detail;

  switch (stage) {
    case 'approved':
      status = 'done';
      detail = request.hr_decided_at
        ? `Approved by ${hrName} · ${fmtDateTime(request.hr_decided_at)}`
        : `Approved by ${hrName}`;
      break;

    case 'rejected_by_hr':
      status = 'rejected';
      detail = `Rejected by HR · ${fmtDateTime(request.hr_decided_at)}`;
      break;

    case 'pending_hr':
      status = 'now';
      // Sick rows reaching pending_hr have just had their cert
      // uploaded — Bashaier's next action is to verify it on Sehhaty.
      // Other leave types use the generic 'reviewing' copy.
      detail = request.leave_type_id === 'sick'
        ? 'HR will verify the Sehhaty certificate next'
        : 'HR will review this next';
      break;

    case 'pending_certificate':
      // 2026-05-10 architecture: pending_certificate means the manager
      // has already approved and the row is waiting on the staff to
      // upload the Sehhaty cert. From HR's perspective this is "next"
      // — they'll act once the cert arrives. Distinct copy from the
      // pre-manager-approval bucket because the action ball is with
      // the staff member, not the manager.
      status = 'next';
      detail = 'HR will verify once the Sehhaty certificate is uploaded';
      break;

    case 'pending_manager':
    case 'pending_substitutes':
    case 'rejected_by_manager':
    case 'rejected_by_substitute':
      // Hasn't reached HR yet (or was closed before reaching it).
      status = 'next';
      detail = 'HR reviews after manager approval';
      break;

    case 'cancelled':
    case 'expired':
      // Terminal — surface any pre-closure decision if one was made.
      if (request.hr_decided_at) {
        status = 'done';
        detail = `Approved by ${hrName} (before ${stage === 'cancelled' ? 'cancellation' : 'expiry'}) · ${fmtDateTime(request.hr_decided_at)}`;
      } else {
        status = 'rejected';
        detail = stage === 'cancelled'
          ? 'Cancelled before HR review'
          : 'Expired before HR review';
      }
      break;

    default:
      // Unreachable per upstream validation.
      status = 'next';
      detail = 'HR review pending';
  }

  return {
    key: 'hr',
    icon: Crown,
    titleEn: 'HR (SUP) final approval',
    detail,
    status,
  };
}
