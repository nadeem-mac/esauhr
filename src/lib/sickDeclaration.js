// =============================================================================
// sickDeclaration.js
//
// Logic helpers for the "I'm sick today" flow and the certificate-tracking
// system that follows it.
//
// Vocabulary:
//   • declaration  — a leave_requests row in stage='pending_certificate'
//                    that was created via the front-door declare-sick UX
//                    (or by Bashaier on behalf of staff).
//   • pressure     — the system's current escalation level for an
//                    unresolved declaration. One of:
//                      'still_out'      — staff hasn't returned yet
//                      'in_grace'       — back at work, within 48h grace
//                      'soft_overdue'   — past 48h, blocks new requests
//                      'hard_overdue'   — past 5 working days,
//                                         days flip to unauthorized absence
//                      'exempt'         — Bashaier marked exempt
//   • return signal — the source of truth for "back at work" date.
//                    Manual override (sick_returned_at) wins; otherwise
//                    fall back to attendance-punch heuristic.
//
// Why this is in its own module:
//   The pressure-state computation is needed in (a) Bashaier's tracker
//   card, (b) the staff dashboard banner, (c) the auto-reminder
//   client-side cron, and (d) the request-submission block check.
//   Centralising it ensures all four surfaces agree on what counts as
//   overdue, which working-days policy applies, and how exemptions work.
// =============================================================================

/**
 * Reason categories Bashaier can pick when marking a sick declaration
 * as cert-exempt. Stored as 'category::free_text_note' in
 * sick_cert_exempt_reason for compactness while keeping structure.
 */
export const CERT_EXEMPT_CATEGORIES = [
  { id: 'minor_single_day', label: 'Single-day minor illness (no clinic visit)' },
  { id: 'hospital_admission', label: 'Hospital admission (cert provided directly to HR)' },
  { id: 'cert_lost_or_abroad', label: 'Cert lost or staff abroad' },
  { id: 'other', label: 'Other (note required)' },
];

/**
 * Reminder kinds — used by sick_reminders.reminder_kind. The
 * client-side cron only fires the auto-* kinds; manual sends use 'manual'.
 */
export const REMINDER_KINDS = {
  GENTLE_24H: 'gentle_24h',
  FIRMER_72H: 'firmer_72h',
  FINAL_5D:   'final_5d',
  MANUAL:     'manual',
};

/**
 * Given a request row + (optionally) the employee's recent attendance
 * punches, compute the current pressure state and the relevant
 * timestamps for display.
 *
 * @param {object} req  leave_requests row in 'pending_certificate' stage
 * @param {Array}  punches  attendance rows for this employee, sorted asc
 * @returns {{
 *   pressure:        'still_out' | 'in_grace' | 'soft_overdue' | 'hard_overdue' | 'exempt',
 *   returnedAt:      Date | null,
 *   hoursSinceReturn: number | null,
 *   workingDaysOverdue: number,
 *   isReturned:      boolean
 * }}
 */
export function classifyPressure(req, punches = []) {
  if (req?.sick_cert_exempt) {
    return {
      pressure: 'exempt',
      returnedAt: req.sick_returned_at ? new Date(req.sick_returned_at) : null,
      hoursSinceReturn: null,
      workingDaysOverdue: 0,
      isReturned: !!req.sick_returned_at,
    };
  }

  const returnedAt = detectReturn(req, punches);
  const isReturned = !!returnedAt;

  if (!isReturned) {
    return { pressure: 'still_out', returnedAt: null, hoursSinceReturn: null, workingDaysOverdue: 0, isReturned: false };
  }

  const now = Date.now();
  const hoursSinceReturn = (now - returnedAt.getTime()) / (1000 * 60 * 60);
  const workingDaysOverdue = workingDaysBetween(returnedAt, new Date());

  let pressure;
  if (hoursSinceReturn < 48)        pressure = 'in_grace';
  else if (workingDaysOverdue < 5)  pressure = 'soft_overdue';
  else                              pressure = 'hard_overdue';

  return { pressure, returnedAt, hoursSinceReturn, workingDaysOverdue, isReturned };
}

/**
 * Determine when the staff returned to work. Manual override wins;
 * otherwise the first attendance punch on or after end_date+1 is
 * used. Returns null if no signal (still out).
 *
 * NOTE: The attendance-punch heuristic assumes punches are filtered to
 * THIS employee already (caller's responsibility to pre-filter for perf).
 */
export function detectReturn(req, punches = []) {
  if (req.sick_returned_at) return new Date(req.sick_returned_at);
  if (!req.end_date) return null;

  // Earliest punch strictly after the last sick day. Punch dates are
  // ISO 'YYYY-MM-DD' strings; lexicographic compare is correct here.
  const sickEnd = req.end_date;
  const firstAfter = punches
    .filter(p => p.date && p.date > sickEnd && (p.first_punch || p.last_punch))
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  if (!firstAfter) return null;

  // Combine date + first_punch time into a Date object. If only
  // last_punch is present (rare), use that as a fallback.
  const t = firstAfter.first_punch || firstAfter.last_punch || '08:00';
  return new Date(`${firstAfter.date}T${t}:00`);
}

/**
 * Count working days (Sun-Thu in KSA workweek) between two dates.
 * `from` is exclusive — the day of return doesn't count as overdue.
 * `to` is inclusive — today counts.
 *
 * KSA standard workweek per Saudi Labour Law: Sunday through Thursday,
 * with Friday-Saturday as weekend. JS Date.getDay() gives Sun=0, Sat=6,
 * so working days are 0-4 (Sun-Thu).
 */
export function workingDaysBetween(from, to) {
  if (!from || !to || from > to) return 0;
  let count = 0;
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() + 1); // exclusive of `from`
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (cursor <= end) {
    const dow = cursor.getDay();
    if (dow >= 0 && dow <= 4) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

/**
 * Pressure-aware label + colour pair for the tracker card pill and the
 * staff banner. Centralised so all surfaces look identical.
 */
export const PRESSURE_LABELS = {
  still_out:    { label: 'Still on declared sick leave', bg: '#E0E7FF', fg: '#3730A3' },
  in_grace:     { label: 'Returned — within 48h grace',  bg: '#DCFCE7', fg: '#15803D' },
  soft_overdue: { label: 'OVERDUE',                       bg: '#FEF3C7', fg: '#92400E' },
  hard_overdue: { label: 'OVERDUE — auto-unauthorized',   bg: '#FEE2E2', fg: '#991B1B' },
  exempt:       { label: 'Cert exempt',                   bg: '#F3F4F6', fg: '#374151' },
};

/**
 * True if the employee has at least one declaration that is currently
 * in 'soft_overdue' or 'hard_overdue' state — used to block new leave/
 * permission submissions on the staff side.
 *
 * The DB trigger does this check too (belt-and-suspenders), but having
 * it client-side gives us a clear UX message instead of a SQL error.
 */
export function hasBlockingDeclaration(declarations = [], punchesByEmployee = {}) {
  return declarations.some(d => {
    const punches = punchesByEmployee[d.employee_id] || [];
    const { pressure } = classifyPressure(d, punches);
    return pressure === 'soft_overdue' || pressure === 'hard_overdue';
  });
}

/**
 * Compose a human-readable date range summary for declarations, used
 * across UI surfaces. Single-day shows just the date; multi-day shows
 * 'X → Y · N days'.
 */
export function formatDeclarationRange(req) {
  if (!req.start_date) return '—';
  if (!req.end_date || req.end_date === req.start_date) return req.start_date;
  return `${req.start_date} → ${req.end_date} · ${req.days || '?'}d`;
}
