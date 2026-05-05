-- ─────────────────────────────────────────────────────────────────────
-- Add off-day pattern to monthly_shift_plans
-- ─────────────────────────────────────────────────────────────────────
-- Lets the manager explicitly mark certain WEEKDAYS as off for a
-- specific (manager, employee, month) plan. Stored as a Postgres
-- integer array of weekday numbers using the JS getDay() convention:
--
--     0 = Sunday    1 = Monday    2 = Tuesday    3 = Wednesday
--     4 = Thursday  5 = Friday    6 = Saturday
--
-- Example: FAHAD H94178 works Saturdays only with Sun + Fri off.
-- His tracker row would store off_weekdays = '{0,5}' meaning
-- Sunday and Friday are explicitly marked as off for May 2026.
--
-- THIS IS IN ADDITION TO IMPLICIT OFF HANDLING
-- The attendance evaluator already treats any date with no shift
-- in employee_shifts as "off-roster". This off-pattern column adds
-- explicit intent on top of that, so the planner UI can:
--   • Show off-pattern weekdays with a gray OFF label in the
--     calendar grid (vs the white blank for unspecified days)
--   • Carry the off-pattern forward when cloning last month's plan
--   • Drive printable / shareable schedule reports later (Phase 2)
--   • Drive a clearer "this is policy off-day" label in the
--     attendance off-roster diagnostic (Phase 2)
--
-- WORKING SHIFTS WIN
-- If a date has BOTH a working shift in employee_shifts AND its
-- weekday is in off_weekdays, the working shift wins. Manager
-- assigning a one-off Friday cover for FAHAD overrides his
-- usual Friday-off pattern.
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

alter table public.monthly_shift_plans
  add column if not exists off_weekdays integer[]
    not null default '{}'::integer[];
