-- ══════════════════════════════════════════════════════════════════════════
-- LEAVE DESK — Backfill *_decided_by columns
--
-- Bug context: decideLeave used to write
--   hr_decided_by = me.auth_user_id || null
-- For accounts without a Supabase Auth UUID linked, the column was
-- saved as NULL. Those rows then disappeared from MY RECENT DECISIONS
-- because the history query filters on hr_decided_by IN (psn, auth)
-- and NULL matches neither.
--
-- The bug is fixed going forward (both decideLeave and HrApprovalModal
-- now write a non-null id, falling back to me.id if auth_user_id is
-- missing). This migration patches the rows already in the table so
-- the existing rejections also surface in the history list.
--
-- Strategy:
--   • Approved leaves at the HR stage with NULL hr_decided_by → set
--     to Bashaier's PSN ('H94830'), since she's the only HR reviewer
--     who could have approved them.
--   • Rejected-by-HR leaves with NULL hr_decided_by → same. She's
--     the only one with the role to perform that rejection.
--   • Rejected-by-manager / approved-at-manager-stage rows are NOT
--     touched here — those have many possible deciders (every line
--     manager) and we can't guess. Inline rejection-reason migration
--     wasn't applied to them either, so they were already missing
--     from history pre-bug.
--
-- After running, the existing rows show up in MY RECENT DECISIONS
-- the next time Bashaier loads the page.
--
-- Idempotent — the WHERE clauses skip rows already populated.
-- ══════════════════════════════════════════════════════════════════════════

-- 1) HR-stage approvals authored by Bashaier
update public.leave_requests
   set hr_decided_by = 'H94830'
 where stage = 'approved'
   and hr_decided_at is not null
   and hr_decided_by is null;

-- 2) HR-stage rejections authored by Bashaier
update public.leave_requests
   set hr_decided_by = 'H94830'
 where stage = 'rejected_by_hr'
   and hr_decided_at is not null
   and hr_decided_by is null;

-- Sanity check — should now show 0 in the 'still null' columns for
-- rows that were attributable.
select
  count(*) filter (where stage = 'approved'        and hr_decided_at is not null and hr_decided_by is null) as approved_still_null,
  count(*) filter (where stage = 'rejected_by_hr'  and hr_decided_at is not null and hr_decided_by is null) as rejected_by_hr_still_null,
  count(*) filter (where hr_decided_by = 'H94830') as bashaier_decisions_total
from public.leave_requests;
