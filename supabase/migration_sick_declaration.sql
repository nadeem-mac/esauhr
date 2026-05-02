-- =====================================================================
-- Sick declaration tracking
-- =====================================================================
--
-- Adds a "declare sick today" front door so staff can register a sick
-- leave the moment they decide not to come in, BEFORE they have a
-- Sehhaty certificate. The leave row is created in a new
-- 'pending_certificate' stage and tracked by HR until the certificate
-- is uploaded (which transitions it through normal sick-leave review)
-- or until the staff member is granted a manual exemption.
--
-- Why this exists:
--   Staff have historically emailed Bashaier "I'm sick today" and then
--   never followed through with the certificate. The portal becomes the
--   front door — every sick declaration creates a tracked record from
--   minute one, with clear escalation if the certificate is missing.
--
-- What this migration does:
--   1. Adds tracking columns to leave_requests:
--        sick_declared_at         — when the row was created via the
--                                   declare-sick flow (vs. a normal
--                                   leave submission)
--        sick_declared_via        — 'staff' | 'hr_on_behalf'
--        sick_returned_at         — Bashaier's manual override of
--                                   the auto-detected return date
--                                   (nullable — defaults to attendance
--                                   first-punch detection)
--        sick_cert_exempt         — boolean; cert obligation waived
--        sick_cert_exempt_by      — who waived it (PSN)
--        sick_cert_exempt_reason  — reason category + free-text note
--        sick_cert_exempt_at      — when the waiver was granted
--
--   2. Creates sick_reminders table:
--        Logs every reminder Bashaier sends (or the system auto-fires)
--        so we have a clear audit trail and can show "last reminder"
--        on the tracker card. One row per send.
--
--   3. The 'pending_certificate' stage is added to the existing
--      leave_requests.stage column. The column is text (not enum) so no
--      schema change needed for the value itself — application code
--      treats 'pending_certificate' as a valid stage.
--
-- Idempotency:
--   All ALTER TABLE / CREATE TABLE statements use IF NOT EXISTS so
--   re-running the migration is safe. The migration runner records the
--   sha256 of this file, so any edits would show as 'CHANGED' on the
--   migrations panel and need an explicit re-run.
-- =====================================================================

-- ----- 1. Tracking columns on leave_requests --------------------------

alter table leave_requests
  add column if not exists sick_declared_at        timestamptz,
  add column if not exists sick_declared_via       text,
  add column if not exists sick_returned_at        timestamptz,
  add column if not exists sick_cert_exempt        boolean not null default false,
  add column if not exists sick_cert_exempt_by     text,
  add column if not exists sick_cert_exempt_reason text,
  add column if not exists sick_cert_exempt_at     timestamptz;

-- Index for the tracker card query (Bashaier's "pending certificates"
-- list filters on stage='pending_certificate' AND not exempt). Partial
-- index keeps it tiny since most leave rows are NOT in this state.
create index if not exists idx_leave_pending_cert
  on leave_requests (sick_declared_at)
  where stage = 'pending_certificate' and sick_cert_exempt = false;


-- ----- 2. sick_reminders table ----------------------------------------

create table if not exists sick_reminders (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references leave_requests(id) on delete cascade,
  sent_at      timestamptz not null default now(),
  sent_by      text,            -- PSN of sender; null when system-auto
  channel      text not null,   -- 'email' | 'in_app' | 'manual'
  reminder_kind text not null,  -- 'gentle_24h' | 'firmer_72h' | 'final_5d' | 'manual'
  note         text             -- optional free-text note from Bashaier
);

create index if not exists idx_sick_reminders_request
  on sick_reminders (request_id, sent_at desc);


-- ----- 3. RLS policies ------------------------------------------------
--
-- The portal uses PSN+PIN auth (anon Supabase key, no auth.uid()), so
-- we follow the existing project pattern of permissive RLS — security
-- is enforced at the application layer. This matches every other RLS
-- policy in this codebase.

alter table sick_reminders enable row level security;

drop policy if exists sick_reminders_all on sick_reminders;
create policy sick_reminders_all on sick_reminders
  for all using (true) with check (true);


-- ----- 4. Belt-and-suspenders trigger ---------------------------------
--
-- When the portal UI is supposed to block new leave/permission
-- submissions for staff with an unresolved soft-overdue sick cert, we
-- want a server-side guard too in case someone bypasses the UI (race
-- conditions, direct API calls). The trigger fires on insert and
-- raises if the employee has any leave_requests in 'pending_certificate'
-- stage that are past the 48h soft-overdue threshold.
--
-- The 48h calculation uses sick_returned_at if Bashaier set it,
-- otherwise falls back to the latest sick day +1 (rough proxy when no
-- return signal exists yet — conservative, will block if uncertain).

create or replace function check_pending_sick_cert()
returns trigger
language plpgsql
as $$
declare
  v_pending_count int;
  v_employee_id text;
begin
  -- Determine the employee for this insert. leave_requests and
  -- permission_requests both have employee_id; the trigger is attached
  -- to both tables.
  v_employee_id := new.employee_id;

  -- Count any leave rows for this employee that are:
  --   • in pending_certificate stage
  --   • not exempt
  --   • past the 48h grace from the staff member's return
  select count(*)
    into v_pending_count
    from leave_requests
   where employee_id = v_employee_id
     and stage = 'pending_certificate'
     and sick_cert_exempt = false
     and (
           (sick_returned_at is not null
              and sick_returned_at < now() - interval '48 hours')
           or
           (sick_returned_at is null
              and end_date < (current_date - interval '2 days'))
         );

  if v_pending_count > 0 then
    raise exception 'BLOCKED: This employee has an unresolved sick leave certificate that is more than 48 hours overdue. Please submit the Sehhaty certificate for the prior sick leave before creating a new request.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- Attach to leave_requests inserts. Self-references to leave_requests
-- (via the count(*) query above) are fine because we explicitly filter
-- on stage = 'pending_certificate', and a freshly-inserted row in any
-- stage is allowed to coexist with the trigger evaluation. The trigger
-- only blocks if there's an EXISTING overdue row.
drop trigger if exists trg_check_pending_sick_cert_leave on leave_requests;
create trigger trg_check_pending_sick_cert_leave
  before insert on leave_requests
  for each row
  -- Don't recursively block when staff is creating ANOTHER pending_cert
  -- declaration (e.g. forgot to extend an existing one). Only block when
  -- the new row is NOT a sick declaration.
  when (new.stage <> 'pending_certificate')
  execute function check_pending_sick_cert();

-- Attach to permission_requests inserts.
drop trigger if exists trg_check_pending_sick_cert_perm on permission_requests;
create trigger trg_check_pending_sick_cert_perm
  before insert on permission_requests
  for each row
  execute function check_pending_sick_cert();
