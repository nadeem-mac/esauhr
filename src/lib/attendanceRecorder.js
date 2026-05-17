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

import { directGet, directPost } from '../supabaseClient.js';

// Map leave_type_id → attendance_daily.status. Identical mapping to
// markLeaveAttendance.js — same per-type vocabulary so the recorder
// and the on-approval write produce the same row shape for the same
// leave. typeName is a soft fallback for legacy rows that have a
// type string but no canonical id ("Sick leave", "Maternity leave",
// etc. — match by keyword).
function statusForLeaveType(leaveTypeId, typeName) {
  switch (leaveTypeId) {
    case 'sick':         return 'sick_leave';
    case 'annual':       return 'annual_leave';
    case 'maternity':    return 'maternity_leave';
    case 'paternity':    return 'paternity_leave';
    case 'hajj':         return 'hajj_leave';
    case 'marriage':     return 'marriage_leave';
    case 'bereavement':  return 'bereavement_leave';
    case 'unpaid':       return 'unpaid_leave';
    case 'emergency':    return 'emergency_leave';
    case 'iddah':        return 'iddah_leave';
  }
  // Fallback: keyword-match the type name. Catches legacy rows where
  // typeId wasn't populated but type ("Maternity leave") was.
  const t = String(typeName || '').toLowerCase();
  if (t.includes('matern'))     return 'maternity_leave';
  if (t.includes('patern'))     return 'paternity_leave';
  if (t.includes('hajj'))       return 'hajj_leave';
  if (t.includes('marri'))      return 'marriage_leave';
  if (t.includes('bereave'))    return 'bereavement_leave';
  if (t.includes('unpaid'))     return 'unpaid_leave';
  if (t.includes('emergen'))    return 'emergency_leave';
  if (t.includes('iddah'))      return 'iddah_leave';
  if (t.includes('sick'))       return 'sick_leave';
  return 'annual_leave';
}

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
      pushRow(empId, {
        status: statusForLeaveType(leave?.typeId, leave?.type),
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
      pushRow(empId, {
        status: statusForLeaveType(leave.typeId, leave.type),
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
 * Returns a delta summary describing what the upsert just did:
 *   • newRows      — rows that did not exist before (insert)
 *   • updatedRows  — rows where at least one tracked field changed
 *   • unchangedRows— rows whose values exactly matched
 *   • changedFields — per-field changed count (first_punch, last_punch,
 *                    status, total_minutes) for the manager-facing
 *                    "what changed in this upload" summary.
 *
 * The pre-fetch is best-effort: if it fails (network blip, table
 * doesn't exist yet for a fresh install) we fall through to the
 * blind upsert and return a delta object with all rows as 'new' —
 * better than blocking the save on a diff that's just informational.
 *
 * @param {Array} rows — output of buildAttendanceRows
 * @returns {Promise<{
 *   newRows: Array, updatedRows: Array, unchangedRows: Array,
 *   changedFields: { first_punch: number, last_punch: number,
 *                    status: number, total_minutes: number },
 *   total: number,
 * }>}
 */
export async function recordAttendanceRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      newRows: [], updatedRows: [], unchangedRows: [],
      changedFields: { first_punch: 0, last_punch: 0, status: 0, total_minutes: 0 },
      total: 0,
    };
  }

  // Pre-fetch existing rows for the (employee_id, attendance_date)
  // keys we're about to upsert. Used to classify each incoming row
  // as new / updated / unchanged so the upload UI can show Bashaier
  // exactly what this upload added vs what was already on file.
  // Built as a PostgREST `in.(...)` filter over two dimensions — we
  // fetch the entire window and filter in memory afterwards. The
  // window is small enough (≤ 2 days × handful of employees) that
  // pulling a slightly wider slab is cheaper than building a
  // composite filter.
  const empIds = [...new Set(rows.map(r => r.employee_id).filter(Boolean))];
  const dates  = [...new Set(rows.map(r => r.attendance_date).filter(Boolean))];
  const existing = new Map(); // empId|date → existing row

  if (empIds.length > 0 && dates.length > 0) {
    try {
      const empFilter  = empIds.map(id => `"${String(id).replace(/"/g, '')}"`).join(',');
      const dateFilter = dates.map(d => `"${String(d).replace(/"/g, '')}"`).join(',');
      const prior = await directGet(
        'attendance_daily',
        `select=employee_id,attendance_date,first_punch,last_punch,status,total_minutes`
        + `&employee_id=in.(${empFilter})`
        + `&attendance_date=in.(${dateFilter})`,
        { timeoutMs: 10000 },
      );
      for (const r of (prior || [])) {
        const k = `${String(r.employee_id).toUpperCase()}|${String(r.attendance_date).slice(0,10)}`;
        existing.set(k, r);
      }
    } catch (e) {
      // Best-effort — log and continue with all rows treated as new.
      // eslint-disable-next-line no-console
      console.warn('[attendanceRecorder] pre-fetch failed, treating all rows as new:', e?.message || e);
    }
  }

  // Classify each incoming row.
  const newRows = [];
  const updatedRows = [];
  const unchangedRows = [];
  const changedFields = { first_punch: 0, last_punch: 0, status: 0, total_minutes: 0 };

  // Time normalisation: DB may return '08:00:00' where the incoming
  // row has '08:00'. Compare as 'HH:MM' to avoid spurious diffs.
  const normTime = (t) => (t ? String(t).slice(0,5) : null);
  const sameTime = (a, b) => normTime(a) === normTime(b);

  for (const r of rows) {
    const k = `${String(r.employee_id).toUpperCase()}|${String(r.attendance_date).slice(0,10)}`;
    const prior = existing.get(k);
    if (!prior) {
      newRows.push(r);
      continue;
    }
    const fpChanged = !sameTime(prior.first_punch, r.first_punch);
    const lpChanged = !sameTime(prior.last_punch,  r.last_punch);
    const stChanged = String(prior.status || '') !== String(r.status || '');
    const tmChanged = Number(prior.total_minutes || 0) !== Number(r.total_minutes || 0);
    if (fpChanged || lpChanged || stChanged || tmChanged) {
      updatedRows.push({ ...r, _prior: prior, _changes: { fpChanged, lpChanged, stChanged, tmChanged } });
      if (fpChanged) changedFields.first_punch  += 1;
      if (lpChanged) changedFields.last_punch   += 1;
      if (stChanged) changedFields.status       += 1;
      if (tmChanged) changedFields.total_minutes += 1;
    } else {
      unchangedRows.push(r);
    }
  }

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

  return {
    newRows, updatedRows, unchangedRows, changedFields,
    total: rows.length,
  };
}
