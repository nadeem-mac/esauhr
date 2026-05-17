-- =============================================================================
-- migration_add_designation.sql
--
-- Adds a `designation` text column to employees. The frontend has been
-- reading `employee?.designation` for several months in the leave/
-- permission/sick approval modals + the rejoining doc + the
-- AttendanceMonthGrid search filter, but the column never existed at
-- the DB level — every read returns undefined and the UI silently
-- falls back to `department` or '—'. Nadeem caught it 2026-05-17
-- when trying to update Nasir's designation and the SELECT failed
-- with 42703.
--
-- WHAT IT DOES
--   Adds the column (idempotent), nothing else. No backfill — every
--   row keeps NULL until HR sets a value via EmployeeEditModal or via
--   a direct UPDATE. The frontend already handles NULL.
--
-- SAFE FOR SUPABASE SQL EDITOR
--   Single ALTER TABLE statement, no transaction control. The editor's
--   implicit transaction wraps it cleanly. No BEGIN/COMMIT inside.
-- =============================================================================

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS designation TEXT;

COMMENT ON COLUMN employees.designation IS
  'Job title / designation shown on auto-generated leave forms, sick approval letters, rejoining reports, and the employees-list search index.';
