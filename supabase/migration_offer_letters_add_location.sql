-- ─────────────────────────────────────────────────────────────────────
-- Add location column to offer_letters
-- ─────────────────────────────────────────────────────────────────────
-- The New Offer form has had a Location dropdown (DMM/RYD/JED) for a
-- while — used to scope the manager allowlist and to render the
-- 'Office' line on the printed letter. The selected value was being
-- passed through to the print window but never persisted to the DB.
--
-- Persisting it now matters because:
--   • OffersCard's Email button derives the manager email from the
--     offer row. Without location on the row, the wrong manager
--     could be picked if the same person manages multiple offices.
--   • The Contract preview renders the letter from the row's data —
--     the 'Office' line was reading offer.location, which was always
--     undefined, so it rendered blank.
--   • The Hiring pipeline filters won't be able to slice by office
--     in future phases without this.
--
-- text instead of an enum so we can store either a 3-letter code
-- ('DMM') or a label ('Dammam') without another schema change. The
-- form sends the code; the letter renderer maps it to a human label.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

alter table public.offer_letters
  add column if not exists location text;

-- Backfill existing rows with a sensible default so old offers don't
-- have a NULL that the email/letter code might choke on. DMM is the
-- HQ office and most existing test offers were Dammam-based.
update public.offer_letters
  set location = 'DMM'
  where location is null;
