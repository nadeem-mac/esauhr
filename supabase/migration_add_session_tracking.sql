-- ════════════════════════════════════════════════════════════════════════
--  migration_add_session_tracking.sql
--
--  Adds session-tracking columns to employees so the portal can enforce:
--    1. Single-session login   — only one device can be signed in per
--                                staff PSN at a time. A new login on a
--                                second device kicks the first.
--    2. Auto-logout on idle    — handled client-side, but needs to be
--                                able to write the session-id reset.
--
--  Nadeem 2026-05-21: 'staff should auto logout if system is not used
--  more then 10 mins, if the staff is logged in in one place he cannot
--  login in another place'
--
-- ── COLUMNS ─────────────────────────────────────────────────────────────
--
--    current_session_id   — opaque UUID generated client-side on each
--                           successful login. The staff's browser stores
--                           the same UUID in localStorage. On every
--                           portal load (and via realtime/polling) the
--                           browser compares the local UUID with this
--                           DB value; if they differ, the local session
--                           is stale and gets force-signed-out.
--    current_session_at   — timestamp the UUID was written. Useful for
--                           HR to audit when the active session began.
--
-- ── BACKWARDS COMPATIBILITY ─────────────────────────────────────────────
--
--    Existing sessions (before this migration) have NULL session_id.
--    The client treats NULL as 'first session after upgrade' — accepts
--    it on first load and writes a fresh UUID immediately. So nobody
--    gets unexpectedly logged out by the migration itself.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS current_session_id text,
  ADD COLUMN IF NOT EXISTS current_session_at timestamptz;

-- Optional index for HR audit queries ('who's currently active?')
CREATE INDEX IF NOT EXISTS employees_current_session_at_idx
  ON employees (current_session_at DESC NULLS LAST);

NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  cnt bigint;
BEGIN
  SELECT count(*) INTO cnt FROM employees;
  RAISE NOTICE '══════════════════════════════════════════════════════════';
  RAISE NOTICE ' session tracking columns ready';
  RAISE NOTICE '   employees row count: %', cnt;
  RAISE NOTICE '   PostgREST schema cache reload signalled';
  RAISE NOTICE '══════════════════════════════════════════════════════════';
END $$;
