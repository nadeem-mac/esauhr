-- =============================================================================
-- migration_mawani_visits.sql
--
-- Tracks Mawani (Saudi Ports Authority) duty visits for staff who have to
-- leave the office during working hours for clearance/customs work. On a
-- Mawani visit date, the attendance evaluator considers the staff member
-- present regardless of punch-in/punch-out times — leaving the office
-- early because of a Mawani trip is not "early leave."
--
-- INITIAL USE CASE
--   SAAD ALOTHMAN (H94193) and MUSAID AL MUAISEB (H94725) work
--   08:00-16:00 (no lunch break). Their schedule is set via the
--   employees.working_hours_group = 'sup_team' flag (handled
--   elsewhere). Mawani visits are an additional layer.
--
-- VISIT WINDOWS
--   planned_start and planned_end are optional. NULL means a full-day
--   visit. With times, it represents a partial-day window (e.g.
--   10:00-13:00 visit). The evaluator treats any visit day as
--   'present' regardless of partial vs full — partial-day evaluation
--   is too brittle to rely on without a second-punch register.
--
-- STATUS LIFECYCLE
--   planned    — entered ahead of time (most common)
--   completed  — visit happened (could be set after the fact)
--   cancelled  — the planned visit didn't happen; revert to normal eval
-- =============================================================================

create table if not exists mawani_visits (
  id              uuid primary key default gen_random_uuid(),
  employee_id     text not null,
  visit_date      date not null,
  planned_start   time,
  planned_end     time,
  purpose         text,
  status          text not null default 'planned'
                  check (status in ('planned', 'completed', 'cancelled')),
  notes           text,
  created_at      timestamptz default now(),
  created_by      text,
  updated_at      timestamptz default now(),
  updated_by      text
);

-- Lookup index: evaluator queries by (employee_id, visit_date) constantly.
create index if not exists idx_mawani_visits_emp_date
  on mawani_visits (employee_id, visit_date);

-- Date-only index for monthly listing queries in the UI.
create index if not exists idx_mawani_visits_date
  on mawani_visits (visit_date);

-- Status filter — most queries want "active" visits (not cancelled).
create index if not exists idx_mawani_visits_status
  on mawani_visits (status);

-- Realtime — the manager UI listens for cross-session updates.
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'mawani_visits'
  ) then
    execute 'alter publication supabase_realtime add table mawani_visits';
  end if;
end $$;
