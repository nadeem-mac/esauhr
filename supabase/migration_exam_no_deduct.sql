-- =============================================================================
-- Exam leave: do not deduct from a fixed balance
-- Date: 2026-06-14
--
-- Exam / study leave is granted by approval, not drawn down from a fixed
-- annual pool. Marking it 'unlimited' stops it showing a shrinking balance
-- (the card now renders it as ∞) while the actual exam-leave days are still
-- recorded as leave_request rows for the record.
--
-- Also switch it to calendar-day counting for consistency.
-- Idempotent.
-- =============================================================================

update public.leave_types
   set accrual_method            = 'unlimited',
       counts_working_days_only  = false
 where id = 'exam';

-- =============================================================================
-- OPTIONAL — set a special 30-day annual entitlement for an employee
-- (e.g. "Shaiji" — replace H_____ with the correct PSN).
--
-- This is normally done from the portal now: open the employee → LEAVE
-- BALANCES → "Set entitlement" → enter 30 + a note. The SQL below does the
-- same thing directly if preferred.
-- =============================================================================
-- update public.employees
--    set annual_entitlement_override = 30
--  where id = 'H_____';   -- <-- Shaiji's PSN

-- verify:
--   select id, name, annual_entitlement_override from public.employees
--    where annual_entitlement_override is not null;
