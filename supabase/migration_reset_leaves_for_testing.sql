-- ════════════════════════════════════════════════════════════════════════
--  migration_reset_leaves_for_testing.sql
--
--  Clears every leave application + related transactional data so HR can
--  test the full leave workflow on real employees from scratch. Run this
--  ONCE in the Supabase SQL Editor before kicking off a testing round.
--
--  Nadeem 2026-05-18: 'okay let us do the testing for staff, reset all
--  leaves so we can try testing on few staff and see how it works.'
--
-- ── WHAT GETS DELETED ───────────────────────────────────────────────────
--    • leave_requests             — every submitted leave (all statuses)
--    • sick_reminders             — daily reminder rows for pending certs
--    • notifications (leave only) — bell-badge entries tied to leaves
--    • audit_log (leave only)     — audit rows for leave events
--    • leave_balances adjustments — manual HR-set carry/adjustment values
--                                   (set back to 0 / NULL so balances
--                                   show the clean entitlement)
--
-- ── WHAT IS PRESERVED ───────────────────────────────────────────────────
--    • employees                  — every employee record
--    • leave_types                — entitlement definitions (annual=21d…)
--    • public_holidays            — KSA calendar
--    • attendance_daily           — every punch record
--    • attendance_uploads         — historical Excel imports
--    • attendance_violations      — independent of leave data
--    • evaluation_scores          — computed from violations, untouched
--    • permission_requests        — separate workflow (Late Arrival / EOD)
--    • rejoining_reports          — rejoin signatures (kept as paper trail)
--                                   Note: if you also want these cleared,
--                                   uncomment the rejoin block below.
--    • monthly_shift_plans        — shift scheduling, untouched
--    • offer_letters / mawani     — onboarding pipeline, untouched
--
-- ── HOW TO RUN ──────────────────────────────────────────────────────────
--    1. Open Supabase Dashboard → SQL Editor → New Query
--    2. Paste this entire file
--    3. Click 'Run'
--    4. Watch the NOTICE output — confirms how many rows were cleared
--    5. Reload esauhr.netlify.app — leave-related views will be empty
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────
--    Supabase SQL Editor wraps every script in a transaction — if any
--    statement fails, the WHOLE script rolls back automatically. There
--    is no undo button once the script succeeds, so make sure this is
--    what you want before clicking Run. Take a Supabase backup if you
--    want belt-and-braces safety:
--      Dashboard → Database → Backups → Manual Backup
--
-- ── SCOPED-RESET MODE ───────────────────────────────────────────────────
--    To reset only for SPECIFIC employees (instead of everyone), change
--    the EMP_FILTER value at the top from NULL to an array of PSN IDs:
--      EMP_FILTER text[] := ARRAY['H94328', 'H94830', 'H94590'];
--    The script then scopes every DELETE/UPDATE to those employees only.
-- ════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  -- Set to NULL to reset for EVERY employee, or to an array of PSN IDs
  -- like ARRAY['H94328', 'H94830'] to reset just those people.
  EMP_FILTER text[] := NULL;

  cnt_leaves    bigint;
  cnt_reminders bigint;
  cnt_notifs    bigint;
  cnt_audit     bigint;
  cnt_balances  bigint;
  scope_label   text;
