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
  IF EMP_FILTER IS NULL THEN
    SELECT count(*) INTO cnt_leaves FROM leave_requests;
    DELETE FROM leave_requests;
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
      DELETE FROM sick_reminders;
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

  -- 3. notifications tied to leave events. We match on entity_type /
  --    kind / category being any of the leave-related markers used
  --    around the codebase. Multiple OR clauses so we catch every
  --    notification kind the app emitted historically.
  IF to_regclass('public.notifications') IS NOT NULL THEN
    IF EMP_FILTER IS NULL THEN
      WITH del AS (
        DELETE FROM notifications
         WHERE COALESCE(entity_type, '')  IN ('leave_request', 'leave', 'sick_certificate')
            OR COALESCE(kind, '')         LIKE 'leave_%'
            OR COALESCE(kind, '')         LIKE 'sick_%'
            OR COALESCE(category, '')     IN ('leave', 'sick_cert')
        RETURNING 1
      )
      SELECT count(*) INTO cnt_notifs FROM del;
    ELSE
      WITH del AS (
        DELETE FROM notifications
         WHERE recipient_id = ANY(EMP_FILTER)
           AND (COALESCE(entity_type, '')  IN ('leave_request', 'leave', 'sick_certificate')
             OR COALESCE(kind, '')         LIKE 'leave_%'
             OR COALESCE(kind, '')         LIKE 'sick_%'
             OR COALESCE(category, '')     IN ('leave', 'sick_cert'))
        RETURNING 1
      )
      SELECT count(*) INTO cnt_notifs FROM del;
    END IF;
    RAISE NOTICE '  ✓ deleted % leave-related notifications', cnt_notifs;
  ELSE
    RAISE NOTICE '  – notifications table not present, skipping';
  END IF;

  -- 4. audit_log entries describing leave events. Action names follow
  --    the 'leave_*' / 'sick_*' / 'substitute_*' / 'rejoin_*' prefixes
  --    used by directPost('audit_log', …) call sites.
  IF to_regclass('public.audit_log') IS NOT NULL THEN
    IF EMP_FILTER IS NULL THEN
      WITH del AS (
        DELETE FROM audit_log
         WHERE COALESCE(action, '') LIKE 'leave_%'
            OR COALESCE(action, '') LIKE 'sick_%'
            OR COALESCE(action, '') LIKE 'substitute_%'
            OR COALESCE(action, '') LIKE 'rejoin_%'
        RETURNING 1
      )
      SELECT count(*) INTO cnt_audit FROM del;
    ELSE
      WITH del AS (
        DELETE FROM audit_log
         WHERE (actor_id = ANY(EMP_FILTER) OR target_id = ANY(EMP_FILTER))
           AND (COALESCE(action, '') LIKE 'leave_%'
             OR COALESCE(action, '') LIKE 'sick_%'
             OR COALESCE(action, '') LIKE 'substitute_%'
             OR COALESCE(action, '') LIKE 'rejoin_%')
        RETURNING 1
      )
      SELECT count(*) INTO cnt_audit FROM del;
    END IF;
    RAISE NOTICE '  ✓ deleted % leave-related audit_log rows', cnt_audit;
  ELSE
    RAISE NOTICE '  – audit_log table not present, skipping';
  END IF;

  -- 5. leave_balances — reset adjustments + carry_over to 0 so the
  --    runtime balance calc shows the clean annual entitlement.
  --    (We don't DELETE the rows because they might carry the year
  --    pointer; setting fields to defaults keeps the row + clears it.)
  IF to_regclass('public.leave_balances') IS NOT NULL THEN
    IF EMP_FILTER IS NULL THEN
      WITH upd AS (
        UPDATE leave_balances
           SET carried_over    = 0,
               adjustment      = 0,
               adjustment_note = NULL
         WHERE COALESCE(carried_over, 0) <> 0
            OR COALESCE(adjustment, 0)    <> 0
            OR adjustment_note IS NOT NULL
        RETURNING 1
      )
      SELECT count(*) INTO cnt_balances FROM upd;
    ELSE
      WITH upd AS (
        UPDATE leave_balances
           SET carried_over    = 0,
               adjustment      = 0,
               adjustment_note = NULL
         WHERE employee_id = ANY(EMP_FILTER)
           AND (COALESCE(carried_over, 0) <> 0
             OR COALESCE(adjustment, 0)    <> 0
             OR adjustment_note IS NOT NULL)
        RETURNING 1
      )
      SELECT count(*) INTO cnt_balances FROM upd;
    END IF;
    RAISE NOTICE '  ✓ reset % leave_balances adjustment rows', cnt_balances;
  ELSE
    RAISE NOTICE '  – leave_balances table not present, skipping';
  END IF;

  -- ── OPTIONAL: rejoining_reports ─────────────────────────────────────
  -- Uncomment this block if you also want to clear the rejoining
  -- signatures (the post-leave 'I have returned' PDFs). By default we
  -- KEEP them as a paper trail even when leaves are cleared.
  --
  -- IF to_regclass('public.rejoining_reports') IS NOT NULL THEN
  --   IF EMP_FILTER IS NULL THEN
  --     DELETE FROM rejoining_reports;
  --   ELSE
  --     DELETE FROM rejoining_reports WHERE employee_id = ANY(EMP_FILTER);
  --   END IF;
  --   RAISE NOTICE '  ✓ deleted rejoining_reports';
  -- END IF;

  RAISE NOTICE '══════════════════════════════════════════════════════════';
  RAISE NOTICE ' RESET COMPLETE — start testing on esauhr.netlify.app';
  RAISE NOTICE '══════════════════════════════════════════════════════════';
END $$;
