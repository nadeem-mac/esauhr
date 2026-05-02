-- ══════════════════════════════════════════════════════════════════════════
-- LEAVE DESK — PSN Auth Migration
-- Run this in your Supabase SQL editor AFTER the original schema.sql + seed.sql.
-- Idempotent: safe to re-run.
-- ══════════════════════════════════════════════════════════════════════════

-- 1. Add auth linkage columns to employees
alter table public.employees
  add column if not exists auth_user_id uuid unique,
  add column if not exists is_admin boolean default false,
  add column if not exists pin_set_at timestamptz;

create index if not exists idx_employees_auth_user on public.employees(auth_user_id);
create index if not exists idx_employees_is_admin on public.employees(is_admin) where is_admin = true;

-- 2. Registration requests table
-- When a staff member types their PSN on the "Request Access" screen,
-- a row lands here for the admin to review.
create table if not exists public.registration_requests (
  id              uuid        primary key default gen_random_uuid(),
  psn             text        not null,
  requested_at    timestamptz default now(),
  status          text        default 'pending',  -- 'pending' | 'approved' | 'rejected'
  approved_at     timestamptz,
  approved_by     uuid,                            -- admin's auth user id
  pin_generated_at timestamptz,
  pin_delivered   boolean     default false,      -- true once email/notification dispatched
  rejection_note  text,

  constraint reg_req_status check (status in ('pending','approved','rejected'))
);

create index if not exists idx_reg_req_status on public.registration_requests(status);
create index if not exists idx_reg_req_psn on public.registration_requests(psn);

-- 3. Mark the admin user (HumbleGenius = Mohammed Nadeem Nisar Shaikh, PSN H94152)
update public.employees
set is_admin = true
where id = 'H94152';

-- 4. RLS — DELIBERATELY PERMISSIVE.
--
-- This app uses PSN+PIN auth at the application layer with the
-- Supabase anon key for all reads and writes. auth.uid() is null in
-- this setup, so any policy that calls auth.uid() effectively
-- evaluates to false and locks the entire table.
--
-- Worse: an earlier version of this file used
--   exists (select 1 from public.employees e where e.is_admin = true)
-- which causes infinite RLS recursion (a policy on employees that
-- queries employees). Re-running that version on a live database
-- will lock the entire portal — every read of employees triggers
-- the policy, which queries employees, which triggers the policy,
-- and so on, until Postgres bails with 42P17.
--
-- The replacement policies below match the pattern used everywhere
-- else in this codebase (audit_log, attendance_violations, etc.):
-- using (true). All real authorisation lives in the React layer
-- (is_admin checks in JS), which is the actual source of truth for
-- this PSN+PIN auth model.
alter table public.employees enable row level security;
alter table public.registration_requests enable row level security;

-- Defensively drop ALL prior policies on these tables — including
-- ones from older versions of this migration that may still be
-- live. We re-run safe replacements below.
do $$
declare r record;
begin
  for r in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('employees','registration_requests')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- Permissive read+write on employees. App-layer is_admin checks
-- enforce who can do what.
create policy "employees_read_all"
  on public.employees for select using (true);

create policy "employees_write_all"
  on public.employees for all using (true) with check (true);

-- Same for registration_requests. The admin panel filters server-
-- side client-side using the React is_admin flag.
create policy "reg_req_read_all"
  on public.registration_requests for select using (true);

create policy "reg_req_write_all"
  on public.registration_requests for all using (true) with check (true);

-- Helper view for admin panel: pending requests joined with employee details
create or replace view public.v_pending_registrations as
select
  r.id           as request_id,
  r.psn,
  r.requested_at,
  r.status,
  e.name         as employee_name,
  e.location,
  e.department,
  e.email        as employee_email,
  e.auth_user_id as already_has_auth
from public.registration_requests r
left join public.employees e on e.id = r.psn
where r.status = 'pending'
order by r.requested_at desc;
