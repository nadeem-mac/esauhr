-- ─── migration_mol_fields ─────────────────────────────────────────────
--
-- Adds the columns we need to mirror the MOL / GOSI government
-- subscriber file into the portal's employees table. These fields
-- are useful for:
--   • Generating Arabic-language letters and forms (vacation form,
--     job offer, leave certificate). The existing VACATION_FORM.docx
--     uses Arabic — without arabic_name we have to type-transliterate
--     by hand.
--   • Matching against the MOL/GOSI roster on subsequent updates so
--     name corrections from the government system propagate.
--   • Surfacing missing data: any portal employee with no national_id
--     after a sync is either pre-MOL data or a mismatched record
--     that needs Bashaier's attention.
--
-- All columns are nullable. Sync is incremental — fields are filled
-- as records get matched in the Admin > Government Data Sync UI.
-- national_id has a UNIQUE constraint so we can use it as the join
-- key on future syncs (each Iqama / National ID is unique by law).
--
-- ───────────────────────────────────────────────────────────────────
alter table public.employees
  add column if not exists arabic_name        text,
  add column if not exists national_id        text,
  add column if not exists date_of_birth      date,
  add column if not exists gender             text check (gender in ('male', 'female') or gender is null),
  add column if not exists arabic_profession  text,
  add column if not exists mol_join_date      date,
  add column if not exists gosi_eligibility   text,
  add column if not exists mol_synced_at      timestamptz;

-- Unique index on national_id so we can use it as a stable lookup
-- key on subsequent syncs. Partial index — null values don't conflict
-- with each other (a pile of pre-sync rows shouldn't block writes).
create unique index if not exists employees_national_id_idx
  on public.employees(national_id)
  where national_id is not null;

-- Optional: also keep the GOSI establishment subscription number
-- and source file metadata in a tiny config table. This is shared
-- across all employees so it doesn't belong in employees, but it's
-- useful for letter-generation and when the establishment ID changes
-- (e.g. company restructuring).
create table if not exists public.mol_settings (
  key         text primary key,
  value       text,
  updated_at  timestamptz default now()
);

-- Seed the establishment ID we already know from the MOL file.
-- ON CONFLICT preserves any existing value so a re-run doesn't blow
-- away an updated establishment ID.
insert into public.mol_settings (key, value)
values
  ('establishment_id_ar', 'شركة وكالة إفرقرين السعودية للشحن'),
  ('establishment_id_en', 'Evergreen Shipping Agency Saudi Co. (LLC)'),
  ('gosi_subscription_id', '609146389')
on conflict (key) do nothing;
