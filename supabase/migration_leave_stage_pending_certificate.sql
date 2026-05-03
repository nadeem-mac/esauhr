-- =====================================================================
-- Allow 'pending_certificate' in leave_requests.stage
-- =====================================================================
--
-- BACKGROUND
-- ----------
-- migration_sick_declaration.sql added the new 'pending_certificate'
-- stage but only mentioned it in commentary — it didn't update the
-- existing CHECK constraint on leave_requests.stage. The original
-- constraint was added by a manual schema edit (not tracked as a
-- migration in this repo), so it never got the new stage value.
--
-- Symptom in production:
--   When a staff member submits a Path A 'I'm sick today' declaration,
--   PostgREST returns:
--     HTTP 400: code 23514 (check_violation),
--     constraint "leave_requests_stage_chk"
--   The INSERT is rejected before the row is created.
--
-- This migration:
--   1. Drops the old constraint (regardless of which exact list of
--      stages it had — older constraints may have had subset lists).
--   2. Re-adds the constraint with the full canonical stage set used
--      by the application today.
--
-- Canonical stage set (single source of truth):
--   pending_manager        — submitted, awaiting line manager approval
--   pending_substitutes    — manager OK'd, awaiting substitute(s) accept
--   pending_hr             — substitutes done, awaiting Bashaier final
--   pending_certificate    — sick declared, awaiting Sehhaty cert  ← NEW
--   approved               — final approval issued
--   rejected_by_manager    — manager declined
--   rejected_by_substitute — a substitute declined the chain
--   rejected_by_hr         — Bashaier declined at final review
--   cancelled              — staff withdrew before approval
--   expired                — auto-marked when stale beyond a deadline
--
-- IDEMPOTENCY
-- -----------
-- Safe to run multiple times. The DROP uses IF EXISTS, the ADD uses
-- a fixed name we own. Re-running just rewrites the same constraint
-- with the same predicate.
-- =====================================================================

alter table public.leave_requests
  drop constraint if exists leave_requests_stage_chk;

alter table public.leave_requests
  add constraint leave_requests_stage_chk
  check (stage in (
    'pending_manager',
    'pending_substitutes',
    'pending_hr',
    'pending_certificate',
    'approved',
    'rejected_by_manager',
    'rejected_by_substitute',
    'rejected_by_hr',
    'cancelled',
    'expired'
  ));

comment on constraint leave_requests_stage_chk on public.leave_requests is
  'Whitelist of valid leave_requests.stage values. Updated by migration_leave_stage_pending_certificate.sql to add pending_certificate (sick declaration without cert yet).';
