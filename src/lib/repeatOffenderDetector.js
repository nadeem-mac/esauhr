// =============================================================================
// repeatOffenderDetector.js — Pattern detection over recent violations
//
// The daily attendance flow generates one violation per (employee, date,
// type). When the same staff member shows up 3+ times in 30 days, that's
// no longer a one-off correction — it's a behavioural pattern that needs
// a different conversation (single consolidated email, manager loop-in,
// expectation reset) rather than another individual notice.
//
// This module pulls recent violations and surfaces staff who cross the
// pattern threshold. Returns a sorted list — most frequent first — that
// the UI can render as a "repeat offenders" tile and the email engine
// can use to build a pattern-aware notice.
//
// Design notes:
//   1. We treat rows with email_outcome = 'retracted' or 'superseded' as
//      already-resolved and exclude them from the count. Only outcomes
//      that count against the staff feed the pattern.
//   2. We don't double-count missed_in + missed_out on the same date —
//      they're a single incident from the staff's perspective.
//   3. The 30-day window is calendar-rolling, not month-bounded. A late
//      on day 31 of a previous month + 2 lates this week = not a pattern;
//      3 lates in the last 30 days = pattern, regardless of month.
//   4. Threshold is exposed as a parameter (default 3) so the future
//      "quarter review" report can bump it to e.g. 6 in 90 days.
// =============================================================================

import { directGet } from '../supabaseClient.js';

// Default threshold + window for the daily flow. Quarter / monthly
// reports can pass their own values.
const DEFAULT_THRESHOLD     = 3;
const DEFAULT_WINDOW_DAYS   = 30;

/**
 * Fetch attendance_violations rows from the last N days, excluding any
 * marked retracted or superseded (those have been resolved already and
 * shouldn't count against the staff). Returns the raw rows.
 *
 * Note: email_outcome is from migration_tier3_email_outcome.sql. Rows
 * predating that migration have null in that column — we treat null as
 * "not yet resolved", i.e. count it.
 */
export async function fetchRecentViolations(windowDays = DEFAULT_WINDOW_DAYS) {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const qs = [
    'select=id,employee_id,violation_date,violation_type,minutes_off,recorded_at,email_outcome',
    `recorded_at=gte.${since}`,
    // Exclude resolved outcomes. Null outcomes (pre-migration rows) are
    // included by default — PostgREST's not.in operator passes nulls
    // through the filter unchanged.
    'or=(email_outcome.is.null,and(email_outcome.neq.retracted,email_outcome.neq.superseded))',
    'order=recorded_at.desc',
  ].join('&');
  try {
    const rows = await directGet('attendance_violations', qs, { timeoutMs: 9000 });
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.warn('fetchRecentViolations failed:', e);
    return [];
  }
}

/**
 * Detect repeat offenders from a violations list.
 *
 * @param {Array} violations  rows from fetchRecentViolations
 * @param {Object} opts
 * @param {number} opts.threshold       minimum incident count to flag (default 3)
 * @param {number} opts.windowDays      window for the displayed label (default 30)
 * @returns Array<{
 *     employeeId, totalIncidents, distinctDates, byType,
 *     firstDate, lastDate, dates, severity
 *   }>
 *   sorted by totalIncidents desc, then by lastDate desc.
 *
 * "Incidents" = distinct (employee, date) pairs. A single date that
 * generated both missed_in and missed_out counts as ONE incident.
 *
 * "Severity" buckets:
 *   - 'pattern'   3-4 incidents — first conversation
 *   - 'repeat'    5-6 incidents — manager + HR coordination
 *   - 'critical'  7+ incidents  — formal warning territory
 */
export function detectRepeatOffenders(violations, opts = {}) {
  const threshold  = opts.threshold  ?? DEFAULT_THRESHOLD;
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  if (!Array.isArray(violations) || !violations.length) return [];

  // Group by employee_id, then by date so missed_in + missed_out on
  // the same day collapse to a single incident with both types listed.
  const byEmployee = new Map();
  for (const r of violations) {
    if (!r?.employee_id || !r?.violation_date) continue;
    const empKey = String(r.employee_id).toUpperCase();
    if (!byEmployee.has(empKey)) byEmployee.set(empKey, new Map());
    const datesMap = byEmployee.get(empKey);
    if (!datesMap.has(r.violation_date)) {
      datesMap.set(r.violation_date, {
        date: r.violation_date,
        types: new Set(),
        minutesOff: 0,
      });
    }
    const inc = datesMap.get(r.violation_date);
    inc.types.add(r.violation_type);
    if (typeof r.minutes_off === 'number' && r.minutes_off > inc.minutesOff) {
      inc.minutesOff = r.minutes_off;
    }
  }

  // Build the per-employee summary, keep only those above threshold.
  const out = [];
  for (const [empKey, datesMap] of byEmployee.entries()) {
    const incidents = Array.from(datesMap.values())
      .sort((a, b) => a.date.localeCompare(b.date));
    if (incidents.length < threshold) continue;

    // Per-type counter — useful for the email body and tile detail.
    const byType = { late: 0, early_leave: 0, missed_in: 0, missed_out: 0 };
    for (const inc of incidents) {
      for (const t of inc.types) {
        if (byType[t] !== undefined) byType[t]++;
      }
    }

    // Severity from total distinct-date incidents.
    let severity = 'pattern';
    if (incidents.length >= 7)      severity = 'critical';
    else if (incidents.length >= 5) severity = 'repeat';

    out.push({
      employeeId:     empKey,
      totalIncidents: incidents.length,
      distinctDates:  incidents.length,
      byType,
      firstDate: incidents[0].date,
      lastDate:  incidents[incidents.length - 1].date,
      dates:     incidents,
      severity,
      windowDays,
    });
  }

  // Most frequent first; ties broken by most recent activity.
  out.sort((a, b) => {
    if (b.totalIncidents !== a.totalIncidents) return b.totalIncidents - a.totalIncidents;
    return b.lastDate.localeCompare(a.lastDate);
  });
  return out;
}

/**
 * One-shot helper — fetch + detect in a single call. Handy for the
 * card component which doesn't need the intermediate rows.
 */
export async function loadRepeatOffenders(opts = {}) {
  const rows = await fetchRecentViolations(opts.windowDays);
  return detectRepeatOffenders(rows, opts);
}
