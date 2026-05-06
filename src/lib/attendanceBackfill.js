// =============================================================================
// attendanceBackfill.js
//
// One-shot historical backfill for attendance_daily. Used when Bashaier
// imports a multi-month xlsx covering a period BEFORE the daily-upload
// flow was in use. Different from the daily recorder in three ways:
//
//   1. Processes EVERY date in the file, not just yesterday + today.
//   2. Status is always 'present' — the late/short/absent evaluation
//      requires shift schedule data which doesn't exist for historical
//      dates. Going forward (May 5 onwards) the daily flow with the
//      recorder will still write the proper evaluated status; backfill
//      only fills the gaps in the past.
//   3. Source field is 'backfill' (vs 'attendance_upload'), so admins
//      can distinguish historical fill rows from daily evaluation
//      rows in audit views.
//
// IDEMPOTENT
//   Upsert on (employee_id, attendance_date) — re-running over the
//   same file overwrites cleanly. Re-running with a fresh file that
//   covers the same date range will overwrite any existing rows for
//   those (employee, date) pairs — including ones written by the
//   daily flow. The UI warns about this before committing.
//
// CHUNKED
//   Posts in 100-row batches with an onProgress callback so the UI
//   can render a progress bar. A 4-month backfill for ~50 staff
//   could be 5,000+ rows; one big POST would risk timeout.
// =============================================================================

import { parseTimeCardXlsx } from './timeCard.js';
import { directPost, directGet } from '../supabaseClient.js';

