-- =============================================================================
-- Seed all standard leave types (corrected for actual schema)
-- Date: 2026-05-08
--
-- Populates `leave_types` with every leave category staff can request.
-- All requests created against any of these go through the same flow:
--
--     STAFF SUBMITS  →  MANAGER REVIEWS  →  HR (BASHAIER) FINAL APPROVES
--
-- Approval flow is enforced by `leave_requests.stage` + its trigger
-- (already in place); no flow changes needed here.
--
-- Uses ON CONFLICT (id) DO UPDATE so it's safe to re-run.
-- =============================================================================

INSERT INTO leave_types (
  id, name, default_days, accrual_method, color, is_paid,
  requires_attachment, min_service_months, max_per_service,
  applies_to_gender, counts_working_days_only, description,
  sort_order, active
) VALUES

  -- Annual paid leave — KSA Art. 109 (21 days, 30 after 5 yrs service).
  ('annual', 'Annual leave', 21, 'annual_grant', '#0F4C2A', true,
   false, 0, NULL, NULL, true,
   'Paid annual leave. Entitlement is 21 days/year (or 30 days/year after 5 years of service). Requires manager + HR approval.',
   10, true),

  -- Sick leave — KSA Art. 117. Sehhaty certificate required for HR verification.
  ('sick', 'Sick leave', 30, 'per_event', '#BE123C', true,
   true, 0, NULL, NULL, false,
   'Medical leave covered by a Sehhaty-verified certificate. First 30 days at full pay; days 31-60 at 75%; days 61-90 at 50%. Requires the Sehhaty leave ID.',
   20, true),

  -- Maternity — KSA Art. 151. 10 weeks (70 calendar days), female only.
  ('maternity', 'Maternity leave', 70, 'per_event', '#9D174D', true,
   true, 0, NULL, 'female', false,
   'Paid maternity leave under Saudi Labor Law Art. 151 — 10 weeks (70 days), can be split before/after delivery.',
   30, true),

  -- Paternity — KSA Art. 113. 3 days, male only.
  ('paternity', 'Paternity leave', 3, 'per_event', '#075985', true,
   false, 0, NULL, 'male', true,
   'Paid paternity leave for the birth of a child — 3 working days under Saudi Labor Law Art. 113.',
   40, true),

  -- Hajj — KSA Art. 114. 10-15 days, once per career, 2 yrs min service.
  ('hajj', 'Hajj leave', 15, 'per_event', '#854F0B', true,
   false, 24, 1, NULL, true,
   'Paid pilgrimage leave — 10 to 15 days. Once per employment under Saudi Labor Law Art. 114. Requires at least 2 years of service.',
   50, true),

  -- Marriage — 5 days, once per service.
  ('marriage', 'Marriage leave', 5, 'per_event', '#7E22CE', true,
   false, 0, 1, NULL, true,
   'Paid marriage leave — 5 days. Once per employment. Requires manager + HR approval.',
   60, true),

  -- Bereavement — KSA Art. 113. 5 days for spouse/parent/child, 3 for others.
  ('bereavement', 'Bereavement leave', 5, 'per_event', '#374151', true,
   false, 0, NULL, NULL, true,
   'Paid leave for the death of a close family member — 5 days for spouse/parent/child, 3 days for sibling/grandparent. Per Saudi Labor Law Art. 113.',
   70, true),

  -- Emergency — non-statutory, manager + HR discretion.
  ('emergency', 'Emergency leave', 3, 'per_event', '#7F1D1D', false,
   false, 0, NULL, NULL, true,
   'Urgent personal or family emergency that cannot be scheduled in advance. Subject to manager + HR approval; may be paid or unpaid depending on circumstances.',
   80, true),

  -- Unpaid — no salary, formal approval still required.
  ('unpaid', 'Unpaid leave', 0, 'per_event', '#525252', false,
   false, 0, NULL, NULL, true,
   'Leave without pay. Requires manager + HR approval. Used when paid balances are exhausted or for extended personal reasons.',
   90, true),

  -- Other — catch-all with free-text description.
  ('other', 'Other', 0, 'per_event', '#475569', false,
   false, 0, NULL, NULL, true,
   'Other leave type not listed above (e.g. educational leave, exam leave, compassionate). Specify the reason in the request — manager + HR approval required.',
   100, true)

ON CONFLICT (id) DO UPDATE SET
  name                     = EXCLUDED.name,
  default_days             = EXCLUDED.default_days,
  accrual_method           = EXCLUDED.accrual_method,
  color                    = EXCLUDED.color,
  is_paid                  = EXCLUDED.is_paid,
  requires_attachment      = EXCLUDED.requires_attachment,
  min_service_months       = EXCLUDED.min_service_months,
  max_per_service          = EXCLUDED.max_per_service,
  applies_to_gender        = EXCLUDED.applies_to_gender,
  counts_working_days_only = EXCLUDED.counts_working_days_only,
  description              = EXCLUDED.description,
  sort_order               = EXCLUDED.sort_order,
  active                   = EXCLUDED.active;

-- Verification:
--   SELECT id, name, default_days, is_paid, applies_to_gender, sort_order
--   FROM leave_types ORDER BY sort_order;
