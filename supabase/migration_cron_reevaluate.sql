-- =============================================================================
-- migration_cron_reevaluate.sql — Daily reevaluation cron infrastructure
--
-- Adds:
--   1. cron_runs audit table — every cron invocation logs start/finish/status
--   2. cron_reevaluate_yesterday() — reclassifies yesterday's attendance rows
--      that lacked a shift schedule when written but now have one
--
-- Why this is needed: when a manager enters Sunday's shift on Wednesday,
-- the attendance row written on Sunday morning has notes='schedule unknown'
-- and no expected_start/end. Without this cron, those rows stay misclassified
-- until someone manually clicks "Re-evaluate this month" in the portal.
--
-- The Netlify Scheduled Function `daily-reeval` calls this at 00:01 KSA.
-- It targets ONLY the "schedule unknown" case — full reeval with all edge
-- cases (overnight bridge, leave coverage, mawani days, permission overlap)
-- still happens via the browser-side reevaluateLastNDays() flow when
-- Bashaier opens the page or uploads a file.
--
-- Apply once: psql or Supabase SQL editor. Idempotent — safe to re-run.
-- =============================================================================

-- ── Audit table ──────────────────────────────────────────────────────
-- One row per cron invocation. Lets us see when the job last ran, what
-- it processed, and whether it errored. The UI surfaces the most recent
-- success/failure in the system-health pill.

CREATE TABLE IF NOT EXISTS cron_runs (
  id              BIGSERIAL PRIMARY KEY,
  job_name        TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'error', 'no_op')),
  rows_processed  INT DEFAULT 0,
  rows_updated    INT DEFAULT 0,
  details         JSONB,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_started
  ON cron_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started
  ON cron_runs (job_name, started_at DESC);


-- ── SQL function: cron_reevaluate_yesterday ──────────────────────────
-- Reclassify yesterday's attendance rows that were written without a
-- schedule (notes contains 'schedule unknown' OR expected_start is
-- null) when shifts have been entered after the fact. Only handles the
-- single-shift, schedule-now-known case — leaves complex cases (multi-
-- shift days, overnight bridges, retroactive leave) for the JS reeval.
--
-- 15-minute grace period for late and early-leave matches the JS logic.

CREATE OR REPLACE FUNCTION cron_reevaluate_yesterday()
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  target_date         DATE := (NOW() AT TIME ZONE 'Asia/Riyadh')::date - INTERVAL '1 day';
  rows_processed      INT := 0;
  rows_updated        INT := 0;
  rows_skipped_no_shift INT := 0;
  rec                 RECORD;
  shift_rec           RECORD;
  in_min              INT;
  out_min             INT;
  start_min           INT;
  end_min             INT;
  is_overnight        BOOLEAN;
  late_min            INT;
  early_min           INT;
  details_arr         JSONB := '[]'::JSONB;
BEGIN
  FOR rec IN
    SELECT id, employee_id, attendance_date, first_punch, last_punch, notes
    FROM attendance_daily
    WHERE attendance_date = target_date
      AND (notes ILIKE '%schedule unknown%' OR expected_start IS NULL)
      AND first_punch IS NOT NULL
  LOOP
    rows_processed := rows_processed + 1;

    -- Single shift lookup. If multiple shifts on the same day exist,
    -- we take the first — the JS reeval handles multi-shift cases
    -- properly via overnight bridging, so leave that to it.
    SELECT start_time, end_time INTO shift_rec
    FROM employee_shifts
    WHERE employee_id = rec.employee_id
      AND shift_date = target_date
      AND status NOT IN ('declined', 'cancelled')
    ORDER BY start_time ASC
    LIMIT 1;

    IF shift_rec.start_time IS NULL THEN
      rows_skipped_no_shift := rows_skipped_no_shift + 1;
      CONTINUE;
    END IF;

    in_min    := EXTRACT(HOUR FROM rec.first_punch) * 60 + EXTRACT(MINUTE FROM rec.first_punch);
    start_min := EXTRACT(HOUR FROM shift_rec.start_time) * 60 + EXTRACT(MINUTE FROM shift_rec.start_time);
    end_min   := EXTRACT(HOUR FROM shift_rec.end_time)   * 60 + EXTRACT(MINUTE FROM shift_rec.end_time);
    is_overnight := end_min <= start_min;

    -- Late: 15-minute grace window after shift start.
    late_min := GREATEST(0, in_min - start_min - 15);

    -- Early leave: only meaningful if there's a punch-out AND the
    -- shift is not overnight. Overnight shift end is on the NEXT
    -- calendar day, so we can't compare against same-day last_punch.
    early_min := 0;
    IF rec.last_punch IS NOT NULL AND NOT is_overnight THEN
      out_min   := EXTRACT(HOUR FROM rec.last_punch) * 60 + EXTRACT(MINUTE FROM rec.last_punch);
      early_min := GREATEST(0, end_min - out_min - 15);
    END IF;

    UPDATE attendance_daily
    SET expected_start      = shift_rec.start_time,
        expected_end        = shift_rec.end_time,
        late_minutes        = late_min,
        early_leave_minutes = early_min,
        notes               = 'Cron re-evaluated: shift now on file ('
                              || shift_rec.start_time::text || ' - '
                              || shift_rec.end_time::text || ')'
    WHERE id = rec.id;

    rows_updated := rows_updated + 1;
    details_arr  := details_arr || jsonb_build_object(
      'employee_id', rec.employee_id,
      'shift', shift_rec.start_time::text || '-' || shift_rec.end_time::text,
      'late_min', late_min,
      'early_min', early_min
    );
  END LOOP;

  RETURN jsonb_build_object(
    'target_date',           target_date,
    'rows_processed',        rows_processed,
    'rows_updated',          rows_updated,
    'rows_skipped_no_shift', rows_skipped_no_shift,
    'updates',               details_arr
  );
END;
$$;


-- ── Permission to call the function via PostgREST RPC ────────────────
-- The Netlify cron uses the anon key (same pattern as the rest of the
-- portal). PostgREST exposes any function with EXECUTE granted to the
-- anon role. This is fine for our model — the function only writes
-- attendance_daily rows that already pass the existing RLS, and is
-- idempotent (running it twice produces the same result).

GRANT EXECUTE ON FUNCTION cron_reevaluate_yesterday() TO anon;
GRANT EXECUTE ON FUNCTION cron_reevaluate_yesterday() TO authenticated;


-- ── How to test manually ─────────────────────────────────────────────
-- After applying:
--   SELECT cron_reevaluate_yesterday();
-- Should return JSON with rows_processed, rows_updated, etc.
--
-- To check the audit log:
--   SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT 5;
