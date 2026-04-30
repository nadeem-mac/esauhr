-- ══════════════════════════════════════════════════════════════════════════
-- LEAVE DESK — Permissions two-step approval migration
-- Run AFTER migration_permissions.sql. Idempotent (safe to re-run).
--
-- Mirrors the existing leave_requests two-stage flow on permission_requests:
--   stage = 'pending_manager' → submitted, awaiting direct manager
--         | 'pending_hr'      → manager approved, awaiting HR (Bashaier)
--         | 'approved'        → final, HR approved
--         | 'rejected_by_manager' / 'rejected_by_hr' / 'cancelled'
--
-- The legacy `status` column is preserved and kept in sync via a trigger so
-- existing code that reads status (PermissionStatusCard pills, the monthly
-- usage view) continues to work without modification.
-- ══════════════════════════════════════════════════════════════════════════

-- 1) New columns
alter table public.permission_requests
  add column if not exists stage              text,
  add column if not exists manager_decided_at timestamptz,
  add column if not exists manager_decided_by text references public.employees(id) on delete set null,
  add column if not exists hr_decided_at      timestamptz,
  add column if not exists hr_decided_by      text references public.employees(id) on delete set null,
  add column if not exists manager_note       text,
  add column if not exists hr_note            text;

-- 2) Stage check constraint (drop-then-add so re-runs don't error on type)
alter table public.permission_requests
  drop constraint if exists permission_requests_stage_check;
alter table public.permission_requests
  add  constraint permission_requests_stage_check
       check (stage in ('pending_manager','pending_hr','approved',
                        'rejected_by_manager','rejected_by_hr','cancelled'));

-- 3) Index on stage for the reviewer queue queries
create index if not exists idx_perm_stage on public.permission_requests(stage, requested_at desc);

-- 4) Backfill stage for existing rows. Older rows only had status, so we
--    convert: pending → pending_manager (so existing pending requests now
--    enter the new flow at the manager step), approved → approved (HR-final
--    in the old single-step world remains HR-final here), rejected →
--    rejected_by_hr (we have no record of who rejected so default to HR).
update public.permission_requests
   set stage = case
                 when status = 'pending'   then 'pending_manager'
                 when status = 'approved'  then 'approved'
                 when status = 'rejected'  then 'rejected_by_hr'
                 when status = 'cancelled' then 'cancelled'
                 else 'pending_manager'
               end
 where stage is null;

-- After backfill, stage becomes mandatory
alter table public.permission_requests
  alter column stage set not null,
  alter column stage set default 'pending_manager';

-- 5) Trigger function: keep legacy status synced with stage on insert/update
create or replace function public.tg_perm_status_from_stage()
returns trigger language plpgsql as $$
begin
  new.status := case
                  when new.stage in ('pending_manager','pending_hr') then 'pending'
                  when new.stage = 'approved'                         then 'approved'
                  when new.stage in ('rejected_by_manager','rejected_by_hr') then 'rejected'
                  when new.stage = 'cancelled'                        then 'cancelled'
                  else new.status
                end;
  return new;
end $$;

drop trigger if exists trg_perm_status_from_stage on public.permission_requests;
create trigger trg_perm_status_from_stage
  before insert or update of stage on public.permission_requests
  for each row execute function public.tg_perm_status_from_stage();

-- 6) Grant select on the helpful timestamps to authenticated users so the
--    progress timeline modal can render them. RLS already restricts which
--    rows are visible.
grant select on public.permission_requests to authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- Migration complete. Existing pending rows will start showing as
-- 'Awaiting manager' in the staff-side timeline. Managers will see them
-- in the Reviews tab; HR continues to act on rows in stage='pending_hr'.
-- ══════════════════════════════════════════════════════════════════════════
