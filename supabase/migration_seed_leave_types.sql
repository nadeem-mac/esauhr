-- =============================================================================
-- Seed all standard leave types
-- Date: 2026-05-08
--
-- Populates `leave_types` with every leave category staff can request.
-- All requests created against any of these go through the same flow:
--
--     STAFF SUBMITS  →  MANAGER REVIEWS  →  HR (BASHAIER) FINAL APPROVES
--
-- That flow is enforced by the `leave_requests.stage` column + its trigger
-- (already in place — see migration_leave_request_stages.sql). This file only
-- adds the type definitions; no flow changes are needed.
--
-- Uses ON CONFLICT (id) DO UPDATE so it's safe to re-run; existing rows get
-- their metadata refreshed but nothing is deleted.
-- =============================================================================

INSERT INTO leave_types (id, name, color, bg, border, sort_order, default_days, min_service_months, max_per_service, description)
VALUES
  -- Annual paid leave — KSA labor law Art. 109. 21 days ≤5y service, 30 days >5y.
  ('annual',      'Annual leave',     '#0F4C2A', '#ECFDF5', '#86EFAC',  10, 21, 0,  NULL,
   'Paid annual leave. Entitlement is 21 days/year (or 30 days/year after 5 years of service). Requires manager + HR approval.'),

  -- Sick leave — KSA labor law Art. 117. Sehhaty certificate verified by HR.
  ('sick',        'Sick leave',       '#BE123C', '#FFF1F2', '#FCA5A5',  20, 30, 0,  NULL,
   'Medical leave covered by a Sehhaty-verified certificate. First 30 days at full pay; days 31-60 at 75%; days 61-90 at 50%. Requires the Sehhaty leave ID.'),

  -- Maternity leave — KSA labor law Art. 151. 10 weeks (70 days).
  ('maternity',   'Maternity leave',  '#9D174D', '#FCE7F3', '#F9A8D4',  30, 70, 0,  NULL,
   'Paid maternity leave under Saudi Labor Law Art. 151 — 10 weeks (70 days), can be split before/after delivery. Female staff only.'),

  -- Paternity leave — KSA labor law Art. 113. 3 days.
  ('paternity',   'Paternity leave',  '#075985', '#E0F2FE', '#7DD3FC',  40, 3,  0,  NULL,
   'Paid paternity leave for the birth of a child — 3 working days under Saudi Labor Law Art. 113. Male staff only.'),

  -- Hajj leave — KSA labor law Art. 114. Once per career, after 2 years service.
  ('hajj',        'Hajj leave',       '#854F0B', '#FEF3C7', '#FCD34D',  50, 15, 24, 1,
   'Paid pilgrimage leave — 10 to 15 days. Once per employment under Saudi Labor Law Art. 114. Requires at least 2 years of service.'),

  -- Marriage leave — common contractual benefit. 5 days, once per service.
  ('marriage',    'Marriage leave',   '#7E22CE', '#FAF5FF', '#D8B4FE',  60, 5,  0,  1,
   'Paid marriage leave — 5 days. Once per employment. Requires manager + HR approval.'),

  -- Bereavement — KSA labor law Art. 113. 5 days for spouse, 3 for relatives.
  ('bereavement', 'Bereavement leave','#374151', '#F3F4F6', '#9CA3AF',  70, 5,  0,  NULL,
   'Paid leave for the death of a close family member — 5 days for spouse/parent/child, 3 days for sibling/grandparent. Per Saudi Labor Law Art. 113.'),

  -- Emergency leave — non-statutory, manager + HR discretion.
  ('emergency',   'Emergency leave',  '#7F1D1D', '#FEE2E2', '#FCA5A5',  80, 3,  0,  NULL,
   'Urgent personal or family emergency that cannot be scheduled in advance. Subject to manager + HR approval; may be paid or unpaid depending on circumstances.'),

  -- Unpaid leave — no salary, formal approval still required.
  ('unpaid',      'Unpaid leave',     '#525252', '#F5F5F4', '#A8A29E',  90, 0,  0,  NULL,
   'Leave without pay. Requires manager + HR approval. Used when paid balances are exhausted or for extended personal reasons.'),

  -- Other — catch-all with free-text description.
  ('other',       'Other',            '#475569', '#F1F5F9', '#94A3B8', 100, 0,  0,  NULL,
   'Other leave type not listed above (e.g. educational leave, exam leave, compassionate). Specify the reason in the request — manager + HR approval required.')

ON CONFLICT (id) DO UPDATE SET
  name               = EXCLUDED.name,
  color              = EXCLUDED.color,
  bg                 = EXCLUDED.bg,
  border             = EXCLUDED.border,
  sort_order         = EXCLUDED.sort_order,
  default_days       = EXCLUDED.default_days,
  min_service_months = EXCLUDED.min_service_months,
  max_per_service    = EXCLUDED.max_per_service,
  description        = EXCLUDED.description;

-- Quick verification:
--   SELECT id, name, default_days, sort_order FROM leave_types ORDER BY sort_order;
