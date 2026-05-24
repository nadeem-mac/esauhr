-- ════════════════════════════════════════════════════════════════════════
--  migration_add_holiday_shifts.sql  ·  Phase 1 of 6
--
--  Holiday-OT scheduling module — tracks who works during Eid Al Adha,
--  Eid Al Fitr, National Day and any other declared windows so the
--  manager-emailed Excel can be replaced with a portal-driven flow.
--
--  Nadeem 2026-05-21: 'managers are required to send the working
--  schedule for their respective staff during each holidays. The
--  system should have a provision how to mark the nominated staff
--  and assigned their working hours'.
--
-- ── TWO TABLES, NO SCHEMA FORK ──────────────────────────────────────────
--
--    holiday_periods  — HR-defined windows (Bashaier owns these).
--                       Each Eid / National Day = one row.
--
--    holiday_shifts   — Manager-nominated assignments. One row per
--                       (employee, date). Status flows
--                       pending → approved by HR → can be edited /
--                       cancelled mid-period if needs change.
--
-- ── DESIGN DECISIONS LOCKED WITH NADEEM ─────────────────────────────────
--
--    • NO OT rate stored — payroll handles compensation externally;
--      portal only captures the schedule + actual-vs-expected delta.
--    • EDIT/CANCEL allowed after approval — managers fix mid-period.
--    • UNIQUE (employee_id, shift_date) — no split shifts in one day
--      (matches the manager-Excel format we're replacing).
--    • STRICT comparison vs attendance (no grace period) — applied
--      later in Phase 5 when this layer overlays the normal evaluator.
-- ════════════════════════════════════════════════════════════════════════

-- ── holiday_periods ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS holiday_periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,                       -- 'Eid Al Adha 2026'
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  is_active    boolean DEFAULT true,
  notes        text,                                -- optional context
  created_by   text REFERENCES employees(id),
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now(),
  CONSTRAINT holiday_periods_dates_valid CHECK (end_date >= start_date)
);

-- Fast 'is any period active that covers this date?' query — used by
-- attendance overlay in Phase 5 + staff dashboard tile in Phase 4.
CREATE INDEX IF NOT EXISTS holiday_periods_active_idx
  ON holiday_periods (start_date, end_date)
 WHERE is_active = true;

-- Updated_at trigger — keeps the timestamp fresh on edits.
CREATE OR REPLACE FUNCTION holiday_periods_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS holiday_periods_set_updated_at ON holiday_periods;
CREATE TRIGGER holiday_periods_set_updated_at
  BEFORE UPDATE ON holiday_periods
  FOR EACH ROW EXECUTE FUNCTION holiday_periods_touch_updated_at();


-- ── holiday_shifts ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS holiday_shifts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_period_id uuid REFERENCES holiday_periods(id) ON DELETE CASCADE,
  employee_id       text NOT NULL REFERENCES employees(id),
  shift_date        date NOT NULL,
  clock_in_time     time NOT NULL,                 -- 09:00
  clock_out_time    time NOT NULL,                 -- 12:00
  expected_hours    numeric(4,2),                  -- auto from in/out
  assigned_by       text NOT NULL REFERENCES employees(id),  -- the manager
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  approved_by       text REFERENCES employees(id), -- Bashaier on approval
  approved_at       timestamptz,
  rejection_reason  text,
  notes             text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  CONSTRAINT holiday_shifts_times_valid CHECK (clock_out_time > clock_in_time),
  CONSTRAINT holiday_shifts_unique_day  UNIQUE (employee_id, shift_date)
);

-- Common query paths
CREATE INDEX IF NOT EXISTS holiday_shifts_employee_idx
  ON holiday_shifts (employee_id, shift_date);
CREATE INDEX IF NOT EXISTS holiday_shifts_period_idx
  ON holiday_shifts (holiday_period_id, status);
CREATE INDEX IF NOT EXISTS holiday_shifts_date_idx
  ON holiday_shifts (shift_date);
CREATE INDEX IF NOT EXISTS holiday_shifts_assigned_by_idx
  ON holiday_shifts (assigned_by);

-- Auto-compute expected_hours from clock_in_time / clock_out_time
-- so the front-end doesn't have to send it.
CREATE OR REPLACE FUNCTION holiday_shifts_compute_hours()
RETURNS trigger AS $$
BEGIN
  NEW.expected_hours = ROUND(
    (EXTRACT(EPOCH FROM (NEW.clock_out_time - NEW.clock_in_time)) / 3600.0)::numeric,
    2
  );
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS holiday_shifts_set_hours_insert ON holiday_shifts;
CREATE TRIGGER holiday_shifts_set_hours_insert
  BEFORE INSERT ON holiday_shifts
  FOR EACH ROW EXECUTE FUNCTION holiday_shifts_compute_hours();

DROP TRIGGER IF EXISTS holiday_shifts_set_hours_update ON holiday_shifts;
CREATE TRIGGER holiday_shifts_set_hours_update
  BEFORE UPDATE ON holiday_shifts
  FOR EACH ROW EXECUTE FUNCTION holiday_shifts_compute_hours();


-- ── Tell PostgREST about the new tables ────────────────────────────────
NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  hp_count bigint;
  hs_count bigint;
BEGIN
  SELECT count(*) INTO hp_count FROM holiday_periods;
  SELECT count(*) INTO hs_count FROM holiday_shifts;
  RAISE NOTICE '══════════════════════════════════════════════════════════';
  RAISE NOTICE ' HOLIDAY-OT SCHEMA READY';
  RAISE NOTICE '   holiday_periods rows: %', hp_count;
  RAISE NOTICE '   holiday_shifts  rows: %', hs_count;
  RAISE NOTICE '   PostgREST schema cache reload signalled';
  RAISE NOTICE '══════════════════════════════════════════════════════════';
END $$;
