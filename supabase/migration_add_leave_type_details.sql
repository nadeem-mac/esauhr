-- ════════════════════════════════════════════════════════════════════════
--  migration_add_leave_type_details.sql
--
--  Adds the `type_details` JSONB column to `leave_requests`. The
--  column holds the per-leave-type extra fields that don't warrant
--  their own dedicated columns (maternity expected_delivery, hajj
--  group, marriage contract_no, etc.).
--
--  Nadeem 2026-05-18:
--    'HTTP 400: PGRST204 Could not find the type_details column of
--     leave_requests in the schema cache'
--
--  PGRST204 = the column genuinely doesn't exist (vs. PostgREST cache
--  staleness). NewRequestModal writes `type_details` on every submit;
--  LeaveApprovedModal + HrApprovalModal read + enrich it before PDF
--  generation; the leave PDF reads from it to populate the type-
--  specific section (MEDICAL CERTIFICATE for sick, MATERNITY DETAILS
--  for maternity, etc.).
--
-- ── WHAT THE COLUMN STORES ──────────────────────────────────────────────
--
--  JSONB shape varies by leave_type_id. Example payloads:
--
--    sick:        {cert_ref, cert_code, cert_date, facility, doctor_name,
--                  specialty, diagnosis, fit_to_return, seen_start,
--                  seen_end, seen_days, seen_patient_name,
--                  seen_patient_id, verified_at, verified_by}
--
--    maternity:   {expected_delivery, hospital, cert_ref,
--                  pregnancy_number, prenatal_days, postnatal_days,
--                  already_delivered, actual_delivery, nursing_hours}
--
--    paternity:   {spouse_name, expected_delivery, hospital,
--                  actual_delivery}
--
--    hajj:        {season_year, group, departure_date, return_date,
--                  first_time, service_years}
--
--    marriage:    {spouse_name, wedding_date, location, contract_no}
--
--    bereavement: {deceased_name, relationship, date_of_passing,
--                  funeral_location}
--
--    emergency:   {nature, contact_person, contact_phone, location}
--
--    study:       {institution, course, format, total_duration, field,
--                  relevance}
--
--    unpaid:      {reason, return_commitment}
--
--    iddah:       (per Saudi labour law fields)
--
--    annual:      {} or NULL (no extra fields)
--
-- ── HOW TO RUN ──────────────────────────────────────────────────────────
--
--    1. Supabase Dashboard → SQL Editor → New Query
--    2. Paste this entire file
--    3. Click Run
--    4. PostgREST schema cache reloads automatically (NOTIFY pgrst)
-- ════════════════════════════════════════════════════════════════════════

-- Add the column if missing. JSONB is preferred over JSON because:
--   • indexable (GIN + B-tree on extracted paths)
--   • compact storage
--   • cheaper to query (no re-parsing on every read)
ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS type_details jsonb;

-- Optional but useful: a GIN index for ad-hoc queries on JSON paths.
-- Cheap to maintain since this column rarely changes after creation.
CREATE INDEX IF NOT EXISTS leave_requests_type_details_gin
  ON leave_requests USING gin (type_details);

-- Tell PostgREST to reload its schema cache so the new column is
-- immediately visible without a manual restart.
NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  cnt_total bigint;
BEGIN
  SELECT count(*) INTO cnt_total FROM leave_requests;
  RAISE NOTICE '══════════════════════════════════════════════════════════';
  RAISE NOTICE ' type_details column ready';
  RAISE NOTICE '   leave_requests row count: %', cnt_total;
  RAISE NOTICE '   PostgREST schema cache reload signalled';
  RAISE NOTICE '══════════════════════════════════════════════════════════';
END $$;
