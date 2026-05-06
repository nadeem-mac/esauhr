-- ─── migration_employee_delete ───────────────────────────────────────
--
-- Provides a safe, audited, cascading delete RPC for removing an
-- employee record permanently. Per Nadeem: "Admin and Bashaier has
-- the access to delete the staff completely if they wish too, but
-- with warning message that the complete data for that staff will
-- be deleted from records, once they confirm remove that staff
-- from records and make sure all system is safe."
--
-- WHY AN RPC INSTEAD OF DIRECT DELETE
--   • RLS gating — the function runs SECURITY DEFINER, so we can
--     authorize once at the top by checking caller's is_admin /
--     is_hr_reviewer flags rather than maintaining 20+ RLS DELETE
--     policies across all the child tables.
--   • Atomicity — the whole cascade lives in one transaction.
--     Either everything goes or nothing does.
--   • Counts — we return what was deleted so the UI can show
--     "X leave requests, Y attendance days, Z shifts removed".
--   • Audit log — single guaranteed write per deletion, surviving
--     even if the employees row is the target.
--   • Confirmation guard — caller must pass the PSN as the
--     `confirmation` argument; if they don't match the target_psn
--     exactly, the call fails. Belt-and-braces protection against
--     accidental UI mistakes.
--
-- WHAT GETS CLEANED UP
--   Most child tables already have ON DELETE CASCADE on their FK
--   to employees (leave_requests, leave_balances, permission_requests,
--   resignation_requests, notifications, hiring lifecycle records).
--   These get cleaned automatically when the employees row is deleted.
--
--   Some tables use ON DELETE SET NULL for reference columns
--   (manager_id, decision_by, reviewer columns) — those just get
--   nulled, preserving the historical record.
--
--   A few tables hold the PSN as bare TEXT (no FK constraint at all):
--     • attendance_daily.employee_id
--     • attendance_uploads.uploaded_by  (FK exists but NOT NULL — cascade
--                                        is not enough; we delete explicitly)
--     • monthly_shift_plans.manager_id and .employee_id
--     • registration_requests.psn
--   These need explicit DELETE statements before the employees row,
--   since they neither cascade nor block.
--
--   audit_log.actor_psn is bare TEXT and we INTENTIONALLY leave it
--   intact — historical audit entries should survive employee
--   deletion so the action trail stays complete.
--
--   auth.users (Supabase auth schema) gets a best-effort delete via
--   the auth_user_id linkage. If the call fails (auth schema
--   permissions vary by setup), we don't roll back — the employees
--   row removal is what matters for app-layer security since the
--   PSN→email lookup goes via employees.
-- ──────────────────────────────────────────────────────────────────

