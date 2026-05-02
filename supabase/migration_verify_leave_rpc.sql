-- migration_verify_leave_rpc.sql
--
-- Public read-only RPC for the leave-form QR verify page
-- (/verify-leave/:uuid). Mirrors verify_permission exactly but for
-- leave_requests, with a uuid id parameter (leave_requests.id is
-- uuid-typed, unlike permission_requests.id which is integer).
--
-- Anonymous users (anyone scanning the QR on a printed leave form)
-- need to confirm a request is real and approved without first
-- logging in. RLS on leave_requests blocks anon SELECT, so this
-- function uses SECURITY DEFINER to bypass RLS and exposes only a
-- minimal sanitized projection.
--
-- Privacy:
--   • Only returns rows where stage='approved' — never leaks
--     pending or rejected requests
--   • Returns employee name + department/location for context, NOT
--     email, manager_id, balance, or any other field
--   • Returns approval timestamps so the verifier can match against
--     the printed letter
--
-- Idempotent — safe to re-run.

-- Drop the existing function first so we can change the return-type
-- signature without hitting "cannot change return type of existing
-- function". CREATE OR REPLACE alone can't do that.
DROP FUNCTION IF EXISTS public.verify_leave(uuid);

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
    lr.employee_id, e.name, e.department, e.location
  FROM public.leave_requests lr
  LEFT JOIN public.employees e ON e.id = lr.employee_id
  WHERE lr.id = p_id
    AND lr.stage = 'approved'   -- only approved requests are publicly verifiable
  LIMIT 1;
$$;

-- Grant execute to anonymous + authenticated so the verify page can
-- call it without requiring auth.
GRANT EXECUTE ON FUNCTION public.verify_leave(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.verify_leave(uuid) TO authenticated;

-- ─── Verify ───────────────────────────────────────────────────────────────
-- Test from psql / Studio SQL editor:
--   SELECT * FROM public.verify_leave('<some-approved-leave-uuid>');
-- Expect: one row with the sanitized fields. For a non-approved or
-- non-existent id, expect zero rows.
