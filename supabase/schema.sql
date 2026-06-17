-- ══════════════════════════════════════════════════════════════════════════
-- LEAVE DESK — Supabase Schema
-- Run this in your Supabase project's SQL editor (one block).
-- It is idempotent: safe to re-run.
-- ══════════════════════════════════════════════════════════════════════════

-- Extensions
create extension if not exists pgcrypto;

-- ─────────────── EMPLOYEES ───────────────
create table if not exists public.employees (
  id              text        primary key,
  name            text        not null,
  location        text        not null,
  department      text        not null,
  email           text,
  phone           text,
  nationality     text        default 'expat',   -- 'saudi' | 'expat'
  join_date       date,                          -- used for service-based entitlement & pro-rata
  employment_status text      default 'active',  -- 'active' | 'terminated' | 'on_leave'
  manager_id      text        references public.employees(id) on delete set null,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists idx_employees_location   on public.employees(location);
create index if not exists idx_employees_department on public.employees(department);
create index if not exists idx_employees_manager    on public.employees(manager_id);

-- ─────────────── LEAVE TYPES ───────────────
create table if not exists public.leave_types (
  id                  text        primary key,
  name                text        not null,
  default_days        numeric     default 0,
  accrual_method      text        default 'annual_grant', -- 'annual_grant' | 'monthly_accrual' | 'per_event' | 'unlimited'
  color               text        default '#2D5F3F',
  is_paid             boolean     default true,
  requires_attachment boolean     default false,
  min_service_months  integer     default 0,    -- e.g. Hajj requires 2 years service
  max_per_service     numeric,                  -- e.g. Hajj = 1 time per service
  applies_to_gender   text,                     -- 'male' | 'female' | null (both)
  counts_working_days_only boolean default false, -- KSA default: calendar days (Art. 109)
  description         text,
  sort_order          integer     default 100,
  active              boolean     default true
);

-- ─────────────── LEAVE REQUESTS ───────────────
create table if not exists public.leave_requests (
  id                uuid        primary key default gen_random_uuid(),
  employee_id       text        not null references public.employees(id) on delete cascade,
  leave_type_id     text        not null references public.leave_types(id),
  start_date        date        not null,
  end_date          date        not null,
  days              numeric     not null,
  is_half_day       boolean     default false,
  half_day_period   text,                       -- 'morning' | 'afternoon'
  reason            text,
  attachment_url    text,
  status            text        default 'pending', -- 'pending' | 'approved' | 'rejected' | 'cancelled'
  requested_at      timestamptz default now(),
  requested_by      text,                       -- user email
  decided_at        timestamptz,
  decided_by        text,
  decision_note     text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),

  constraint valid_dates check (end_date >= start_date),
  constraint valid_status check (status in ('pending','approved','rejected','cancelled'))
);

create index if not exists idx_requests_employee  on public.leave_requests(employee_id);
create index if not exists idx_requests_status    on public.leave_requests(status);
create index if not exists idx_requests_dates     on public.leave_requests(start_date, end_date);
create index if not exists idx_requests_type      on public.leave_requests(leave_type_id);

-- ─────────────── LEAVE BALANCES (per employee, per type, per year) ───────────────
-- Tracks manual adjustments and carried-over days. Entitlement itself is derived
-- at runtime from service length + pro-rata join_date rules.
create table if not exists public.leave_balances (
  id              uuid        primary key default gen_random_uuid(),
  employee_id     text        not null references public.employees(id) on delete cascade,
  leave_type_id   text        not null references public.leave_types(id),
  year            integer     not null,
  carried_over    numeric     default 0,
  adjustment      numeric     default 0,
  adjustment_note text,
  updated_at      timestamptz default now(),
  unique(employee_id, leave_type_id, year)
);

create index if not exists idx_balances_lookup on public.leave_balances(employee_id, leave_type_id, year);

