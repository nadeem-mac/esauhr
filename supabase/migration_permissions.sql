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

-- 4) Row-level security
alter table public.permission_requests enable row level security;

drop policy if exists "perm_self_select"    on public.permission_requests;
drop policy if exists "perm_self_insert"    on public.permission_requests;
drop policy if exists "perm_self_cancel"    on public.permission_requests;
drop policy if exists "perm_reviewer_all"   on public.permission_requests;
drop policy if exists "perm_admin_all"      on public.permission_requests;

-- Staff can read their own permission rows
create policy "perm_self_select"
  on public.permission_requests for select
  using (
    exists (select 1 from public.employees e
              where e.auth_user_id = auth.uid() and e.id = permission_requests.employee_id)
  );

-- Staff can insert their own permission rows
create policy "perm_self_insert"
  on public.permission_requests for insert
  with check (
    exists (select 1 from public.employees e
              where e.auth_user_id = auth.uid() and e.id = permission_requests.employee_id)
  );

-- Staff can cancel their own pending rows
create policy "perm_self_cancel"
  on public.permission_requests for update
  using (
    exists (select 1 from public.employees e
              where e.auth_user_id = auth.uid()
                and e.id = permission_requests.employee_id)
    and permission_requests.status = 'pending'
  )
  with check (
    status in ('pending','cancelled')
  );

-- Reviewers (can_review_permissions) and admins can do anything
create policy "perm_reviewer_all"
  on public.permission_requests for all
  using (
    exists (select 1 from public.employees e
              where e.auth_user_id = auth.uid()
                and (e.can_review_permissions = true or e.is_admin = true))
  )
  with check (
    exists (select 1 from public.employees e
              where e.auth_user_id = auth.uid()
                and (e.can_review_permissions = true or e.is_admin = true))
  );

-- The view is admin/reviewer readable
grant select on public.v_monthly_permission_usage to authenticated;

-- 5) Allow only admins to update reviewer-role flags on employees
-- (existing employees policies don't need changes; the admin RLS policy already covers all-columns updates)
