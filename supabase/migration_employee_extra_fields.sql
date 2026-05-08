-- =============================================================================
-- Add extra employee fields from ESAU LIST EMPLOYEES 2026
-- Date: 2026-05-08
--
-- Adds 5 new columns to `employees` table to capture data from the
-- master employee spreadsheet:
--
--   • iqama_id          — National ID (Saudi) or Iqama (expat); 10 digits
--   • gender            — 'male' | 'female'; powers maternity/paternity filter
--   • personal_email    — non-@evergreen email (gmail/hotmail/etc)
--   • nationality_full  — full nationality name (Saudi, Indian, Pakistani, ...)
--   • department_ar     — Arabic department name (silent; reserved for bilingual UI)
--
-- Existing columns (`nationality` short form, `email` company email, etc.)
-- are preserved untouched so all current code keeps working.
--
-- All ADDs use IF NOT EXISTS so the migration is safe to re-run.
-- =============================================================================

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS iqama_id         text,
  ADD COLUMN IF NOT EXISTS gender           text,
  ADD COLUMN IF NOT EXISTS personal_email   text,
  ADD COLUMN IF NOT EXISTS nationality_full text,
  ADD COLUMN IF NOT EXISTS department_ar    text;

-- Optional check constraint on gender — keeps the column to two valid
-- values so the maternity/paternity filter can rely on it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_gender_check'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_gender_check
      CHECK (gender IS NULL OR gender IN ('male', 'female'));
  END IF;
END$$;

-- Helpful indexes for searches on the new fields.
CREATE INDEX IF NOT EXISTS idx_employees_iqama_id  ON employees(iqama_id);
CREATE INDEX IF NOT EXISTS idx_employees_gender    ON employees(gender);

-- Verify with:
--   \d employees
-- or:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'employees' ORDER BY ordinal_position;
