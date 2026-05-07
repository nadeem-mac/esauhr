-- ─────────────────────────────────────────────────────────────────────
-- Tier 2 Fix #1 — Data integrity constraints (Sharique-mismatch class)
-- ─────────────────────────────────────────────────────────────────────
-- The attendance_daily UNIQUE constraint already exists (see
-- migration_attendance_daily.sql line 80). This migration covers the
-- remaining gap: employees.manager_id has no foreign key, so a typo
-- or stale reference can persist silently and surface later as
-- confusing emails ("manager NULL set this shift") or wrong
-- attribution lines.
--
-- Approach (safe on a live system):
--   1. AUDIT FIRST. Run the audit queries at the top to surface any
--      orphan manager_id values BEFORE the FK is created.
--   2. Clean any orphans by either nulling them out, fixing them, or
--      tombstoning the offending rows.
--   3. Apply the FK as NOT VALID (no impact on existing rows, blocks
--      future bad writes).
--   4. Optionally VALIDATE later, after cleanup, to enforce the
--      constraint historically too.
--
-- Idempotent — every step uses IF NOT EXISTS / DO $$ ... END $$ blocks.
-- Safe to re-run.
--
-- ─────────────────────────────────────────────────────────────────────


-- ── STEP 1: AUDIT — orphan manager_id values ───────────────────────
-- Run this first. If it returns zero rows, you can safely jump to
-- STEP 3 (NOT VALID is unnecessary if no orphans exist). If it
-- returns rows, decide per-row whether to NULL the manager_id, fix
-- it, or tombstone the employee record before continuing.
--
-- SELECT e.id, e.name, e.manager_id, e.department,
--        'manager not found in employees' AS issue
-- FROM public.employees e
-- LEFT JOIN public.employees m ON m.id = e.manager_id
-- WHERE e.manager_id IS NOT NULL
--   AND m.id IS NULL;


-- ── STEP 1b: AUDIT — set_by orphans on employee_shifts ────────────
-- Run after STEP 1. If this returns rows, the manager attribution
-- email logic is naming people who don't exist in the employees
-- table. Same triage as above.
--
-- SELECT s.id, s.employee_id, s.shift_date, s.set_by,
--        'set_by not found in employees' AS issue
-- FROM public.employee_shifts s
-- LEFT JOIN public.employees m ON m.id = s.set_by
-- WHERE s.set_by IS NOT NULL
--   AND m.id IS NULL;


-- ── STEP 2 (optional): clean orphans ──────────────────────────────
-- Uncomment and run only after reviewing STEP 1's output. Choose ONE
-- of the strategies below. Default recommended: NULL out orphans (the
-- email layer already gracefully handles null manager_id).
--
-- UPDATE public.employees
--    SET manager_id = NULL
--  WHERE manager_id IS NOT NULL
--    AND manager_id NOT IN (SELECT id FROM public.employees);
--
-- UPDATE public.employee_shifts
--    SET set_by = NULL
--  WHERE set_by IS NOT NULL
--    AND set_by NOT IN (SELECT id FROM public.employees);


-- ── STEP 3: add the FK constraints (NOT VALID) ────────────────────
-- NOT VALID lets us add the constraint without checking existing
-- rows. This means future inserts/updates are validated, but legacy
-- bad rows are tolerated until you choose to VALIDATE later.
--
-- ON DELETE SET NULL: if a manager is deleted from employees, their
-- direct reports' manager_id becomes NULL rather than cascading the
-- delete. Same for set_by — historical shift attribution survives a
-- manager being removed, just without the named attribution.

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'employees_manager_id_fkey'
       and conrelid = 'public.employees'::regclass
  ) then
    alter table public.employees
      add constraint employees_manager_id_fkey
      foreign key (manager_id)
      references public.employees(id)
      on delete set null
      not valid;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'employee_shifts_set_by_fkey'
       and conrelid = 'public.employee_shifts'::regclass
  ) then
    alter table public.employee_shifts
      add constraint employee_shifts_set_by_fkey
      foreign key (set_by)
      references public.employees(id)
      on delete set null
      not valid;
  end if;
end $$;


-- ── STEP 4 (optional, after cleanup): VALIDATE the constraints ───
-- Run only AFTER STEP 2 has cleaned all orphans. This walks every
-- existing row and proves the constraint holds. If any row violates,
-- the VALIDATE statement fails and the constraint stays in NOT VALID
-- mode — you can re-run after fixing.
--
-- ALTER TABLE public.employees
--   VALIDATE CONSTRAINT employees_manager_id_fkey;
--
-- ALTER TABLE public.employee_shifts
--   VALIDATE CONSTRAINT employee_shifts_set_by_fkey;


-- ── STEP 5: idempotency unique constraint on employee_shifts ─────
-- One shift per (employee, date) pair. Without this, a bug in the
-- save handler could double-write and the manager UI would show
-- duplicates. The portal already uses ON CONFLICT for upsert, so
-- adding the constraint locks the invariant at the schema level.

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'employee_shifts_employee_id_shift_date_key'
       and conrelid = 'public.employee_shifts'::regclass
  ) then
    alter table public.employee_shifts
      add constraint employee_shifts_employee_id_shift_date_key
      unique (employee_id, shift_date);
  end if;
end $$;