-- ─────────────── PUBLIC HOLIDAYS ───────────────
create table if not exists public.public_holidays (
  id          uuid        primary key default gen_random_uuid(),
  date        date        not null unique,
  name        text        not null,
  country     text        default 'SA',
  is_official boolean     default true,
  note        text
);

create index if not exists idx_holidays_date on public.public_holidays(date);

-- ─────────────── AUDIT LOG ───────────────
create table if not exists public.audit_log (
  id          uuid        primary key default gen_random_uuid(),
  action      text        not null,
  entity_type text,
  entity_id   text,
  actor       text,
  details     jsonb,
  created_at  timestamptz default now()
);

create index if not exists idx_audit_entity on public.audit_log(entity_type, entity_id);
create index if not exists idx_audit_created on public.audit_log(created_at desc);

-- ══════════════════════════════════════════════════════════════════════════
-- TRIGGERS: auto-update updated_at
-- ══════════════════════════════════════════════════════════════════════════
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_employees_touch on public.employees;
create trigger trg_employees_touch before update on public.employees
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_requests_touch on public.leave_requests;
create trigger trg_requests_touch before update on public.leave_requests
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_balances_touch on public.leave_balances;
create trigger trg_balances_touch before update on public.leave_balances
  for each row execute function public.touch_updated_at();

-- ══════════════════════════════════════════════════════════════════════════
-- HELPFUL VIEW: employees with current-year leave summary
-- ══════════════════════════════════════════════════════════════════════════
create or replace view public.v_employee_leave_summary as
select
  e.id,
  e.name,
  e.location,
  e.department,
  e.join_date,
  extract(year from now())::int as year,
  (
    select coalesce(sum(r.days), 0)
    from public.leave_requests r
    where r.employee_id = e.id
      and r.status = 'approved'
      and extract(year from r.start_date) = extract(year from now())
  ) as total_days_used,
  (
    select coalesce(sum(r.days), 0)
    from public.leave_requests r
    where r.employee_id = e.id
      and r.status = 'pending'
      and extract(year from r.start_date) = extract(year from now())
  ) as total_days_pending
from public.employees e
where e.employment_status = 'active';

-- ══════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- Authenticated users get full read/write.  Tighten later per role.
-- ══════════════════════════════════════════════════════════════════════════
alter table public.employees         enable row level security;
alter table public.leave_types       enable row level security;
alter table public.leave_requests    enable row level security;
alter table public.leave_balances    enable row level security;
alter table public.public_holidays   enable row level security;
alter table public.audit_log         enable row level security;

-- Helper to drop & recreate policies cleanly
do $$
declare r record;
begin
  for r in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('employees','leave_types','leave_requests','leave_balances','public_holidays','audit_log')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy "auth_read_employees"    on public.employees       for select to authenticated using (true);
create policy "auth_write_employees"   on public.employees       for all    to authenticated using (true) with check (true);
create policy "auth_read_types"        on public.leave_types     for select to authenticated using (true);
create policy "auth_write_types"       on public.leave_types     for all    to authenticated using (true) with check (true);
create policy "auth_read_requests"     on public.leave_requests  for select to authenticated using (true);
create policy "auth_write_requests"    on public.leave_requests  for all    to authenticated using (true) with check (true);
create policy "auth_read_balances"     on public.leave_balances  for select to authenticated using (true);
create policy "auth_write_balances"    on public.leave_balances  for all    to authenticated using (true) with check (true);
create policy "auth_read_holidays"     on public.public_holidays for select to authenticated using (true);
create policy "auth_write_holidays"    on public.public_holidays for all    to authenticated using (true) with check (true);
create policy "auth_read_audit"        on public.audit_log       for select to authenticated using (true);
create policy "auth_write_audit"       on public.audit_log       for insert to authenticated with check (true);

