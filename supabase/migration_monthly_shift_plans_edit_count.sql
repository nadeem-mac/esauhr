-- ─────────────────────────────────────────────────────────────────────
-- Add edit_count to monthly_shift_plans
-- ─────────────────────────────────────────────────────────────────────
-- Tracks how many times a manager has edited a saved plan AFTER the
-- initial save. Used by the planner UI to enforce a 3-edit cap:
--
--   edit_count = 0  → fresh save (initial commit, no edits yet)
--   edit_count = 1  → first edit applied
--   edit_count = 2  → second edit applied
--   edit_count = 3  → third edit applied; further edits BLOCKED
--
-- Why a count instead of a boolean?
--   The constitution wants a hard cap, not just a "has been edited"
--   flag. With a count we can show the manager how many edits remain
--   ("2 of 3 edits used") and refuse the 4th.
--
-- Why store it on monthly_shift_plans?
--   It's a property of the (manager_id, plan_month) pair, same as
--   shifts_count and last_committed_at. Fits the existing tracker
--   row naturally without a new table.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

alter table public.monthly_shift_plans
  add column if not exists edit_count integer not null default 0;
