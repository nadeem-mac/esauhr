// =============================================================================
// sickHardPressure.js
//
// Logic for the hard-pressure escalation step: when a Sehhaty certificate is
// 5+ working days overdue, the system auto-marks the underlying sick days
// as unauthorized absences in attendance_violations. If the staff submits
// the cert within 14 days of the auto-marking, the system auto-undoes the
// marking. After 14 days, HR has to undo manually.
//
// VOCABULARY
//   • markable declaration  — pending_certificate row whose end_date is
//                             5+ working days in the past, no
//                             unauthorized_absence violations yet exist
//                             linked to it.
//   • unmarkable violations — unauthorized_absence rows whose source
//                             declaration is NO LONGER pending_certificate
//                             (cert was submitted, or row was exempted),
//                             AND the row was auto-marked within the
//                             AUTO_UNMARK_WINDOW_DAYS window.
//
// CONSTRAINTS
//   This module is pure. It computes WHAT to mark / unmark; the caller
//   (typically ReviewerPanel.load()) is responsible for actually issuing
//   the directPost / directPatch calls. The split keeps the logic
//   testable and the side effects isolated.
//
// SAFETY
//   The sweep MUST be idempotent. Two HR users opening the dashboard
//   within the same minute should NOT produce duplicate violations.
//   Idempotency is provided by:
//     1. The unique constraint on (employee_id, violation_date,
//        violation_type) in attendance_violations — a duplicate insert
//        returns a constraint violation that the caller can swallow.
//     2. findMarkableDeclarations excludes any declaration that already
//        has unauthorized_absence violations linked via source_request_id.
//   Both gates run; either alone would technically be sufficient.
// =============================================================================

import { workingDaysBetween } from './sickDeclaration.js';

/** Minimum working days a cert must be overdue before auto-marking
 *  fires. Mirrors the conventional "5 working days" threshold used in
 *  KSA HR practice. Reminder commit (4) already escalates language at
 *  this same threshold via the final_5d reminder kind. */
export const HARD_OVERDUE_WORKING_DAYS = 5;

/** How long after auto-marking the staff has to submit the cert and
 *  trigger an auto-undo. After this window, HR has to un-mark the
 *  violations manually (commit 5 part B — UI for that lives in
 *  PendingSickCertsCard and the auto-undo helper still works for the
 *  manual case, just with `auto_unmarked_by` set to the HR PSN). */
export const AUTO_UNMARK_WINDOW_DAYS = 14;

/**
 * Iterate over all dates from start to end (inclusive) and return
 * those that fall on a working day per the project's KSA Sun-Thu
 * convention. The return is an array of YYYY-MM-DD strings.
 *
 * NOTE: this duplicates a small slice of workingDaysBetween's logic
 * but produces the actual day list rather than a count, because we
 * need a violation row per day.
 */
