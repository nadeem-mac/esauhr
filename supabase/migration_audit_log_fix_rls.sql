-- ══════════════════════════════════════════════════════════════════════════
-- LEAVE DESK — Audit Log RLS Fix
--
-- The original migration_audit_log.sql created RLS policies that require
-- auth.role() = 'authenticated' for INSERT and an authenticated admin
-- match for SELECT. The portal uses app-layer auth with the Supabase
-- anon key (PSN/PIN authentication), so:
--   • auth.role() returns 'anon', not 'authenticated' → every logAction()
--     call has been silently failing to insert (the catch in audit.js
--     swallows the error).
--   • auth.uid() returns null → admins can't read the table either.
--
-- Result: the audit_log table is real but always empty, and the Activity
-- Log surface in the admin panel always shows the empty state.
--
-- This migration replaces those policies with permissive ones that match
-- every other table in the portal (attendance_violations, app_settings,
-- employee_shifts, etc.) — security is enforced at the app layer where
-- isAdmin / isHrReviewer gates are checked before any read or write.
--
-- Idempotent — safe to run repeatedly. Run this AFTER migration_audit_log.sql.
-- ══════════════════════════════════════════════════════════════════════════

-- Make sure the table exists (no-op if migration_audit_log.sql already ran).
-- Don't drop or recreate — preserve any rows that may have been written by
-- a future code path that bypasses logAction().
create table if not exists public.audit_log (
  id            bigserial   primary key,
  actor_user_id uuid,
  actor_psn     text,
  actor_name    text,
  action        text        not null,
  target_type   text,
  target_id     text,
  target_label  text,
  details       jsonb,
  user_agent    text,
  created_at    timestamptz default now()
);

-- Indexes (idempotent)
create index if not exists idx_audit_actor_created on public.audit_log(actor_user_id, created_at desc);
create index if not exists idx_audit_psn_created   on public.audit_log(actor_psn, created_at desc);
create index if not exists idx_audit_action        on public.audit_log(action, created_at desc);
create index if not exists idx_audit_created       on public.audit_log(created_at desc);

-- Enable RLS so policies apply
alter table public.audit_log enable row level security;

-- Drop the restrictive policies from the original migration
drop policy if exists "audit_insert_authenticated" on public.audit_log;
drop policy if exists "audit_select_admin"          on public.audit_log;
-- Also drop any prior permissive policies in case this is re-run
drop policy if exists "anon_read_audit_log"  on public.audit_log;
drop policy if exists "anon_write_audit_log" on public.audit_log;

-- Permissive policies — match the pattern used by every other table in
-- the portal. The app layer (AppShell.jsx) gates the AdminPanel mount
-- on isAdmin / isHrReviewer, so only admins ever see the read surface.
-- Inserts come exclusively from logAction() which is fire-and-forget
-- and only writes the actor's own actions — no cross-user spoofing risk.
create policy "anon_read_audit_log"
  on public.audit_log for select
  using (true);

create policy "anon_write_audit_log"
  on public.audit_log for insert
  with check (true);

-- Sanity check — count rows so the SQL editor shows whether existing
-- inserts have landed (will be 0 if this is a first-time fix, or higher
-- if a prior migration variant succeeded).
select count(*) as audit_log_rows from public.audit_log;