-- ══════════════════════════════════════════════════════════════════════════
-- SEED: leave types (Saudi Labor Law defaults)
-- ══════════════════════════════════════════════════════════════════════════
insert into public.leave_types (id, name, default_days, accrual_method, color, is_paid, requires_attachment, min_service_months, max_per_service, applies_to_gender, counts_working_days_only, description, sort_order) values
  ('annual',      'Annual Leave',      21,  'monthly_accrual', '#2D5F3F', true,  false, 12, null,  null,     false,  '21 days under 5 years service, 30 days after. Accrues monthly.', 10),
  ('sick',        'Sick Leave',        120, 'annual_grant',    '#B84A3E', true,  true,  0,  null,  null,     false, '30 days full pay + 60 days at 3/4 pay + 30 days unpaid per year. Medical certificate required.', 20),
  ('emergency',   'Emergency Leave',   5,   'annual_grant',    '#D4875C', true,  false, 0,  null,  null,     false,  'Unforeseen personal emergencies.', 30),
  ('hajj',        'Hajj Leave',        15,  'per_event',       '#8B6B3E', true,  false, 24, 1,     'muslim', false, 'Pilgrimage — granted once per employment, after 2 years of service.', 40),
  ('maternity',   'Maternity Leave',   70,  'per_event',       '#C97B84', true,  true,  0,  null,  'female', false, '10 weeks — up to 4 before and the rest after delivery.', 50),
  ('paternity',   'Paternity Leave',   3,   'per_event',       '#5A7A9B', true,  false, 0,  null,  'male',   false,  '3 days on the birth of a child.', 60),
  ('marriage',    'Marriage Leave',    5,   'per_event',       '#A67FB5', true,  false, 0,  1,     null,     false,  '5 days for the employee''s own marriage.', 70),
  ('bereavement', 'Bereavement Leave', 5,   'per_event',       '#6B6B6B', true,  false, 0,  null,  null,     false,  '5 days — spouse, parent, child. 3 days — sibling, grandparent.', 80),
  ('exam',        'Exam Leave',        15,  'unlimited',       '#7A9B5A', true,  true,  0,  null,  null,     false, 'For employees studying at accredited institutions. Granted per approval — not deducted from a fixed pool.', 90),
  ('unpaid',      'Unpaid Leave',      0,   'per_event',       '#9B9B9B', false, false, 0,  null,  null,     false,  'Leave without pay.', 100)
on conflict (id) do update set
  name = excluded.name,
  default_days = excluded.default_days,
  accrual_method = excluded.accrual_method,
  color = excluded.color,
  description = excluded.description;

-- ══════════════════════════════════════════════════════════════════════════
-- SEED: KSA public holidays (indicative — adjust each year)
-- ══════════════════════════════════════════════════════════════════════════
insert into public.public_holidays (date, name, country, is_official, note) values
  ('2026-02-22', 'Founding Day',          'SA', true, 'Fixed date'),
  ('2026-03-20', 'Eid Al-Fitr (Day 1)',   'SA', true, 'Indicative — confirm moon sighting'),
  ('2026-03-21', 'Eid Al-Fitr (Day 2)',   'SA', true, 'Indicative'),
  ('2026-03-22', 'Eid Al-Fitr (Day 3)',   'SA', true, 'Indicative'),
  ('2026-03-23', 'Eid Al-Fitr (Day 4)',   'SA', true, 'Indicative'),
  ('2026-05-27', 'Arafah Day',            'SA', true, 'Indicative'),
  ('2026-05-28', 'Eid Al-Adha (Day 1)',   'SA', true, 'Indicative'),
  ('2026-05-29', 'Eid Al-Adha (Day 2)',   'SA', true, 'Indicative'),
  ('2026-05-30', 'Eid Al-Adha (Day 3)',   'SA', true, 'Indicative'),
  ('2026-09-23', 'National Day',          'SA', true, 'Fixed date')
on conflict (date) do nothing;

-- Done.
select 'Schema installed successfully' as status;
