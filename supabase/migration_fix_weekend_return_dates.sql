-- =============================================================================
-- Fix actual_return_date that landed on a KSA weekend
-- Date: 2026-06-14
--
-- Background: the rejoining-entry form was defaulting the return date
-- to end_date + 1 with no weekend skip, so leaves ending on a Thursday
-- (or Saturday) produced a proposed return on Friday/Saturday — days
-- ESAU staff don't report to work (Sun–Thu work week). The form
-- defaults are now KSA-weekend-aware, but historical rows already in
-- the DB still carry the bad values.
--
-- This migration:
--   1. Repairs Nasir Khan H94328 specifically — his 17 May → 13 Jun
--      annual leave now correctly shows return date Sun 14 Jun 2026.
--   2. Sweep: any approved/logged rejoining whose actual_return_date
--      falls on a Friday (dow=5) or Saturday (dow=6) is rolled forward
--      to the next Sunday. Only rows where the return date is at or
--      after the leave end_date are touched.
--
-- Idempotent: re-running is a no-op once everything is on a working day.
-- =============================================================================

-- ─── 1. Nasir Khan (H94328) ─────────────────────────────────────────────────
--   17 May → 13 Jun (Sat) annual leave → return Sunday 14 Jun.
update public.leave_requests
   set actual_return_date = date '2026-06-14'
 where employee_id   = 'H94328'
   and leave_type_id = 'annual'
   and start_date    = date '2026-05-17';

-- ─── 2. Sweep — any other rejoinings sitting on a weekend ───────────────────
--   Postgres extract(dow): Sun=0, Mon=1 … Fri=5, Sat=6. KSA weekend = 5 | 6.
--   Roll Fri → Sun (+2 days), Sat → Sun (+1 day).
update public.leave_requests
   set actual_return_date = case extract(dow from actual_return_date)::int
                              when 5 then actual_return_date + 2
                              when 6 then actual_return_date + 1
                            end
 where actual_return_date is not null
   and extract(dow from actual_return_date)::int in (5, 6)
   and actual_return_date >= end_date;

-- ─── verification queries (run manually) ────────────────────────────────────
--   -- Nasir's record
--   select id, employee_id, start_date, end_date, days, actual_return_date,
--          to_char(actual_return_date, 'Day') as return_dow
--     from public.leave_requests
--    where employee_id = 'H94328' and start_date = '2026-05-17';
--
--   -- Any rejoinings still landing on a KSA weekend?
--   select id, employee_id, leave_type_id, end_date, actual_return_date,
--          to_char(actual_return_date, 'Day') as return_dow
--     from public.leave_requests
--    where actual_return_date is not null
--      and extract(dow from actual_return_date)::int in (5,6);
