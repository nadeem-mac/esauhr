-- =============================================================================
-- Clean up confusing leave balances (pre-portal placeholders)
-- Date: 2026-06-14
--
-- Symptom: employee cards showed nonsense like "-19 / 30 days available …
-- 27 used before portal … 22 used in 2026". Two things caused it:
--
--   (a) A negative "pre-portal" adjustment (e.g. -27) was left on the 2026
--       balance row as a placeholder for usage taken before the portal.
--       The real usage is now stored as leave_request rows, so subtracting
--       the placeholder ON TOP double-counted → negative balance.
--   (b) The card UI also re-subtracted that placeholder a second time.
--
-- (b) is fixed in the app (the card now shows simply
--       available = entitlement (+carry +bonus) − used − pending,
--     in green). (a) is data — cleared below.
--
-- After this runs, the balance everywhere reads:
--       entitlement − used_in_year   (e.g. Nasir: 30 − 23 = 7)
--
-- Idempotent.
-- =============================================================================

-- ─── 1. Clear stale negative pre-portal / migration adjustments (2026) ──────
update public.leave_balances
   set adjustment = 0,
       adjustment_note = trim(both ' ·' from
         coalesce(adjustment_note, '')) || ' · cleared 2026-06-14 (pre-portal placeholder; real usage now in leave_request rows)'
 where year = 2026
   and adjustment < 0
   and (
        adjustment_note ilike '%migrat%'
     or adjustment_note ilike '%excel%'
     or adjustment_note ilike '%pre-portal%'
     or adjustment_note ilike '%pre portal%'
     or adjustment_note ilike '%portal usage%'
   );

-- ─── 2. DIAGNOSTIC — why does Nasir read 8 not 7? (run + read, no change) ────
--   `used` counts approved ANNUAL rows whose start_date is in 2026.
--   If only the 22-day May leave shows, the 2 Apr 1-day leave is missing
--   (or not approved / wrong type) → used = 22 → 30-22 = 8. It needs to be
--   a logged row for used to be 23 → 7.
--
--   select start_date, end_date, days, leave_type_id, status
--     from public.leave_requests
--    where employee_id = 'H94328'
--      and leave_type_id = 'annual'
--      and extract(year from start_date) = 2026
--    order by start_date;

-- ─── 3. OPTIONAL — log the 2 Apr 2026 1-day annual leave if it's missing ────
--   UNCOMMENT to run. Guarded so it won't duplicate.
--
-- insert into public.leave_requests
--   (employee_id, leave_type_id, start_date, end_date, days, is_half_day,
--    reason, stage, status, requested_at, manager_decided_at, hr_decided_at, requested_by)
-- select 'H94328', 'annual', date '2026-04-02', date '2026-04-02', 1, false,
--        'Manual entry · historical (2 Apr 2026)', 'approved', 'approved',
--        timestamp '2026-04-02 12:00:00+00', timestamp '2026-04-02 12:00:00+00',
--        timestamp '2026-04-02 12:00:00+00', 'H94830'
--  where not exists (
--    select 1 from public.leave_requests
--     where employee_id = 'H94328' and leave_type_id = 'annual'
--       and start_date = date '2026-04-02'
--  );

-- ─── verification ───────────────────────────────────────────────────────────
--   select employee_id, year, leave_type_id, carried_over, adjustment, adjustment_note
--     from public.leave_balances
--    where employee_id = 'H94328' and year = 2026 and leave_type_id = 'annual';
