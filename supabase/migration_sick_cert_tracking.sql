-- =============================================================================
-- Sick leave simplification — cert tracking columns
-- Date: 2026-05-08
--
-- Folds the old `pending_certificate` stage into a simpler model:
-- a sick leave row goes through the normal stage flow (pending_manager →
-- pending_hr → approved) and the Sehhaty certificate is just an attached
-- attribute, tracked via boolean + timestamp + ID columns.
--
-- New columns on leave_requests:
--   • cert_received     — boolean, default false
--   • cert_id           — text, the Sehhaty certificate number (e.g. SH-447291)
--   • cert_uploaded_at  — timestamp when the PDF was successfully uploaded
--   • cert_deadline_at  — timestamp the cert must arrive by (24h after submission)
--   • declared_via      — text, who created the row: 'staff' (default) /
--                         'manager_on_behalf' / 'hr_on_behalf' / 'auto_marked'
--   • magic_link_token  — uuid, opaque token for the public cert-upload page
--
-- All ADDs use IF NOT EXISTS so the migration is safe to re-run.
-- =============================================================================

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS cert_received    boolean      DEFAULT false,
  ADD COLUMN IF NOT EXISTS cert_id          text,
  ADD COLUMN IF NOT EXISTS cert_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS cert_deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS declared_via     text         DEFAULT 'staff',
  ADD COLUMN IF NOT EXISTS magic_link_token uuid         DEFAULT gen_random_uuid();

-- Backfill existing pending_certificate rows. Today these rows live in
-- stage='pending_certificate' meaning "submitted but cert not yet attached".
-- After this migration they're just normal sick leave rows with
-- cert_received=false. The cert_chase cron then takes over, sending
-- reminders based on cert_deadline_at.
UPDATE leave_requests
SET
  cert_received    = false,
  cert_deadline_at = COALESCE(cert_deadline_at, created_at + interval '24 hours'),
  declared_via     = COALESCE(declared_via, 'staff')
WHERE stage = 'pending_certificate'
  AND cert_received IS NULL;

-- Helpful indexes for the cert-chase cron to find rows efficiently.
CREATE INDEX IF NOT EXISTS idx_leave_requests_cert_deadline
  ON leave_requests(cert_deadline_at)
  WHERE cert_received = false;

CREATE INDEX IF NOT EXISTS idx_leave_requests_magic_link
  ON leave_requests(magic_link_token);

-- Verify with:
--   SELECT id, stage, cert_received, cert_deadline_at, declared_via
--   FROM leave_requests
--   WHERE leave_type_id = 'sick'
--   ORDER BY created_at DESC
--   LIMIT 10;
