-- =============================================================================
-- migration_app_settings.sql
--
-- Single-row-per-key store for editable platform settings. Designed for things
-- like email signature blocks, default subject prefixes, and corporate contact
-- info — values that need to change occasionally without a code deploy.
--
-- Usage from app:
--   SELECT value FROM app_settings WHERE key = 'email_templates';
--   INSERT … ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
--
-- This migration is idempotent — safe to run multiple times.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.app_settings (
  key          text PRIMARY KEY,
  value        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Comment for documentation
COMMENT ON TABLE  public.app_settings IS 'Key-value store for editable platform settings (email templates, signatures, etc.)';
COMMENT ON COLUMN public.app_settings.key   IS 'Setting key, e.g. ''email_templates''';
COMMENT ON COLUMN public.app_settings.value IS 'JSON value — schema depends on key';

-- Permissive RLS — read by anyone authenticated, write by HR/admin via app
-- layer (auth is enforced in JS, supabase anon key is used).
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_app_settings"  ON public.app_settings;
DROP POLICY IF EXISTS "anon_write_app_settings" ON public.app_settings;
CREATE POLICY "anon_read_app_settings"
  ON public.app_settings FOR SELECT
  USING (true);
CREATE POLICY "anon_write_app_settings"
  ON public.app_settings FOR ALL
  USING (true)
  WITH CHECK (true);

-- Seed the email_templates row so the UI has something to render even
-- before the first edit. Defaults match the values currently hardcoded
-- in src/lib/permissionLetter.js — running this migration changes
-- nothing about generated emails until an admin saves a customisation.
INSERT INTO public.app_settings (key, value)
VALUES (
  'email_templates',
  jsonb_build_object(
    'hr_signature', jsonb_build_object(
      'name',     'BASHAIER ALI',
      'company',  'Evergreen Shipping Agency Saudi Co.,(L.L.C)',
      'unit',     'ESAU - SADMN SUP/ HR DEPT',
      'address',  'P.O.Box : 1008,  DAMMAM – 31431, K.S.A',
      'whatsapp', '966-54 320 9694',
      'tel',      '966-013 813 8563 – Ext 8543',
      'email',    'bashaier.alsubaie@evergreen-shipping.com.sa'
    ),
    'subject_prefixes', jsonb_build_object(
      'permission_letter', '[Permission Letter]',
      'rejoining_letter',  '[Rejoining Letter]',
      'attendance_late',   '[Lateness Notice]',
      'attendance_early',  '[Early Departure Notice]',
      'attendance_missed', '[Punch Reminder]'
    )
  )
)
ON CONFLICT (key) DO NOTHING;
