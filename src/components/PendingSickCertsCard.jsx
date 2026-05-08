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
import { HeartPulse, ChevronRight, ShieldCheck, Loader2, Inbox, Bell, AlertTriangle, Send, Mail, FileText } from 'lucide-react';
import { classifyPressure, PRESSURE_LABELS, formatDeclarationRange } from '../lib/sickDeclaration.js';
import { reminderStatus, reminderKindLabel } from '../lib/sickReminderEmail.js';
import { groupViolationsBySource, findStaffNeedingDigest, AUTO_UNMARK_WINDOW_DAYS } from '../lib/sickHardPressure.js';
import { directPatch } from '../supabaseClient.js';
import { logAction } from '../lib/audit.js';
import CertExemptModal from './CertExemptModal.jsx';
import SendReminderModal from './SendReminderModal.jsx';
import UnauthorizedDigestModal from './UnauthorizedDigestModal.jsx';

// Build a cert-request email draft for staff who have a sick leave
// already approved (cert-exempt) but haven't submitted the Sehhaty
// certificate yet. Per Nadeem (2026-05-06): "we want staff to reply
// by email with attachment of the sick leave". Bashaier opens this
// in her email client, the staff replies with the PDF, she uploads
// via the Add Cert button to close the case.
function buildCertRequestEmail({ employee, request }) {
  const empName = employee?.name || 'colleague';
  const startStr = request?.start_date || '';
  const endStr = request?.end_date || '';
  const dateRange = startStr === endStr || !endStr
    ? startStr
    : `${startStr} to ${endStr}`;
  const subject = `Sehhaty certificate required — sick leave on ${dateRange}`;
  const body =
`Dear ${empName},

Your sick leave on ${dateRange} has been approved by your manager and HR (cert-exempt) so the day off is on the books.

To close the case in our HR records, please reply to this email with your Sehhaty certificate attached as a PDF. Once received, your sick leave record will be fully verified.

If a Sehhaty certificate was not issued for this absence, please reply confirming so I can mark the case as closed.

Thank you,
HR — Evergreen Shipping Agency Saudi Co.`;
  const to = encodeURIComponent(employee?.email || '');
  const subj = encodeURIComponent(subject);
  const bod  = encodeURIComponent(body);
  return `mailto:${to}?subject=${subj}&body=${bod}`;
}

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
  violations = [], // attendance_violations rows of type unauthorized_absence
  onRowOpen,       // (req) => void  — invoked when a row is tapped, opens HrApprovalModal
  onChanged,       // () => void     — invoked after exempt or reminder send
  loading,         // boolean — showing spinner while initial data arrives
}) {
  // Modal targets — at most one modal open at a time.
  const [exemptingReq,  setExemptingReq]  = useState(null);
  const [remindingReq,  setRemindingReq]  = useState(null);
  // Filter pill state. Lets Bashaier quickly cut the list by pressure
  // tier so she can focus on the urgent items without scrolling.
  // 'all' is the default; the other tiers map directly to the
  // pressure values produced by classifyPressure().
  //   in_grace      → returned within 48h grace window
  //   soft_overdue  → 2-5 working days late
  //   hard_overdue  → 5+ working days late
  // 'still_out' (staff hasn't returned yet) is included in 'all'
  // and handled implicitly — there's nothing to filter on yet, so
  // a dedicated pill would just duplicate the All view.
  const [filter, setFilter] = useState('all');
  // Add-cert form — opens when Bashaier clicks ADD CERT on a
  // post-approval row (stage='approved' && sick_cert_exempt=true).
  // She types the service code from the email reply / cert PDF and
  // we patch the row, marking the case closed.
  const [addingCertReq, setAddingCertReq] = useState(null);
  // Digest modal — true when the "Send weekly digest" CTA is clicked.
  // The modal lists every staff with active unauthorized_absence rows
  // that haven't been notified yet (email_sent_at IS NULL).
  const [digestOpen,    setDigestOpen]    = useState(false);

  // Group violations by the declaration that produced them, so each
  // row in the card knows whether it's been auto-marked and how many
  // days. groupViolationsBySource only counts ACTIVE violations
  // (auto_unmarked_at IS NULL); un-marked rows fall out automatically.
  const violationsByDecl = useMemo(
    () => groupViolationsBySource(violations),
    [violations],
  );

  // Staff who need a digest email — at least one active unauthorized
  // violation with no email_sent_at. Drives the top-of-card CTA.
  const digestTargets = useMemo(
    () => findStaffNeedingDigest(violations),
    [violations],
  );

  // Decorate each row with classifyPressure result + a sort key. Done in
  // useMemo so we don't re-compute on every render (could be 50+ rows).
  // No punches passed — see comment at top of file. classifyPressure
  // gracefully degrades to 'still_out' when punches are absent.
  const decorated = useMemo(() => {
    if (!rows) return [];
    return rows
      .map(r => {
        const pressure = classifyPressure(r, []).pressure;
        // Count of active unauthorized_absence violations linked to
        // this declaration. Drives the "MARKED UNAUTHORIZED · N days"
        // badge alongside the pressure / reminder pills.
        const markedViolations = violationsByDecl.get(r.id) || [];
        return {
          req: r,
          emp: empMap?.[r.employee_id] || null,
          pressure,
          // reminder status — { suggested, alreadySent, lastSentAt, lastSentKind }
          // Drives the "REMINDER DUE" pill (when alreadySent=false and
          // pressure is in_grace / soft_overdue / hard_overdue) and the
          // "Last reminder: X on Y" subtitle on each row.
          reminder: reminderStatus(r, pressure, reminders),
          markedDays: markedViolations.length,
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
  }, [rows, empMap, reminders, violationsByDecl]);

  // Counts shown in the section header so Bashaier can see at-a-glance
  // how many overdue items there are without scrolling.
  const counts = useMemo(() => {
    const c = { total: decorated.length, hard: 0, soft: 0, grace: 0, stillOut: 0 };
    for (const d of decorated) {
      if (d.pressure === 'hard_overdue') c.hard++;
      else if (d.pressure === 'soft_overdue') c.soft++;
      else if (d.pressure === 'in_grace') c.grace++;
      else if (d.pressure === 'still_out') c.stillOut++;
    }
    return c;
  }, [decorated]);

  // Apply the filter pill selection to produce the visible rows.
  // 'all' (default) keeps everything, the others narrow to a single
  // pressure tier. Auto-falls-through to the empty-state if the
  // filter excludes everything (e.g. Bashaier picked Hard-overdue
  // and there are none — she sees the empty state, not a stale list).
  const displayedRows = useMemo(() => {
    if (filter === 'all') return decorated;
    return decorated.filter(d => d.pressure === filter);
  }, [decorated, filter]);

  // Hide the card entirely when there are no pending certs AND no
  // unsent digest targets. The latter matters because a staff who
  // submitted their cert (declaration moved out of pending_certificate)
  // could still have unsent unauthorized notifications waiting — we
  // want Bashaier to be able to send those even after the row leaves
  // the pending list.
  // We DO show the card during loading so the dashboard layout doesn't
  // jump as data trickles in.
  if (!loading && counts.total === 0 && digestTargets.length === 0) {
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

      {/* Weekly digest CTA — visible only when there are staff with
          active unauthorized_absence violations that haven't been
          notified yet. Tapping it opens UnauthorizedDigestModal which
          lists each affected staff, lets Bashaier review and send
          their personalized notification email, and stamps email_sent_at
          on the violations once dispatched.

          We surface it as a banner inside the card (rather than a
          separate top-level card) so the digest queue stays anchored
          to the certificate-tracker context — they're the same
          workflow at different escalation tiers. */}
      {digestTargets.length > 0 && !loading && (
        <div
          className="mx-4 mt-3 mb-1 rounded-xl px-4 py-3 border flex items-start gap-3"
          style={{ background: '#FEF2F2', borderColor: '#FCA5A5' }}
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: '#991B1B' }} />
          <div className="flex-1 text-[12px]" style={{ color: '#0A0A0A' }}>
            <div className="font-semibold mb-0.5">
              {digestTargets.length === 1
                ? '1 staff member needs an unauthorized-absence notification'
                : `${digestTargets.length} staff members need unauthorized-absence notifications`}
            </div>
            <div style={{ opacity: 0.85 }}>
              The system auto-marked their declared sick days as unauthorized after the cert went 5+ working days overdue. Review and send the digest emails before the {AUTO_UNMARK_WINDOW_DAYS}-day auto-undo window expires.
            </div>
          </div>
          {!!me?.is_hr_reviewer && (
            <button
              type="button"
              onClick={() => setDigestOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold tracking-wider hover:opacity-90"
              style={{ background: '#991B1B', color: '#FFFFFF' }}
            >
              <Send className="w-3 h-3" />
              REVIEW &amp; SEND
            </button>
          )}
        </div>
      )}

      {/* Filter pills — Bashaier can narrow the visible rows to a
          single pressure tier (e.g. only Hard-overdue) when she's
          working through the queue. Counts on each pill let her see
          at a glance how many items each tier has without scrolling.
          Hidden during loading and when the list is empty (no point
          showing pills for an empty list). */}
      {!loading && counts.total > 0 && (
        <div
          className="px-4 py-2.5 border-b flex items-center gap-1.5 flex-wrap"
          style={{ borderColor: 'var(--border-soft)' }}
        >
          <FilterPill active={filter === 'all'}              onClick={() => setFilter('all')}>
            All · {counts.total}
          </FilterPill>
          {counts.stillOut > 0 && (
            <FilterPill active={filter === 'still_out'}     onClick={() => setFilter('still_out')} dotColor="#9CA3AF">
              Still out · {counts.stillOut}
            </FilterPill>
          )}
          {counts.grace > 0 && (
            <FilterPill active={filter === 'in_grace'}      onClick={() => setFilter('in_grace')} dotColor="#10B981">
              In grace · {counts.grace}
            </FilterPill>
          )}
          {counts.soft > 0 && (
            <FilterPill active={filter === 'soft_overdue'}  onClick={() => setFilter('soft_overdue')} dotColor="#F59E0B">
              Overdue · {counts.soft}
            </FilterPill>
          )}
          {counts.hard > 0 && (
            <FilterPill active={filter === 'hard_overdue'}  onClick={() => setFilter('hard_overdue')} dotColor="#DC2626">
              Hard-overdue · {counts.hard}
            </FilterPill>
          )}
        </div>
      )}

      {/* Body — list of declaration rows or a loading/empty state. */}
      {loading ? (
        <div className="px-4 py-6 flex items-center gap-2 text-sm" style={{ color: '#0A0A0A', opacity: 0.7 }}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading pending certificates…
        </div>
      ) : displayedRows.length === 0 ? (
        // No rows match the current filter. If the underlying data is
        // empty AND there are digest targets, defer to the banner above
        // (no extra "nothing pending" message). Otherwise show a
        // contextual empty state — different copy when filtering vs
        // when truly empty so Bashaier knows whether to clear the
        // filter or whether the queue is genuinely clean.
        decorated.length === 0 && digestTargets.length > 0 ? null : (
          <div className="px-4 py-6 flex items-center gap-2 text-sm" style={{ color: '#0A0A0A', opacity: 0.7 }}>
            <Inbox className="w-4 h-4" />
            {decorated.length === 0
              ? 'Nothing pending — all certificates received.'
              : 'No items match this filter.'}
            {decorated.length > 0 && filter !== 'all' && (
              <button
                type="button"
                onClick={() => setFilter('all')}
                className="ml-2 underline"
                style={{ background: 'none', border: 'none', color: '#0A0A0A', opacity: 0.7, cursor: 'pointer' }}
              >
                Show all
              </button>
            )}
          </div>
        )
      ) : (
        <ul className="divide-y" style={{ borderColor: 'var(--border-soft)' }}>
          {displayedRows.map(({ req, emp, pressure, reminder, markedDays }) => {
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
                      {/* POST-APPROVAL — surfaces when manager AND HR
                          have already approved this row as cert-exempt.
                          The day off is on the books; the only thing
                          outstanding is the Sehhaty cert from the staff.
                          Higher visual priority than pressure pill since
                          this means "case is open, not yet closed". */}
                      {req.stage === 'approved' && req.sick_cert_exempt && (
                        <span
                          className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold tracking-wider"
                          style={{ background: '#DBEAFE', color: '#1E3A8A', border: '1px solid #93C5FD' }}
                          title="Manager + HR approved cert-exempt; staff still owes the Sehhaty cert"
                        >
                          POST-APPROVAL · CERT DUE
                        </span>
                      )}
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
                      {/* MARKED UNAUTHORIZED — surfaces when the sweep
                          has produced active unauthorized_absence
                          violations linked to this declaration. The
                          number is the count of active (not yet
                          un-marked) days. Tooltip mentions the 14-day
                          auto-undo window so Bashaier knows the row
                          is reversible by the staff submitting the
                          cert. */}
                      {markedDays > 0 && (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold tracking-wider"
                          style={{ background: '#7F1D1D', color: '#FFFFFF' }}
                          title={`Auto-marked as unauthorized absence. Auto-undoes if cert submitted within ${AUTO_UNMARK_WINDOW_DAYS} days.`}
                        >
                          <AlertTriangle className="w-2.5 h-2.5" />
                          MARKED UNAUTHORIZED · {markedDays} day{markedDays === 1 ? '' : 's'}
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
                    {req.stage === 'approved' && req.sick_cert_exempt ? (
                      // POST-APPROVAL row — manager and HR have already
                      // approved the day off (cert-exempt). The case
                      // stays open until staff returns with the cert.
                      // Two actions:
                      //   EMAIL    — opens mailto draft asking staff to
                      //              reply with cert PDF attached
                      //   ADD CERT — opens inline form for Bashaier to
                      //              type the service code (from email
                      //              reply or from staff's portal upload)
                      // The exempt button is hidden — already exempted.
                      // Reminder button is replaced by EMAIL for clarity.
                      <>
                        <a
                          href={buildCertRequestEmail({ employee: emp, request: req })}
                          onClick={(e) => e.stopPropagation()}
                          className="px-3 py-1.5 flex items-center gap-1 text-[10px] tracking-wider opacity-70 hover:opacity-100"
                          style={{ color: '#0A0A0A', borderColor: tint.border, textDecoration: 'none' }}
                          title="Compose an email asking the staff to reply with their Sehhaty cert PDF"
                        >
                          <Mail className="w-3.5 h-3.5" />
                          EMAIL
                        </a>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setAddingCertReq(req); }}
                          className="px-3 py-1.5 flex items-center gap-1 text-[10px] tracking-wider opacity-70 hover:opacity-100"
                          style={{ color: '#0A0A0A', borderColor: tint.border }}
                          title="Add the Sehhaty service code to close this case"
                        >
                          <FileText className="w-3.5 h-3.5" />
                          ADD CERT
                        </button>
                      </>
                    ) : (
                      // PRE-APPROVAL row — sick declaration without cert
                      // still in active review. REMIND + EXEMPT as before.
                      <>
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
                      </>
                    )}
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

      {/* Weekly digest modal — opens from the top-of-card "REVIEW &
          SEND" CTA when there are staff with unsent unauthorized-absence
          notifications. Iterates through the affected staff, lets
          Bashaier review each personalized email, opens mailto for the
          selected one, and stamps email_sent_at on the underlying
          violations once dispatched. */}
      {digestOpen && (
        <UnauthorizedDigestModal
          targets={digestTargets}
          empMap={empMap}
          violations={violations}
          rows={rows}
          me={me}
          onClose={() => setDigestOpen(false)}
          onSent={() => {
            onChanged?.();
          }}
        />
      )}

      {/* Add-cert form — Bashaier types the Sehhaty service code from
          the staff's email reply (or from a manual lookup) and we
          patch the row to mark the case closed. */}
      {addingCertReq && (
        <AddCertModal
          request={addingCertReq}
          employee={empMap?.[addingCertReq.employee_id] || null}
          me={me}
          onClose={() => setAddingCertReq(null)}
          onSaved={() => {
            setAddingCertReq(null);
            onChanged?.();
          }}
        />
      )}
    </section>
  );
}

// ─── AddCertModal ────────────────────────────────────────────────────────
// Inline form for Bashaier to record the Sehhaty cert details from
// staff's email reply. Patches the existing approved row — no new row
// is created. Once saved:
//   • sehhaty_code populated → row drops out of the cert-tracking query
//   • sick_cert_exempt → false (cert is now actually verified, not exempt)
//   • sehhaty_verified_at + sehhaty_verified_by stamped
// Per Nadeem (2026-05-06): "once bashaier sees that and verifies the
// case must be closed".
function AddCertModal({ request, employee, me, onClose, onSaved }) {
  const [code, setCode] = useState('');
  const [issueDate, setIssueDate] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const canSubmit = code.trim().length >= 3 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const now = new Date().toISOString();
      const patch = {
        sehhaty_code: code.trim(),
        sehhaty_issue_date: issueDate || null,
        sehhaty_verified_at: now,
        sehhaty_verified_by: me?.id || null,
        sehhaty_verification_note: note.trim() || 'Cert received via email reply and verified.',
        // Cert is now provided + verified — clear the exempt flag so
        // the row's status reflects "fully approved with cert" rather
        // than "cert-exempt".
        sick_cert_exempt: false,
      };
      await directPatch('leave_requests', 'id', request.id, patch, { timeoutMs: 12000 });
      try {
        logAction(me, 'sick_cert_added_post_approval', {
          targetType: 'leave_request',
          targetId: request.id,
          targetLabel: `${employee?.name || request.employee_id} · sick · ${request.start_date}`,
          details: { sehhaty_code: code.trim(), via: 'manual_entry' },
        });
      } catch { /* audit best-effort */ }
      onSaved?.();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4"
         style={{ background: 'rgba(15,31,26,0.55)' }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-paper rounded-t-2xl sm:rounded-2xl w-full max-w-md fade-in"
        style={{ boxShadow: '0 12px 40px rgba(31,27,22,0.2)' }}>
        <div className="px-5 py-4 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="text-[10px] tracking-[0.25em] font-bold mb-1" style={{ color: '#0F4C2A' }}>
            ADD SEHHATY CERTIFICATE
          </div>
          <h3 className="text-lg" style={{ fontFamily: 'inherit', color: '#0A0A0A', fontWeight: 500 }}>
            Close the case
          </h3>
          <div className="text-[11px] mt-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>
            {employee?.name} ({request.employee_id}) · sick · {request.start_date}
            {request.end_date && request.end_date !== request.start_date && ` → ${request.end_date}`}
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="text-[10px] tracking-wider font-bold mb-1 block" style={{ color: '#0A0A0A', opacity: 0.7 }}>
              SEHHATY SERVICE CODE <span style={{ color: '#B91C1C' }}>*</span>
            </label>
            <input value={code} onChange={e => setCode(e.target.value)}
              placeholder="e.g. PHC1234567"
              autoFocus
              className="w-full px-3 py-2 rounded-lg border text-sm bg-transparent focus:outline-none font-mono"
              style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}/>
            <div className="text-[10px] mt-1" style={{ color: '#0A0A0A', opacity: 0.55 }}>
              The reference printed on the Sehhaty PDF. Required.
            </div>
          </div>
          <div>
            <label className="text-[10px] tracking-wider font-bold mb-1 block" style={{ color: '#0A0A0A', opacity: 0.7 }}>
              ISSUE DATE <span className="opacity-60 font-normal">(optional)</span>
            </label>
            <input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border text-sm bg-transparent focus:outline-none"
              style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}/>
          </div>
          <div>
            <label className="text-[10px] tracking-wider font-bold mb-1 block" style={{ color: '#0A0A0A', opacity: 0.7 }}>
              VERIFICATION NOTE <span className="opacity-60 font-normal">(optional)</span>
            </label>
            <textarea value={note} onChange={e => setNote(e.target.value)}
              rows={2}
              placeholder="e.g. Cert received via email on 08 May, matches request"
              className="w-full px-3 py-2 rounded-lg border text-sm bg-transparent focus:outline-none resize-none"
              style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}/>
          </div>
          {error && (
            <div className="text-[11px] px-3 py-2 rounded"
              style={{ background: '#FEE2E2', color: '#991B1B', border: '1px solid #FCA5A5' }}>
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t flex justify-end gap-2"
          style={{ borderColor: 'var(--border-soft)' }}>
          <button onClick={onClose}
            disabled={submitting}
            className="text-[11px] px-3 py-1.5 rounded-full border"
            style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', color: '#0A0A0A', fontWeight: 600 }}>
            Cancel
          </button>
          <button onClick={submit} disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 text-[11px] px-4 py-1.5 rounded-full"
            style={{
              background: canSubmit ? '#0F4C2A' : '#9CA3AF',
              color: '#FFFFFF',
              fontWeight: 700,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}>
            {submitting ? 'Saving…' : '✓ Save & close case'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Compact filter pill used at the top of the card body. Colored dot
// indicator + label + optional count, matching the existing pill
// aesthetic used elsewhere in the portal (review filters, queue
// filters in HrApprovalModal).
function FilterPill({ active, onClick, children, dotColor }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] transition-colors"
      style={{
        background:    active ? '#1F1B16' : '#FFFFFF',
        color:         active ? '#FFFFFF' : '#1F1B16',
        border:        `1px solid ${active ? '#1F1B16' : 'var(--border-soft)'}`,
        fontWeight:    active ? 600 : 500,
        cursor:        'pointer',
      }}
    >
      {dotColor && (
        <span
          aria-hidden="true"
          style={{
            width: 6, height: 6, borderRadius: '50%',
            background: dotColor, display: 'inline-block',
          }}
        />
      )}
      {children}
    </button>
  );
}
