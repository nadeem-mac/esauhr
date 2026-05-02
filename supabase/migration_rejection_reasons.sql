-- ══════════════════════════════════════════════════════════════════════════
-- LEAVE DESK — Rejection Reason Fields
--
-- When a leave request is rejected (by manager or HR), capture WHY
-- so the staff member can see the reason on their My Applications
-- card. Two columns:
--   • rejection_reason_code — short machine-readable category code
--     (one of REJECTION_REASON_CODES in src/lib/leaveLogic.js).
--     Drives the human-readable label shown to staff.
--   • rejection_reason_note — optional free-text from the rejector
--     for additional context (e.g. 'Sehhaty leave ID does not
--     match certificate; please resubmit').
--
-- Both columns are nullable. Existing rejected requests have neither
-- set; new rejections write both. Display logic falls back to a
-- generic 'Rejected — no reason given' when both are null.
--
-- Idempotent — safe to run multiple times.
-- ══════════════════════════════════════════════════════════════════════════

alter table public.leave_requests
  add column if not exists rejection_reason_code text,
  add column if not exists rejection_reason_note text;

-- Sanity check
select
  count(*) filter (where status like 'rejected%' or stage like 'rejected%') as rejected_total,
  count(*) filter (where rejection_reason_code is not null) as with_reason_code,
  count(*) filter (where rejection_reason_note is not null) as with_reason_note
from public.leave_requests;
