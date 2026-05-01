-- migration_bashaier_reports_to_john.sql
--
-- Sets Bashaier's manager to John Ho so HER OWN leave + permission
-- requests route through John Ho first (manager stage), preventing
-- her from being her own approval chain.
--
-- This migration is safe to run multiple times (idempotent).
-- It does NOT touch any other employee's manager_id.

-- ─── 1. Find John Ho's PSN ───────────────────────────────────────────────
-- John Ho is identified by his email johnho@evergreen-shipping.com.sa
-- (used by the docx generator as a hardcoded CC). If he is not yet in
-- the employees table, the migration adds him as a minimal record so
-- the manager_id reference is valid.

INSERT INTO public.employees (id, name, email, department, location)
SELECT 'H94001', 'JOHN HO', 'johnho@evergreen-shipping.com.sa', 'EXEC', 'DMM'
WHERE NOT EXISTS (
  SELECT 1 FROM public.employees
   WHERE LOWER(email) = 'johnho@evergreen-shipping.com.sa'
      OR LOWER(name) LIKE '%john%ho%'
);

-- Resolve the actual John Ho PSN (whether just inserted or already there).
DO $$
DECLARE
  john_psn TEXT;
BEGIN
  SELECT id INTO john_psn
    FROM public.employees
   WHERE LOWER(email) = 'johnho@evergreen-shipping.com.sa'
      OR LOWER(name) LIKE '%john%ho%'
   ORDER BY id ASC
   LIMIT 1;

  IF john_psn IS NULL THEN
    RAISE EXCEPTION 'John Ho not found in employees table after insert attempt — check the email/name lookup';
  END IF;

  -- ─── 2. Bashaier reports to John Ho ────────────────────────────────────
  UPDATE public.employees
     SET manager_id = john_psn
   WHERE id = 'H94830'                            -- Bashaier
     AND (manager_id IS DISTINCT FROM john_psn);  -- only if changing

  RAISE NOTICE 'Bashaier (H94830) manager_id set to %', john_psn;
END
$$;

-- ─── 3. Verify ───────────────────────────────────────────────────────────
-- After running, this query should return one row showing
-- Bashaier's name and her manager being John Ho:
--
--   SELECT e.id, e.name, e.manager_id, m.name AS manager_name
--     FROM public.employees e
--     LEFT JOIN public.employees m ON m.id = e.manager_id
--    WHERE e.id = 'H94830';