export function workingDaysInRange(startDateStr, endDateStr) {
  if (!startDateStr || !endDateStr) return [];
  const out = [];
  const start = new Date(startDateStr);
  const end = new Date(endDateStr);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return out;
  if (end < start) return out;

  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  const last = new Date(end);
  last.setHours(0, 0, 0, 0);

  while (cur <= last) {
    const dow = cur.getDay(); // 0 = Sun, 5 = Fri, 6 = Sat
    // KSA working week is Sunday through Thursday (dow 0-4).
    if (dow !== 5 && dow !== 6) {
      out.push(cur.toISOString().slice(0, 10));
    }
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/**
 * Find declarations whose cert is 5+ working days overdue AND haven't
 * yet had their sick days auto-marked.
 *
 * @param {Array} declarations  pending_certificate leave_request rows
 * @param {Array} violations    existing attendance_violations rows
 *                              (any type — we filter by source_request_id)
 * @param {Date}  [today]       reference date; defaults to now()
 * @returns {Array} declarations needing marking
 */
export function findMarkableDeclarations(declarations = [], violations = [], today = new Date()) {
  // Set of declaration ids that already have unauthorized_absence
  // violations linked. We exclude these regardless of their
  // auto_unmarked_at status — if a declaration was marked, then
  // un-marked, we don't re-mark it via the sweep. The reasoning:
  // un-marking is either (a) auto-undo because cert was submitted
  // (so the declaration's stage is no longer pending_certificate
  // and our caller already filters those out), or (b) manual undo
  // by HR for a documented reason; in either case the sweep should
  // not silently override the un-mark.
  const alreadyMarked = new Set(
    violations
      .filter(v => v.violation_type === 'unauthorized_absence' && v.source_request_id)
      .map(v => v.source_request_id),
  );

  return declarations.filter(d => {
    if (d.stage !== 'pending_certificate') return false;
    if (d.sick_cert_exempt) return false;
    if (alreadyMarked.has(d.id)) return false;
    if (!d.end_date) return false;

    // Working days between end_date and today. The cert deadline is
    // ~48h after return; the hard-pressure threshold is 5 WORKING
    // days past end_date (which is a strict superset of "5 days past
    // the cert deadline" for any reasonable choice of grace period).
    const overdueWdays = workingDaysBetween(new Date(d.end_date), today);
    return overdueWdays >= HARD_OVERDUE_WORKING_DAYS;
  });
}

/**
 * Build the set of attendance_violations rows to insert when marking
 * a single declaration. Produces one row per working day in
 * [start_date, end_date] inclusive.
 *
 * @param {object} declaration   leave_request row
 * @param {string} [actorPsn]    PSN of the user whose dashboard load
 *                               triggered the sweep. Recorded as
 *                               recorded_by even though the actual
 *                               authoring is the system; we still
 *                               want a traceable "who's session was
 *                               this?" for the audit.
 * @returns {Array<object>} one row per working day
 */
export function buildUnauthorizedRowsForDeclaration(declaration, actorPsn = null) {
  const days = workingDaysInRange(declaration.start_date, declaration.end_date || declaration.start_date);
  const nowIso = new Date().toISOString();
  return days.map(dayIso => ({
    employee_id:        declaration.employee_id,
    violation_date:     dayIso,
    violation_type:     'unauthorized_absence',
    minutes_off:        null,
    punch_in_time:      null,
    punch_out_time:     null,
    scheduled_start:    null,
    scheduled_end:      null,
    recorded_by:        actorPsn || 'system',
    email_sent_at:      null,
    upload_id:          null,
    permission_id:      null,
    source_request_id:  declaration.id,
    auto_marked_at:     nowIso,
    auto_unmarked_at:   null,
    auto_unmarked_by:   null,
  }));
}

/**
 * Find existing unauthorized_absence violations that are eligible for
 * AUTO-undo because:
 *   • Their source declaration is no longer in pending_certificate
 *     stage (i.e., the cert was submitted, the row is exempt, etc.)
 *   • They were auto-marked within AUTO_UNMARK_WINDOW_DAYS
 *   • They aren't already auto-unmarked
 *
 * Manual un-marking by HR follows a different path (HR-driven action
 * in PendingSickCertsCard, not this sweep).
 *
 * @param {Array} allViolations  attendance_violations rows of any type
 * @param {Map<string, object>} declarationsById  map keyed by declaration id
 * @param {Date}  [today]
 * @returns {Array} unauthorized violations to un-mark
 */
export function findAutoUnmarkableViolations(allViolations = [], declarationsById = new Map(), today = new Date()) {
  return allViolations.filter(v => {
    if (v.violation_type !== 'unauthorized_absence') return false;
    if (!v.source_request_id) return false;
    if (v.auto_unmarked_at) return false;
    if (!v.auto_marked_at) return false;

    // 14-day window check.
    const markedAt = new Date(v.auto_marked_at);
    if (Number.isNaN(markedAt.getTime())) return false;
    const daysSinceMark = (today.getTime() - markedAt.getTime()) / (24 * 60 * 60 * 1000);
    if (daysSinceMark > AUTO_UNMARK_WINDOW_DAYS) return false;

    // Source declaration must indicate the cert obligation is settled.
    const decl = declarationsById.get(v.source_request_id);
    if (!decl) return false;
    if (decl.stage === 'pending_certificate' && !decl.sick_cert_exempt) return false;

    return true;
  });
}

/**
 * Group violations by source_request_id for display purposes.
 * PendingSickCertsCard uses this to show "MARKED UNAUTHORIZED · N days"
 * badges, where N is the count of active violations linked to the row.
 */
export function groupViolationsBySource(violations = []) {
  const map = new Map();
  for (const v of violations) {
    if (v.violation_type !== 'unauthorized_absence' || !v.source_request_id) continue;
    if (v.auto_unmarked_at) continue; // un-marked rows don't count
    if (!map.has(v.source_request_id)) map.set(v.source_request_id, []);
    map.get(v.source_request_id).push(v);
  }
  return map;
}

/**
 * Find staff who have AT LEAST ONE active unauthorized_absence
 * violation that hasn't yet had a notification email sent. Used by
 * the weekly digest UI to populate the "to-notify" list.
 *
 * The "notification sent" check is based on the email_sent_at column
 * of attendance_violations, which the existing AttendanceView flow
 * already populates when a manual violation is logged. Auto-marked
 * rows have email_sent_at NULL until the digest button fires.
 *
 * @returns {Array<{ employeeId, count, declarationIds, sampleDay }>}
 */
export function findStaffNeedingDigest(violations = []) {
  const byEmployee = new Map();
  for (const v of violations) {
    if (v.violation_type !== 'unauthorized_absence') continue;
    if (v.auto_unmarked_at) continue;
    if (!v.source_request_id) continue;
    if (v.email_sent_at) continue;
    if (!byEmployee.has(v.employee_id)) {
      byEmployee.set(v.employee_id, {
        employeeId: v.employee_id,
        violations: [],
        declarationIds: new Set(),
      });
    }
    const entry = byEmployee.get(v.employee_id);
    entry.violations.push(v);
    entry.declarationIds.add(v.source_request_id);
  }

  return Array.from(byEmployee.values()).map(e => ({
    employeeId:     e.employeeId,
    count:          e.violations.length,
    declarationIds: Array.from(e.declarationIds),
    violations:     e.violations,
    sampleDay:      e.violations[0]?.violation_date || null,
  }));
}
