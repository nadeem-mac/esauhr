// =============================================================================
// PendingSickCertsCard
//
// HR-dashboard panel for Bashaier (HR reviewer) showing every staff member who
// has DECLARED a sick day (Path A in SickLeaveModal) but hasn't yet submitted
// the matching Sehhaty certificate.
//
// WHAT IT TRACKS
//   leave_requests rows in stage='pending_certificate'. These come from
//   declarations made via the front-door "I'm sick today" flow without a
//   cert. They sit in this stage until the staff comes back with their
//   Sehhaty PDF (Path B), at which point the row's stage transitions to
//   'pending_manager' and it leaves this list.
//
// WHY IT EXISTS
//   Without visibility into pending declarations, the HR team has no way to
//   know who owes them a certificate. The system would silently let
//   declarations languish forever, which defeats the whole purpose of the
//   front-door declaration flow (we wanted compliance accountability, not
//   just a different surface for staff to tell us they're sick on).
//
// LAYOUT
//   • Card sits at the TOP of Bashaier's HR dashboard, above sign-in
//     activity and leave requests — design decision per Nadeem's call.
//   • Each row tinted by pressure stage:
//       still_out / in_grace  → no tint, neutral
//       soft_overdue          → amber row tint
//       hard_overdue          → red row tint
//   • Sorted with overdue at the top so urgent items are first thing
//     Bashaier sees.
//
// ROW INTERACTION
//   • Tap a row → opens the existing HrApprovalModal (reuses the detail
//     view we already have, no duplicate UI). Even though the row is in
//     pending_certificate stage and the modal is built for pending_hr,
//     the modal renders read-only field summaries fine for any stage.
//   • Each row has a small "Mark cert exempt" button that opens a
//     categorized-reason modal — Bashaier-only action.
//
// PRESSURE CLASSIFICATION
//   Uses classifyPressure from sickDeclaration.js, which returns:
//     still_out      — staff hasn't come back yet (no end-of-leave signal)
//     in_grace       — returned, within 48h grace period
//     soft_overdue   — returned, 2-5 working days late
//     hard_overdue   — 5+ working days late (commit 5 will auto-mark
//                       this as unauthorized absence)
//     exempt         — cert exempted by HR (won't normally appear here
//                       because exempt rows transition out of pending_
//                       certificate stage when marked, but we keep it
//                       for safety in case of race)
//
//   We fetch the rows but we don't fetch the staff's attendance punches
//   in this card — too expensive at the dashboard level. Without punches,
//   classifyPressure can only know about hard-overdue cases via the
//   end_date of the declaration vs. today. The full punch-driven
//   classification will land in commit 5 when we do attendance
//   integration.
// =============================================================================

import React, { useState, useMemo } from 'react';
import { HeartPulse, ChevronRight, ShieldCheck, Loader2, Inbox, Bell } from 'lucide-react';
import { classifyPressure, PRESSURE_LABELS, formatDeclarationRange } from '../lib/sickDeclaration.js';
import { reminderStatus, reminderKindLabel } from '../lib/sickReminderEmail.js';
import CertExemptModal from './CertExemptModal.jsx';
import SendReminderModal from './SendReminderModal.jsx';

// Sort key: overdue first (hard > soft), then by declaration date desc.
// Returns a numeric sort value; lower = appears earlier (we want
// hard_overdue at top → lowest value).
function pressureSortKey(pressure) {
  switch (pressure) {
    case 'hard_overdue': return 0;
    case 'soft_overdue': return 1;
    case 'in_grace':     return 2;
    case 'still_out':    return 3;
    case 'exempt':       return 4;
    default:             return 5;
  }
}

// Per-pressure row tint. Background colour applied to the whole row
// container so overdue items pop visually without needing to read the
// pill. Border colour matches.
function rowTint(pressure) {
  switch (pressure) {
    case 'hard_overdue': return { background: '#FEF2F2', border: '#FCA5A5' };
    case 'soft_overdue': return { background: '#FFFBEB', border: '#FDE68A' };
    default:             return { background: '#FFFFFF', border: 'var(--border-soft)' };
  }
}