BEGIN
  scope_label := CASE
    WHEN EMP_FILTER IS NULL THEN 'ALL EMPLOYEES'
    ELSE 'employees: ' || array_to_string(EMP_FILTER, ', ')
  END;

  RAISE NOTICE '══════════════════════════════════════════════════════════';
  RAISE NOTICE ' LEAVE RESET — scope: %', scope_label;
  RAISE NOTICE '══════════════════════════════════════════════════════════';

  -- 1. leave_requests
  --    Supabase enforces safeupdate (DELETE/UPDATE without WHERE is
  --    blocked with SQLSTATE 21000). We add `WHERE TRUE` for the
  --    everyone-mode DELETE so the guard is satisfied — semantically
  --    identical to no WHERE, but explicit.
  IF EMP_FILTER IS NULL THEN
    SELECT count(*) INTO cnt_leaves FROM leave_requests;
    DELETE FROM leave_requests WHERE TRUE;
  ELSE
    SELECT count(*) INTO cnt_leaves
      FROM leave_requests
     WHERE employee_id = ANY(EMP_FILTER);
    DELETE FROM leave_requests
     WHERE employee_id = ANY(EMP_FILTER);
  END IF;
  RAISE NOTICE '  ✓ deleted % leave_requests rows', cnt_leaves;

  -- 2. sick_reminders
  IF to_regclass('public.sick_reminders') IS NOT NULL THEN
    IF EMP_FILTER IS NULL THEN
      SELECT count(*) INTO cnt_reminders FROM sick_reminders;
      DELETE FROM sick_reminders WHERE TRUE;
    ELSE
      SELECT count(*) INTO cnt_reminders
        FROM sick_reminders
       WHERE employee_id = ANY(EMP_FILTER);
      DELETE FROM sick_reminders
       WHERE employee_id = ANY(EMP_FILTER);
    END IF;
    RAISE NOTICE '  ✓ deleted % sick_reminders rows', cnt_reminders;
  ELSE
    RAISE NOTICE '  – sick_reminders table not present, skipping';
  END IF;

  -- 3. notifications tied to leave events.
  --
  --    The schema of this table varies between Supabase projects (some
  --    use entity_type, some use kind, some category, some all three).
  --    Rather than hard-coding column names that may not exist (the
  --    previous version hit '42703: column "entity_type" does not
  --    exist'), we introspect information_schema.columns first and
  --    build a DELETE that references ONLY columns that actually
  --    exist. If none of our expected marker columns are present,
  --    we skip the cleanup with an explanatory NOTICE rather than
  --    blow up the whole script.
  IF to_regclass('public.notifications') IS NOT NULL THEN
    DECLARE
      has_entity_type bool;
      has_kind        bool;
      has_category    bool;
      has_type        bool;
      has_recipient   bool;
      where_clause    text := '';
      sql_text        text;
    BEGIN
      SELECT bool_or(column_name = 'entity_type'),
             bool_or(column_name = 'kind'),
             bool_or(column_name = 'category'),
             bool_or(column_name = 'type'),
             bool_or(column_name = 'recipient_id')
        INTO has_entity_type, has_kind, has_category, has_type, has_recipient
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'notifications';

      -- Build the OR-chain of column matchers, only including columns
      -- the table actually has.
      IF has_entity_type THEN
        where_clause := where_clause || ' OR COALESCE(entity_type, '''') IN (''leave_request'', ''leave'', ''sick_certificate'')';
      END IF;
      IF has_kind THEN
        where_clause := where_clause || ' OR COALESCE(kind, '''') LIKE ''leave_%''';
        where_clause := where_clause || ' OR COALESCE(kind, '''') LIKE ''sick_%''';
      END IF;
      IF has_category THEN
        where_clause := where_clause || ' OR COALESCE(category, '''') IN (''leave'', ''sick_cert'')';
      END IF;
      IF has_type THEN
        where_clause := where_clause || ' OR COALESCE(type, '''') LIKE ''leave_%''';
        where_clause := where_clause || ' OR COALESCE(type, '''') LIKE ''sick_%''';
      END IF;

      IF where_clause = '' THEN
        RAISE NOTICE '  – notifications: no recognised leave/sick marker column, skipping';
      ELSE
        -- Strip the leading ' OR ' and wrap in parens so the scoped
        -- mode can AND it with the employee filter cleanly.
        where_clause := '(' || substring(where_clause from 5) || ')';

        IF EMP_FILTER IS NULL THEN
          sql_text := format(
            'WITH del AS (DELETE FROM notifications WHERE %s RETURNING 1) SELECT count(*) FROM del',
            where_clause);
        ELSIF has_recipient THEN
          sql_text := format(
            'WITH del AS (DELETE FROM notifications WHERE recipient_id = ANY($1) AND %s RETURNING 1) SELECT count(*) FROM del',
            where_clause);
        ELSE
          -- Scoped mode requested but no recipient_id column to filter
          -- by — fall back to clearing for everyone since we can't
          -- safely scope. Warn so HR knows.
          RAISE NOTICE '  ! notifications: no recipient_id column for scoped delete — falling back to all';
          sql_text := format(
            'WITH del AS (DELETE FROM notifications WHERE %s RETURNING 1) SELECT count(*) FROM del',
            where_clause);
        END IF;

        IF EMP_FILTER IS NULL OR NOT has_recipient THEN
          EXECUTE sql_text INTO cnt_notifs;
        ELSE
          EXECUTE sql_text INTO cnt_notifs USING EMP_FILTER;
        END IF;
        RAISE NOTICE '  ✓ deleted % leave-related notifications', cnt_notifs;
      END IF;
    END;
  ELSE
    RAISE NOTICE '  – notifications table not present, skipping';
  END IF;

  -- 4. audit_log entries describing leave events. Action names follow
  --    the 'leave_*' / 'sick_*' / 'substitute_*' / 'rejoin_*' prefixes
  --    used by directPost('audit_log', …) call sites.
  --    Same schema-aware introspection pattern as the notifications
  --    block — verifies which columns exist before referencing them.
  IF to_regclass('public.audit_log') IS NOT NULL THEN
    DECLARE
      has_action      bool;
      has_actor_id    bool;
      has_target_id   bool;
      has_employee_id bool;
      where_action    text := '';
      where_scope     text := '';
      sql_text        text;
    BEGIN
      SELECT bool_or(column_name = 'action'),
             bool_or(column_name = 'actor_id'),
             bool_or(column_name = 'target_id'),
             bool_or(column_name = 'employee_id')
        INTO has_action, has_actor_id, has_target_id, has_employee_id
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'audit_log';

      IF NOT has_action THEN
        RAISE NOTICE '  – audit_log: no action column found, skipping';
      ELSE
        where_action := '(COALESCE(action, '''') LIKE ''leave_%''
                       OR COALESCE(action, '''') LIKE ''sick_%''
                       OR COALESCE(action, '''') LIKE ''substitute_%''
                       OR COALESCE(action, '''') LIKE ''rejoin_%'')';

        -- Scope clause uses whichever employee-pointer columns the
        -- table actually has (actor_id / target_id / employee_id).
        IF EMP_FILTER IS NOT NULL THEN
          IF has_actor_id THEN
            where_scope := where_scope || ' OR actor_id = ANY($1)';
          END IF;
          IF has_target_id THEN
            where_scope := where_scope || ' OR target_id = ANY($1)';
          END IF;
          IF has_employee_id THEN
            where_scope := where_scope || ' OR employee_id = ANY($1)';
          END IF;
          IF where_scope = '' THEN
            RAISE NOTICE '  ! audit_log: no employee-id column for scoped delete — clearing all leave-related rows';
          ELSE
            where_scope := '(' || substring(where_scope from 5) || ') AND ';
          END IF;
        END IF;

        IF EMP_FILTER IS NULL OR where_scope = '' THEN
          sql_text := format(
            'WITH del AS (DELETE FROM audit_log WHERE %s RETURNING 1) SELECT count(*) FROM del',
            where_action);
          EXECUTE sql_text INTO cnt_audit;
        ELSE
          sql_text := format(
            'WITH del AS (DELETE FROM audit_log WHERE %s%s RETURNING 1) SELECT count(*) FROM del',
            where_scope, where_action);
          EXECUTE sql_text INTO cnt_audit USING EMP_FILTER;
        END IF;
        RAISE NOTICE '  ✓ deleted % leave-related audit_log rows', cnt_audit;
      END IF;
    END;
  ELSE
    RAISE NOTICE '  – audit_log table not present, skipping';
  END IF;

  -- 5. leave_balances — reset adjustments + carry_over to 0 so the
  --    runtime balance calc shows the clean annual entitlement.
  --    Same schema-aware introspection pattern: only touches columns
  --    that actually exist.
  IF to_regclass('public.leave_balances') IS NOT NULL THEN
    DECLARE
      has_carried bool;
      has_adj     bool;
      has_note    bool;
      set_clause  text := '';
      where_dirty text := '';
      sql_text    text;
    BEGIN
      SELECT bool_or(column_name = 'carried_over'),
             bool_or(column_name = 'adjustment'),
             bool_or(column_name = 'adjustment_note')
        INTO has_carried, has_adj, has_note
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'leave_balances';

      IF has_carried THEN
        set_clause  := set_clause  || ', carried_over = 0';
        where_dirty := where_dirty || ' OR COALESCE(carried_over, 0) <> 0';
      END IF;
      IF has_adj THEN
        set_clause  := set_clause  || ', adjustment = 0';
        where_dirty := where_dirty || ' OR COALESCE(adjustment, 0) <> 0';
      END IF;
      IF has_note THEN
        set_clause  := set_clause  || ', adjustment_note = NULL';
        where_dirty := where_dirty || ' OR adjustment_note IS NOT NULL';
      END IF;

      IF set_clause = '' THEN
        RAISE NOTICE '  – leave_balances: none of the adjustment columns exist, skipping';
      ELSE
        set_clause  := substring(set_clause from 3);          -- strip leading ', '
        where_dirty := '(' || substring(where_dirty from 5) || ')'; -- strip leading ' OR '

        IF EMP_FILTER IS NULL THEN
          sql_text := format(
            'WITH upd AS (UPDATE leave_balances SET %s WHERE %s RETURNING 1) SELECT count(*) FROM upd',
            set_clause, where_dirty);
          EXECUTE sql_text INTO cnt_balances;
        ELSE
          sql_text := format(
            'WITH upd AS (UPDATE leave_balances SET %s WHERE employee_id = ANY($1) AND %s RETURNING 1) SELECT count(*) FROM upd',
            set_clause, where_dirty);
          EXECUTE sql_text INTO cnt_balances USING EMP_FILTER;
        END IF;
        RAISE NOTICE '  ✓ reset % leave_balances adjustment rows', cnt_balances;
      END IF;
    END;
  ELSE
    RAISE NOTICE '  – leave_balances table not present, skipping';
  END IF;

  -- ── OPTIONAL: rejoining_reports ─────────────────────────────────────
  -- Uncomment this block if you also want to clear the rejoining
  -- signatures (the post-leave 'I have returned' PDFs). By default we
  -- KEEP them as a paper trail even when leaves are cleared.
  -- Note: Supabase safeupdate requires WHERE even for everyone-mode,
  -- hence the `WHERE TRUE`.
  --
  -- IF to_regclass('public.rejoining_reports') IS NOT NULL THEN
  --   IF EMP_FILTER IS NULL THEN
  --     DELETE FROM rejoining_reports WHERE TRUE;
  --   ELSE
  --     DELETE FROM rejoining_reports WHERE employee_id = ANY(EMP_FILTER);
  --   END IF;
  --   RAISE NOTICE '  ✓ deleted rejoining_reports';
  -- END IF;

  RAISE NOTICE '══════════════════════════════════════════════════════════';
  RAISE NOTICE ' RESET COMPLETE — start testing on esauhr.netlify.app';
  RAISE NOTICE '══════════════════════════════════════════════════════════';
END $$;
