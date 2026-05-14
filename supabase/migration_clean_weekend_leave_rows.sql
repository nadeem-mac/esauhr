-- =============================================================================
-- migration_clean_weekend_leave_rows.sql
--
-- Per Nadeem 2026-05-10: 'if ML, then weekend should not show as ML'.
-- When a leave spans a Friday or Saturday (KSA weekend), the weekend
-- day shouldn't carry the leave status — the staff isn't on leave that
-- day, they're just on a standard weekend off. The leave only consumes
-- working days from the company's perspective.
--
-- Previous backfills (and at least one historical write path) wrote
-- leave-status rows for weekend dates anyway. After the per-type
-- migration that flipped AL → ML for Aminah, her Fridays + Saturdays
-- in May now show as ML on the calendar, which is wrong.
--
-- FIX: convert every attendance_daily row that falls on a Fri/Sat
-- AND currently carries any leave-family status to 'off_day', and
-- detach the leave_request_id link. The next attendance upload will
-- re-confirm them as off_day via the normal weekend path; until then
-- the calendar reads them as OF (the standard off-day chip).
--
-- POSTGRES NOTE:
--   EXTRACT(DOW FROM date) returns 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat.
--   This matches the JS Date.getDay() convention we use client-side.
--
-- IDEMPOTENT: safe to re-run. Only updates rows whose status changes.
-- =============================================================================

UPDATE attendance_daily
SET status            = 'off_day',
    leave_request_id  = NULL,
    recorded_at       = now()
WHERE EXTRACT(DOW FROM attendance_date) IN (5, 6)
  AND status IN (
    'annual_leave', 'sick_leave',
    'maternity_leave', 'paternity_leave',
    'hajj_leave', 'marriage_leave', 'bereavement_leave',
    'unpaid_leave', 'emergency_leave', 'iddah_leave',
    'on_leave'
  );

-- Quick sanity check: should return 0 after the UPDATE settles.
SELECT COUNT(*) AS weekend_leave_rows_remaining
FROM attendance_daily
WHERE EXTRACT(DOW FROM attendance_date) IN (5, 6)
  AND status LIKE '%_leave';
