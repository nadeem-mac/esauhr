-- ─────────────────────────────────────────────────────────────────────
-- Re-scope monthly_shift_plans to (manager_id, employee_id, plan_month)
-- ─────────────────────────────────────────────────────────────────────
-- Originally keyed by (manager_id, plan_month). The Monthly Planner UI
-- is per-employee though — a manager picks one employee from the
-- dropdown and plans them. Without employee_id in the tracker, saving
-- staff A's plan would mark staff B as "locked" the moment the
-- manager switched dropdowns: same manager, same month → same tracker
-- row returned. Fix is to extend the tracker so each (manager, employee,
-- month) combination has its own row.
--
-- The end-of-month reminder logic (commit 2 of the original 3-commit
-- shift plan) still works fine — its "did the manager plan anything
-- for this month" check just looks for ANY row matching
-- (manager_id, plan_month), which behaves identically with or
-- without employee_id in the row.
--
-- Pre-launch consideration: existing tracker rows from the old design
-- have no employee_id. The cleanest path is to drop them — they're
-- test data and the actual shift data lives in employee_shifts which
-- this migration doesn't touch. After re-saving via the planner, the
-- tracker rebuilds correctly.
--
-- Idempotent — each step uses IF [NOT] EXISTS guards. Safe to re-run
-- and safe to run on a database where employee_id is already present.
-- ─────────────────────────────────────────────────────────────────────

-- 1. Add the column. Allowed null initially so the ADD doesn't reject
--    on rows that pre-existed.
alter table public.monthly_shift_plans
  add column if not exists employee_id text;

-- 2. Drop any rows from the old design (employee_id is null). These are
--    pre-launch test data; nothing of value is lost. The shift data
--    itself is in employee_shifts and is unaffected.
delete from public.monthly_shift_plans where employee_id is null;

-- 3. Now the column can be NOT NULL.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public'
      and table_name='monthly_shift_plans'
      and column_name='employee_id'
      and is_nullable='YES'
  ) then
    alter table public.monthly_shift_plans
      alter column employee_id set not null;
  end if;
end $$;

-- 4. Drop the old (manager_id, plan_month) constraint if still present.
alter table public.monthly_shift_plans
  drop constraint if exists monthly_shift_plans_manager_month_uniq;

-- 5. Add the new (manager_id, employee_id, plan_month) unique
--    constraint. Wrapped in a guarded block so re-runs don't error.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'monthly_shift_plans_manager_employee_month_uniq'
  ) then
    alter table public.monthly_shift_plans
      add constraint monthly_shift_plans_manager_employee_month_uniq
      unique (manager_id, employee_id, plan_month);
  end if;
end $$;

-- 6. Index on employee_id for the per-employee tracker fetch driven
--    by loadPlan.
create index if not exists idx_monthly_shift_plans_employee_id
  on public.monthly_shift_plans(employee_id);
