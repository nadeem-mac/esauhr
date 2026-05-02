-- ══════════════════════════════════════════════════════════════════════════
-- LEAVE DESK — Sehhaty Sick Leave Fields
--
-- Saudi Labor Law (Art. 117) sick leave: 120 days/year, distributed as
-- 30 fully paid + 60 at 75% + 30 unpaid. Since 2022 only Sehhaty
-- (or SEHA for foreign certificates) is accepted as the source of
-- truth — paper certificates are no longer valid.
--
-- This migration adds optional columns to leave_requests for the
-- Sehhaty service code (verification number on the digital
-- certificate), the issue date, the issuing clinic/hospital, and the
-- HR verification record. All columns are nullable — existing leave
-- types (annual, etc.) ignore them; only sick-leave requests will
-- populate them via the New Request flow.
--
-- Idempotent — safe to run multiple times.
-- ══════════════════════════════════════════════════════════════════════════

-- Add columns only if they don't exist (idempotent)
alter table public.leave_requests
  add column if not exists sehhaty_code            text,
  add column if not exists sehhaty_issue_date      date,
  add column if not exists sehhaty_clinic          text,
  add column if not exists sehhaty_verified_at     timestamptz,
  add column if not exists sehhaty_verified_by     text,
  add column if not exists sehhaty_verification_note text;

-- Helpful index for finding unverified approved sick leaves
-- (Bashaier's daily reminder: 'these were approved but not yet
-- cross-checked on Sehhaty').
create index if not exists idx_requests_sehhaty_unverified
  on public.leave_requests(leave_type_id, status, sehhaty_verified_at)
  where leave_type_id = 'sick' and status = 'approved' and sehhaty_verified_at is null;

-- Sanity check
select
  count(*) filter (where leave_type_id = 'sick') as sick_leaves_total,
  count(*) filter (where leave_type_id = 'sick' and sehhaty_code is not null) as with_sehhaty_code,
  count(*) filter (where leave_type_id = 'sick' and sehhaty_verified_at is not null) as verified
from public.leave_requests;
