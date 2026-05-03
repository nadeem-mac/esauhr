-- ══════════════════════════════════════════════════════════════════════════
-- ATTENDANCE — Review log (morning vs end-of-day pass tracking)
-- Idempotent. Safe to re-run.
--
-- Purpose: HR processes the daily attendance file in two passes:
--
--   Day X 10:00      → import Day X file → MORNING pass: late-arrival
--                      check only. Punch-out data is incomplete because
--                      staff are still at their desks, so early-departure
--                      and missed-punch detection would produce mostly
--                      false positives.
--
--   Day X+1 anytime  → re-import Day X file (now complete) → END-OF-DAY
--                      pass: early-departure + missed-punch checks on
--                      complete data.
--
-- The risk: HR forgets the day-after EOD pass. Day X's early-leavers
-- and missed-punches go un-emailed, and the violation evidence quietly
-- ages out. This table records each pass so AttendanceView can surface
-- a "review pending for [date]" banner the next time HR opens the page.
-- ══════════════════════════════════════════════════════════════════════════

create table if not exists public.attendance_review_log (
  -- The xlsx file's data date (csvDate in code). One row per date —
  -- the same date can be reviewed in both modes, recorded against the
  -- same row.
  review_date  date primary key,

  -- Morning pass — set when a file with this review_date is loaded
  -- with viewMode resolving to 'morning'. Updated on every subsequent
  -- morning pass (so morning_at always reflects the latest morning
  -- review for this date).
  morning_at   timestamptz,
  morning_by   text references public.employees(id) on delete set null,

  -- End-of-day pass — set when a file with this review_date is loaded
  -- with viewMode resolving to 'eod'. Same update semantics.
  eod_at       timestamptz,
  eod_by       text references public.employees(id) on delete set null,

  -- Bookkeeping.
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Touch updated_at on every UPDATE so the row's freshness is tracked
-- without relying on either timestamp column individually.
create or replace function public.tg_attendance_review_log_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_attendance_review_log_touch on public.attendance_review_log;
create trigger trg_attendance_review_log_touch
  before update on public.attendance_review_log
  for each row execute function public.tg_attendance_review_log_touch();

-- Index for the pending-review query: the page loads attendance_review_log
-- filtered by review_date >= (today - 14 days). The PK index already
-- covers this, so no additional index is needed — the table is keyed on
-- review_date.

-- ── RLS policy (project convention: permissive RLS, app-layer auth) ──
-- Per CLAUDE.md / userMemories: "All RLS permissive (using true) per
-- project's PSN+PIN auth model". Match existing tables.

alter table public.attendance_review_log enable row level security;

drop policy if exists attendance_review_log_select on public.attendance_review_log;
create policy attendance_review_log_select
  on public.attendance_review_log for select
  using (true);

drop policy if exists attendance_review_log_insert on public.attendance_review_log;
create policy attendance_review_log_insert
  on public.attendance_review_log for insert
  with check (true);

drop policy if exists attendance_review_log_update on public.attendance_review_log;
create policy attendance_review_log_update
  on public.attendance_review_log for update
  using (true)
  with check (true);

-- Grants for the anon key (project uses anon throughout, app-layer auth).
grant select, insert, update on public.attendance_review_log to authenticated, anon;

comment on table public.attendance_review_log is
  'Per-date log of which review passes (morning vs end-of-day) HR has run on the daily attendance file. Used by AttendanceView to surface "EOD review pending for [date]" banners when a morning pass was logged but the EOD pass is overdue.';

-- ══════════════════════════════════════════════════════════════════════════
-- Migration complete.
-- ══════════════════════════════════════════════════════════════════════════