export default function PendingSickCertsCard({
  rows,            // leave_requests rows in 'pending_certificate' stage
  empMap,          // { employee_id: employee_row }
  me,              // current viewer; used as actor for the exempt action
  reminders = [],  // sick_reminders rows for the visible declarations
  onRowOpen,       // (req) => void  — invoked when a row is tapped, opens HrApprovalModal
  onChanged,       // () => void     — invoked after exempt or reminder send
  loading,         // boolean — showing spinner while initial data arrives
}) {
  // Track which row (if any) is the active modal target. At most one
  // modal is open at a time; the two states are independent because the
  // exempt flow takes a different path through the row's trailing-action
  // column than the reminder flow.
  const [exemptingReq,  setExemptingReq]  = useState(null);
  const [remindingReq,  setRemindingReq]  = useState(null);

  // Decorate each row with classifyPressure result + a sort key. Done in
  // useMemo so we don't re-compute on every render (could be 50+ rows).
  // No punches passed — see comment at top of file. classifyPressure
  // gracefully degrades to 'still_out' when punches are absent.
  const decorated = useMemo(() => {
    if (!rows) return [];
    return rows
      .map(r => {
        const pressure = classifyPressure(r, []).pressure;
        return {
          req: r,
          emp: empMap?.[r.employee_id] || null,
          pressure,
          // reminder status — { suggested, alreadySent, lastSentAt, lastSentKind }
          // Drives the "REMINDER DUE" pill (when alreadySent=false and
          // pressure is in_grace / soft_overdue / hard_overdue) and the
          // "Last reminder: X on Y" subtitle on each row.
          reminder: reminderStatus(r, pressure, reminders),
        };
      })
      .sort((a, b) => {
        const keyDiff = pressureSortKey(a.pressure) - pressureSortKey(b.pressure);
        if (keyDiff !== 0) return keyDiff;
        // Tie-break by declared_at desc (most recent first within same pressure).
        const aT = a.req.sick_declared_at || a.req.requested_at || '';
        const bT = b.req.sick_declared_at || b.req.requested_at || '';
        return bT.localeCompare(aT);
      });
  }, [rows, empMap, reminders]);

  // Counts shown in the section header so Bashaier can see at-a-glance
  // how many overdue items there are without scrolling.
  const counts = useMemo(() => {
    const c = { total: decorated.length, hard: 0, soft: 0 };
    for (const d of decorated) {
      if (d.pressure === 'hard_overdue') c.hard++;
      else if (d.pressure === 'soft_overdue') c.soft++;
    }
    return c;
  }, [decorated]);

  // Hide the card entirely when there are no pending certs and we're not
  // loading. No reason to take up space when there's nothing to track.
  // We DO show the card during loading so the dashboard layout doesn't
  // jump as data trickles in.
  if (!loading && counts.total === 0) {
    return null;
  }

  return (
    <section
      className="rounded-xl border"
      style={{
        background: 'var(--paper-soft, #FEFAF3)',
        borderColor: 'var(--border-soft)',
      }}
    >
      {/* Header bar — title + counts + soft caption. The counts pills
          give Bashaier the urgent summary in one glance. */}
      <header
        className="px-4 py-3 border-b flex items-center gap-3 flex-wrap"
        style={{ borderColor: 'var(--border-soft)' }}
      >
        <HeartPulse className="w-4 h-4" style={{ color: '#B91C1C' }} />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] tracking-[0.25em] font-bold" style={{ color: '#0A0A0A' }}>
            PENDING SICK CERTIFICATES · {counts.total}
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.65 }}>
            Staff who declared sick but haven't submitted a Sehhaty certificate yet.
          </div>
        </div>
        {/* Counts row — visible only when there are flagged items, so the
            header stays clean when everything's on track. */}
        {counts.hard > 0 && (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider"
            style={{ background: '#FEE2E2', color: '#991B1B' }}
            title="Overdue 5+ working days — will auto-mark as unauthorized in a future update"
          >
            {counts.hard} HARD-OVERDUE
          </span>
        )}
        {counts.soft > 0 && (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider"
            style={{ background: '#FEF3C7', color: '#92400E' }}
            title="Returned, 2-5 working days late on cert"
          >
            {counts.soft} OVERDUE
          </span>
        )}
      </header>

      {/* Body — list of declaration rows or a loading/empty state. */}
      {loading ? (
        <div className="px-4 py-6 flex items-center gap-2 text-sm" style={{ color: '#0A0A0A', opacity: 0.7 }}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading pending certificates…
        </div>
      ) : decorated.length === 0 ? (
        // This branch is unreachable given the early-return above, but
        // keep it defensive in case parent toggles `loading` without
        // re-rendering rows.
        <div className="px-4 py-6 flex items-center gap-2 text-sm" style={{ color: '#0A0A0A', opacity: 0.7 }}>
          <Inbox className="w-4 h-4" />
          Nothing pending — all certificates received.
        </div>
      ) : (
        <ul className="divide-y" style={{ borderColor: 'var(--border-soft)' }}>
          {decorated.map(({ req, emp, pressure, reminder }) => {
            const tint = rowTint(pressure);
            const pressureMeta = PRESSURE_LABELS[pressure] || PRESSURE_LABELS.still_out;
            const empName = emp?.name || req.employee_id;
            const empPsn  = emp?.psn || '';
            const empDept = emp?.department || '';

            // Decide whether the "REMINDER DUE" pill should show.
            // Surface it only when:
            //   • The row is in a state that warrants reminding
            //     (in_grace / soft_overdue / hard_overdue — NOT
            //     still_out, NOT exempt).
            //   • The auto-suggested reminder kind for this pressure
            //     hasn't been sent yet (alreadySent === false).
            // This prevents the pill from nagging Bashaier about a
            // reminder she's already dispatched, while still flagging
            // when the row has escalated to a new tier (e.g. went from
            // soft_overdue to hard_overdue — final_5d hasn't been sent
            // yet, so the pill comes back).
            const reminderable =
              pressure === 'in_grace' ||
              pressure === 'soft_overdue' ||
              pressure === 'hard_overdue';
            const reminderDue = reminderable && !reminder.alreadySent;

            return (
              <li
                key={req.id}
                className="flex items-stretch hover:opacity-95 transition-opacity"
                style={{ background: tint.background }}
              >
                {/* Row body — clickable, opens HrApprovalModal */}
                <button
                  type="button"
                  onClick={() => onRowOpen?.(req)}
                  className="flex-1 px-4 py-3 text-left flex items-center gap-3 min-w-0"
                >
                  <div className="flex-1 min-w-0">
                    {/* Top line — staff name and identifying info. */}
                    <div className="flex items-baseline gap-2 mb-0.5 flex-wrap">
                      <span className="text-sm" style={{ fontWeight: 600, color: '#0A0A0A' }}>
                        {empName}
                      </span>
                      {empPsn && (
                        <span className="text-[10px] font-mono" style={{ color: '#0A0A0A', opacity: 0.6 }}>
                          {empPsn}
                        </span>
                      )}
                      {empDept && (
                        <span className="text-[10px]" style={{ color: '#0A0A0A', opacity: 0.6 }}>
                          · {empDept}
                        </span>
                      )}
                    </div>
                    {/* Bottom line — declaration range + pressure pill +
                        reminder pill + free-text reason if present. */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.85 }}>
                        Declared: {formatDeclarationRange(req)}
                      </span>
                      <span
                        className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold tracking-wider"
                        style={{ background: pressureMeta.bg, color: pressureMeta.fg }}
                      >
                        {pressureMeta.label}
                      </span>
                      {/* REMINDER DUE — appears next to the pressure
                          pill when the auto-suggested reminder for
                          this row's pressure stage hasn't been sent
                          yet. Tappable visual cue, not the action
                          itself (that's the REMIND button on the right). */}
                      {reminderDue && (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold tracking-wider"
                          style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #F59E0B' }}
                          title={`Auto-suggested reminder: ${reminderKindLabel(reminder.suggested)}`}
                        >
                          <Bell className="w-2.5 h-2.5" />
                          REMINDER DUE
                        </span>
                      )}
                      {req.reason && (
                        <span
                          className="text-[10px] truncate"
                          style={{ color: '#0A0A0A', opacity: 0.65, maxWidth: 320 }}
                          title={req.reason}
                        >
                          {req.reason}
                        </span>
                      )}
                    </div>
                    {/* Last-reminder line — only shown when at least one
                        reminder has been sent for this row. Gives Bashaier
                        a one-glance answer to "have I already nagged this
                        person and if so, with which tier?" */}
                    {reminder.lastSentAt && (
                      <div className="text-[10px] mt-1" style={{ color: '#0A0A0A', opacity: 0.6 }}>
                        Last reminder: {reminderKindLabel(reminder.lastSentKind)} on{' '}
                        {new Date(reminder.lastSentAt).toLocaleDateString('en-GB', {
                          day: '2-digit', month: 'short', year: 'numeric'
                        })}
                      </div>
                    )}
                  </div>
                  <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: '#0A0A0A', opacity: 0.4 }} />
                </button>

                {/* Trailing action column — Bashaier-only actions.
                    Distinct from the main row click area so accidental
                    taps don't trigger them. Hidden for non-HR reviewers.

                    Two actions stacked vertically:
                      REMIND  — opens SendReminderModal pre-filled with
                                the pressure-suggested reminder kind.
                      EXEMPT  — opens CertExemptModal to bypass the cert
                                requirement entirely.

                    Both buttons stop click propagation so the row's
                    underlying onRowOpen doesn't fire. */}
                {!!me?.is_hr_reviewer && (
                  <div className="flex flex-col border-l divide-y"
                       style={{ borderColor: tint.border }}>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setRemindingReq(req); }}
                      className="px-3 py-1.5 flex items-center gap-1 text-[10px] tracking-wider opacity-70 hover:opacity-100"
                      style={{ color: '#0A0A0A', borderColor: tint.border }}
                      title="Send a Sehhaty cert reminder email to this employee"
                    >
                      <Bell className="w-3.5 h-3.5" />
                      REMIND
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setExemptingReq(req); }}
                      className="px-3 py-1.5 flex items-center gap-1 text-[10px] tracking-wider opacity-70 hover:opacity-100"
                      style={{ color: '#0A0A0A', borderColor: tint.border }}
                      title="Mark this declaration as cert-exempt (skip the Sehhaty requirement)"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      EXEMPT
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Mount the exempt modal at the card level so dismissals don't
          accidentally trigger row-tap handlers. */}
      {exemptingReq && (
        <CertExemptModal
          request={exemptingReq}
          employee={empMap?.[exemptingReq.employee_id] || null}
          me={me}
          onClose={() => setExemptingReq(null)}
          onCompleted={() => {
            setExemptingReq(null);
            onChanged?.();
          }}
        />
      )}

      {/* Mount the reminder modal here too. Bashaier picks REMIND on a
          row, the modal opens with the pressure-suggested kind pre-
          selected; on send, sick_reminders gets a row and onChanged
          re-fetches so the row's "Last reminder" subtitle updates. */}
      {remindingReq && (
        <SendReminderModal
          declaration={remindingReq}
          employee={empMap?.[remindingReq.employee_id] || null}
          manager={(() => {
            const emp = empMap?.[remindingReq.employee_id];
            return emp?.manager_id ? (empMap?.[emp.manager_id] || null) : null;
          })()}
          me={me}
          onClose={() => setRemindingReq(null)}
          onSent={() => {
            setRemindingReq(null);
            onChanged?.();
          }}
        />
      )}
    </section>
  );
}
