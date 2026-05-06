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
export function buildBackfillRows({ parsedRows, employees, recordedBy, shiftEmployeeIds, mawaniDays }) {
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

  // Normalize the shift-worker set so .has() works regardless of how
  // the caller passed it in (Set, Array, null).
  const shiftSet = (shiftEmployeeIds instanceof Set)
    ? shiftEmployeeIds
    : new Set(shiftEmployeeIds || []);

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

    // Skip rows with no usable punch data — purely informational
    // entries that don't tell us anything attendance-wise.
    const firstPunch = r.firstPunch;
    const lastPunch  = r.lastPunch || r.firstPunch;
    if (!firstPunch && !lastPunch) { skipped++; continue; }

    // ─── Evaluation ──────────────────────────────────────────────
    // Apply standard 08:00-17:00 office-hours evaluation when we
    // can. Skip employees who appear in monthly_shift_plans (we
    // don't know their historical shifts so we can't fairly
    // classify their punches as late/short). Skip KSA weekend
    // dates (Fri/Sat) — office staff working those are doing OT,
    // not bound by the office-hours window.
    const isShiftWorker = shiftSet.has(empId);
    const dt = new Date(dateIso + 'T00:00:00');
    const isWeekend = isKsaWeekendDow(dt.getDay());

    // Mawani visit on this date? Treat as 'present' — leaving
    // office for duty visit isn't early leave. Cancelled visits
    // don't count, only planned/completed ones.
    const isMawaniDay = mawaniSet.has(`${empId}|${dateIso}`);
    const policy = policyFor(emp);

    let status, lateMin, earlyMin, expectedStart, expectedEnd, noteText;
    if (isMawaniDay) {
      status        = 'present';
      lateMin       = 0;
      earlyMin      = 0;
      expectedStart = policy.startTime;
      expectedEnd   = policy.endTime;
      noteText      = `Backfill — Mawani duty visit (${policy.label})`;
      mawaniDayCount++;
    } else if (isShiftWorker || isWeekend) {
      status        = 'present';
      lateMin       = 0;
      earlyMin      = 0;
      expectedStart = null;
      expectedEnd   = null;
      if (isShiftWorker) shiftWorkerSkipped++;
      noteText = isShiftWorker
        ? 'Backfill — shift worker, schedule unknown'
        : 'Backfill — KSA weekend punch';
    } else {
      const evalRes = evaluateOffice(firstPunch, lastPunch, policy);
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

    rows.push({
      employee_id:        empId,
      attendance_date:    dateIso,
      status,
      first_punch:        toTime(firstPunch),
      last_punch:         toTime(lastPunch),
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

  // Build empPolicyMap: employee_id → policy { startTime, endTime, ... }
  // Caller can pass `employees` to avoid an extra fetch; otherwise
  // we look up the working_hours_group column from the employees table.
  let empById = options?.employees
    ? new Map((options.employees || []).map(e => [e?.id, e]).filter(([k]) => k))
    : null;
  if (!empById) {
    try {
      const emps = await directGet(
        'employees',
        'select=id,working_hours_group',
        { timeoutMs: 9000 }
      );
      empById = new Map((emps || []).map(e => [e?.id, e]).filter(([k]) => k));
    } catch {
      empById = new Map();
    }
  }

  // Phase 2 — fetch all backfill rows. Project only the columns
  // we need to evaluate; status + minutes + id is enough.
  if (onProgress) try { onProgress({ phase: 'fetching', processed: 0, total: 0 }); } catch {}
  const existing = await directGet(
    'attendance_daily',
    'select=id,employee_id,attendance_date,first_punch,last_punch,status,' +
    'late_minutes,early_leave_minutes,expected_start,expected_end,punch_count,' +
    'leave_request_id,recorded_by' +
    '&source=eq.backfill' +
    '&order=attendance_date.asc',
    { timeoutMs: 30000 }
  ) || [];

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
    const isShiftWorker = shiftSet.has(empId);
    const isMawaniDay = mawaniSet.has(`${empId}|${r.attendance_date}`);

    let newStatus, newLate, newEarly, newExpStart, newExpEnd, newNote;
    if (isMawaniDay) {
      newStatus    = 'present';
      newLate      = 0;
      newEarly     = 0;
      newExpStart  = policy.startTime;
      newExpEnd    = policy.endTime;
      newNote      = `Backfill — Mawani duty visit (${policy.label}) (re-evaluated)`;
      mawaniDayCount++;
    } else if (isShiftWorker || isWeekend) {
      // Force back to a clean 'present' baseline — no eval applies.
      newStatus    = 'present';
      newLate      = 0;
      newEarly     = 0;
      newExpStart  = null;
      newExpEnd    = null;
      newNote = isShiftWorker
        ? 'Backfill — shift worker, schedule unknown (re-evaluated)'
        : 'Backfill — KSA weekend punch (re-evaluated)';
    } else {
      const ev = evaluateOffice(r.first_punch, r.last_punch, policy);
      newStatus   = ev.status;
      newLate     = ev.lateMin;
      newEarly    = ev.earlyMin;
      newExpStart = policy.startTime;
      newExpEnd   = policy.endTime;
      newNote = `Backfill — re-evaluated against ${policy.label} with 15-min grace`;
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
      source:             'backfill',
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
