// =============================================================================
// evaluationWeights.js
//
// Severity-weighted scoring for attendance_violations rows. Replaces the
// previous flat '-2 points per violation beyond 5' rule with a per-type
// weighting that actually reflects the operational impact of each kind
// of incident.
//
// THE TABLE
//   Type                       | Minutes off | Weight (pts deducted)
//   ---------------------------+-------------+----------------------
//   unauthorized_absence       | n/a         | 5
//   missed_out                 | n/a         | 3
//   late                       | > 30        | 3
//   late                       | 15-30       | 2
//   early / early_leave        | > 30        | 3
//   early / early_leave        | 15-30       | 1
//   missed_in (with later in)  | n/a         | 2
//   other / unknown            | n/a         | 1   (fallback so nothing slips through silently)
//
// THE THRESHOLD
//   The old rule counted occurrences ('totalCount > 5'). The new rule
//   sums weights ('deduction > 10'). 10 points was chosen so the previous
//   threshold (5 minor lates = -2*0 = 0 deduction under old math, but
//   now flagged as soon as the weighted impact reaches the same severity
//   as roughly two-three substantive incidents).
//
//   This means:
//     • One unauthorized absence + one late > 30 = 8 pts (not yet flagged
//       but on watch)
//     • Two unauthorized absences = 10 pts (right at the line)
//     • Three no-punch-outs + one late = 11 pts (flagged immediately)
//     • Five minor lates 15-30 min = 10 pts (also flagged, same severity
//       weight as before but reached more cleanly)
//
// Pure functions only — no React, no DB. Both BashaierTasksCard (HR-side
// escalation panel) and PersonalDashboard (staff-side early-warning tile)
// import from here so the math is identical on both sides.
// =============================================================================

// Tunable constants — exported so they can be referenced in the UI
// ('approaching review threshold at X+ points') and policy docs.
export const REVIEW_THRESHOLD     = 10;  // deduction ≥ this → formal escalation
export const WATCH_LOWER          = 5;   // deduction in [WATCH_LOWER, REVIEW_THRESHOLD - 1] → 'watch'
export const BASE_SCORE           = 100;

// Per-type / per-magnitude weights. Map keys are the canonical
// violation_type strings stored in attendance_violations.violation_type.
// `early` and `early_leave` are both accepted because the recorder
// has used both at various times — same weight for both.
const HEAVY  = 3;
const MEDIUM = 2;
const LIGHT  = 1;

/**
 * Compute the deduction weight for a single violation row.
 *
 * @param {Object} v — an attendance_violations row, at minimum
 *   { violation_type, minutes_off }
 * @returns {number} non-negative integer point deduction (0 if the
 *   row should not contribute — e.g. type unknown AND minutes_off
 *   exactly zero, which can happen for synthetic placeholder rows).
 */
export function weightForViolation(v) {
  if (!v || !v.violation_type) return 0;
  const m = Math.abs(Number(v.minutes_off) || 0);
  switch (v.violation_type) {
    case 'unauthorized_absence':
      return 5;
    case 'missed_out':
      // No punch-out — Sonnie's specific concern. The day's worked
      // time is unverifiable for payroll, hence higher weight than
      // a regular late arrival.
      return HEAVY;
    case 'missed_in':
      // Punched out but no in — usually means staff was already on
      // site (forgot to badge in). Slightly less severe than missed_out
      // because the out-punch at least bounds the workday end.
      return MEDIUM;
    case 'late':
      return m > 30 ? HEAVY : MEDIUM;
    case 'early':
    case 'early_leave':
      // Early-departures get slightly lighter weighting than late
      // arrivals at the same magnitude — leaving 20 min early after
      // a full day in is operationally less disruptive than arriving
      // 20 min late and missing the morning handover.
      return m > 30 ? HEAVY : LIGHT;
    default:
      // Unknown type — record something so the row isn't silently
      // dropped, but don't over-weight an unfamiliar code.
      return LIGHT;
  }
}

/**
 * Roll up an array of violations into the canonical summary used by
 * BashaierTasksCard's escalation list AND PersonalDashboard's tile.
 *
 * @param {Array} violations — attendance_violations rows for ONE employee
 *   in the current calendar month, filtered to cleared_at IS NULL.
 * @returns {{
 *   totalCount, lateCount, earlyCount, missedCount, absenceCount,
 *   deduction, score,
 *   severityBreakdown: { unauthorized, missedOut, missedIn, lateHeavy,
 *                        lateMedium, earlyHeavy, earlyLight, other },
 * }}
 */
export function summariseViolations(violations) {
  let totalCount = 0;
  let lateCount = 0, earlyCount = 0, missedCount = 0, absenceCount = 0;
  let deduction = 0;
  const sev = {
    unauthorized: 0, missedOut: 0, missedIn: 0,
    lateHeavy: 0, lateMedium: 0,
    earlyHeavy: 0, earlyLight: 0,
    other: 0,
  };

  for (const v of (violations || [])) {
    if (!v?.violation_type) continue;
    totalCount += 1;
    const w = weightForViolation(v);
    deduction += w;
    const m = Math.abs(Number(v.minutes_off) || 0);
    switch (v.violation_type) {
      case 'unauthorized_absence':
        absenceCount += 1; sev.unauthorized += 1; break;
      case 'missed_out':
        missedCount += 1; sev.missedOut += 1; break;
      case 'missed_in':
        missedCount += 1; sev.missedIn += 1; break;
      case 'late':
        lateCount += 1;
        if (m > 30) sev.lateHeavy += 1; else sev.lateMedium += 1;
        break;
      case 'early':
      case 'early_leave':
        earlyCount += 1;
        if (m > 30) sev.earlyHeavy += 1; else sev.earlyLight += 1;
        break;
      default:
        sev.other += 1; break;
    }
  }

  return {
    totalCount,
    lateCount, earlyCount, missedCount, absenceCount,
    deduction,
    score: Math.max(0, BASE_SCORE - deduction),
    severityBreakdown: sev,
  };
}

/**
 * Classify the current month's deduction into one of three traffic-light
 * zones used by the staff-facing EVALUATION STATUS tile and the
 * HR-side escalation rule.
 *
 *   'clean'   — deduction < WATCH_LOWER  (everything fine)
 *   'watch'   — WATCH_LOWER ≤ deduction < REVIEW_THRESHOLD
 *               (approaching review; staff still has time to course-correct)
 *   'review'  — deduction ≥ REVIEW_THRESHOLD
 *               (manager + HR will be notified at month-end)
 *
 * @param {number} deduction
 * @returns {'clean'|'watch'|'review'}
 */
export function zoneForDeduction(deduction) {
  if (deduction >= REVIEW_THRESHOLD) return 'review';
  if (deduction >= WATCH_LOWER)      return 'watch';
  return 'clean';
}

/**
 * Human-readable label for each zone — used in tile copy and email bodies.
 */
export const ZONE_LABEL = {
  clean:  'Within expectations',
  watch:  'Approaching review',
  review: 'Review imminent',
};

/**
 * Color tokens for the three zones. Keys match the values returned by
 * zoneForDeduction(). The card and the email pill both use these so
 * the same incident reads consistently across surfaces.
 */
export const ZONE_COLOR = {
  clean:  { fg: '#0F4C2A', bg: '#ECFDF5', border: '#86EFAC' },
  watch:  { fg: '#92400E', bg: '#FEF3C7', border: '#FCD34D' },
  review: { fg: '#7F1D1D', bg: '#FEE2E2', border: '#FCA5A5' },
};
