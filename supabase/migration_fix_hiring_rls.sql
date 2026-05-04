-- ─────────────────────────────────────────────────────────────────────
-- Fix RLS policies on offer_letters / resignation_requests / signatories
-- ─────────────────────────────────────────────────────────────────────
-- Bashaier hit "42501: new row violates row-level security policy for
-- table signatories" when adding a signatory inline from the New
-- Offer form. Root cause: the original Phase 1 migration scoped
-- policies to `anon` only, but the portal's directPost helper sends
-- requests with the anon key as a Bearer token, which PostgREST
-- evaluates as the `authenticated` role (not `anon`). The anon-only
-- policy never matched, so RLS denied the insert.
--
-- Fix: drop and recreate the policies scoped to `public` (covers
-- anon, authenticated, and service_role). Same permissive pattern
-- the rest of the portal uses for its tables — RLS is on for the
-- table but the policy lets all roles read/write, with app-layer
-- is_admin / is_hr_reviewer checks enforcing the actual access
-- rules.
--
-- Idempotent: drops existing policies first, recreates fresh.
-- ─────────────────────────────────────────────────────────────────────

-- offer_letters
drop policy if exists offer_letters_anon_all on public.offer_letters;
drop policy if exists offer_letters_all on public.offer_letters;
create policy offer_letters_all on public.offer_letters
  for all to public using (true) with check (true);

-- resignation_requests
drop policy if exists resignations_anon_all on public.resignation_requests;
drop policy if exists resignations_all on public.resignation_requests;
create policy resignations_all on public.resignation_requests
  for all to public using (true) with check (true);

-- signatories
drop policy if exists signatories_anon_all on public.signatories;
drop policy if exists signatories_all on public.signatories;
create policy signatories_all on public.signatories
  for all to public using (true) with check (true);
