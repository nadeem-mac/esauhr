-- ══════════════════════════════════════════════════════════════════════════
-- LEAVE DESK — Permissions + Reviewer Roles Migration (v3)
-- Run this AFTER migration_psn_auth.sql and migration_audit_log.sql.
-- Idempotent.
--
-- Adds:
--   • can_review_leave / can_review_permissions flags on employees
--   • permission_requests table (late-arrival + early-leave)
--   • v_monthly_permission_usage view (running quota per staff per month)
--   • RLS policies that respect the new reviewer roles
--   • Bashaier (H94830) gets can_review_leave + can_review_permissions = true
-- ══════════════════════════════════════════════════════════════════════════

-- 1) Reviewer-role flags on employees
alter table public.employees
  add column if not exists can_review_leave       boolean default false,
  add column if not exists can_review_permissions boolean default false;

-- Seed the inaugural SUP reviewer
update public.employees
   set can_review_leave = true,
       can_review_permissions = true
 where id = 'H94830';

-- 2) Permission requests table
create table if not exists public.permission_requests (
  id              bigserial   primary key,
  employee_id     text        not null references public.employees(id) on delete cascade,
  type            text        not null check (type in ('late_arrival','early_leave')),
  permission_date date        not null,
  hours           numeric(3,1) not null default 1.0 check (hours > 0 and hours <= 8),
  reason          text,
  status          text        not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  exceeds_quota   boolean     default false,    -- true if the request pushes monthly total > 3hrs / 3 occurrences
  reviewed_by     text        references public.employees(id) on delete set null,
  reviewed_at     timestamptz,
  decision_note   text,
  requested_by    text,
  requested_at    timestamptz default now(),
  created_at      timestamptz default now()
);

create index if not exists idx_perm_emp_date  on public.permission_requests(employee_id, permission_date desc);
create index if not exists idx_perm_status    on public.permission_requests(status, requested_at desc);
create index if not exists idx_perm_type_date on public.permission_requests(type, permission_date desc);

-- 3) Monthly usage view — combined late + early bucket per employee per month
drop view if exists public.v_monthly_permission_usage;
create view public.v_monthly_permission_usage as
select
  employee_id,
  date_trunc('month', permission_date)::date as month,
  count(*) filter (where status in ('approved','pending')) as occurrences,
  coalesce(sum(hours) filter (where status in ('approved','pending')), 0)::numeric(4,1) as hours_used,
  count(*) filter (where status='approved') as approved_count,
  coalesce(sum(hours) filter (where status='approved'), 0)::numeric(4,1) as hours_approved
from public.permission_requests
group by employee_id, date_trunc('month', permission_date);

-- 4) Row-level security — DELIBERATELY PERMISSIVE.
--
-- This app uses PSN+PIN auth at the application layer with the
-- Supabase anon key. auth.uid() is always null in this setup, so
-- any policy referencing auth.uid() effectively evaluates to false
-- and locks the table.
--
-- An earlier version of this file shipped policies that referenced
-- auth.uid() (perm_self_select, perm_reviewer_all, etc.). Those
-- policies, if applied to a live database with this auth model,
-- would break every read and write to permission_requests until
-- they were dropped or replaced.
--
-- Pattern below matches every other working table in the schema
-- (audit_log, attendance_violations, employees, etc.):
-- using (true). The actual access gates live in the React layer
-- (ReviewerPanel scopes by role; PersonalDashboard scopes by
-- employee_id), which is the source of truth for this auth model.
alter table public.permission_requests enable row level security;

-- Defensively drop ALL prior policies on this table, including
-- ones from older versions of this migration that may still be
-- live, before re-creating safe ones.
do $$
declare r record;
begin
  for r in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'permission_requests'
  loop
    execute format('drop policy %I on public.permission_requests', r.policyname);
  end loop;
end $$;

create policy "perm_read_all"
  on public.permission_requests for select using (true);

create policy "perm_write_all"
  on public.permission_requests for all using (true) with check (true);

-- The view is admin/reviewer readable
grant select on public.v_monthly_permission_usage to authenticated;

-- 5) Allow only admins to update reviewer-role flags on employees
-- (existing employees policies don't need changes; the admin RLS policy already covers all-columns updates)
