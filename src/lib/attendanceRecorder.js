// =============================================================================
// attendanceRecorder.js
//
// Translates AttendanceView's `detection` buckets into rows for the
// `attendance_daily` table and upserts them. Called by AttendanceView
// after every successful file upload — the records become the source
// of truth for the monthly attendance calendar grid.
//
// PER ROW:
//   We emit one attendance_daily row per (employee, date) found in the
//   uploaded file's two-day window. Bucket mapping:
//
//     late          → status='late'
//     early         → status='short'
//     onTime        → status='present'
//     onLeave       → status='annual_leave' or 'sick_leave' (looked up)
//     shiftOffDay   → status='off_roster'
//     missedIn      → status='absent' if no punches; otherwise 'late'
//     missedOut     → status='short' (left without final punch)
//     unknownEmp    → skipped (can't record — no employee_id)
//     weekend       → skipped (KSA weekend, intentionally not recorded)
//
// PURE-ABSENCES:
//   For employees with a shift on the date but no row in the file at
//   all, we emit status='absent' with null punches. This covers the
//   "didn't show up" case which the buckets don't capture (since they
//   only iterate over rows that ARE in the file).
//
// IDEMPOTENT:
//   Upsert on (employee_id, attendance_date) — re-uploading the same
//   day overwrites cleanly. Re-uploading after fixing leave records
//   correctly flips an erroneous 'absent' into 'annual_leave', etc.
// =============================================================================

import { directPost } from '../supabaseClient.js';

