// ─── Date utilities ─────────────────────────────────────────────────
//
// Centralised date math for the ESAU HR portal. The primary purpose
// is to eliminate UTC drift — historically the codebase mixed
// `toISOString().slice(0, 10)` (UTC) with manual local-component
// composition, causing off-by-one-day errors for rows near midnight
// in the Asia/Riyadh timezone (UTC+3).
//
// Tier 1 fix (#2 / item 1): all date-string production in the
// attendance pipeline goes through these helpers. Time arithmetic
// stays in minutes-since-midnight (see toMinutes/fromMinutes), which
// is timezone-independent.
//
// All functions in this module operate on LOCAL TIME by default. The
// browser's local timezone is assumed to be Asia/Riyadh in production;
// for development this matches the developer's machine, which is
// fine because the same logic applies (the helper just preserves
// whatever local time the Date carries).

/**
 * Format a Date as YYYY-MM-DD using LOCAL time components.
 * Returns null for invalid input. Never returns UTC.
 *
 * Use this everywhere in place of `d.toISOString().slice(0, 10)` —
 * the UTC slice causes a one-day shift for any Date created late in
 * the day local time when the UTC component lands in the next day.
 */
export function localDateString(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today as YYYY-MM-DD in local time. */
export function todayLocal() {
  return localDateString(new Date());
}

/**
 * Add days to a YYYY-MM-DD string and return the result as YYYY-MM-DD.
 * Pure arithmetic on the date components — does not roll through
 * Date objects, so DST and timezone are non-issues. Negative days OK.
 */
export function addDaysIso(iso, days) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + days);
  return localDateString(d);
}

/**
 * Parse YYYY-MM-DD into a Date at LOCAL midnight. Returns null on
 * invalid input. Use this anywhere you need to construct a Date
 * from a date-only string and want it anchored to local time
 * (e.g., for comparisons, weekday checks, or formatting).
 */
export function parseIsoDate(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * First day of the month containing `iso`, as YYYY-MM-DD.
 */
export function monthStart(iso) {
  const d = parseIsoDate(iso);
  if (!d) return null;
  return localDateString(new Date(d.getFullYear(), d.getMonth(), 1));
}

/**
 * Last day of the month containing `iso`, as YYYY-MM-DD.
 */
export function monthEnd(iso) {
  const d = parseIsoDate(iso);
  if (!d) return null;
  // Day 0 of next month = last day of current month
  return localDateString(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/**
 * Returns the day-of-week for a YYYY-MM-DD string in local time.
 * 0 = Sunday ... 5 = Friday, 6 = Saturday.
 */
export function isoDayOfWeek(iso) {
  const d = parseIsoDate(iso);
  return d ? d.getDay() : -1;
}

/**
 * KSA weekend check — Friday (5) or Saturday (6).
 */
export function isKsaWeekend(iso) {
  const dow = isoDayOfWeek(iso);
  return dow === 5 || dow === 6;
}

/**
 * Next non-KSA-weekend date (advances 0 days if `iso` is already a
 * working day, otherwise rolls forward to the next Sunday).
 *
 * Used for proposing return-to-work / rejoining dates: under KSA
 * Labor Law the working week is Sun–Thu, so a leave ending on a
 * Thursday means the staff member's first day back is the following
 * Sunday, not Friday. Always reach for this helper instead of a raw
 * `addDaysIso(end_date, 1)` when defaulting a return-to-work date.
 */
export function nextWorkingDayIso(iso) {
  if (!iso || typeof iso !== 'string') return null;
  let cur = iso, guard = 0;
  while (isKsaWeekend(cur) && guard++ < 8) cur = addDaysIso(cur, 1);
  return cur;
}

// Back-compat alias — ymd was the original name in attendanceBackfill.js
// before this module existed. New code should prefer localDateString.
export const ymd = localDateString;
