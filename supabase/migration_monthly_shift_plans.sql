-- ─────────────────────────────────────────────────────────────────────
-- Add monthly_shift_plans tracking table
-- ─────────────────────────────────────────────────────────────────────
-- Records when a manager has committed a shift plan for a given
-- (manager, month) pair. Lets the end-of-month reminder logic answer
-- "did manager X plan month Y?" with one cheap row lookup instead of
-- scanning every employee_shifts row.
--
-- One row per (manager_id, plan_month) — UNIQUE constraint ensures we
-- update-not-insert when a manager re-saves.
--
-- plan_month is the FIRST DAY of the planned month (e.g. 2026-06-01
-- means "the June 2026 plan"). Storing as a date column keeps SQL
-- comparisons simple — to check "did Sonnie plan June?" the reminder
-- code does a single equality match against the first of the month.
--
-- shifts_count is informational — total shifts saved in the most
-- recent commit. Helps Bashaier eyeball whether a plan was suspiciously
-- thin without opening the planner.
--
-- last_committed_at is a UI affordance — the planner shows "last saved
-- 2 hours ago" when the manager re-opens the same month so they know
-- their previous save is still on file.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS) — safe to re-run after partial failure.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.monthly_shift_plans (
  id                  uuid primary key default gen_random_uuid(),
  manager_id          text not null,
  plan_month          date not null,
  shifts_count        integer not null default 0,
  last_committed_at   timestamptz not null default now(),
  last_committed_by   text,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint monthly_shift_plans_manager_month_uniq
    unique (manager_id, plan_month)
);

-- Touch updated_at on UPDATE so realtime consumers can sort by recency.
-- Pattern matches the existing audit_log / leave_requests conventions.
create or replace function public.touch_monthly_shift_plans_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_monthly_shift_plans_updated_at on public.monthly_shift_plans;
create trigger trg_monthly_shift_plans_updated_at
  before update on public.monthly_shift_plans
  for each row execute function public.touch_monthly_shift_plans_updated_at();

-- Indexes:
--   • plan_month — the reminder query filters by month every check
--   • manager_id — the planner queries by manager every page load
create index if not exists idx_monthly_shift_plans_plan_month
  on public.monthly_shift_plans(plan_month);
create index if not exists idx_monthly_shift_plans_manager_id
  on public.monthly_shift_plans(manager_id);

-- RLS off (consistent with the rest of the schema where security is
-- enforced at the app layer using the anon key). The custom direct*
-- helpers in the React app go through PostgREST without per-row policy
-- checks; access is gated by which UI components mount for which roles.
alter table public.monthly_shift_plans enable row level security;
drop policy if exists "monthly_shift_plans_all_anon" on public.monthly_shift_plans;
create policy "monthly_shift_plans_all_anon" on public.monthly_shift_plans
  for all to anon, authenticated
  using (true)
  with check (true);