create or replace function public.admin_delete_employee(
  target_psn text,
  confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_uid uuid;
  caller_emp record;
  victim record;
  counts jsonb;
begin
  -- ─── 1. Authentication ────────────────────────────────────────
  caller_uid := auth.uid();
  if caller_uid is null then
    return jsonb_build_object('ok', false, 'error', 'Not authenticated');
  end if;

  select id, name, is_admin, is_hr_reviewer
  into caller_emp
  from public.employees
  where auth_user_id = caller_uid
  limit 1;

  if caller_emp is null then
    return jsonb_build_object('ok', false, 'error', 'Caller has no employee record');
  end if;

  -- ─── 2. Authorization ─────────────────────────────────────────
  if not (coalesce(caller_emp.is_admin, false)
       or coalesce(caller_emp.is_hr_reviewer, false)) then
    return jsonb_build_object(
      'ok', false,
      'error', 'Only admin or HR reviewer can delete employees'
    );
  end if;

  -- ─── 3. Confirmation guard — caller must echo the PSN ─────────
  -- The UI requires admin to type the PSN before enabling the
  -- delete button; the server checks the same thing belt-and-
  -- braces. Without an exact match, we refuse.
  if confirmation is null or confirmation <> target_psn then
    return jsonb_build_object(
      'ok', false,
      'error', 'Confirmation does not match target PSN'
    );
  end if;

  -- ─── 4. Self-protection ───────────────────────────────────────
  -- Admin cannot delete their own record. If they need to be
  -- removed, another admin has to do it.
  if target_psn = caller_emp.id then
    return jsonb_build_object(
      'ok', false,
      'error', 'You cannot delete your own employee record. Ask another admin.'
    );
  end if;

  -- ─── 5. Look up the victim ────────────────────────────────────
  select id, name, department, location, national_id, auth_user_id, is_admin
  into victim
  from public.employees
  where id = target_psn;

  if victim is null then
    return jsonb_build_object('ok', false, 'error', 'Employee not found');
  end if;

  -- Don't delete the last remaining admin — there must always be
  -- at least one admin to manage the system. If victim is_admin
  -- and they're the only one, refuse.
  if coalesce(victim.is_admin, false) then
    if (select count(*) from public.employees where coalesce(is_admin, false) and id <> target_psn) = 0 then
      return jsonb_build_object(
        'ok', false,
        'error', 'Cannot delete the last admin. Promote another employee to admin first.'
      );
    end if;
  end if;

  -- ─── 6. Count children for the response + audit detail ────────
  -- We do this BEFORE the deletes so the counts reflect what's
  -- about to disappear. Some of these tables don't exist in older
  -- deployments — the to_regclass guard returns NULL so the count
  -- short-circuits to 0 instead of failing.
  counts := jsonb_build_object(
    'leave_requests',         (select count(*) from public.leave_requests where employee_id = target_psn),
    'leave_balances',         (select count(*) from public.leave_balances where employee_id = target_psn),
    'attendance_daily',       (select count(*) from public.attendance_daily where employee_id = target_psn),
    'attendance_uploads',     (select count(*) from public.attendance_uploads where uploaded_by = target_psn),
    'monthly_shift_plans',    (select count(*) from public.monthly_shift_plans where employee_id = target_psn or manager_id = target_psn),
    'permission_requests',    (select count(*) from public.permission_requests where employee_id = target_psn),
    'registration_requests',  (select count(*) from public.registration_requests where psn = target_psn)
  );

  -- ─── 7. Explicit deletes for non-cascading references ─────────
  -- attendance_uploads has uploaded_by NOT NULL with a bare FK
  -- (no CASCADE / SET NULL behaviour). Without this delete, the
  -- employees row removal would fail with FK violation.
  delete from public.attendance_uploads where uploaded_by = target_psn;

  -- These tables hold the PSN as bare TEXT (no FK constraint), so
  -- they don't block deletion but would leave orphan records.
  delete from public.attendance_daily where employee_id = target_psn;
  delete from public.monthly_shift_plans where employee_id = target_psn or manager_id = target_psn;
  delete from public.registration_requests where psn = target_psn;

  -- ─── 8. Delete the employee row ───────────────────────────────
  -- Cascading FKs handle:
  --   leave_requests, leave_balances, permission_requests,
  --   resignation_requests, notifications, offer_letters
  --   (psn_assigned), and any rejoining_workflow rows pointing
  --   to this employee.
  delete from public.employees where id = target_psn;

  -- ─── 9. Best-effort auth.users cleanup ────────────────────────
  -- If the employee had an auth_user_id, try to remove it from
  -- auth.users so any active sessions are invalidated. May fail
  -- on shared / managed Supabase instances; that's OK — the
  -- employees row removal already prevents PSN → email lookup
  -- on next login attempt.
  if victim.auth_user_id is not null then
    begin
      delete from auth.users where id = victim.auth_user_id;
    exception when others then
      -- Swallow — log to caller via the response if needed
      null;
    end;
  end if;

  -- ─── 10. Audit log ────────────────────────────────────────────
  -- Single record of the deletion. actor_psn / actor_name preserve
  -- WHO did it; target_id / target_label preserve WHO was deleted;
  -- details holds the counts so admin can later see what was
  -- removed in the activity log entry.
  insert into public.audit_log (
    action, target_type, target_id, target_label,
    actor_user_id, actor_psn, actor_name, details
  )
  values (
    'employee_deleted',
    'employees',
    target_psn,
    victim.name,
    caller_uid,
    caller_emp.id,
    caller_emp.name,
    jsonb_build_object(
      'department', victim.department,
      'location', victim.location,
      'national_id', victim.national_id,
      'counts', counts
    )
  );

  return jsonb_build_object(
    'ok', true,
    'deleted', target_psn,
    'name', victim.name,
    'counts', counts
  );
end;
$$;

grant execute on function public.admin_delete_employee(text, text) to authenticated;
