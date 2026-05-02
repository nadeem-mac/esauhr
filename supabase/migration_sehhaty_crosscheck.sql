-- ══════════════════════════════════════════════════════════════════════════
-- LEAVE DESK — Sehhaty Cross-Check Fields
--
-- Extension to the original migration_sehhaty_sick_leave.sql.
--
-- The Sehhaty / Seha inquiry result page (seha.sa/#/inquiries/slenquiry)
-- returns a structured certificate with: patient name, start/end dates,
-- duration in days, issue date, doctor name, and specialty. When HR
-- verifies a sick leave, they should cross-check this data against
-- what the staff member submitted in the request.
--
-- These columns capture what HR saw on Sehhaty so the verification
-- becomes a structured comparison rather than a blind 'I checked'.
-- The values are what BASHAIER typed in (or what the system auto-
-- populated from the request) — they form the audit record of what
-- was on Sehhaty at verification time.
--
-- All fields nullable — only sick-leave verifications populate them.
-- Idempotent — safe to run multiple times.
-- ══════════════════════════════════════════════════════════════════════════

alter table public.leave_requests
  add column if not exists sehhaty_seen_name        text,
  add column if not exists sehhaty_seen_start       date,
  add column if not exists sehhaty_seen_end         date,
  add column if not exists sehhaty_seen_days        smallint,
  add column if not exists sehhaty_seen_issue_date  date,
  add column if not exists sehhaty_seen_doctor      text,
  add column if not exists sehhaty_seen_specialty   text,
  add column if not exists sehhaty_seen_id_number   text;

-- Sanity check
select
  count(*) filter (where leave_type_id = 'sick' and sehhaty_seen_name is not null) as cross_checks_recorded
from public.leave_requests;