// HH:MM[:SS] → HH:MM:SS for Postgres `time`. Returns null for empty.
function toTime(s) {
  if (!s || typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  // Allow HH:MM and HH:MM:SS — pad to seconds for consistency.
  if (/^\d{1,2}:\d{2}$/.test(trimmed)) return `${trimmed}:00`;
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  return null;
}

// Compute lateness in minutes given expected start + actual first punch.
// Negative → arrived early. Returns 0 for missing inputs.
function diffMinutes(expectedHHMM, actualHHMM) {
  if (!expectedHHMM || !actualHHMM) return 0;
  const [eh, em] = expectedHHMM.split(':').map(n => parseInt(n, 10));
  const [ah, am] = actualHHMM.split(':').map(n => parseInt(n, 10));
  if ([eh, em, ah, am].some(n => Number.isNaN(n))) return 0;
  return (ah * 60 + am) - (eh * 60 + em);
}

/**
 * Build attendance_daily rows from the AttendanceView detection
 * buckets for a single date. Each bucket entry already has the
 * employee, punch times, and (for late/early) the expected schedule.
 *
 * @param {Object} args
 * @param {string} args.date           - YYYY-MM-DD
 * @param {Object} args.buckets        - The detection object filtered
 *                                       to this date
 * @param {Map} args.shiftByEmpDate    - employeeId → { start, end }
 *                                       for shifts on this date
 * @param {Map} args.leaveByEmpDate    - employeeId → { type, requestId }
 *                                       for approved leave covering
 *                                       this date
 * @param {Set} args.fileEmpIds        - employees with at least one row
 *                                       in the file for this date
 * @param {Array} args.shiftEmployees  - employees with a shift this
 *                                       date (used to detect absences)
 * @param {string} args.recordedBy     - PSN of the recorder (Bashaier)
 * @returns {Array} rows ready for upsert into attendance_daily
 */
export function buildAttendanceRows({
  date,
  buckets,
  shiftByEmpDate,
  leaveByEmpDate,
  fileEmpIds,
  shiftEmployees,
  recordedBy,
}) {
  const rowsByEmp = new Map();

  function pushRow(empId, payload) {
    if (!empId) return;
    // Last writer wins per (employee, date) within a single build.
    rowsByEmp.set(empId, {
      employee_id: empId,
      attendance_date: date,
      recorded_at: new Date().toISOString(),
      recorded_by: recordedBy || null,
      source: 'attendance_upload',
      ...payload,
    });
  }

  // ─── Late bucket ──────────────────────────────────────────────────
  (buckets.late || [])
    .filter(e => e.dateLabel === date)
    .forEach(e => {
      const empId = e.employee?.id;
      const sched = shiftByEmpDate.get(empId);
      const lateMin = diffMinutes(sched?.start, e.punchInStr);
      pushRow(empId, {
        status: 'late',
        first_punch: toTime(e.punchInStr),
        last_punch:  toTime(e.punchOutStr),
        punch_count: (e.punchInStr ? 1 : 0) + (e.punchOutStr ? 1 : 0),
        expected_start: toTime(sched?.start),
        expected_end:   toTime(sched?.end),
        late_minutes: lateMin > 0 ? lateMin : 0,
      });
    });

  // ─── Early-leave bucket ───────────────────────────────────────────
  (buckets.early || [])
    .filter(e => e.dateLabel === date)
    .forEach(e => {
      const empId = e.employee?.id;
      const sched = shiftByEmpDate.get(empId);
      const earlyMin = diffMinutes(e.punchOutStr, sched?.end);
      pushRow(empId, {
        status: 'short',
        first_punch: toTime(e.punchInStr),
        last_punch:  toTime(e.punchOutStr),
        punch_count: (e.punchInStr ? 1 : 0) + (e.punchOutStr ? 1 : 0),
        expected_start: toTime(sched?.start),
        expected_end:   toTime(sched?.end),
        early_leave_minutes: earlyMin > 0 ? earlyMin : 0,
      });
    });

  // ─── On-time bucket ───────────────────────────────────────────────
  (buckets.onTime || [])
    .filter(e => e.dateLabel === date)
    .forEach(e => {
      const empId = e.employee?.id;
      const sched = shiftByEmpDate.get(empId);
      pushRow(empId, {
        status: 'present',
        first_punch: toTime(e.punchInStr),
        last_punch:  toTime(e.punchOutStr),
        punch_count: (e.punchInStr ? 1 : 0) + (e.punchOutStr ? 1 : 0),
        expected_start: toTime(sched?.start),
        expected_end:   toTime(sched?.end),
      });
    });

  // ─── Off-roster (worked outside roster) bucket ────────────────────
  (buckets.shiftOffDay || [])
    .filter(e => e.dateLabel === date)
    .forEach(e => {
      const empId = e.employee?.id;
      pushRow(empId, {
        status: 'off_roster',
        first_punch: toTime(e.punchInStr),
        last_punch:  toTime(e.punchOutStr),
        punch_count: (e.punchInStr ? 1 : 0) + (e.punchOutStr ? 1 : 0),
        notes: 'Worked off-roster (no shift planned for this date)',
      });
    });

  // ─── Missed punch-in (today only): may still be late / present ────
  (buckets.missedIn || [])
    .filter(e => e.dateLabel === date)
    .forEach(e => {
      const empId = e.employee?.id;
      const sched = shiftByEmpDate.get(empId);
      // No punch in but maybe a punch out — treat as 'late' with the
      // explanatory note. If both are missing, fall through to absent
      // detection below.
      const hasOut = !!e.punchOutStr;
      pushRow(empId, {
        status: hasOut ? 'late' : 'absent',
        first_punch: null,
        last_punch:  toTime(e.punchOutStr),
        punch_count: hasOut ? 1 : 0,
        expected_start: toTime(sched?.start),
        expected_end:   toTime(sched?.end),
        notes: 'No punch-in recorded',
      });
    });

  // ─── Missed punch-out (yesterday only): treat as short ────────────
  (buckets.missedOut || [])
    .filter(e => e.dateLabel === date)
    .forEach(e => {
      const empId = e.employee?.id;
      const sched = shiftByEmpDate.get(empId);
      pushRow(empId, {
        status: 'short',
        first_punch: toTime(e.punchInStr),
        last_punch:  null,
        punch_count: e.punchInStr ? 1 : 0,
        expected_start: toTime(sched?.start),
        expected_end:   toTime(sched?.end),
        notes: 'No punch-out recorded',
      });
    });

  // ─── On-leave bucket ──────────────────────────────────────────────
  (buckets.onLeave || [])
    .filter(e => e.dateLabel === date)
    .forEach(e => {
      const empId = e.employee?.id;
      const leave = leaveByEmpDate.get(empId);
      const isSick = (leave?.type || '').toLowerCase().includes('sick');
      pushRow(empId, {
        status: isSick ? 'sick_leave' : 'annual_leave',
        first_punch: null,
        last_punch:  null,
        punch_count: 0,
        leave_request_id: leave?.requestId || null,
      });
    });

  // ─── Pure absences ────────────────────────────────────────────────
  // Anyone who had a shift this date but isn't already accounted for
  // by one of the buckets above. They had a row (rowsByEmp.has(empId))
  // OR they didn't show up at all (not in fileEmpIds).
  for (const emp of (shiftEmployees || [])) {
    const empId = emp.id;
    if (rowsByEmp.has(empId)) continue;
    // Was on leave?
    const leave = leaveByEmpDate.get(empId);
    if (leave) {
      const isSick = (leave.type || '').toLowerCase().includes('sick');
      pushRow(empId, {
        status: isSick ? 'sick_leave' : 'annual_leave',
        leave_request_id: leave.requestId || null,
      });
      continue;
    }
    // Not in the file, not on leave, had a shift → absent
    if (!fileEmpIds.has(empId)) {
      const sched = shiftByEmpDate.get(empId);
      pushRow(empId, {
        status: 'absent',
        first_punch: null,
        last_punch:  null,
        punch_count: 0,
        expected_start: toTime(sched?.start),
        expected_end:   toTime(sched?.end),
        notes: 'No punches recorded for the date',
      });
    }
  }

  return Array.from(rowsByEmp.values());
}

/**
 * Upsert daily attendance rows. Conflict target is the unique
 * (employee_id, attendance_date) — re-runs overwrite cleanly.
 *
 * @param {Array} rows — output of buildAttendanceRows
 * @returns {Promise<void>}
 */
export async function recordAttendanceRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  // Send in chunks of 100 to stay well under PostgREST's payload
  // limits and avoid one huge bulk hammering the channel.
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await directPost('attendance_daily', slice, {
      upsert: true,
      onConflict: 'employee_id,attendance_date',
      timeoutMs: 12000,
    });
  }
}
