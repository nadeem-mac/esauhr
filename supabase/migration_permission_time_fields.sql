-- Permission request time-window fields
-- ──────────────────────────────────────────────────────────────────────────────
-- The existing permission_requests table tracks `hours` (the duration), but
-- the printed form needs the actual clock times — From / To. Adding two
-- TEXT columns in HH:MM format so the form can render the exact window
-- the staff member is requesting.
--
-- TEXT (not TIME) keeps the values simple to read/write from the React
-- modal — the modal stores '08:00' / '09:00' strings and never has to
-- worry about timezone offsets, ISO parsing, or round-tripping a TIME
-- value through Supabase REST. The duration in mins is derived in JS
-- from the two strings; `hours` stays as the canonical bucket counter
-- (1 hr per occurrence, 3 hr / 3 occurrence monthly cap).
--
-- Idempotent — uses IF NOT EXISTS so re-running is safe.

alter table public.permission_requests
  add column if not exists time_from text,
  add column if not exists time_to   text;

comment on column public.permission_requests.time_from is
  'Start of the permission window in HH:MM. Example: "08:00".';
comment on column public.permission_requests.time_to is
  'End of the permission window in HH:MM. Example: "09:00".';
