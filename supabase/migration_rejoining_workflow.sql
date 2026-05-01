-- migration_rejoining_workflow.sql
--
-- Replaces the old "manager clicks Confirm" flow with a 3-step approval
-- mirroring the leave application itself:
--
--   1. Staff submits rejoining request after returning from leave
--      → return_stage = 'pending_manager'
--   2. Manager approves (or rejects with reason)
--      → return_stage = 'pending_hr'  (or 'rejected_by_manager')
--   3. HR / Bashaier final approval
--      → return_stage = 'approved'    (or 'rejected_by_hr')
--      → returned_at, return_confirmed_by populated at this step
--      → Rejoining Report (.docx) becomes available
--
-- Idempotent.

-- 1) Workflow columns ────────────────────────────────────────────────────────
alter table public.leave_requests
  add column if not exists return_stage              text,
  add column if not exists return_submitted_at       timestamptz,
  add column if not exists return_manager_decided_at timestamptz,
  add column if not exists return_manager_decided_by text references public.employees(id) on delete set null,
  add column if not exists return_hr_decided_at      timestamptz,
  add column if not exists return_hr_decided_by      text references public.employees(id) on delete set null,
  add column if not exists return_rejection_reason   text;

-- 2) Stage check (drop-then-add for re-runnability)
alter table public.leave_requests
  drop constraint if exists leave_requests_return_stage_check;
alter table public.leave_requests
  add  constraint leave_requests_return_stage_check
       check (return_stage is null or return_stage in
              ('pending_manager','pending_hr','approved',
               'rejected_by_manager','rejected_by_hr'));

-- 3) Backfill — rows that already went through the old "manager confirms"
--    flow (returned_at IS NOT NULL but return_stage NULL) are backfilled
--    to return_stage='approved' so the data model is internally consistent.
update public.leave_requests
   set return_stage = 'approved'
 where returned_at is not null and return_stage is null;

-- 4) Index for the pending-rejoining queries (manager + HR cards)
create index if not exists idx_leave_pending_rejoining
  on public.leave_requests (return_stage, end_date)
  where return_stage in ('pending_manager','pending_hr');

-- 5) Extend verify_leave RPC ─────────────────────────────────────────────────
-- DROP first because RETURNS TABLE shape changed.
drop function if exists public.verify_leave(uuid);

create or replace function public.verify_leave(p_id uuid)
returns table (
  id                       uuid,
  leave_type_id            text,
  start_date               date,
  end_date                 date,
  days                     numeric,
  is_half_day              boolean,
  stage                    text,
  status                   text,
  requested_at             timestamptz,
  manager_decided_at       timestamptz,
  hr_decided_at            timestamptz,
  returned_at              timestamptz,
  actual_return_date       date,
  return_stage             text,
  return_status            text,
  return_submitted_at      timestamptz,
  return_manager_decided_at timestamptz,
  return_hr_decided_at     timestamptz,
  employee_id              text,
  employee_name            text,
  employee_department      text,
  employee_location        text
)
language sql
security definer
set search_path = public
as $$
  select
    lr.id, lr.leave_type_id, lr.start_date, lr.end_date,
    lr.days, lr.is_half_day, lr.stage, lr.status,
    lr.requested_at, lr.manager_decided_at, lr.hr_decided_at,
    lr.returned_at, lr.actual_return_date,
    lr.return_stage, lr.return_status,
    lr.return_submitted_at, lr.return_manager_decided_at, lr.return_hr_decided_at,
    lr.employee_id, e.name, e.department, e.location
  from public.leave_requests lr
  left join public.employees e on e.id = lr.employee_id
  where lr.id = p_id
    and lr.stage = 'approved'
  limit 1;
$$;

grant execute on function public.verify_leave(uuid) to anon;
grant execute on function public.verify_leave(uuid) to authenticated;

-- ─── Verify ───────────────────────────────────────────────────────────────
-- After running, test:
--   select id, end_date, return_stage from leave_requests
--    where stage='approved' and end_date < current_date
--    order by end_date desc limit 5;
--   select * from verify_leave('<some-approved-uuid>');
-- Expect: rows that already went through the old flow show
-- return_stage='approved'; rows that haven't yet show NULL.
