-- migration_rejoining_enhancements.sql
--
-- Adds three rejoining-process improvements:
--   B) Auto no-show flag — daily cron sets return_status='no_show' on
--      approved leaves where end_date+1 has passed without the staff
--      submitting their rejoining (return_stage IS NULL).
--   D) Balance reconciliation snapshot — capture the leave balance at
--      submit time and at HR-approval time so the printed Rejoining
--      Report shows before/after numbers, and any discrepancy is
--      visible.
--   E) Substitute notifications — small, generic table the app can use
--      to surface "you're free" messages to substitutes when the staff
--      they were covering submits their rejoining.
--
-- Idempotent — safe to re-run.

-- ─── B) AUTO NO-SHOW FLAG ────────────────────────────────────────────────
-- Function: scans for overdue rejoinings and flags them. Returns the
-- count of rows updated so a manual run is observable.
create or replace function public.flag_no_show_rejoinings()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  flagged integer;
begin
  with bumped as (
    update public.leave_requests
       set return_status = 'no_show'
     where stage = 'approved'
       and end_date < (current_date - interval '1 day')
       and (return_stage is null)
       and (return_status is null or return_status = 'pending')
     returning id
  )
  select count(*)::integer into flagged from bumped;
  return flagged;
end;
$$;

grant execute on function public.flag_no_show_rejoinings() to authenticated;

-- Schedule the function to run daily at 06:00 KSA (03:00 UTC) — before
-- the workday starts so Bashaier sees the flags first thing.
-- Requires the pg_cron extension (Supabase has it enabled by default
-- on Pro plan; on Free, run manually or trigger from the app).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Remove any prior schedule of the same name so re-runs don't double up.
    perform cron.unschedule('flag-no-show-rejoinings-daily')
      where exists (
        select 1 from cron.job where jobname = 'flag-no-show-rejoinings-daily'
      );
    perform cron.schedule(
      'flag-no-show-rejoinings-daily',
      '0 3 * * *',                                -- 03:00 UTC = 06:00 KSA
      $cron$ select public.flag_no_show_rejoinings(); $cron$
    );
  end if;
end$$;


-- ─── D) BALANCE RECONCILIATION SNAPSHOT ──────────────────────────────────
-- Two snapshot fields. balance_before captures the available balance at
-- the moment the original leave was approved (so the printed report can
-- show "had X days, took Y, has Z left" in a single readable line).
-- balance_after is set at HR-approval of the rejoining and reflects the
-- recalculated balance — including any auto-credit for early returns.
alter table public.leave_requests
  add column if not exists balance_before numeric,
  add column if not exists balance_after  numeric;


-- ─── E) SUBSTITUTE NOTIFICATIONS ─────────────────────────────────────────
-- Generic notifications table. Type-tagged so the same table can carry
-- other notifications later (e.g. shift reminders) without schema churn.
create table if not exists public.notifications (
  id            uuid        primary key default gen_random_uuid(),
  recipient_id  text        not null references public.employees(id) on delete cascade,
  kind          text        not null,                                     -- e.g. 'substitute_freed'
  title         text        not null,
  body          text,
  related_id    uuid,                                                    -- e.g. leave_requests.id
  read_at       timestamptz,
  created_at    timestamptz default now()
);

create index if not exists idx_notifications_recipient_unread
  on public.notifications(recipient_id, created_at desc)
  where read_at is null;

-- RLS — recipients can read & mark their own notifications read.
alter table public.notifications enable row level security;

drop policy if exists "notif_read_own"   on public.notifications;
drop policy if exists "notif_update_own" on public.notifications;

create policy "notif_read_own" on public.notifications
  for select using (
    recipient_id in (select id from public.employees where auth_user_id = auth.uid())
  );

create policy "notif_update_own" on public.notifications
  for update using (
    recipient_id in (select id from public.employees where auth_user_id = auth.uid())
  );

-- Trigger — when a leave row's return_stage transitions from NULL to
-- 'pending_manager' (i.e. staff submits their rejoining), insert one
-- notification per substitute. They see "you're free" in their UI.
create or replace function public.notify_substitutes_on_rejoin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sub_id text;
  emp_name text;
begin
  -- Only on the NULL → pending_manager transition.
  if (tg_op = 'UPDATE'
      and (old.return_stage is null)
      and new.return_stage = 'pending_manager')
  then
    select name into emp_name from public.employees where id = new.employee_id;
    foreach sub_id in array coalesce(new.substitute_ids, array[]::text[]) loop
      insert into public.notifications (recipient_id, kind, title, body, related_id)
      values (
        sub_id,
        'substitute_freed',
        'Coverage ended',
        coalesce(emp_name, new.employee_id) || ' has returned from leave and submitted their rejoining. Your coverage commitment is now closed.',
        new.id
      );
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_notify_substitutes_on_rejoin on public.leave_requests;
create trigger trg_notify_substitutes_on_rejoin
  after update of return_stage on public.leave_requests
  for each row execute function public.notify_substitutes_on_rejoin();

-- Extend verify_leave RPC to project balance fields so they're visible
-- on the public verify page too.
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
  balance_before           numeric,
  balance_after            numeric,
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
    lr.balance_before, lr.balance_after,
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
-- Run a manual no-show pass right now to backfill any rows that should
-- already have been flagged:
--   select public.flag_no_show_rejoinings();
-- Expect: an integer count of rows newly flagged.
--
-- Test the substitute-notification trigger:
--   update public.leave_requests
--      set return_stage = 'pending_manager',
--          return_submitted_at = now()
--    where id = '<test-leave-uuid>';
--   select * from public.notifications
--    where related_id = '<test-leave-uuid>';
-- Expect: one row per substitute, kind='substitute_freed'.
