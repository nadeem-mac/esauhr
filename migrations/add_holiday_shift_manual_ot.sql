-- Manager-dictated OT hours for a holiday shift.
-- When set, the OT report uses this value as the credited OT (ASSIGNED
-- HRS) for that shift instead of the punch-computed figure. Used for
-- overnight / extended Eid work where the manager fixes the hours
-- (e.g. Sonnie: "apply 2.0 OT work hours").
--
-- Idempotent. Run in the Supabase SQL editor (no BEGIN/COMMIT).

ALTER TABLE holiday_shifts
  ADD COLUMN IF NOT EXISTS manual_ot_hours numeric(4,2);

COMMENT ON COLUMN holiday_shifts.manual_ot_hours IS
  'Manager-approved OT hours for this shift; overrides the computed worked hours in the OT report when set.';
