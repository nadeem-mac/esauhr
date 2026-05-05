-- ─────────────────────────────────────────────────────────────────────
-- Reset all shift data (pre-launch one-shot)
-- ─────────────────────────────────────────────────────────────────────
-- Wipes employee_shifts + monthly_shift_plans so the managers can
-- re-plan from a clean slate. Run this when:
--
--   • The shift tables hold a mix of legacy / partial / status-
--     unclear rows that's hard to debug
--   • Pre-launch, before any data is committed to attendance
--     enforcement that depends on shift schedules
--   • You want to verify "manager saves a plan → attendance picks
--     it up" end-to-end with no prior data interfering
--
-- WHAT THIS DOES
--   1. Deletes every row from monthly_shift_plans (the per-
--      employee tracker that drives the 3-edit cap, last-saved
--      timestamps, and end-of-month reminder logic)
--   2. Deletes every row from employee_shifts (the actual shift
--      assignments, including any pending / accepted / declined
--      acknowledgments)
--
-- WHAT THIS DOES NOT TOUCH
--   • Schema: no DROP/ALTER. The tables, columns, constraints,
--     indexes, and triggers from the previous migrations remain.
--   • Other tables: employees, leave_requests, attendance
--     uploads, audit_log — all untouched.
--   • Future inserts: managers re-plan via the planner UI as
--     normal; new rows populate the tables fresh.
--
-- ROW-COUNT NOTICES
--   The DO block raises a NOTICE with the row counts after each
--   delete so the migration runner shows visible feedback in the
--   server logs (or in pgAdmin / Supabase Studio if anyone runs
--   it there). The actual app's Settings → Migrations runner
--   doesn't display NOTICEs but the SQL still executes correctly.
--
-- IDEMPOTENT
--   Running a second time is harmless — both DELETEs find empty
--   tables and remove zero rows.
-- ─────────────────────────────────────────────────────────────────────

do $$
declare
  shift_rows_before    integer;
  tracker_rows_before  integer;
begin
  -- Pre-counts — for the NOTICE only.
  select count(*) into shift_rows_before   from public.employee_shifts;
  select count(*) into tracker_rows_before from public.monthly_shift_plans;

  raise notice 'Pre-reset: employee_shifts has % rows, monthly_shift_plans has % rows',
    shift_rows_before, tracker_rows_before;
end $$;

-- 1. Wipe the tracker rows first. These reference (manager_id,
--    employee_id, plan_month) and live independently of
--    employee_shifts — there's no FK relationship — so order
--    here is just for tidiness, not correctness.
--
--    `WHERE id IS NOT NULL` matches every row (id is the UUID
--    PK, never null) but satisfies Supabase's no-bare-DELETE
--    guard. Without an explicit WHERE clause, the platform
--    rejects the statement with code 21000 to protect against
--    accidental table wipes — even when wiping is exactly what
--    you intended.
delete from public.monthly_shift_plans where id is not null;

-- 2. Wipe the actual shift rows. This also clears any pending /
--    accepted / declined acknowledgments since they live on the
--    same row (status, accepted_at, declined_at columns).
delete from public.employee_shifts where id is not null;

do $$
declare
  shift_rows_after    integer;
  tracker_rows_after  integer;
begin
  select count(*) into shift_rows_after   from public.employee_shifts;
  select count(*) into tracker_rows_after from public.monthly_shift_plans;

  raise notice 'Post-reset: employee_shifts has % rows, monthly_shift_plans has % rows',
    shift_rows_after, tracker_rows_after;
end $$;
