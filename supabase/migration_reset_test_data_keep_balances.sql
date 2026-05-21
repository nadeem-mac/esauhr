-- ════════════════════════════════════════════════════════════════════════
--  RESET_TEST_DATA_KEEP_BALANCES.sql
--
--  Wipes ONLY the test leave + permission requests created during portal
--  testing, leaving the freshly-imported leave_balances (from
--  SYNC_LEAVE_BALANCES.sql) intact.
--
--  Nadeem 2026-05-21: 'i want to reset it, so we can start fresh after
--  importing the actual leave'
--
-- ── WHAT GETS DELETED ───────────────────────────────────────────────────
--    • leave_requests       — every test leave (all stages)
--    • permission_requests  — every test late-arrival / early-departure
--    • sick_reminders       — pending-cert reminder rows
--    • notifications        — bell-badge entries for leave/permission/sick
--    • audit_log            — leave/sick/substitute/rejoin/permission rows
--
-- ── WHAT IS PRESERVED ───────────────────────────────────────────────────
--    • leave_balances       — KEPT (your freshly-imported tracker state)
--    • employees, leave_types, public_holidays, attendance_*,
--      evaluation_scores, rejoining_reports — all untouched
-- ════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  cnt_leaves      bigint := 0;
  cnt_permissions bigint := 0;
  cnt_reminders   bigint := 0;
  cnt_notifs      bigint := 0;
  cnt_audit       bigint := 0;
BEGIN
  RAISE NOTICE '══════════════════════════════════════════════════════════';
  RAISE NOTICE ' RESET TEST DATA — leave_balances PRESERVED';
  RAISE NOTICE '══════════════════════════════════════════════════════════';

  -- 1. leave_requests
  IF to_regclass('public.leave_requests') IS NOT NULL THEN
    SELECT count(*) INTO cnt_leaves FROM leave_requests;
    DELETE FROM leave_requests WHERE TRUE;
    RAISE NOTICE '  ✓ deleted % leave_requests rows', cnt_leaves;
  END IF;

  -- 2. permission_requests
  IF to_regclass('public.permission_requests') IS NOT NULL THEN
    SELECT count(*) INTO cnt_permissions FROM permission_requests;
    DELETE FROM permission_requests WHERE TRUE;
    RAISE NOTICE '  ✓ deleted % permission_requests rows', cnt_permissions;
  END IF;

  -- 3. sick_reminders
  IF to_regclass('public.sick_reminders') IS NOT NULL THEN
    SELECT count(*) INTO cnt_reminders FROM sick_reminders;
    DELETE FROM sick_reminders WHERE TRUE;
    RAISE NOTICE '  ✓ deleted % sick_reminders rows', cnt_reminders;
  END IF;

  -- 4. notifications tied to leave/permission/sick events
  -- (schema-aware: only touches columns that exist)
  IF to_regclass('public.notifications') IS NOT NULL THEN
    DECLARE
      has_entity_type bool;
      has_kind        bool;
      has_category    bool;
      has_type        bool;
      where_clause    text := '';
      sql_text        text;
    BEGIN
      SELECT bool_or(column_name = 'entity_type'),
             bool_or(column_name = 'kind'),
             bool_or(column_name = 'category'),
             bool_or(column_name = 'type')
        INTO has_entity_type, has_kind, has_category, has_type
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'notifications';

      IF has_entity_type THEN
        where_clause := where_clause || ' OR COALESCE(entity_type, '''') IN (''leave_request'', ''leave'', ''sick_certificate'', ''permission_request'', ''permission'')';
      END IF;
      IF has_kind THEN
        where_clause := where_clause || ' OR COALESCE(kind, '''') LIKE ''leave_%''';
        where_clause := where_clause || ' OR COALESCE(kind, '''') LIKE ''sick_%''';
        where_clause := where_clause || ' OR COALESCE(kind, '''') LIKE ''permission_%''';
      END IF;
      IF has_category THEN
        where_clause := where_clause || ' OR COALESCE(category, '''') IN (''leave'', ''sick_cert'', ''permission'')';
      END IF;
      IF has_type THEN
        where_clause := where_clause || ' OR COALESCE(type, '''') LIKE ''leave_%''';
        where_clause := where_clause || ' OR COALESCE(type, '''') LIKE ''sick_%''';
        where_clause := where_clause || ' OR COALESCE(type, '''') LIKE ''permission_%''';
      END IF;

      IF where_clause <> '' THEN
        where_clause := '(' || substring(where_clause from 5) || ')';
        sql_text := format(
          'WITH del AS (DELETE FROM notifications WHERE %s RETURNING 1) SELECT count(*) FROM del',
          where_clause);
        EXECUTE sql_text INTO cnt_notifs;
        RAISE NOTICE '  ✓ deleted % leave-related notifications', cnt_notifs;
      END IF;
    END;
  END IF;

  -- 5. audit_log (schema-aware)
  IF to_regclass('public.audit_log') IS NOT NULL THEN
    DECLARE
      has_action bool;
      sql_text   text;
    BEGIN
      SELECT bool_or(column_name = 'action')
        INTO has_action
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'audit_log';

      IF has_action THEN
        sql_text := 'WITH del AS (DELETE FROM audit_log WHERE '
                 || '(COALESCE(action, '''') LIKE ''leave_%'' '
                 || ' OR COALESCE(action, '''') LIKE ''sick_%'' '
                 || ' OR COALESCE(action, '''') LIKE ''substitute_%'' '
                 || ' OR COALESCE(action, '''') LIKE ''rejoin_%'' '
                 || ' OR COALESCE(action, '''') LIKE ''permission_%'') '
                 || 'RETURNING 1) SELECT count(*) FROM del';
        EXECUTE sql_text INTO cnt_audit;
        RAISE NOTICE '  ✓ deleted % audit_log rows', cnt_audit;
      END IF;
    END;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '  ↪ leave_balances PRESERVED (tracker import intact)';
  RAISE NOTICE '══════════════════════════════════════════════════════════';
  RAISE NOTICE ' READY FOR FRESH TESTING — esauhr.netlify.app';
  RAISE NOTICE '══════════════════════════════════════════════════════════';
END $$;
