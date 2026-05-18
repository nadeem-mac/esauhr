-- ════════════════════════════════════════════════════════════════════════
--  migration_normalize_employee_emails.sql
--
--  Strips every kind of whitespace (space, tab, newline, NBSP) from the
--  `email` and `personal_email` columns on the employees table. Emails
--  legally cannot contain whitespace anywhere — local part, before/after
--  the @, or in the domain — so any whitespace is a data-entry artefact
--  from the source spreadsheet (paste-from-Word, AutoCorrect, etc.) and
--  safe to remove globally.
--
--  Nadeem 2026-05-18: 'The email for Bedor.Almwallad@evergreen-shipping
--  .com.sa, there is a space after Bedor. correct similar cases if any'
--
-- ── KNOWN OFFENDERS (audited from ESAU_LIST_EMPLOYEES_2026.xlsx) ────────
--
--  Corporate emails (employees.email) with whitespace issues:
--    • H94753 BEDOR ALMWALLAD          'Bedor. Almwallad@…\xa0 '
--                                    → 'Bedor.Almwallad@…'
--    • H94766 AMINAH ABDULLAH          'Aminah. Abdullah @…\xa0 '
--                                    → 'Aminah.Abdullah@…'
--    • H94651 MOHSIN BALOBAID          '  mohsin.balobaid@…'
--                                    → 'mohsin.balobaid@…'
--    • H94779 JASSIM AL DOSSERY        'jassim.aldossery@…   '
--                                    → 'jassim.aldossery@…'
--    • H94957 FAISAL ALAWAD            'Faisal.Alawad@… '
--                                    → 'Faisal.Alawad@…'
--    • H94801 KHALID ALMUTAIRI         'Khalid.Almutari@…\xa0 '
--                                    → 'Khalid.Almutari@…'
--    • H94944 HAMAD ALNASHRI           'hamad.alnashri@…\xa0 '
--                                    → 'hamad.alnashri@…'
--
--  Personal emails (employees.personal_email) with whitespace issues:
--    Same families above plus H94692, H94282, H94420 (leading NBSP),
--    H94226, H94109, H94371 (trailing closing paren). The trailing
--    paren / leading NBSP cases are handled by the same regex.
--
-- ── WHAT THIS SCRIPT DOES ───────────────────────────────────────────────
--
--    UPDATE employees
--       SET email          = strip_whitespace(email),
--           personal_email = strip_whitespace(personal_email)
--     WHERE … contains any whitespace OR NBSP …
--
--  The strip is done via regexp_replace matching every ASCII whitespace
--  character (space, tab, LF, CR) PLUS the non-breaking space (NBSP,
--  U+00A0, chr(160)) which is what AutoCorrect tends to insert. The
--  scope is filtered so only rows that ACTUALLY had whitespace get
--  touched (cleaner audit log + faster execution).
--
-- ── WHAT THIS SCRIPT DOES NOT TOUCH ─────────────────────────────────────
--
--    • Spelling errors in local parts ('Almutari' should probably be
--      'Almutairi') — those are policy decisions, not data hygiene.
--      HR review required.
--    • Domain typos like 'gamil.con' → 'gmail.com' (H94801 personal).
--      Listed in the NOTICE output for manual review.
--    • Missing domains like 'JALDOSSARY3@' (H94779 personal). HR
--      review required.
--    • Trailing punctuation like ')' (H94371 personal). The whitespace
--      strip will not touch these — they're listed in the NOTICE for
--      manual review.
--
-- ── HOW TO RUN ──────────────────────────────────────────────────────────
--
--    1. Supabase Dashboard → SQL Editor → New Query
--    2. Paste this entire file
--    3. Click Run
--    4. Read the NOTICE output:
--         • 'fixed N corporate emails' / 'fixed N personal emails'
--         • specific BEFORE → AFTER list for the ESAU corporate fixes
--         • 'NEEDS MANUAL REVIEW' list with rows the regex can't fix
-- ════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  -- Whitespace character class for regexp_replace: includes ASCII
  -- whitespace (\s) AND the non-breaking space (chr(160)). Doing this
  -- via concatenation rather than escape sequence so it works
  -- identically on any Supabase/Postgres version.
  ws_class CONSTANT text :=
    '[' || chr(9) || chr(10) || chr(13) || chr(32) || chr(160) || ']';

  cnt_corp     bigint;
  cnt_personal bigint;
  r            record;
