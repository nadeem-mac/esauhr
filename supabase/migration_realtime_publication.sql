-- Realtime publication membership
-- ──────────────────────────────────────────────────────────────────────────────
-- Supabase Realtime is opt-in per table. Channels can subscribe
-- successfully to any table, but events are ONLY delivered if the table
-- is a member of the supabase_realtime publication. If a table is
-- missing, channel.subscribe() returns 'SUBSCRIBED' but no events ever
-- arrive — silent failure, hardest kind to debug.
--
-- This migration ensures all tables with active realtime subscribers in
-- the app are in the publication. Idempotent: each ALTER PUBLICATION is
-- guarded by a check so re-running is safe.
--
-- Tables and the components that subscribe to them:
--   leave_requests       — PersonalDashboard, PendingSubstitutionsCard,
--                          ManagerDashboard, ReviewerPanel, AppShell
--   permission_requests  — PersonalDashboard, ReviewerPanel, AppShell
--   employees            — AppShell (catches role/manager changes)
--   employee_shifts      — StaffShiftStatusCard, ManagerShiftStatusCard,
--                          PendingShiftApprovalsCard
--   registration_requests — AdminPanel pending count

do $$
declare
  pub_exists boolean;
begin
  -- Make sure the publication itself exists (Supabase creates it by
  -- default but let's be defensive)
  select exists(
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) into pub_exists;

  if not pub_exists then
    create publication supabase_realtime;
  end if;
end $$;

-- Add each table to the publication if it isn't already a member.
-- ALTER PUBLICATION ... ADD TABLE errors if the table is already there,
-- so we use the conditional pattern below.

do $$
declare
  t text;
  needed text[] := ARRAY[
    'leave_requests',
    'permission_requests',
    'employees',
    'employee_shifts',
    'registration_requests'
  ];
begin
  foreach t in array needed loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'Added public.% to supabase_realtime publication', t;
    end if;
  end loop;
end $$;

-- Verify — show the final membership list. Run this after the migration
-- to confirm every table you expect is in the publication.
select tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
order by tablename;
