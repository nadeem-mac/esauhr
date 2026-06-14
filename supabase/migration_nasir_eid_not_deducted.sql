-- =============================================================================
-- Nasir Khan (H94328) — Eid Al-Adha not deducted from annual leave
-- Date: 2026-06-14
--
-- KSA Labor Law: official public holidays (Eid Al-Adha) that fall INSIDE an
-- annual-leave period are NOT counted against the annual-leave balance.
--
-- His leave PERIOD is unchanged — 17 May → 13 June 2026 (28 calendar days,
-- rejoining Sun 14 June). But Eid Al-Adha (26 → 31 May 2026 = 6 days) inside
-- that period is not deducted, so the days CHARGED to his balance = 22.
--
--   Original period      : 17 May → 13 June 2026   (28 calendar days)
--   Less Eid Al-Adha      : 26 → 31 May 2026        ( 6 days)
--   Annual leave deducted : 22 days
--
--   Entitlement           : 30 days
--   Utilised in 2026      : 23 days  (1 day on 2 Apr + 22 for this leave)
--   Remaining balance     : 07 days
--
-- Safe to re-run (idempotent).
-- =============================================================================

-- ─── 1. Charge 22 days (period/end_date unchanged) ──────────────────────────
update public.leave_requests
   set days = 22
 where employee_id   = 'H94328'
   and leave_type_id = 'annual'
   and start_date    = date '2026-05-17';

-- ─── 2. Make sure Eid Al-Adha 2026 is in public_holidays ────────────────────
--   (so the report can show "… 6 Eid Al-Adha holiday days not deducted").
insert into public.public_holidays (date, name)
select d::date, 'Eid Al-Adha'
  from generate_series(date '2026-05-26', date '2026-05-31', interval '1 day') d
 where not exists (
   select 1 from public.public_holidays p where p.date = d::date
 );

-- ─── verification (run manually) ────────────────────────────────────────────
--   select employee_id, start_date, end_date, days, actual_return_date
--     from public.leave_requests
--    where employee_id = 'H94328' and start_date = '2026-05-17';
--
--   select date, name from public.public_holidays
--    where date between '2026-05-26' and '2026-05-31' order by date;
