-- =============================================================================
-- migration_evaluation_excuse_dispute.sql
--
-- Build 4 + Build 6 of the EVALUATION FLAG rework (Nadeem 2026-05-17).
--
-- BUILD 4 — excuse / dispute flow
--   • cleared_reason  — when Bashaier manually clears a violation (vs an
--                       automatic clear via retroactive permission, which
--                       uses cleared_by_permission_id), the reason text
--                       is captured here so the audit trail explains WHY.
--                       cleared_at + cleared_by already exist; this is
--                       the third leg of the manual-clear payload.
--   • dispute_text    — when staff disputes/explains a violation, their
--                       brief note (capped at 280 chars in the UI).
--   • dispute_at      — timestamp the dispute was filed. Used to show
--                       'Awaiting HR review' badges and order Bashaier's
--                       review queue.
--
-- BUILD 6 — structured audit linkage
--   • evaluation_scores.violation_ids — array of attendance_violations.id
--                       values that rolled up into this evaluation_scores
--                       row. Before Build 6 the notes column held a
--                       freeform string ('5 late, 2 early...') with no
--                       linkable audit trail. After this migration we
--                       can click any evaluation_scores row and see
--                       exactly which incidents contributed.
--
-- SAFETY
--   All ADD COLUMN ... IF NOT EXISTS so reruns are no-ops. No backfill
--   needed — existing rows keep NULL on the new columns, which the UI
--   already treats as 'no excuse', 'no dispute', 'legacy row'.
--
-- ROLLBACK
--   ALTER TABLE ... DROP COLUMN IF EXISTS — leaves the data intact only
--   if you don't run it. Keep this commented out unless you're sure.
-- =============================================================================

BEGIN;

-- Build 4 — manual-excuse reason text
ALTER TABLE attendance_violations
  ADD COLUMN IF NOT EXISTS cleared_reason TEXT;

-- Build 4 — staff dispute fields
ALTER TABLE attendance_violations
  ADD COLUMN IF NOT EXISTS dispute_text TEXT,
  ADD COLUMN IF NOT EXISTS dispute_at   TIMESTAMPTZ;

-- Build 6 — link the score row back to the specific incidents that
-- caused it. Postgres native text array — no FK to attendance_violations
-- because we want the score row to survive even if a contributing
-- violation gets manually deleted (audit trail preservation > FK
-- integrity for this slice).
ALTER TABLE evaluation_scores
  ADD COLUMN IF NOT EXISTS violation_ids TEXT[];

-- Helpful index for Bashaier's 'disputes awaiting review' query.
-- Partial index keeps it small — only rows with an active dispute
-- (dispute filed but not yet cleared) get indexed.
CREATE INDEX IF NOT EXISTS idx_attn_violations_pending_dispute
  ON attendance_violations (dispute_at DESC)
  WHERE dispute_at IS NOT NULL AND cleared_at IS NULL;

COMMIT;

-- Rollback (uncomment to use):
-- BEGIN;
--   ALTER TABLE attendance_violations
--     DROP COLUMN IF EXISTS cleared_reason,
--     DROP COLUMN IF EXISTS dispute_text,
--     DROP COLUMN IF EXISTS dispute_at;
--   ALTER TABLE evaluation_scores
--     DROP COLUMN IF EXISTS violation_ids;
--   DROP INDEX IF EXISTS idx_attn_violations_pending_dispute;
-- COMMIT;
