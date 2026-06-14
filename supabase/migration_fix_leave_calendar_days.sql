-- =============================================================================
-- Fix leave duration: calendar days, not working days
-- Date: 2026-06-14
--
-- KSA Labor Law Art. 109/151/etc — weekly rest days and public holidays
-- falling inside a leave period are counted as part of the leave. Annual
-- and most other statutory leaves must therefore be COUNTED IN CALENDAR
-- DAYS, not working days.
--
-- Earlier the seed had counts_working_days_only = true for annual (and
-- most others), which made calculateRequestDays() return the working-day
-- count at submission time. This under-counted requests (e.g. Nasir
-- H94328's 17 May → 13 June annual leave was saved as 20 days instead
-- of the correct 28 calendar days).
--
-- This migration:
--   1. Flips counts_working_days_only = false for every KSA-law leave
--      type (annual, emergency, hajj, paternity, marriage, bereavement,
--      unpaid, other). Sick + maternity were already false.
--   2. Re-computes the `days` column for every existing leave_request
--      that uses one of those types, setting it to the inclusive
--      calendar-day count between start_date and end_date (half-day
--      requests keep their 0.5 / 1 etc. exactly).
--   3. Repairs Nasir Khan's specific record (H94328 · 17 May 2026
--      annual leave) — end_date corrected to 13 Jun 2026, days = 28.
--
-- Safe to re-run: every step is idempotent.
-- =============================================================================

-- ─── 1. Set calendar-day mode on the affected leave types ───────────────────
update public.leave_types
   set counts_working_days_only = false
 where id in (
   'annual', 'emergency', 'hajj', 'paternity', 'marriage',
   'bereavement', 'unpaid', 'other'
 );

-- ─── 2. Recompute days for all existing requests of those types ─────────────
--   Calendar-day count = (end_date - start_date) + 1 days (inclusive).
--   Half-day requests keep their explicit fractional value (0.5).
update public.leave_requests
   set days = (end_date - start_date) + 1
 where leave_type_id in (
   'annual', 'emergency', 'hajj', 'paternity', 'marriage',
   'bereavement', 'unpaid', 'other', 'sick', 'maternity'
 )
   and coalesce(is_half_day, false) = false
   and days <> (end_date - start_date) + 1;

-- ─── 3. Nasir Khan (H94328) · 17 May → 13 June 2026 annual leave ────────────
--   The submitted end_date was Thu 11 June (last working day). Under the
--   correct KSA calendar-day rule, his leave actually ends Sat 13 June
--   (last day of leave; rejoining Sun 14 June). Duration becomes 28.
update public.leave_requests
   set end_date = date '2026-06-13',
       days     = 28
 where employee_id   = 'H94328'
   and leave_type_id = 'annual'
   and start_date    = date '2026-05-17';

-- ─── verification queries (run manually after migration) ────────────────────
--   select id, name, counts_working_days_only from public.leave_types
--     order by sort_order;
--
--   select id, employee_id, leave_type_id, start_date, end_date, days, status
--     from public.leave_requests
--    where employee_id = 'H94328' and start_date = '2026-05-17';
--
--   -- Any annual-leave row whose days still don't match calendar days?
--   select id, employee_id, start_date, end_date, days,
--          (end_date - start_date) + 1 as calendar_days
--     from public.leave_requests
--    where leave_type_id = 'annual'
--      and coalesce(is_half_day,false) = false
--      and days <> (end_date - start_date) + 1;
