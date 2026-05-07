-- ─────────────────────────────────────────────────────────────────────
-- Tier 3 Fix #3 — Email outcome tracking
-- ─────────────────────────────────────────────────────────────────────
-- Adds an `email_outcome` column to attendance_violations so HR can
-- retroactively mark whether a violation email was correct, retracted
-- (sent in error), or superseded (replaced by a corrected one).
--
-- The point: gives Bashaier a feedback loop on the system's accuracy.
-- After a few months of data, queries like
--
--   SELECT email_outcome, COUNT(*) FROM attendance_violations
--    WHERE recorded_at >= '2026-05-01' GROUP BY 1;
--
-- tell us how often violation emails turned out to be wrong, so we
-- can target detection improvements where it matters.
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

do $$
begin
  -- Add the column with a CHECK constraint enumerating valid values.
  -- NULL is allowed and means "no outcome marked yet" — most rows
  -- start in this state and may stay there if Bashaier doesn't review.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'attendance_violations'
       and column_name = 'email_outcome'
  ) then
    alter table public.attendance_violations
      add column email_outcome text
      check (email_outcome is null or email_outcome in (
        'correct',     -- the email was justified, no correction needed
        'retracted',   -- the email was sent but later determined wrong
        'superseded'   -- the row was reclassified by a re-eval; the
                       -- original email is now stale (e.g., leave
                       -- approved retroactively turned the late row
                       -- into annual_leave)
      ));
  end if;

  -- Audit who marked the outcome and when. NULL when email_outcome
  -- itself is NULL.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'attendance_violations'
       and column_name = 'email_outcome_at'
  ) then
    alter table public.attendance_violations
      add column email_outcome_at timestamptz;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'attendance_violations'
       and column_name = 'email_outcome_by'
  ) then
    alter table public.attendance_violations
      add column email_outcome_by text;
  end if;
end $$;

-- Index for the future analytics view — scoped by outcome state +
-- date, since most queries will be "how many retracted in last
-- month?" or "how many superseded this quarter?".
-- Note: `attendance_violations` uses `recorded_at` (not created_at)
-- as the row timestamp — confirmed against the live schema and
-- mirrored elsewhere in the codebase (MyAttendanceCard.jsx,
-- monthlyAttendanceReport.js).
create index if not exists attendance_violations_outcome_recorded_idx
  on public.attendance_violations(email_outcome, recorded_at)
 where email_outcome is not null;
