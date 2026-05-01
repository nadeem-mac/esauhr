-- migration_role_flags.sql
--
-- Replace hardcoded PSN allowlists with proper role/group flags on
-- the employees table. Idempotent — safe to re-run.
--
-- Prior state (in code):
--   • ATTENDANCE_PSNS = {'H94830','H94152'} — who can see the
--     Attendance tab in AppShell.jsx
--   • SUP_TEAM_PSNS   = {'H94830','H94458','H94330','H94712'} — who
--     follows the 08:00→16:00 SUP working-hours schedule, used in
--     AttendanceView.jsx for late/early cutoffs and shift labelling
--
-- This migration:
--   1. Adds two columns:
--      • can_view_attendance  boolean  default false
--      • working_hours_group  text     default 'standard'
--           valid values: 'standard' (default 08:00→17:00),
--                         'sup_team' (08:00→16:00)
--   2. Seeds the existing allowlist values so behaviour does not
--      change after deployment.
--   3. Adds a check constraint on working_hours_group so typos
--      don't silently put someone in an unrecognised schedule.

-- ─── 1. Columns ──────────────────────────────────────────────────────────
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS can_view_attendance boolean DEFAULT false;

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS working_hours_group text DEFAULT 'standard';

-- ─── 2. Seed values ──────────────────────────────────────────────────────
-- Attendance tab: Bashaier + Nadeem
UPDATE public.employees
   SET can_view_attendance = true
 WHERE id IN ('H94830','H94152')
   AND can_view_attendance IS DISTINCT FROM true;

-- SUP team schedule: Bashaier + 3 colleagues
UPDATE public.employees
   SET working_hours_group = 'sup_team'
 WHERE id IN ('H94830','H94458','H94330','H94712')
   AND working_hours_group IS DISTINCT FROM 'sup_team';

-- Everyone else stays on default 'standard'.

-- ─── 3. Constraint ───────────────────────────────────────────────────────
-- Drop first if a previous run created it, then add fresh.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'employees_working_hours_group_chk'
  ) THEN
    EXECUTE 'ALTER TABLE public.employees DROP CONSTRAINT employees_working_hours_group_chk';
  END IF;
END
$$;

ALTER TABLE public.employees
  ADD CONSTRAINT employees_working_hours_group_chk
  CHECK (working_hours_group IN ('standard','sup_team'));

-- ─── Verify ──────────────────────────────────────────────────────────────
-- After running:
--   SELECT id, name, can_view_attendance, working_hours_group
--     FROM public.employees
--    WHERE can_view_attendance OR working_hours_group <> 'standard'
--    ORDER BY id;
-- Expect:
--   • H94152 NADEEM …       attendance=true,  schedule=standard
--   • H94330 …              attendance=false, schedule=sup_team
--   • H94458 …              attendance=false, schedule=sup_team
--   • H94712 …              attendance=false, schedule=sup_team
--   • H94830 BASHAIER …     attendance=true,  schedule=sup_team
