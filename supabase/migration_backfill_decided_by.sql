-- ══════════════════════════════════════════════════════════════════════════
-- LEAVE DESK — Fix decided_by column type + backfill NULL values
--
-- Two problems to solve:
--
-- (1) SCHEMA INCONSISTENCY
--     leave_requests.hr_decided_by and .manager_decided_by are stored
--     as `uuid`, but the equivalent columns on permission_requests
--     (added later, via migration_permissions_two_step.sql) are
--     `text`. The leave-side columns were added either manually
--     through Supabase UI or via an early migration that's no longer
--     in the repo, before the text-based pattern was settled.
--
--     This means decideLeave can only write Supabase Auth UUIDs, not
--     PSN strings — but the app uses PSN+PIN auth, so for any user
--     account without an auth UUID linked, the column is forced to
--     NULL. NULL rows then disappear from MY RECENT DECISIONS.
--
-- (2) EXISTING NULL ATTRIBUTIONS
--     Past decisions saved with NULL hr_decided_by need to be
--     attributed so they reappear in the history list.
--
-- The fix:
--   • Change column type from uuid to text (matching the pattern
--     used for permission_requests). Existing UUID values are
--     preserved as their text representation.
--   • Backfill NULLs on rows that can be safely attributed:
--       - 'approved' or 'rejected_by_hr' rows where hr_decided_at
--         is set → must be Bashaier (only HR reviewer in scope).
--   • No FK constraint on either column (uuid wouldn't reference
--     employees.id which is text), so no constraint to drop.
--   • No RLS policy or trigger depends on these columns' types.
--
-- After running, MY RECENT DECISIONS shows every prior decision and
-- every future decision (including ones from accounts without an
-- auth_user_id linked).
--
-- Idempotent — re-running is a no-op.
-- ══════════════════════════════════════════════════════════════════════════

-- 1) Change column type uuid → text. Postgres ALTER COLUMN TYPE with
--    USING ::text serialises the UUID as its canonical 36-char string.
alter table public.leave_requests
  alter column hr_decided_by type text using hr_decided_by::text;

alter table public.leave_requests
  alter column manager_decided_by type text using manager_decided_by::text;

-- 2) HR-stage approvals authored by Bashaier
update public.leave_requests
   set hr_decided_by = 'H94830'
 where stage = 'approved'
   and hr_decided_at is not null
   and hr_decided_by is null;

-- 3) HR-stage rejections authored by Bashaier
update public.leave_requests
   set hr_decided_by = 'H94830'
 where stage = 'rejected_by_hr'
   and hr_decided_at is not null
   and hr_decided_by is null;

-- 4) Sanity check — the *_still_null columns should now show 0 for
--    rows that were attributable.
select
  count(*) filter (where stage = 'approved'        and hr_decided_at is not null and hr_decided_by is null) as approved_still_null,
  count(*) filter (where stage = 'rejected_by_hr'  and hr_decided_at is not null and hr_decided_by is null) as rejected_by_hr_still_null,
  count(*) filter (where hr_decided_by = 'H94830') as bashaier_decisions_total,
  count(*) filter (where hr_decided_by ~ '^[0-9a-f]{8}-') as legacy_uuid_decisions
from public.leave_requests;
