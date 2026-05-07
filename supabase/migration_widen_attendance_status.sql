-- =============================================================================
-- migration_widen_attendance_status.sql
--
-- Widens the attendance_daily.status CHECK constraint to allow the
-- new leave-bucket statuses introduced in commit 1d05efd:
--
--   maternity_leave, paternity_leave, hajj_leave,
--   emergency_leave, unpaid_leave
--
-- Without this migration, the leave-seed pass added in commit 8cf66e0
-- (and the classifier's special-leave routing) will fail with:
--
--   ERROR: 23514: new row for relation "attendance_daily" violates
--          check constraint "attendance_daily_status_check"
--
-- This migration is idempotent — safe to re-run if already applied.
-- =============================================================================

ALTER TABLE attendance_daily
  DROP CONSTRAINT IF EXISTS attendance_daily_status_check;

ALTER TABLE attendance_daily
  ADD CONSTRAINT attendance_daily_status_check
  CHECK (status IN (
    'present',
    'late',
    'short',
    'absent',
    'annual_leave',
    'sick_leave',
    'maternity_leave',
    'paternity_leave',
    'hajj_leave',
    'emergency_leave',
    'unpaid_leave',
    'on_leave',
    'off_roster',
    'off_day',
    'pending_certificate'
  ));

-- Verify the constraint is in place. Should return the current
-- definition with all the new statuses listed.
SELECT pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname = 'attendance_daily_status_check';
