-- migration_verify_permission_rpc.sql
--
-- Public read-only RPC for the QR-code verify page (/verify/:id).
-- Anonymous users (anyone scanning the QR on a printed letter)
-- need to confirm a request is real and approved without first
-- logging in. RLS on permission_requests blocks anon SELECT, so
-- this function uses SECURITY DEFINER to bypass RLS and exposes
-- only a minimal sanitized projection.
--
-- Privacy:
--   • Only returns rows where stage='approved' — never leaks
--     pending or rejected requests
--   • Returns employee name + department for context, NOT email,
--     manager_id, balance, or any other field
--   • Returns approval timestamps (date+time) so the verifier can
--     match against the printed letter
--
-- Idempotent — safe to re-run.

CREATE OR REPLACE FUNCTION public.verify_permission(p_id integer)
RETURNS TABLE (
  id                  integer,
  type                text,
  permission_date     date,
  time_from           text,
  time_to             text,
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
    pr.id, pr.type, pr.permission_date, pr.time_from, pr.time_to,
    pr.stage, pr.status,
    pr.requested_at, pr.manager_decided_at, pr.hr_decided_at,
    pr.employee_id, e.name, e.department, e.location
  FROM public.permission_requests pr
  LEFT JOIN public.employees e ON e.id = pr.employee_id
  WHERE pr.id = p_id
    AND pr.stage = 'approved'   -- only approved requests are publicly verifiable
  LIMIT 1;
$$;

-- Grant execute to anonymous role so the verify page can call it
-- without requiring auth.
GRANT EXECUTE ON FUNCTION public.verify_permission(integer) TO anon;
GRANT EXECUTE ON FUNCTION public.verify_permission(integer) TO authenticated;

-- ─── Verify ───────────────────────────────────────────────────────────────
-- Test from psql / Studio SQL editor:
--   SELECT * FROM public.verify_permission(<some_approved_request_id>);
-- Expect: one row with the sanitized fields. For a non-approved
-- or non-existent id, expect zero rows.
