-- ─────────────────────────────────────────────────────────────────────
-- offer_letters: add salary breakdown columns
-- ─────────────────────────────────────────────────────────────────────
-- Per Nadeem: the formal Evergreen joining report breaks salary
-- into Basic / Housing / Transportation / Other Allowance / Total.
-- The offer letter must show the same breakdown so the candidate
-- sees the same numbers on both documents.
--
-- Adds 4 new numeric columns (basic, housing, transportation,
-- other allowance). The existing salary_amount column continues
-- to hold the total — kept as the primary value so existing code
-- and queries don't break.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

alter table public.offer_letters
  add column if not exists salary_basic           numeric default 0,
  add column if not exists salary_housing         numeric default 0,
  add column if not exists salary_transportation  numeric default 0,
  add column if not exists salary_other           numeric default 0;

-- For any existing offer rows (created before this migration),
-- backfill basic = total so the breakdown is non-zero and the
-- letter still renders a complete table. Most likely zero rows in
-- production at this stage but the safety net costs nothing.
update public.offer_letters
   set salary_basic = coalesce(salary_amount, 0)
 where (salary_basic is null or salary_basic = 0)
   and salary_amount is not null
   and salary_amount > 0;
