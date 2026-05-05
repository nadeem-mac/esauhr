-- ─────────────────────────────────────────────────────────────────────
-- attendance_daily — persistent daily attendance log
-- ─────────────────────────────────────────────────────────────────────
-- One row per (employee, calendar date). Captures everything the
-- calendar grid needs to render and the detail tooltip to expand:
--
--   • Status        — categorical (present, late, absent, leave, etc.)
--   • Punch summary — first/last punch times (HH:MM:SS), punch count
--   • Schedule ref  — what shift was expected, computed late/early
--                     minutes against that
--   • Leave ref     — which leave_request covers the date, if any
--   • Audit         — who recorded it and from what source
--
-- Populated automatically by AttendanceView when Bashaier uploads a
-- file. Each (employee, date) pair upserts so re-uploading the same
-- file produces no duplicates and lets her fix mistakes by re-sending.
--
-- The unique constraint enforces the "one row per employee per day"
-- invariant. Re-upload writes via ON CONFLICT (employee_id,
-- attendance_date).
--
-- STATUS ENUM (kept tight at 8 buckets for the calendar palette;
-- finer-grained reasoning lives in late_minutes / early_leave_minutes
-- and the optional notes field):
--
--   present       — punched in on time, expected full shift
--   late          — punched in past grace
--   short         — left early, partial day
--   absent        — had a shift, zero punches in the file
--   annual_leave  — covered by approved annual leave_request
--   sick_leave    — covered by approved sick leave_request
--   off_day       — manager-marked off-day OR no shift planned
--   off_roster    — worked but no shift planned (cover, etc.)
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.attendance_daily (
  id                  uuid primary key default gen_random_uuid(),

  -- Identity
  employee_id         text not null,
  attendance_date     date not null,

  -- Categorical status driving the grid color
  status              text not null
    check (status in (
      'present', 'late', 'short', 'absent',
      'annual_leave', 'sick_leave',
      'off_day', 'off_roster'
    )),

  -- Punch summary (HH:MM:SS strings stored as time so they sort and
  -- compare cleanly; nullable for leave / off / absent rows)
  first_punch         time,
  last_punch          time,
  punch_count         integer default 0,

  -- Schedule reference + derived metrics. Null when no shift was
  -- planned for the date (off_roster / off_day rows).
  expected_start      time,
  expected_end        time,
  late_minutes        integer default 0,
  early_leave_minutes integer default 0,

  -- Leave reference for annual_leave / sick_leave rows. References
  -- leave_requests.id when applicable.
  leave_request_id    uuid,

  -- Optional free-text note set by the recorder. Surfaces in the
  -- tooltip. Used for things like "covered for X" or "left due to
  -- emergency."
  notes               text,

  -- Audit
  recorded_at         timestamptz not null default now(),
  recorded_by         text,
  source              text not null default 'attendance_upload',

  unique (employee_id, attendance_date)
);

-- Speed up the grid's per-month per-employee fetch
create index if not exists attendance_daily_emp_date_idx
  on public.attendance_daily(employee_id, attendance_date);

create index if not exists attendance_daily_date_idx
  on public.attendance_daily(attendance_date);

-- Add to realtime publication so the grid refreshes live as Bashaier
-- uploads new files (or re-uploads to fix something).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'attendance_daily'
  ) then
    alter publication supabase_realtime add table public.attendance_daily;
  end if;
end $$;
