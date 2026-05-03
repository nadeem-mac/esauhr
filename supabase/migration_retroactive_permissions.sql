-- =====================================================================
-- Retroactive permissions — auto-clear matching attendance violations
-- =====================================================================
--
-- When HR approves a permission request whose permission_date is in
-- the past, the system auto-clears any matching attendance_violations
-- row (same employee_id + same date + matching violation_type). The
-- violation row stays in the table for audit; we just stamp three
-- new columns to mark it as resolved by the permission.
--
-- WHAT THIS MIGRATION DOES
--
--   1. Adds three columns to attendance_violations:
--        cleared_by_permission_id  uuid → permission_requests(id)
--                                  on delete set null
--        cleared_at                timestamptz
--        cleared_by                text  (PSN of approver, or 'system')
--
--   2. Adds a partial index to support the AttendanceView's "active
--      violations" query (filter cleared_at IS NULL) and the per-row
--      "show me what cleared this" lookup.
--
-- IDEMPOTENCY
--   ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — re-run
--   safe.
-- =====================================================================

-- Note on the column type for cleared_by_permission_id:
--   permission_requests.id is `bigint` (legacy serial) NOT uuid in this
--   project — verified against migration_permissions.sql. The FK type
--   must match. Using bigint here.

alter table public.attendance_violations
  add column if not exists cleared_by_permission_id bigint
    references public.permission_requests(id) on delete set null,
  add column if not exists cleared_at  timestamptz,
  add column if not exists cleared_by  text;

comment on column public.attendance_violations.cleared_by_permission_id is
  'Permission request that retroactively cleared this violation. Set when HR approves a permission whose date matches the violation. NULL for active or system-cleared violations.';
comment on column public.attendance_violations.cleared_at is
  'Soft-clear timestamp. When set, the violation is treated as resolved — it stays in the table for audit but the active-queue surfaces (AttendanceView, MyAttendanceCard, monthly report) filter it out.';
comment on column public.attendance_violations.cleared_by is
  'PSN of the person who cleared this violation, or the literal string ''system'' for automatic clearing.';


-- Partial index for the active-violations query — most violations
-- never get cleared, so the partial index stays small.
create index if not exists idx_attendance_violations_active
  on public.attendance_violations (employee_id, violation_date, violation_type)
  where cleared_at is null;

create index if not exists idx_attendance_violations_cleared_perm
  on public.attendance_violations (cleared_by_permission_id)
  where cleared_by_permission_id is not null;

comment on index public.idx_attendance_violations_active is
  'Drives the AttendanceView "active violations" filter (cleared_at IS NULL) and quick lookups during the cross-reference pass.';
comment on index public.idx_attendance_violations_cleared_perm is
  'Reverse lookup: which violations did this permission clear? Used in the future un-clear flow if a permission is rejected after initial approval.';
