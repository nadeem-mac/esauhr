-- Single-punch HR override flag.
-- When an attendance_daily row has only one punch, the device stream
-- can't tell sign-on from sign-off. HR can mark which it was in the
-- Monthly Attendance grid; setting manual_override = true tells the
-- re-evaluation to leave that row alone so the correction sticks.
--
-- Idempotent. Run in the Supabase SQL editor (no BEGIN/COMMIT — the
-- editor wraps statements in an implicit transaction).

ALTER TABLE attendance_daily
  ADD COLUMN IF NOT EXISTS manual_override boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN attendance_daily.manual_override IS
  'HR manually fixed an ambiguous single-punch day; re-evaluation skips this row.';
