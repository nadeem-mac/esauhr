-- =============================================================================
-- migration_widen_attendance_status_full.sql
--
-- Follow-up to migration_widen_attendance_status.sql — adds the
-- three remaining leave-type statuses (marriage, bereavement, iddah)
-- that weren't included in the first widening pass. Together with
-- per-type mapping in the write paths (markLeaveAttendance.js +
-- attendanceRecorder.js), this lets the attendance calendar and
-- the Shift Staff Attendance Report show the actual leave type
-- (ML, PL, HJ, MAR, BR, IDD, EM, UP) rather than collapsing
-- everything into AL/SL.
--
-- Idempotent — safe to re-run. ALTER + ADD wrapped in a DROP IF
-- EXISTS so partial-state databases roll forward cleanly.
-- =============================================================================

ALTER TABLE attendance_daily DROP CONSTRAINT IF EXISTS attendance_daily_status_check;

ALTER TABLE attendance_daily ADD CONSTRAINT attendance_daily_status_check
  CHECK (status IN (
    'present', 'late', 'short', 'absent',
    'annual_leave', 'sick_leave',
    'maternity_leave', 'paternity_leave',
    'hajj_leave', 'marriage_leave', 'bereavement_leave',
    'unpaid_leave', 'emergency_leave', 'iddah_leave',
    'on_leave', 'pending_certificate',
    'off_day', 'off_roster'
  ));

-- =============================================================================
-- BACKFILL: walk attendance_daily rows that have a linked
-- leave_request_id but whose current status doesn't match the
-- leave_type_id. Maternity (Aminah, others) currently shows as
-- 'annual_leave' even after the previous widening — because the
-- write paths defaulted to annual_leave. This backfill catches
-- everyone retroactively.
-- =============================================================================

UPDATE attendance_daily ad
SET status = CASE lr.leave_type_id
      WHEN 'sick'        THEN 'sick_leave'
      WHEN 'annual'      THEN 'annual_leave'
      WHEN 'maternity'   THEN 'maternity_leave'
      WHEN 'paternity'   THEN 'paternity_leave'
      WHEN 'hajj'        THEN 'hajj_leave'
      WHEN 'marriage'    THEN 'marriage_leave'
      WHEN 'bereavement' THEN 'bereavement_leave'
      WHEN 'unpaid'      THEN 'unpaid_leave'
      WHEN 'emergency'   THEN 'emergency_leave'
      WHEN 'iddah'       THEN 'iddah_leave'
      ELSE                    ad.status   -- leave untouched for unknown types
    END,
    recorded_at = now()
FROM leave_requests lr
WHERE ad.leave_request_id = lr.id
  AND ad.status <> CASE lr.leave_type_id
      WHEN 'sick'        THEN 'sick_leave'
      WHEN 'annual'      THEN 'annual_leave'
      WHEN 'maternity'   THEN 'maternity_leave'
      WHEN 'paternity'   THEN 'paternity_leave'
      WHEN 'hajj'        THEN 'hajj_leave'
      WHEN 'marriage'    THEN 'marriage_leave'
      WHEN 'bereavement' THEN 'bereavement_leave'
      WHEN 'unpaid'      THEN 'unpaid_leave'
      WHEN 'emergency'   THEN 'emergency_leave'
      WHEN 'iddah'       THEN 'iddah_leave'
      ELSE                    ad.status
    END;
