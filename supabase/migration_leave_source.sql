-- Add a sturdy provenance column to leave_requests so imported / manual /
-- portal leaves can be identified without matching on the free-text reason.
-- Idempotent; safe to run via the Supabase SQL editor (no BEGIN/COMMIT).
--
--   source values used by the app:
--     'leave_tracker_import'  — brought in from the legacy Excel tracker
--     (null)                  — created in-portal (normal workflow / logbook)
--
-- Run this BEFORE using the Leave History Import tab.

alter table public.leave_requests
  add column if not exists source text;

-- Backfill any rows already imported via the earlier reason-marker approach
-- so they are tagged consistently going forward.
update public.leave_requests
   set source = 'leave_tracker_import'
 where source is null
   and reason like 'Imported from leave tracker%';

create index if not exists idx_leave_requests_source
  on public.leave_requests (source);
