-- ─────────────────────────────────────────────────────────────────────
-- Drop unused certificate-tracking columns from leave_requests
-- ─────────────────────────────────────────────────────────────────────
-- The columns 'cert_received' and 'cert_uploaded_at' were added in
-- migration_sick_cert_tracking.sql in anticipation of a magic-link
-- /cert/<token> upload page (Phase 4). That phase was abandoned per
-- Nadeem 2026-05-10: staff must use the portal, no separate magic
-- link. The columns sit in the database with default 'false'/'null'
-- and have never been written to by any code path.
--
-- Existing tracking is sufficient: when a staff uploads the cert via
-- the portal, the leave_requests row's stage flips out of
-- 'pending_certificate' (to 'pending_manager' for normal flow, or
-- 'approved' for blocked-state cert-only escape). The chase cron
-- selects rows by stage = 'pending_certificate', not by the
-- now-dropped boolean.
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

alter table public.leave_requests
  drop column if exists cert_received,
  drop column if exists cert_uploaded_at;
