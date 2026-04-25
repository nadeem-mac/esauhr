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

-- 4. RLS — light policies. Adjust later if you want stricter rules.
alter table public.employees enable row level security;
alter table public.registration_requests enable row level security;

-- Drop existing if present (so re-running this migration is safe)
drop policy if exists "employees_select_authenticated" on public.employees;
drop policy if exists "employees_admin_all" on public.employees;
drop policy if exists "reg_req_admin_all" on public.registration_requests;
drop policy if exists "reg_req_anon_insert" on public.registration_requests;

-- Anyone authenticated can read employee directory (needed for app to function)
create policy "employees_select_authenticated"
  on public.employees for select
  using (auth.role() = 'authenticated');

-- Admins can do anything to employees
create policy "employees_admin_all"
  on public.employees for all
  using (
    exists (
      select 1 from public.employees e
      where e.auth_user_id = auth.uid() and e.is_admin = true
    )
  );

-- Admins can read/update/delete all registration requests
create policy "reg_req_admin_all"
  on public.registration_requests for all
  using (
    exists (
      select 1 from public.employees e
      where e.auth_user_id = auth.uid() and e.is_admin = true
    )
  );

-- Anonymous (unauthenticated) users can INSERT a registration request
-- (this is how the "Request Access" screen works for unsigned-in staff)
create policy "reg_req_anon_insert"
  on public.registration_requests for insert
  with check (true);

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
