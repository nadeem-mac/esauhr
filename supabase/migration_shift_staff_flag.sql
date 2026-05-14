-- =============================================================================
-- migration_shift_staff_flag.sql
--
-- Adds the "is_shift_staff" employee-level boolean flag, set by each
-- manager on their direct reports. Used by the Shift Staff Attendance
-- Report (in the Attendance tab, HR-only) to filter who appears in the
-- in/out/total-hours summary.
--
-- Why a flag and not "anyone who has shifts assigned":
-- A manager may assign a one-off shift to a normally-office-hours
-- person (e.g. weekend cover). Auto-flagging from shift assignments
-- would then pull that person into the routine attendance report,
-- which doesn't reflect their job pattern. The explicit flag keeps
-- "shift staff" as a deliberate categorisation by the manager.
--
-- Audit trail: who set the flag and when. Not used for RLS — managers
-- can toggle their own direct reports' flag, HR can override.
-- =============================================================================

-- 1) Columns
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS is_shift_staff BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shift_staff_marked_by TEXT,
  ADD COLUMN IF NOT EXISTS shift_staff_marked_at TIMESTAMP WITH TIME ZONE;

-- Foreign key separately so the ADD COLUMN above stays atomic in case
-- the constraint exists from a prior partial run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'employees_shift_staff_marked_by_fkey'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_shift_staff_marked_by_fkey
      FOREIGN KEY (shift_staff_marked_by) REFERENCES employees(id);
  END IF;
END $$;

-- 2) Partial index — most employees aren't shift staff, so a partial
-- index on the "true" subset is tiny and lets the report's filter
-- `is_shift_staff=eq.true` resolve from index alone.
CREATE INDEX IF NOT EXISTS idx_employees_is_shift_staff
  ON employees (is_shift_staff)
  WHERE is_shift_staff = true;

-- 3) RLS: no special policy needed. The existing employees policies
-- already allow:
--   • managers to read+update their direct reports (manager_id = me)
--   • HR (Bashaier) to read+update everyone
-- This new column inherits those rules. The toggle UI in
-- ManagerDashboard issues a PATCH against employees.is_shift_staff
-- which only succeeds if the existing policies permit.
