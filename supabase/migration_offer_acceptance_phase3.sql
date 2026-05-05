-- ─────────────────────────────────────────────────────────────────────
-- Phase 3: Candidate acceptance flow
-- ─────────────────────────────────────────────────────────────────────
-- Adds the columns needed to:
--   1. Capture the candidate's Iqama / National ID at offer-creation
--      time (Bashaier enters it on the New Offer form). The candidate
--      proves identity on the public acceptance page by entering both
--      their email AND their Iqama. Email alone is too weak (anyone
--      who got the email can paste in their own address); Iqama
--      proves they're the actual person Bashaier sent the offer to.
--
--   2. Record the candidate's response: when they responded, what IP
--      and user-agent the request came from (audit trail), and if
--      they declined, the reason they gave.
--
-- The `status` column already supports 'offer_accepted' and
-- 'offer_declined' values from the original Phase 1 migration; no
-- check constraint changes needed.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

alter table public.offer_letters
  add column if not exists candidate_iqama       text,
  add column if not exists responded_at          timestamptz,
  add column if not exists response_ip           text,
  add column if not exists response_user_agent   text,
  add column if not exists decline_reason        text;

-- Index on offer_token for fast public-page lookups.
-- Already present in Phase 1 migration but ensuring it exists here
-- so this migration is safe to apply against a partially-migrated DB.
create index if not exists offer_letters_token_idx
  on public.offer_letters (offer_token);

-- Index on responded_at for the OffersCard "recent responses" sort.
create index if not exists offer_letters_responded_at_idx
  on public.offer_letters (responded_at desc nulls last);
