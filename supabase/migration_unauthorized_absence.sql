-- =====================================================================
-- Hard pressure — auto-mark unauthorized absence
-- =====================================================================
--
-- Commit 5 of the sick-leave roadmap. Once a Sehhaty certificate is
-- 5+ working days overdue, the system auto-marks the underlying sick
-- days as 'unauthorized_absence' in attendance_violations. Staff is
-- notified via a weekly digest email; if they submit the cert within
-- 14 days of the auto-marking, the system auto-undoes the mark.
-- After 14 days, HR has to undo manually.
--
-- WHAT THIS MIGRATION DOES
--
--   1. Adds a new violation_type value: 'unauthorized_absence'.
--      The existing CHECK constraint listed only the four punch-derived
--      types (late / early_leave / missed_in / missed_out). The
--      constraint name varies across environments because earlier
--      migrations were created via Supabase Studio rather than tracked
--      SQL files, so we use a DO block to find and drop any check
--      constraint that mentions violation_type, then re-add a fresh
--      one with our chosen name.
--
--   2. Adds tracking columns to attendance_violations:
--        source_request_id     — points to leave_requests(id) when this
--                                violation was auto-marked from a sick
--                                declaration. Lets the sweep find its
--                                own previously-marked rows for un-
--                                marking, and lets the UI link a
--                                violation back to its origin.
--        auto_marked_at        — when the system auto-marked. NULL for
--                                manually-recorded violations (the
--                                existing AttendanceView flow).
--        auto_unmarked_at      — when the system (or HR) un-marked it.
--                                Soft-delete pattern; the row stays
--                                for audit but is treated as inactive.
--        auto_unmarked_by      — PSN of the person/system that un-
--                                marked. 'system' for auto-undo within
--                                the 14-day window; an HR PSN for
--                                manual un-marking after the window.
--
--   3. Adds a partial index on source_request_id for fast lookup of
--      "which violations did this declaration produce?". Used by the
--      sweep when un-marking and by the UI when showing the per-
--      declaration badge.
--
-- IDEMPOTENCY
--   All ADD COLUMN uses IF NOT EXISTS. Constraint drop is conditional
--   via DO block. Re-running this migration is safe.
-- =====================================================================

-- ----- 1. Allow 'unauthorized_absence' in violation_type -------------
-- Drop any existing check constraint that mentions violation_type. The
-- name varies by environment (could be attendance_violations_type_chk,
-- attendance_violations_violation_type_check, or anything else),
-- because the original schema was set up via Supabase Studio and is
-- not tracked in this repo.
do $$
declare con_name text;
begin
  for con_name in
    select conname from pg_constraint
    where conrelid = 'public.attendance_violations'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%violation_type%'
  loop
    execute format('alter table public.attendance_violations drop constraint %I', con_name);
  end loop;
end $$;

alter table public.attendance_violations
  add constraint attendance_violations_violation_type_chk
  check (violation_type in (
    'late',
    'early_leave',
    'missed_in',
    'missed_out',
    'unauthorized_absence'
  ));

comment on constraint attendance_violations_violation_type_chk
  on public.attendance_violations is
  'Whitelist of valid violation_type values. Updated by migration_unauthorized_absence.sql to add unauthorized_absence (auto-marked from sick declarations whose cert is 5+ working days overdue).';


-- ----- 2. Tracking columns -------------------------------------------
alter table public.attendance_violations
  add column if not exists source_request_id uuid
    references public.leave_requests(id) on delete set null,
  add column if not exists auto_marked_at    timestamptz,
  add column if not exists auto_unmarked_at  timestamptz,
  add column if not exists auto_unmarked_by  text;

comment on column public.attendance_violations.source_request_id is
  'Leave request that produced this violation via auto-marking. Set only when violation_type = unauthorized_absence and origin = system sweep. Manually-logged violations (the AttendanceView upload flow) leave this null.';
comment on column public.attendance_violations.auto_marked_at is
  'Timestamp when the system sweep auto-marked this violation. Null for manually-logged violations.';
comment on column public.attendance_violations.auto_unmarked_at is
  'Soft-delete timestamp. When set, the violation is treated as inactive — it stays in the table for audit but the staff dashboard, monthly reports, etc. filter it out.';
comment on column public.attendance_violations.auto_unmarked_by is
  'PSN of the person who un-marked, or the literal string ''system'' if the auto-undo (within 14 days of marking when the cert is submitted) fired it.';


-- ----- 3. Index for sweep + UI lookups -------------------------------
create index if not exists idx_attendance_violations_source
  on public.attendance_violations (source_request_id, auto_unmarked_at)
  where source_request_id is not null;

comment on index public.idx_attendance_violations_source is
  'Supports the hard-pressure sweep''s "violations for declaration X that aren''t already un-marked" query. Partial because most violations have source_request_id IS NULL.';
