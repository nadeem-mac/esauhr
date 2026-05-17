-- =============================================================================
-- migration_employment_status_inactive.sql
--
-- Adds 'inactive' as an allowed value for employees.employment_status.
--
-- WHY
--   The portal's current "Delete employee" action calls
--   admin_delete_employee RPC which destructively wipes the row AND
--   their related history (requests, balances, attendance, etc.).
--   Bashaier asked for a soft-delete pattern instead: the data should
--   be preserved, the staff member excluded from active counts, but
--   still viewable on demand. The existing employment_status enum
--   already has 'departed' and 'terminated' but both carry specific
--   semantics (resigned vs fired). 'inactive' is a neutral catch-all
--   for "archived from active roster, reason not specified".
--
-- WHAT IT DOES
--   • Drops the existing CHECK constraint on employment_status
--   • Re-creates it with 'inactive' added to the allowed list
--
-- SAFE FOR SUPABASE SQL EDITOR
--   No explicit BEGIN/COMMIT — the editor wraps the script in its
--   own transaction. Two DDL statements, both idempotent.
-- =============================================================================

-- Drop the existing check constraint by name. Idempotent — IF EXISTS
-- means re-runs don't fail. Name pattern matches what
-- migration_lifecycle_phase1.sql created.
alter table public.employees
  drop constraint if exists employees_employment_status_check;

-- Re-create the check with 'inactive' added. Includes every value the
-- old constraint allowed PLUS the new one so existing rows in any
-- legitimate status stay valid.
alter table public.employees
  add constraint employees_employment_status_check
  check (employment_status in (
    'pre_joining',  -- hired but not yet started
    'active',       -- currently working
    'on_notice',    -- serving notice period
    'on_leave',     -- long-term leave (maternity, hajj, extended sick)
    'departed',     -- voluntarily left
    'terminated',   -- involuntarily separated
    'inactive'      -- archived, reason unspecified (NEW)
  ));

comment on column public.employees.employment_status is
  'Lifecycle state. Active roster: active, on_notice, on_leave. Archived: inactive, departed, terminated. Pre-onboarding: pre_joining. Inactive is a soft-delete catch-all when neither departed nor terminated applies.';