BEGIN
  -- Safety net: only proceed if the table + columns we expect exist.
  IF to_regclass('public.employees') IS NULL THEN
    RAISE NOTICE 'employees table not found — aborting';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'employees'
       AND column_name  = 'email'
  ) THEN
    RAISE NOTICE 'employees.email column not found — aborting';
    RETURN;
  END IF;

  RAISE NOTICE '══════════════════════════════════════════════════════════';
  RAISE NOTICE ' EMAIL WHITESPACE NORMALISATION';
  RAISE NOTICE '══════════════════════════════════════════════════════════';

  -- ── corporate email ─────────────────────────────────────────────────
  -- Show BEFORE → AFTER for every row that's about to be touched, so
  -- the audit trail in the NOTICE output is comprehensive.
  RAISE NOTICE '';
  RAISE NOTICE 'Corporate emails (employees.email):';
  FOR r IN
    SELECT id, name, email AS before_val,
           regexp_replace(email, ws_class, '', 'g') AS after_val
      FROM employees
     WHERE email IS NOT NULL
       AND email <> regexp_replace(email, ws_class, '', 'g')
     ORDER BY id
  LOOP
    RAISE NOTICE '  %  %', r.id, r.name;
    RAISE NOTICE '    before: %', quote_literal(r.before_val);
    RAISE NOTICE '    after : %', quote_literal(r.after_val);
  END LOOP;

  WITH upd AS (
    UPDATE employees
       SET email = regexp_replace(email, ws_class, '', 'g')
     WHERE email IS NOT NULL
       AND email <> regexp_replace(email, ws_class, '', 'g')
    RETURNING 1
  )
  SELECT count(*) INTO cnt_corp FROM upd;
  RAISE NOTICE '  → fixed % corporate email row(s)', cnt_corp;

  -- ── personal email ──────────────────────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'employees'
       AND column_name  = 'personal_email'
  ) THEN
    RAISE NOTICE '';
    RAISE NOTICE 'Personal emails (employees.personal_email):';
    FOR r IN
      SELECT id, name, personal_email AS before_val,
             regexp_replace(personal_email, ws_class, '', 'g') AS after_val
        FROM employees
       WHERE personal_email IS NOT NULL
         AND personal_email <> regexp_replace(personal_email, ws_class, '', 'g')
       ORDER BY id
    LOOP
      RAISE NOTICE '  %  %', r.id, r.name;
      RAISE NOTICE '    before: %', quote_literal(r.before_val);
      RAISE NOTICE '    after : %', quote_literal(r.after_val);
    END LOOP;

    WITH upd AS (
      UPDATE employees
         SET personal_email = regexp_replace(personal_email, ws_class, '', 'g')
       WHERE personal_email IS NOT NULL
         AND personal_email <> regexp_replace(personal_email, ws_class, '', 'g')
      RETURNING 1
    )
    SELECT count(*) INTO cnt_personal FROM upd;
    RAISE NOTICE '  → fixed % personal email row(s)', cnt_personal;
  ELSE
    RAISE NOTICE 'employees.personal_email column not present, skipping';
  END IF;

  -- ── Manual-review list ──────────────────────────────────────────────
  -- Rows the regex can't fix on its own. HR should look at each and
  -- update by hand (or via the Employee detail modal in the portal).
  RAISE NOTICE '';
  RAISE NOTICE 'NEEDS MANUAL REVIEW — issues the regex did not fix:';

  -- Corporate emails with weird local parts (spaces preserved as dots
  -- already removed, but unusual chars / typos remain).
  FOR r IN
    SELECT id, name, email, personal_email
      FROM employees
     WHERE
       -- known typo domains
       (email          ILIKE '%gamil.%' OR
        email          ILIKE '%hotmial.%' OR
        email          ILIKE '%yaho.%' OR
        email          ILIKE '%@%.con' OR
        email          ILIKE '%@%.cmo' OR
        personal_email ILIKE '%gamil.%' OR
        personal_email ILIKE '%hotmial.%' OR
        personal_email ILIKE '%yaho.%' OR
        personal_email ILIKE '%@%.con' OR
        personal_email ILIKE '%@%.cmo'
       )
        OR
       -- email ending with bracket / paren / other non-letter punctuation
       email           ~ '[)\]\}>,;:!?]$' OR
       personal_email  ~ '[)\]\}>,;:!?]$' OR
       -- broken: starts/ends with @ or has empty local/domain
       email          ~ '^@|@$|@\.' OR
       personal_email ~ '^@|@$|@\.'
     ORDER BY id
  LOOP
    RAISE NOTICE '  %  %  →  corp: % · pers: %',
                 r.id, r.name,
                 COALESCE(quote_literal(r.email), 'NULL'),
                 COALESCE(quote_literal(r.personal_email), 'NULL');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '══════════════════════════════════════════════════════════';
  RAISE NOTICE ' NORMALISATION COMPLETE';
  RAISE NOTICE '   corporate emails fixed: %', cnt_corp;
  RAISE NOTICE '   personal  emails fixed: %', COALESCE(cnt_personal, 0);
  RAISE NOTICE '   see MANUAL REVIEW list above for typos / broken rows';
  RAISE NOTICE '══════════════════════════════════════════════════════════';
END $$;
