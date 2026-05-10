// =============================================================================
// markLeaveAttendance.js
//
// When an HR approver finalises a leave request, the days covered by
// the leave must also appear correctly on the attendance grid as
// status='sick_leave' (or 'annual_leave', etc.) — otherwise the
// monthly calendar shows the staff as 'absent' or 'present' even
// though they were on approved leave.
//
// This helper iterates from start_date to end_date and upserts one
// attendance_daily row per working day (Sun–Thu in KSA) with the
// appropriate status, link back to the leave_request_id, and null
// punches. Friday and Saturday are intentionally skipped — the
// weekend isn't tracked in attendance_daily by design.
//
// IDEMPOTENT: upsert on (employee_id, attendance_date). Re-running
// after a re-approval cleanly overwrites stale rows. If the staff
// had already been marked 'present' by an attendance file upload
// (the back-at-work-without-cert scenario), this flip restores the
// row to 'sick_leave' once the cert is in and HR approves.
//
// SAFE: failures are warnings, not errors. The leave-request approval
// itself has already succeeded by the time this runs; if attendance
// patching fails, we log it but don't unwind. The next attendance
// upload will correct it via the same upsert path.
// =============================================================================

import { directPost } from '../supabaseClient.js';

// KSA workweek runs Sunday–Thursday. JS Date.getDay() returns 0=Sun,
// 1=Mon, ..., 5=Fri, 6=Sat. So Fri (5) and Sat (6) are off.
function isWeekend(yyyymmdd) {
  // yyyymmdd is "2026-05-10"; build Date in UTC to avoid TZ drift.
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  return day === 5 || day === 6;
}

// Walk start..end inclusive, yielding every YYYY-MM-DD string.
function* dateRange(startISO, endISO) {
  const [sy, sm, sd] = startISO.split('-').map(Number);
  const [ey, em, ed] = endISO.split('-').map(Number);
  let cur = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  while (cur <= end) {
    const dt = new Date(cur);
    const yyyy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    yield `${yyyy}-${mm}-${dd}`;
    cur += 86400000;
  }
}

// Map leave_type_id → attendance_daily.status value.
// The attendance_daily.status column has a CHECK constraint that
// only allows these values: 'present', 'late', 'short', 'absent',
// 'annual_leave', 'sick_leave', 'off_day', 'off_roster'. Anything
// outside that fails with a 23514. So we collapse non-sick/annual
// leave types into 'annual_leave' — not perfect taxonomy, but it
// keeps the row insertable. A future migration could widen the
// constraint to include maternity_leave, unpaid_leave, etc.
function statusForLeaveType(leaveTypeId) {
  switch (leaveTypeId) {
    case 'sick':            return 'sick_leave';
    case 'annual':          return 'annual_leave';
    default:                return 'annual_leave';
  }
}

/**
 * Mark every working day from start_date to end_date as the
 * appropriate leave status on attendance_daily. Weekends skipped.
 *
 * @param {object} request — leave_requests row (needs employee_id,
 *                            leave_type_id, start_date, end_date, id).
 * @returns {Promise<{updated: number, skipped: number, errors: number}>}
 */
export async function markLeaveDaysAttendance(request) {
  const result = { updated: 0, skipped: 0, errors: 0 };
  if (!request?.employee_id || !request?.start_date || !request?.end_date) {
    console.warn('markLeaveDaysAttendance: missing fields', request);
    return result;
  }

  const status = statusForLeaveType(request.leave_type_id);

  // Build payloads first so we can batch the upsert in one POST.
  const payloads = [];
  for (const dateStr of dateRange(request.start_date, request.end_date)) {
    if (isWeekend(dateStr)) {
      result.skipped++;
      continue;
    }
    payloads.push({
      employee_id: request.employee_id,
      attendance_date: dateStr,
      status,
      leave_request_id: request.id,
      first_punch: null,
      last_punch: null,
      // Note: minutes_late, minutes_short etc. left to default (zero
      // or null per schema) — they don't apply on a leave day.
      source: 'leave_approval',
    });
  }

  if (!payloads.length) return result;

  try {
    // PostgREST upsert via the dedicated upsert option in directPost,
    // which sets the right Prefer header and the on_conflict query
    // param. The unique key (employee_id, attendance_date) is the
    // merge target; status + leave_request_id are overwritten.
    await directPost('attendance_daily', payloads, {
      timeoutMs: 12000,
      upsert: true,
      onConflict: 'employee_id,attendance_date',
    });
    result.updated = payloads.length;
  } catch (err) {
    console.warn('markLeaveDaysAttendance upsert failed:', err?.message || err);
    result.errors = payloads.length;
  }

  return result;
}
