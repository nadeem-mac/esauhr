-- ─────────────────────────────────────────────────────────────────────
-- Seed initial signatories for offer letters
-- ─────────────────────────────────────────────────────────────────────
-- Adds the people who currently sign offer letters at Evergreen.
-- These show up in the "Signed by" picker on the New Offer form.
-- Signature image upload is Phase 2b — for now letters render with
-- the typed name + title only (clean professional layout).
--
-- To add more signatories later: paste an INSERT below or build the
-- "Settings → Signatories" admin panel (Phase 2b).
--
-- Idempotent: ON CONFLICT DO NOTHING means re-running this migration
-- won't duplicate rows even if you run it after manual edits.
-- ─────────────────────────────────────────────────────────────────────

-- Add a unique constraint on (name, title) so ON CONFLICT works
-- without needing to know the auto-generated UUID.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'signatories_name_title_unique'
  ) then
    alter table public.signatories
      add constraint signatories_name_title_unique unique (name, title);
  end if;
end $$;

-- Initial signatory list. Update names/titles below as the actual
-- signing authorities at Evergreen Shipping. department_scope can
-- be null (signs for any department) or a specific value matching
-- employees.department to scope a signatory to particular roles.

insert into public.signatories (name, title, email, department_scope, display_order, active)
values
  ('John Ho',          'Country Head',                 'johnho@evergreen-shipping.com.sa',          null,  10, true),
  ('James Liu',        'Country Head',                 'jamesliu@evergreen-shipping.com.sa',        null,  20, true),
  ('Fahad Al-Hussain', 'SUP Department Manager',       'fahad.alhussain@evergreen-shipping.com.sa', 'SUP', 30, true),
  ('Sadakathullah',    'BIZ Department Manager',       null,                                        'BIZ', 40, true)
on conflict (name, title) do nothing;
