-- migration_rejoining.sql
--
-- Adds return-from-leave tracking to leave_requests and extends the
-- public verify_leave RPC so the printed Rejoining Report can be
-- verified the same way the Vacation Form already is.
--
-- DESIGN
--   Return is tracked AS A SUB-STATE of the existing approved leave
--   row — NOT a new stage and NOT a new table. The leave stays at
--   stage='approved' throughout; the new columns just record what
--   happened after end_date.
--
--   return_status values:
--     'pending'   — leave ended but not yet confirmed (default)
--     'returned'  — staff back at work, manager/HR confirmed
--     'extended'  — leave was extended past original end_date
--     'no_show'   — end_date + 3 days passed with no return record
--                   (set by the no-show flag in the HR task card)
--
--   The 'pending' default means every approved leave is correctly
--   pre-populated when this migration runs — managers will see all
--   their reports' past leaves in the Pending Returns card.
--
-- Idempotent — safe to re-run.

-- 1) Columns ─────────────────────────────────────────────────────────────────
alter table public.leave_requests
  add column if not exists returned_at         timestamptz,
  add column if not exists actual_return_date  date,
  add column if not exists return_confirmed_by text references public.employees(id) on delete set null,
  add column if not exists return_notes        text,
  add column if not exists return_status       text default 'pending';

-- 2) Status check constraint (drop-then-add so re-runs don't conflict)
alter table public.leave_requests
  drop constraint if exists leave_requests_return_status_check;
alter table public.leave_requests
  add  constraint leave_requests_return_status_check
       check (return_status in ('pending','returned','extended','no_show'));

-- 3) Index for the 'find pending returns' query — manager and HR cards both
--    filter on stage='approved' AND end_date<today AND returned_at IS NULL.
create index if not exists idx_leave_pending_returns
  on public.leave_requests (end_date)
  where returned_at is null and stage = 'approved';

-- 4) Extend verify_leave RPC to project the new fields ───────────────────────
-- DROP first because the RETURNS TABLE shape changed; CREATE OR REPLACE
-- alone would fail with "cannot change return type" on PostgreSQL.
drop function if exists public.verify_leave(uuid);

CREATE OR REPLACE FUNCTION public.verify_leave(p_id uuid)
RETURNS TABLE (
  id                  uuid,
  leave_type_id       text,
  start_date          date,
  end_date            date,
  days                numeric,
  is_half_day         boolean,
  stage               text,
  status              text,
  requested_at        timestamptz,
  manager_decided_at  timestamptz,
  hr_decided_at       timestamptz,
  returned_at         timestamptz,
  actual_return_date  date,
  return_status       text,
  employee_id         text,
  employee_name       text,
  employee_department text,
  employee_location   text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    lr.id, lr.leave_type_id, lr.start_date, lr.end_date,
    lr.days, lr.is_half_day, lr.stage, lr.status,
    lr.requested_at, lr.manager_decided_at, lr.hr_decided_at,
    lr.returned_at, lr.actual_return_date, lr.return_status,
    lr.employee_id, e.name, e.department, e.location
  FROM public.leave_requests lr
  LEFT JOIN public.employees e ON e.id = lr.employee_id
  WHERE lr.id = p_id
    AND lr.stage = 'approved'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.verify_leave(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.verify_leave(uuid) TO authenticated;

-- ─── Verify ───────────────────────────────────────────────────────────────
-- After running, test:
--   SELECT id, end_date, returned_at, return_status FROM leave_requests
--    WHERE stage='approved' AND end_date < CURRENT_DATE
--    ORDER BY end_date DESC LIMIT 5;
--   SELECT * FROM verify_leave('<some-approved-uuid>');
-- Expect: existing rows have return_status='pending', new columns null.