// Local YYYY-MM-DD without timezone surprises.
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// HH:MM[:SS] → HH:MM:SS for Postgres `time`. Returns null for empty.
function toTime(s) {
  if (!s || typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (/^\d{1,2}:\d{2}$/.test(trimmed))      return `${trimmed}:00`;
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  return null;
}

// DD/MM/YYYY → YYYY-MM-DD. Returns null on bad input.
function isoDate(ddmmyyyy) {
  if (!ddmmyyyy) return null;
  const m = String(ddmmyyyy).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

// ─── Standard office-hours policy for historical evaluation ─────────
// Used when the employee is NOT a shift worker (i.e. has no record in
// monthly_shift_plans). Mirrors the daily flow's defaults so the
// historical view classifies office staff the same way the daily
// recorder does for the same shift. Shift workers can't be evaluated
// retroactively because we don't know what their schedule was on
// historical dates.
const STD_START_TIME      = '08:00:00';
const STD_END_TIME        = '17:00:00';
const STD_LATE_CUTOFF     = '08:15:00';  // 15-min grace
const STD_EARLY_CUTOFF    = '16:45:00';  // 15-min grace before close

// SUP-team policy — same start, earlier end (no lunch break).
// Mirrors the SUP_END / SUP_EARLY_CUTOFF constants in AttendanceView
// so the daily flow and the historical backfill agree on what
// "08:00-16:00" means.
const SUP_END_TIME        = '16:00:00';
const SUP_EARLY_CUTOFF    = '15:45:00';  // 15-min grace before close

function timeToMinutes(t) {
  if (!t) return null;
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (parseInt(m[3] || '0', 10) / 60);
}

// Pick the schedule that applies to a given employee. Returns the
// canonical { startTime, endTime, lateCutoff, earlyCutoff, label }
// object. SUP team gets 08:00-16:00; everyone else gets the standard
// 08:00-17:00. Future per-employee overrides should hook in here.
function policyFor(emp) {
  if (emp?.working_hours_group === 'sup_team') {
    return {
      startTime:    STD_START_TIME,
      endTime:      SUP_END_TIME,
      lateCutoff:   STD_LATE_CUTOFF,
      earlyCutoff:  SUP_EARLY_CUTOFF,
      label:        'SUP team (08:00-16:00)',
    };
  }
  return {
    startTime:    STD_START_TIME,
    endTime:      STD_END_TIME,
    lateCutoff:   STD_LATE_CUTOFF,
    earlyCutoff:  STD_EARLY_CUTOFF,
    label:        'Standard (08:00-17:00)',
  };
}

// Evaluate a non-shift-worker punch pair against the supplied policy.
// Returns { status, lateMin, earlyMin } where status ∈ {present,late,short}.
function evaluateOffice(firstPunch, lastPunch, policy) {
  const p = policy || policyFor(null);
  const fp = toTime(firstPunch);
  const lp = toTime(lastPunch);
  const lateMin  = (fp && fp > p.lateCutoff)
    ? Math.max(0, Math.round(timeToMinutes(fp) - timeToMinutes(p.startTime)))
    : 0;
  const earlyMin = (lp && lp < p.earlyCutoff)
    ? Math.max(0, Math.round(timeToMinutes(p.endTime) - timeToMinutes(lp)))
    : 0;
  // Late dominates short if both apply on the same day — late is the
  // more actionable signal for HR follow-up. We still record the
  // early-leave minutes in the row for the tooltip / report detail.
  const status = lateMin > 0 ? 'late'
               : earlyMin > 0 ? 'short'
               : 'present';
  return { status, lateMin, earlyMin };
}

// Build a one-shot policy from a manager-assigned shift's start/end
// times. Same shape as policyFor() output so the rest of the code
// can use either interchangeably. 15-min grace mirrors the office
// policy for consistency — staff get the same buffer no matter what
// schedule applies.
//
// Per Nadeem (2026-05-06): on shift days we evaluate against the
// MANAGER-ASSIGNED window (e.g. NAWAF on 5 May 00:00-08:00), not
// against standard office hours. The grace stays at 15 min so the
// rule is one consistent thing across the org.
function policyFromShift(shift) {
  if (!shift?.start || !shift?.end) return null;
  // Normalize to HH:MM:SS
  const norm = (t) => /^\d{2}:\d{2}$/.test(t) ? `${t}:00` : t;
  const start = norm(shift.start);
  const end   = norm(shift.end);
  const startMin = timeToMinutes(start);
  const endMin   = timeToMinutes(end);
  if (startMin == null || endMin == null) return null;
  // 15-minute grace either side. Compute as HH:MM strings.
  const minToHm = (m) => {
    const mm = ((m % 60) + 60) % 60;
    const hh = Math.floor(((m - mm + 1440 * 4) / 60)) % 24; // wrap safe
    return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`;
  };
  const lateCutoff  = minToHm(startMin + 15);
  const earlyCutoff = minToHm(endMin - 15);
  return {
    startTime:   start,
    endTime:     end,
    lateCutoff,
    earlyCutoff,
    label:       `Shift (${start.slice(0,5)}-${end.slice(0,5)})`,
  };
}

// Evaluate a punch pair against a manager-assigned shift schedule.
// Same logic as evaluateOffice, but with the shift's policy.
//
// Edge case — overnight shifts (e.g. 22:00-06:00 the next morning):
// the punch records sit on the dates they actually happened, so an
// overnight shift normally produces two attendance rows (the start
// row with first_punch ~22:00 and no last_punch; the end row with
// no first_punch and last_punch ~06:00). For now we treat each row
// independently — the backfill flow's existing missed-in/missed-out
// handling already produces sensible classifications. A future
// enhancement could pair start/end punches across midnight.
function evaluateShift(firstPunch, lastPunch, shift) {
  const policy = policyFromShift(shift);
  if (!policy) {
    // Schedule unknown — fall back to "present" without late/short.
    return { status: 'present', lateMin: 0, earlyMin: 0, policy: null };
  }
  const evalRes = evaluateOffice(firstPunch, lastPunch, policy);
  return { ...evalRes, policy };
}

// KSA weekend = Friday + Saturday. Office-hours policy doesn't apply
// to weekend work (most office staff are off then; weekend punches
// are typically OT or special coverage). We leave those as 'present'
// without late/short evaluation.
function isKsaWeekendDow(dow) {
  return dow === 5 || dow === 6;
}

/**
 * Parse the file. Reuses the daily parser since the file format is
 * identical — just a longer date range.
 *
 * @param {File} file
 * @returns {Promise<{rows, dataDate, sheetName}>}
 */
export async function parseBackfillXlsx(file) {
  return parseTimeCardXlsx(file);
}

/**
 * Fetch the set of employee IDs that appear in monthly_shift_plans
 * (any month, any manager). These are "shift workers" — staff with
 * a non-standard schedule that we can't fairly evaluate against
 * standard office hours retroactively. Backfill leaves their rows
 * as 'present' rather than guessing late/short status.
 *
 * @returns {Promise<Set<string>>}
 */
export async function fetchShiftEmployeeIds() {
  try {
    const rows = await directGet(
      'monthly_shift_plans',
      'select=employee_id&shifts_count=gt.0',
      { timeoutMs: 9000 }
    );
    const out = new Set();
    (rows || []).forEach(r => { if (r?.employee_id) out.add(r.employee_id); });
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Fetch per-date shift assignments from employee_shifts and return a
 * Map keyed by `${empId}|${YYYY-MM-DD}` with each value being the
 * shift's `{ start, end, status }`. Used by buildBackfillRows /
 * reevaluateBackfillRows to evaluate shift-worker punches against
 * the actual manager-assigned schedule.
 *
 * Why a Map (not Set) (Nadeem 2026-05-06): on shift days we don't
 * just want to skip — we want to evaluate punches against the
 * SHIFT'S actual start/end times. e.g. NAWAF H94295's shift on
 * 5 May was 00:00-08:00 — system should compare his punches to
 * that window, marking him late if he started after 00:00 + grace
 * or short if he left before 08:00 - grace.
 *
 * Only includes shifts that aren't cancelled/declined — pending,
 * accepted, and acknowledged shifts all count as schedule of record.
 *
 * @param {string} startDate YYYY-MM-DD inclusive
 * @param {string} endDate   YYYY-MM-DD inclusive
 * @returns {Promise<Map<string, {start: string, end: string, status: string}>>}
 */
export async function fetchShiftAssignmentDates(startDate, endDate) {
  try {
    const qs =
      'select=employee_id,shift_date,shift_start,shift_end,status' +
      `&shift_date=gte.${startDate}` +
      `&shift_date=lte.${endDate}` +
      '&status=neq.declined' +
      '&status=neq.cancelled';
    const rows = await directGet('employee_shifts', qs, { timeoutMs: 9000 });
    const out = new Map();
    (rows || []).forEach(r => {
      if (r?.employee_id && r?.shift_date) {
        out.set(`${r.employee_id}|${r.shift_date}`, {
          start: r.shift_start,
          end: r.shift_end,
          status: r.status,
        });
      }
    });
    return out;
  } catch {
    return new Map();
  }
}

/**
 * Fetch all active (non-cancelled) Mawani-visit (employee_id, date)
 * pairs in a single query, return them as a Set keyed by
 * `${empId}|${YYYY-MM-DD}`. Used by buildBackfillRows /
 * reevaluateBackfillRows to short-circuit late/short evaluation on
 * duty-visit days.
 *
 * @returns {Promise<Set<string>>}
 */
export async function fetchMawaniDays() {
  try {
    const rows = await directGet(
      'mawani_visits',
      'select=employee_id,visit_date&status=neq.cancelled',
      { timeoutMs: 9000 }
    );
    const out = new Set();
    (rows || []).forEach(r => {
      if (r?.employee_id && r?.visit_date) {
        out.add(`${r.employee_id}|${r.visit_date}`);
      }
    });
    return out;
  } catch {
    // Table may not exist yet (migration not run) — degrade
    // gracefully to "no Mawani days" so the rest of the flow keeps
    // working until Bashaier runs the migration.
    return new Set();
  }
}

/**
 * Convert parsed rows into attendance_daily upsert payload.
 *
 * @param {Object} args
 * @param {Array}  args.parsedRows  — output of parseBackfillXlsx().rows
 * @param {Array}  args.employees   — directory for PSN canonicalization
 * @param {string} args.recordedBy  — PSN of the importer (Bashaier / admin)
 * @returns {{ rows, summary }}
 *
 *  summary = {
 *    parsed:     total parsed rows
 *    skipped:    rows missing PSN/date/punches
 *    unmatched:  rows whose PSN didn't resolve to any directory employee
 *    rows:       count of upsert-ready rows
 *    employees:  Set of unique employee IDs touched
 *    minDate:    earliest YYYY-MM-DD
 *    maxDate:    latest YYYY-MM-DD
 *  }
 */
export function buildBackfillRows({ parsedRows, employees, recordedBy, shiftEmployeeIds, shiftAssignmentDates, mawaniDays }) {
  // Index the directory once. Two indexes — one for full PSN match
  // (e.g. "H94499"), one for the digits-only fallback ("94499") since
  // some xlsx exports drop the H prefix.
  const empById     = new Map();
  const empByDigits = new Map();
  (employees || []).forEach(e => {
    if (!e?.id) return;
    empById.set(String(e.id).toUpperCase(), e);
    const m = String(e.id).match(/(\d+)/);
    if (m && m[1]) empByDigits.set(m[1], e);
  });

  // Normalize both shift sets. shiftSet (employee-level) is kept as a
  // fallback / legacy path — but the primary check is the date-aware
  // shiftDateMap keyed `${empId}|${YYYY-MM-DD}` → { start, end, status }.
  // A staffer is treated as "on shift today" only if there's a Map
  // entry for THIS specific date; the entry's times drive the
  // late/early evaluation against the manager-assigned schedule.
  const shiftSet = (shiftEmployeeIds instanceof Set)
    ? shiftEmployeeIds
    : new Set(shiftEmployeeIds || []);
  const shiftDateSet = (shiftAssignmentDates instanceof Map)
    ? shiftAssignmentDates
    : new Map();

  // Mawani-visit set keyed as `${empId}|${YYYY-MM-DD}` so a single
  // .has() call answers "is this employee on Mawani duty this date?"
  const mawaniSet = (mawaniDays instanceof Set)
    ? mawaniDays
    : new Set(mawaniDays || []);

  const rows = [];
  const touchedEmployees = new Set();
  let parsed = 0;
  let skipped = 0;
  let unmatched = 0;
  let lateCount = 0;
  let shortCount = 0;
  let presentCount = 0;
  let shiftWorkerSkipped = 0;  // count of rows we left as 'present'
                                // because the employee is a shift worker
  let mawaniDayCount = 0;       // count of rows tagged as Mawani duty
  let totalMissedIn = 0;        // out only — no clock-in punch
  let totalMissedOut = 0;       // in only — no clock-out punch
  let minDate = null;
  let maxDate = null;
  const now = new Date().toISOString();

  // Validate ISO date shape — parser already returns YYYY-MM-DD, but
  // defend against unexpected null/garbage.
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

  for (const r of (parsedRows || [])) {
    parsed++;
    const psn = String(r.psn || '').toUpperCase().trim();
    // Date comes from parseTimeCardXlsx already in YYYY-MM-DD form
    // via parseDdmmyyyy. Use it directly — DON'T re-parse as
    // DD/MM/YYYY (the bug that caused 4901 rows to silently skip).
    const dateIso = (r.date && ISO_RE.test(r.date)) ? r.date : null;
    if (!psn || !dateIso) { skipped++; continue; }

    // Resolve to canonical employee_id
    const emp = empById.get(psn) ||
                empByDigits.get(psn.replace(/^H/, ''));
    const empId = emp?.id || psn;
    if (!emp) unmatched++;

    // Skip rows with no usable punch data — both punches missing
    // means the row is purely informational and tells us nothing
    // attendance-wise. Rows with only ONE punch are kept and
    // classified as missed-in (no first) or missed-out (no last)
    // so Bashaier can see them as data-quality issues.
    const firstPunchRaw = r.firstPunch;
    const lastPunchRaw  = r.lastPunch;
    if (!firstPunchRaw && !lastPunchRaw) { skipped++; continue; }
    const hasFirst = !!firstPunchRaw;
    const hasLast  = !!lastPunchRaw;
    const isMissedIn  = !hasFirst && hasLast;   // out only
    const isMissedOut = hasFirst && !hasLast;   // in only

    // ─── Evaluation ──────────────────────────────────────────────
    // Apply standard 08:00-17:00 office-hours evaluation when we
    // can. Skip employees who appear in monthly_shift_plans (we
    // don't know their historical shifts so we can't fairly
    // classify their punches as late/short). Skip KSA weekend
    // dates (Fri/Sat) — office staff working those are doing OT,
    // not bound by the office-hours window.
    //
    // SUP TEAM TAKES PRECEDENCE: if Bashaier has explicitly marked
    // the employee as 'sup_team' working hours, that designation
    // wins over any monthly_shift_plans entry. Otherwise, e.g. a
    // SUP-staffer who briefly appeared on a manager's roster gets
    // forever skipped from policy evaluation. Explicit SUP
    // designation = 08:00-16:00 office-hours eval, period.
    //
    // SHIFT CHECK IS DATE-SPECIFIC (Nadeem 2026-05-06): we only
    // treat the employee as a shift worker on dates where there's
    // an actual employee_shifts row. Staff like Fahd (Saturday
    // shifts only) get evaluated against the standard policy on
    // Sun-Thu, fixing the bug where any monthly_shift_plans entry
    // made them un-flaggable for late/early on every day.
    //
    // shiftDateSet is the primary source of truth. shiftSet (legacy
    // employee-level) is now a fallback only when shiftDateSet is
    // empty (e.g. caller didn't pass it in for backwards compat).
    const isSupTeam = emp?.working_hours_group === 'sup_team';
    const shiftEntry = shiftDateSet.get(`${empId}|${dateIso}`) || null;
    const hasDateSpecificShift = !!shiftEntry;
    const fallbackToEmpLevel = (shiftDateSet.size === 0) && shiftSet.has(empId);
    const isShiftWorker = !isSupTeam && (hasDateSpecificShift || fallbackToEmpLevel);
    const dt = new Date(dateIso + 'T00:00:00');
    const isWeekend = isKsaWeekendDow(dt.getDay());

    // Mawani visit on this date? Treat as 'present' — leaving
    // office for duty visit isn't early leave. Cancelled visits
    // don't count, only planned/completed ones.
    const isMawaniDay = mawaniSet.has(`${empId}|${dateIso}`);
    const policy = policyFor(emp);

    let status, lateMin, earlyMin, expectedStart, expectedEnd, noteText;
    let missedInCount = 0, missedOutCount = 0;  // local flags for the
                                                 // outer counters below
    if (isMawaniDay) {
      // Mawani visits subsume the missed-punch concern — staff is
      // off-site on duty, partial punches are expected.
      status        = 'present';
      lateMin       = 0;
      earlyMin      = 0;
      expectedStart = policy.startTime;
      expectedEnd   = policy.endTime;
      noteText      = isMissedIn
        ? `Backfill — Mawani duty visit (${policy.label}) (no punch-in)`
        : isMissedOut
          ? `Backfill — Mawani duty visit (${policy.label}) (no punch-out)`
          : `Backfill — Mawani duty visit (${policy.label})`;
      mawaniDayCount++;
    } else if (hasDateSpecificShift) {
      // Shift day with a known manager-assigned schedule.
      // Evaluate punches against THAT window with 15-min grace.
      // Per Nadeem (2026-05-06): e.g. NAWAF on 5 May 00:00-08:00 —
      // late if first_punch > 00:15, short if last_punch < 07:45.
      const shiftPolicy = policyFromShift(shiftEntry);
      if (!shiftPolicy) {
        // Schedule data missing/invalid — fall back to old behaviour
        // (mark present, skip eval). Defensive only.
        status        = 'present';
        lateMin       = 0;
        earlyMin      = 0;
        expectedStart = null;
        expectedEnd   = null;
        noteText      = `Backfill — shift assigned but times unparseable`;
        shiftWorkerSkipped++;
      } else if (isMissedIn) {
        status        = 'late';
        lateMin       = 0;
        earlyMin      = 0;
        expectedStart = shiftPolicy.startTime;
        expectedEnd   = shiftPolicy.endTime;
        noteText      = `Backfill — no punch-in recorded (${shiftPolicy.label})`;
        missedInCount = 1;
      } else if (isMissedOut) {
        status        = 'short';
        lateMin       = 0;
        earlyMin      = 0;
        expectedStart = shiftPolicy.startTime;
        expectedEnd   = shiftPolicy.endTime;
        noteText      = `Backfill — no punch-out recorded (${shiftPolicy.label})`;
        missedOutCount = 1;
      } else {
        const evalRes = evaluateOffice(firstPunchRaw, lastPunchRaw, shiftPolicy);
        status        = evalRes.status;
        lateMin       = evalRes.lateMin;
        earlyMin      = evalRes.earlyMin;
        expectedStart = shiftPolicy.startTime;
        expectedEnd   = shiftPolicy.endTime;
        noteText      = `Backfill — evaluated against ${shiftPolicy.label} with 15-min grace`;
      }
    } else if (isShiftWorker || isWeekend) {
      // Legacy / fallback path — employee-level shift fallback or
      // KSA weekend without a shift entry. Schedule unknown, mark
      // present, no late/short.
      status        = 'present';
      lateMin       = 0;
      earlyMin      = 0;
      expectedStart = null;
      expectedEnd   = null;
      if (isShiftWorker) shiftWorkerSkipped++;
      const baseLabel = isShiftWorker
        ? 'shift worker, schedule unknown'
        : 'KSA weekend punch';
      noteText = isMissedIn
        ? `Backfill — ${baseLabel} (no punch-in)`
        : isMissedOut
          ? `Backfill — ${baseLabel} (no punch-out)`
          : `Backfill — ${baseLabel}`;
    } else if (isMissedIn) {
      // Missed clock-in for office staff — mirrors daily-flow
      // convention (status='late' so the violation surfaces, with
      // a note explaining the missing clock-in). late_minutes=0
      // because we genuinely don't know how late they arrived.
      status        = 'late';
      lateMin       = 0;
      earlyMin      = 0;
      expectedStart = policy.startTime;
      expectedEnd   = policy.endTime;
      noteText      = `Backfill — no punch-in recorded (${policy.label})`;
      missedInCount = 1;
    } else if (isMissedOut) {
      // Missed clock-out — same rationale, classified as 'short'
      // with a note. early_leave_minutes=0 since we don't know.
      status        = 'short';
      lateMin       = 0;
      earlyMin      = 0;
      expectedStart = policy.startTime;
      expectedEnd   = policy.endTime;
      noteText      = `Backfill — no punch-out recorded (${policy.label})`;
      missedOutCount = 1;
    } else {
      // Normal case: both punches present. Run the policy-based
      // late/short evaluation.
      const evalRes = evaluateOffice(firstPunchRaw, lastPunchRaw, policy);
      status        = evalRes.status;
      lateMin       = evalRes.lateMin;
      earlyMin      = evalRes.earlyMin;
      expectedStart = policy.startTime;
      expectedEnd   = policy.endTime;
      noteText      = `Backfill — evaluated against ${policy.label} with 15-min grace`;
    }

    if (status === 'late') lateCount++;
    else if (status === 'short') shortCount++;
    else presentCount++;
    if (missedInCount)  totalMissedIn++;
    if (missedOutCount) totalMissedOut++;

    rows.push({
      employee_id:        empId,
      attendance_date:    dateIso,
      status,
      // Don't conflate first/last — preserve which punch is
      // actually present so the UI can show "no punch-in"/"no
      // punch-out" decorations correctly.
      first_punch:        hasFirst ? toTime(firstPunchRaw) : null,
      last_punch:         hasLast  ? toTime(lastPunchRaw)  : null,
      punch_count:        r.uniqueCount || 0,
      expected_start:     expectedStart,
      expected_end:       expectedEnd,
      late_minutes:       lateMin,
      early_leave_minutes:earlyMin,
      leave_request_id:   null,
      notes:              noteText,
      recorded_at:        now,
      recorded_by:        recordedBy || null,
      source:             'backfill',
    });

    touchedEmployees.add(empId);
    if (!minDate || dateIso < minDate) minDate = dateIso;
    if (!maxDate || dateIso > maxDate) maxDate = dateIso;
  }

  return {
    rows,
    summary: {
      parsed,
      skipped,
      unmatched,
      rows: rows.length,
      employees: touchedEmployees,
      minDate,
      maxDate,
      // Evaluation breakdown — surfaced in the preview UI so the
      // user sees what the imported rows will look like before
      // committing. Late + short are bucketed against the standard
      // 08:00-17:00 office-hours policy with 15-min grace.
      lateCount,
      shortCount,
      presentCount,
      shiftWorkerSkipped,
      mawaniDayCount,
      missedInCount:  totalMissedIn,
      missedOutCount: totalMissedOut,
    },
  };
}

/**
 * Check how many of the proposed rows would overwrite existing
 * attendance_daily entries. Lets the UI warn the user before they
 * commit a destructive backfill.
 *
 * @param {Array<{employee_id, attendance_date}>} rows
 * @returns {Promise<{ existingCount, sample }>}  — sample is up to 5
 *   (employee, date) pairs that would be overwritten
 */
export async function previewOverwrites(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { existingCount: 0, sample: [] };
  }
  // Take min/max date as a coarse window; the per-employee filter
  // would mean potentially hundreds of OR clauses which PostgREST
  // chokes on. Better to fetch the date range and filter client-side.
  const minDate = rows.reduce((m, r) => !m || r.attendance_date < m ? r.attendance_date : m, null);
  const maxDate = rows.reduce((m, r) => !m || r.attendance_date > m ? r.attendance_date : m, null);
  if (!minDate || !maxDate) return { existingCount: 0, sample: [] };

  try {
    const empIds = Array.from(new Set(rows.map(r => r.employee_id))).join(',');
    const existing = await directGet(
      'attendance_daily',
      `select=employee_id,attendance_date` +
      `&attendance_date=gte.${minDate}&attendance_date=lte.${maxDate}` +
      `&employee_id=in.(${encodeURIComponent(empIds)})`,
      { timeoutMs: 12000 }
    );
    const haveByKey = new Set(
      (existing || []).map(r => `${r.employee_id}|${r.attendance_date}`)
    );
    const overlapping = rows.filter(
      r => haveByKey.has(`${r.employee_id}|${r.attendance_date}`)
    );
    return {
      existingCount: overlapping.length,
      sample: overlapping.slice(0, 5).map(r => ({
        employee_id: r.employee_id,
        attendance_date: r.attendance_date,
      })),
    };
  } catch {
    return { existingCount: 0, sample: [] };
  }
}

/**
 * Upsert the rows in 100-row chunks, calling onProgress after each.
 *
 * @param {Array} rows
 * @param {(progress: {written, total}) => void} onProgress
 * @returns {Promise<{written}>}
 */
export async function recordBackfillRows(rows, onProgress) {
  if (!Array.isArray(rows) || rows.length === 0) return { written: 0 };
  const CHUNK = 100;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await directPost('attendance_daily', slice, {
      upsert: true,
      onConflict: 'employee_id,attendance_date',
      timeoutMs: 15000,
    });
    written += slice.length;
    if (onProgress) {
      try { onProgress({ written, total: rows.length }); } catch {}
    }
  }
  return { written };
}

/**
 * Re-evaluate attendance_daily rows that were imported via backfill.
 *
 * USE CASE
 *   The first wave of historical backfill imports happened before
 *   the late/short evaluation logic existed — every row landed as
 *   status='present'. Rather than asking the user to re-upload the
 *   xlsx, this helper scans rows where source='backfill', applies
 *   the standard 08:00-17:00 + 15-min grace policy in-memory, and
 *   upserts the rows whose classification actually changed.
 *
 * SCOPE
 *   • Only touches rows with source='backfill' so daily-flow rows
 *     (which were evaluated against real shift schedules) are left
 *     alone.
 *   • Skips employees who appear in monthly_shift_plans — same as
 *     the original backfill builder. We can't fairly classify their
 *     historical punches without their actual schedules.
 *   • Skips KSA weekend dates (Fri/Sat) — same as the builder.
 *   • Only writes rows where status / late_minutes / early_leave_minutes
 *     actually changed, so the upsert footprint stays small.
 *
 * @param {function} [onProgress] — called with { phase, processed, total }
 * @returns {Promise<{ scanned, changed, lateCount, shortCount, presentCount }>}
 */
export async function reevaluateBackfillRows(onProgress, options = {}) {
  // Phase 1 — load shift-worker IDs + Mawani days + employee
  // working-hours-group lookup so we can apply per-employee policy
  if (onProgress) try { onProgress({ phase: 'shifts', processed: 0, total: 0 }); } catch {}
  const shiftSet = await fetchShiftEmployeeIds();
  const mawaniSet = await fetchMawaniDays();
  // Date-aware shift assignments — for each row's attendance_date,
  // we'll check `${empId}|${date}` against this set instead of the
  // employee-level shiftSet. See fetchShiftAssignmentDates docstring.
  // We need the date range to scope the fetch — derive from the
  // existing rows we're about to re-evaluate. Done after the
  // attendance_daily fetch below to keep the query tight.
  let shiftDateSet = new Map();

  // Build empPolicyMap: employee_id → policy. ALWAYS fetch fresh
  // here — the caller's employees prop may be stale if the user
  // recently marked staff as SUP (the prop typically comes from a
  // page-level fetch that runs once on mount, so working_hours_group
  // changes made via the WorkingHoursManager wouldn't be reflected).
  // A fresh fetch is cheap (one column from a small table) and
  // guarantees the latest policy designations are applied. Falls
  // back to options.employees only if the fetch genuinely fails.
  let empById = null;
  try {
    const emps = await directGet(
      'employees',
      'select=id,working_hours_group',
      { timeoutMs: 9000 }
    );
    empById = new Map((emps || []).map(e => [e?.id, e]).filter(([k]) => k));
  } catch {
    empById = options?.employees
      ? new Map((options.employees || []).map(e => [e?.id, e]).filter(([k]) => k))
      : new Map();
  }

  // Phase 2 — fetch all backfill rows. Project only the columns
  // we need to evaluate; status + minutes + id is enough.
  if (onProgress) try { onProgress({ phase: 'fetching', processed: 0, total: 0 }); } catch {}
  // Source scope — by default we re-evaluate ALL rows (both backfill
  // and daily-flow). The daily flow's classification is based on the
  // employee's working_hours_group at upload time; if Bashaier later
  // marks an employee as SUP-team, the previously-uploaded rows are
  // stale until re-evaluated. Caller can opt into the legacy
  // backfill-only scope by passing options.scope='backfill'.
  const scope = options?.scope || 'all';
  const sourceFilter = scope === 'backfill'
    ? '&source=eq.backfill'
    : '';  // 'all' — no filter
  const existing = await directGet(
    'attendance_daily',
    'select=id,employee_id,attendance_date,first_punch,last_punch,status,' +
    'late_minutes,early_leave_minutes,expected_start,expected_end,punch_count,' +
    'leave_request_id,recorded_by,source' +
    sourceFilter +
    '&order=attendance_date.asc',
    { timeoutMs: 45000 }
  ) || [];

  // Now that we have the date range from existing rows, fetch the
  // date-keyed shift assignments. Tight scope — only the dates that
  // appear in attendance_daily rows we're re-evaluating.
  if (existing.length > 0) {
    const minD = existing[0].attendance_date;
    const maxD = existing[existing.length - 1].attendance_date;
    shiftDateSet = await fetchShiftAssignmentDates(minD, maxD);
  }

  // Phase 3 — compute proposed updates in-memory
  const toUpsert = [];
  let lateCount = 0;
  let shortCount = 0;
  let presentCount = 0;
  let mawaniDayCount = 0;

  for (const r of existing) {
    const empId = r.employee_id;
    const emp = empById.get(empId);
    const policy = policyFor(emp);
    const dt = new Date(r.attendance_date + 'T00:00:00');
    const isWeekend = isKsaWeekendDow(dt.getDay());
    // SUP team takes precedence over shift-worker membership —
    // see same comment in buildBackfillRows above. Date-aware
    // shift check (Nadeem 2026-05-06): only treat as shift worker
    // on dates where they actually have an employee_shifts row.
    const isSupTeam = emp?.working_hours_group === 'sup_team';
    const shiftEntry = shiftDateSet.get(`${empId}|${r.attendance_date}`) || null;
    const hasDateSpecificShift = !!shiftEntry;
    const fallbackToEmpLevel = (shiftDateSet.size === 0) && shiftSet.has(empId);
    const isShiftWorker = !isSupTeam && (hasDateSpecificShift || fallbackToEmpLevel);
    const isMawaniDay = mawaniSet.has(`${empId}|${r.attendance_date}`);
    const isDailyRow = r.source !== 'backfill';

    // SAFETY GUARD — for DAILY-FLOW rows belonging to SHIFT WORKERS
    // WITHOUT a date-specific shift entry (legacy fallback path),
    // the original recorder evaluated against the actual shift
    // schedule (which we don't have here). Re-evaluating those would
    // discard valid late/short/off_roster classifications. Skip them.
    // For rows WITH a date-specific shift entry, we now have the
    // schedule and can evaluate properly — those are NOT skipped.
    if (isDailyRow && isShiftWorker && !hasDateSpecificShift) continue;

    // Same guard for daily-flow rows on existing 'off_roster' or
    // 'on_leave' status — those classifications carry information
    // we shouldn't blindly overwrite.
    if (isDailyRow && (r.status === 'off_roster' || r.status === 'on_leave' ||
                       r.status === 'annual_leave' || r.status === 'sick_leave')) continue;

    // Detect missing punches — preserves the same semantics as
    // buildBackfillRows so a row imported via backfill keeps its
    // missed-in / missed-out classification across re-evaluation.
    const hasFirst = !!r.first_punch;
    const hasLast  = !!r.last_punch;
    const isMissedIn  = !hasFirst && hasLast;
    const isMissedOut = hasFirst && !hasLast;

    let newStatus, newLate, newEarly, newExpStart, newExpEnd, newNote;
    if (isMawaniDay) {
      newStatus    = 'present';
      newLate      = 0;
      newEarly     = 0;
      newExpStart  = policy.startTime;
      newExpEnd    = policy.endTime;
      newNote      = isMissedIn
        ? `Mawani duty visit (${policy.label}) (no punch-in) (re-evaluated)`
        : isMissedOut
          ? `Mawani duty visit (${policy.label}) (no punch-out) (re-evaluated)`
          : `Mawani duty visit (${policy.label}) (re-evaluated)`;
      mawaniDayCount++;
    } else if (hasDateSpecificShift) {
      // Shift day with manager-assigned schedule — evaluate against it.
      const shiftPolicy = policyFromShift(shiftEntry);
      if (!shiftPolicy) {
        newStatus = 'present'; newLate = 0; newEarly = 0;
        newExpStart = null; newExpEnd = null;
        newNote = 'Shift assigned but times unparseable (re-evaluated)';
      } else if (isMissedIn) {
        newStatus = 'late'; newLate = 0; newEarly = 0;
        newExpStart = shiftPolicy.startTime; newExpEnd = shiftPolicy.endTime;
        newNote = `No punch-in recorded (${shiftPolicy.label}) (re-evaluated)`;
      } else if (isMissedOut) {
        newStatus = 'short'; newLate = 0; newEarly = 0;
        newExpStart = shiftPolicy.startTime; newExpEnd = shiftPolicy.endTime;
        newNote = `No punch-out recorded (${shiftPolicy.label}) (re-evaluated)`;
      } else {
        const ev = evaluateOffice(r.first_punch, r.last_punch, shiftPolicy);
        newStatus = ev.status; newLate = ev.lateMin; newEarly = ev.earlyMin;
        newExpStart = shiftPolicy.startTime; newExpEnd = shiftPolicy.endTime;
        newNote = `Re-evaluated against ${shiftPolicy.label} with 15-min grace`;
      }
    } else if (isShiftWorker || isWeekend) {
      // Legacy fallback / weekend path — schedule unknown, baseline present.
      newStatus    = 'present';
      newLate      = 0;
      newEarly     = 0;
      newExpStart  = null;
      newExpEnd    = null;
      const baseLabel = isShiftWorker
        ? 'Shift worker, schedule unknown (re-evaluated)'
        : 'KSA weekend punch (re-evaluated)';
      newNote = isMissedIn
        ? `${baseLabel} (no punch-in)`
        : isMissedOut
          ? `${baseLabel} (no punch-out)`
          : baseLabel;
    } else if (isMissedIn) {
      newStatus    = 'late';
      newLate      = 0;
      newEarly     = 0;
      newExpStart  = policy.startTime;
      newExpEnd    = policy.endTime;
      newNote      = `No punch-in recorded (${policy.label}) (re-evaluated)`;
    } else if (isMissedOut) {
      newStatus    = 'short';
      newLate      = 0;
      newEarly     = 0;
      newExpStart  = policy.startTime;
      newExpEnd    = policy.endTime;
      newNote      = `No punch-out recorded (${policy.label}) (re-evaluated)`;
    } else {
      const ev = evaluateOffice(r.first_punch, r.last_punch, policy);
      newStatus   = ev.status;
      newLate     = ev.lateMin;
      newEarly    = ev.earlyMin;
      newExpStart = policy.startTime;
      newExpEnd   = policy.endTime;
      newNote = `Re-evaluated against ${policy.label} with 15-min grace`;
    }

    // Tally for the summary regardless of whether we actually write
    if (newStatus === 'late')        lateCount++;
    else if (newStatus === 'short')  shortCount++;
    else                              presentCount++;

    // Only push to upsert if anything actually changed — avoids
    // unnecessary writes when most rows are already correct.
    const changed =
      newStatus !== r.status ||
      (newLate || 0) !== (r.late_minutes || 0) ||
      (newEarly || 0) !== (r.early_leave_minutes || 0) ||
      (newExpStart || null) !== (r.expected_start || null) ||
      (newExpEnd   || null) !== (r.expected_end   || null);
    if (!changed) continue;

    toUpsert.push({
      employee_id:        empId,
      attendance_date:    r.attendance_date,
      status:             newStatus,
      first_punch:        r.first_punch,
      last_punch:         r.last_punch,
      punch_count:        r.punch_count || 0,
      expected_start:     newExpStart,
      expected_end:       newExpEnd,
      late_minutes:       newLate,
      early_leave_minutes:newEarly,
      leave_request_id:   r.leave_request_id || null,
      notes:              newNote,
      recorded_at:        new Date().toISOString(),
      recorded_by:        r.recorded_by || null,
      // Preserve the original source — daily-flow rows stay as
      // 'attendance_upload', backfill rows stay as 'backfill'.
      source:             r.source || 'backfill',
    });
  }

  // Phase 4 — upsert changed rows in batches
  const CHUNK = 100;
  for (let i = 0; i < toUpsert.length; i += CHUNK) {
    const slice = toUpsert.slice(i, i + CHUNK);
    await directPost('attendance_daily', slice, {
      upsert: true,
      onConflict: 'employee_id,attendance_date',
      timeoutMs: 15000,
    });
    if (onProgress) {
      try { onProgress({ phase: 'writing', processed: Math.min(i + CHUNK, toUpsert.length), total: toUpsert.length }); } catch {}
    }
  }

  return {
    scanned: existing.length,
    changed: toUpsert.length,
    lateCount,
    shortCount,
    presentCount,
    mawaniDayCount,
  };
}

// Re-export so consumers can format dates consistently.
export const __utils = { ymd, toTime, isoDate };
