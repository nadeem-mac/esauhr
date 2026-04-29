-- ══════════════════════════════════════════════════════════════════════════
-- ATTENDANCE — extra tables for violation logging, weekly rotating
-- shift schedules, and monthly evaluation deductions.
-- Run this in your Supabase project's SQL editor (one block).
-- It is idempotent: safe to re-run.
-- ══════════════════════════════════════════════════════════════════════════

-- Extensions (no-op if already created in schema.sql)
create extension if not exists pgcrypto;

-- ─────────────── EMPLOYEE_SHIFTS ───────────────
-- Weekly rotating schedules. One row per (employee, week_start_date).
-- week_start_date is the Sunday of the week the shift covers (KSA week
-- begins Sunday). Each per-day start/end pair is null if that day is off.
create table if not exists public.employee_shifts (
  id                          uuid          primary key default gen_random_uuid(),
  employee_id                 text          not null references public.employees(id) on delete cascade,
  week_start_date             date          not null,
  sun_start time, sun_end time,
  mon_start time, mon_end time,
  tue_start time, tue_end time,
  wed_start time, wed_end time,
  thu_start time, thu_end time,
  fri_start time, fri_end time,
  sat_start time, sat_end time,
  manager_notes               text,
  set_by_manager_id           text          not null references public.employees(id),
  set_at                      timestamptz   not null default now(),
  accepted_by_employee_at     timestamptz,
  accepted_signature          text,
  notified_bashaier_at        timestamptz,
  unique(employee_id, week_start_date)
);

-- ─────────────── ATTENDANCE_VIOLATIONS ───────────────
-- Per-incident log. Bashaier writes a row here every time she clicks one
-- of the "Email notice" buttons in the Attendance tab. Composite unique
-- key dedupes accidental double-clicks.
create table if not exists public.attendance_violations (
  id                  uuid          primary key default gen_random_uuid(),
  employee_id         text          not null references public.employees(id) on delete cascade,
  violation_date      date          not null,
  violation_type      text          not null check (violation_type in ('late','early','missed_in','missed_out')),
  minutes_off         integer,                   -- minutes late or minutes early; null for missed_*
  punch_time          time,                      -- the actual punch time recorded; null for missed
  scheduled_start     time,                      -- their schedule that day
  scheduled_end       time,                      -- their schedule that day
  used_shift_id       uuid          references public.employee_shifts(id) on delete set null,
  recorded_by         text          not null references public.employees(id),
  recorded_at         timestamptz   not null default now(),
  notified_employee_at timestamptz,
  unique(employee_id, violation_date, violation_type)
);

-- ─────────────── ATTENDANCE_EVAL_DEDUCTIONS ───────────────
-- Monthly deduction log. A row is created when a staff member exceeds 5
-- violations in a calendar month. Bashaier reviews and fires the
-- pre-drafted email to their direct manager from her tasks card.
create table if not exists public.attendance_eval_deductions (
  id                          uuid          primary key default gen_random_uuid(),
  employee_id                 text          not null references public.employees(id) on delete cascade,
  month_start                 date          not null,                   -- first day of the month
  total_violations            integer       not null,
  late_count                  integer       not null default 0,
  early_count                 integer       not null default 0,
  missed_count                integer       not null default 0,
  points_deducted             integer       not null,                   -- e.g. 5 per offence-month
  reason                      text,
  reviewed_by                 text          references public.employees(id),
  reviewed_at                 timestamptz,
  email_sent_to_manager_at    timestamptz,
  unique(employee_id, month_start)
);

-- ─────────────── EMPLOYEES — new columns ───────────────
-- Attendance-specific evaluation score. Default 100 is the baseline.
-- Each monthly deduction reduces this. Visible to HR only.
alter table public.employees
  add column if not exists attendance_eval_score      integer not null default 100;
alter table public.employees
  add column if not exists attendance_eval_last_calc  timestamptz;

-- ─────────────── INDEXES ───────────────
create index if not exists idx_violations_emp_date  on public.attendance_violations(employee_id, violation_date);
create index if not exists idx_violations_date      on public.attendance_violations(violation_date);
create index if not exists idx_violations_type      on public.attendance_violations(violation_type);
create index if not exists idx_shifts_emp_week      on public.employee_shifts(employee_id, week_start_date);
create index if not exists idx_shifts_week          on public.employee_shifts(week_start_date);
create index if not exists idx_deductions_emp       on public.attendance_eval_deductions(employee_id);
create index if not exists idx_deductions_month     on public.attendance_eval_deductions(month_start);

-- ─────────────── ROW LEVEL SECURITY ───────────────
-- Following the project's pattern (see schema.sql): allow any authenticated
-- session to read/write at the DB level. The actual gating to "Bashaier
-- and Nadeem only" is enforced in the React app via the ATTENDANCE_PSNS
-- allowlist in AppShell.jsx.
alter table public.attendance_violations        enable row level security;
alter table public.employee_shifts              enable row level security;
alter table public.attendance_eval_deductions   enable row level security;

do $$
declare r record;
begin
  for r in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('attendance_violations','employee_shifts','attendance_eval_deductions')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy "auth_read_violations"   on public.attendance_violations      for select to authenticated using (true);
create policy "auth_write_violations"  on public.attendance_violations      for all    to authenticated using (true) with check (true);
create policy "auth_read_shifts"       on public.employee_shifts            for select to authenticated using (true);
create policy "auth_write_shifts"      on public.employee_shifts            for all    to authenticated using (true) with check (true);
create policy "auth_read_deductions"   on public.attendance_eval_deductions for select to authenticated using (true);
create policy "auth_write_deductions"  on public.attendance_eval_deductions for all    to authenticated using (true) with check (true);
