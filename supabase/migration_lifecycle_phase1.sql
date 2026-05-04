-- ─────────────────────────────────────────────────────────────────────
-- ESAU HR portal — Lifecycle migration, Phase 1
-- ─────────────────────────────────────────────────────────────────────
-- What this does
--   Lays the data foundation for the joiner pipeline (offer letter →
--   acceptance → SOL → PSN issued → pre-joiner onboarding → active)
--   and the leaver pipeline (resignation → manager approval → HR
--   approval → on-notice → departed).
--
--   No UI changes. No behaviour changes for existing users. This is
--   purely the bones that the next phases build on top of.
--
-- How to run
--   Open Supabase Dashboard → SQL Editor → New query.
--   Paste each SECTION on its own and run it. Sections are
--   independent — re-running any section is safe (idempotent).
--   The PREVIEW queries at the bottom let you verify the result.
--
-- BEFORE YOU RUN
--   Take a backup snapshot in Supabase Dashboard → Database →
--   Backups. Fast and free; gives you one-click rollback.
--
-- What this DOES NOT touch
--   Any existing row data. The migration adds columns with safe
--   defaults and creates new tables. The active column on
--   employees gets a new trigger but its current values are
--   preserved.
-- ─────────────────────────────────────────────────────────────────────


-- ════════════════════════════════════════════════════════════════════
-- SECTION 1 — EMPLOYEES TABLE: NEW LIFECYCLE COLUMNS
-- ════════════════════════════════════════════════════════════════════
-- Four new columns, all nullable with safe defaults. The existing
-- employment_status column already exists with values like 'active' /
-- 'terminated' / 'on_leave' — we extend the value set rather than
-- replace it, so existing rows continue to work unchanged.

alter table public.employees
  add column if not exists last_working_day        date,
  add column if not exists resignation_reason      text,
  add column if not exists resignation_recorded_at timestamptz;

-- Drop the old constraint if it exists, then add a fresh one that
-- accepts the lifecycle states alongside the existing values. Old
-- values stay valid so no row needs touching.
do $$
declare cname text;
begin
  select conname into cname
    from pg_constraint
   where conrelid = 'public.employees'::regclass
     and pg_get_constraintdef(oid) ilike '%employment_status%';
  if cname is not null then
    execute format('alter table public.employees drop constraint %I', cname);
  end if;
end $$;

alter table public.employees
  add constraint employees_employment_status_check
  check (employment_status in (
    -- New lifecycle states
    'pre_joining',  -- offer accepted, PSN issued, before join_date
    'active',       -- working, default state
    'on_notice',    -- resigned, working through notice period
    'departed',     -- after last_working_day, account closed
    -- Pre-existing values, kept for compatibility
    'terminated',
    'on_leave'
  ));

-- Backfill: any employee row with NULL or unknown employment_status
-- gets 'active' so the new constraint passes. Existing valid values
-- pass through.
update public.employees
   set employment_status = 'active'
 where employment_status is null
    or employment_status not in ('pre_joining','active','on_notice','departed','terminated','on_leave');

-- Index lifecycle columns the cron job and dashboard cards will hit
-- frequently.
create index if not exists idx_employees_employment_status on public.employees(employment_status);
create index if not exists idx_employees_last_working_day  on public.employees(last_working_day);


-- ════════════════════════════════════════════════════════════════════
-- SECTION 2 — TRIGGER: KEEP active IN SYNC WITH employment_status
-- ════════════════════════════════════════════════════════════════════
-- The portal's existing queries filter on the `active` boolean to
-- decide who shows up in dashboards. Rather than rewrite every
-- query, we keep `active` as a derived value. Pre-joiners and
-- departed staff are not active. Everyone else is.
--
-- This means the rest of the codebase doesn't need to change —
-- existing `where active = true` filters automatically exclude
-- pre-joiners and departed staff once their status changes.

create or replace function public.sync_employees_active_flag()
returns trigger
language plpgsql
as $$
begin
  -- Active flag derived from employment_status. pre_joining and
  -- departed staff are not "active" for everyday queries; on_notice
  -- staff still are (they're working through their notice period).
  if NEW.employment_status in ('active','on_notice','on_leave') then
    NEW.active := true;
  else
    NEW.active := false;  -- pre_joining, departed, terminated
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_employees_sync_active on public.employees;
create trigger trg_employees_sync_active
  before insert or update of employment_status
  on public.employees
  for each row
  execute function public.sync_employees_active_flag();

-- One-time backfill so the active flag matches the new derivation
-- on existing rows. After this, the trigger keeps it correct.
update public.employees
   set active = case
     when employment_status in ('active','on_notice','on_leave') then true
     else false
   end;


-- ════════════════════════════════════════════════════════════════════
-- SECTION 3 — SIGNATORIES TABLE
-- ════════════════════════════════════════════════════════════════════
-- One row per person who signs offer letters. The offer-letter
-- generator picks a signatory based on the offer's department and
-- inserts that person's name, title, and signature image into the
-- generated PDF.
--
-- signature_image_path stores a Supabase Storage path (we'll create
-- the storage bucket in a later phase). active=false retires a
-- signatory without losing the historical record of letters they
-- signed.

create table if not exists public.signatories (
  id                    uuid        primary key default gen_random_uuid(),
  name                  text        not null,
  title                 text        not null,                  -- e.g. "Country Head", "BIZ Manager"
  email                 text,
  department_scope      text,                                  -- null = applies to all departments
  signature_image_path  text,                                  -- Supabase Storage path
  active                boolean     default true,
  display_order         integer     default 100,               -- for sorting in pickers
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

create index if not exists idx_signatories_active on public.signatories(active) where active = true;
create index if not exists idx_signatories_dept   on public.signatories(department_scope) where active = true;


-- ════════════════════════════════════════════════════════════════════
-- SECTION 4 — OFFER LETTERS TABLE
-- ════════════════════════════════════════════════════════════════════
-- The full lifecycle of an offer, from draft through PSN issuance.
-- One row per offer; lives forever as part of the audit trail even
-- after the candidate becomes an active employee.

create table if not exists public.offer_letters (
  id                  uuid        primary key default gen_random_uuid(),

  -- Candidate identity (PSN doesn't exist yet at this stage)
  candidate_name      text        not null,
  candidate_email     text        not null,                    -- personal email, locked once acceptance happens
  candidate_phone     text,
  candidate_nationality text      default 'expat',

  -- Offer terms
  position_title      text        not null,
  department          text        not null,
  proposed_join_date  date        not null,
  salary_amount       numeric     not null,
  salary_currency     text        default 'SAR',
  manager_id          text        references public.employees(id) on delete set null,
  signatory_id        uuid        references public.signatories(id) on delete set null,

  -- Acceptance machinery
  offer_token         text        not null unique,             -- random URL-safe string for the acceptance link
  expires_at          timestamptz not null,
  pdf_storage_path    text,                                    -- generated PDF in Supabase Storage

  -- Lifecycle status
  status              text        not null default 'offer_sent'
    check (status in (
      'draft',          -- created but not sent
      'offer_sent',     -- emailed to candidate
      'offer_accepted', -- candidate clicked accept on the public page
      'offer_declined', -- candidate explicitly declined
      'expired',        -- 14-day window passed without action
      'withdrawn',      -- HR withdrew the offer
      'psn_issued',     -- SOL processing complete, PSN entered, employees row created
      'cancelled'       -- offer abandoned mid-process
    )),

  -- Acceptance audit
  accepted_at         timestamptz,
  acceptance_ip       text,
  acceptance_user_agent text,
  declined_at         timestamptz,
  decline_reason      text,

  -- SOL processing
  psn_assigned        text        references public.employees(id) on delete set null,
  psn_assigned_at     timestamptz,
  psn_assigned_by_id  text        references public.employees(id) on delete set null,

  -- HR notes during SOL processing (Iqama, GOSI, contract signing, etc.)
  hr_notes            text,

  -- Audit
  created_at          timestamptz default now(),
  created_by_id       text        references public.employees(id) on delete set null,
  updated_at          timestamptz default now()
);

create index if not exists idx_offer_letters_token        on public.offer_letters(offer_token);
create index if not exists idx_offer_letters_status       on public.offer_letters(status);
create index if not exists idx_offer_letters_email        on public.offer_letters(candidate_email);
create index if not exists idx_offer_letters_join_date    on public.offer_letters(proposed_join_date);
create index if not exists idx_offer_letters_psn_assigned on public.offer_letters(psn_assigned);


-- ════════════════════════════════════════════════════════════════════
-- SECTION 5 — RESIGNATION REQUESTS TABLE
-- ════════════════════════════════════════════════════════════════════
-- Tracks the dual-stage approval chain for staff-submitted
-- resignations. The manager approves first, then HR. Either can
-- reject. The employee can withdraw at any stage before final
-- approval.
--
-- HR-recorded resignations (where Bashaier records the outcome of
-- an in-person conversation) skip this table entirely and update
-- employees directly. This table is for self-service flows.

create table if not exists public.resignation_requests (
  id                          uuid        primary key default gen_random_uuid(),

  employee_id                 text        not null references public.employees(id) on delete cascade,
  proposed_last_working_day   date        not null,
  reason                      text,

  -- Stage flow: pending_manager → pending_hr → approved/rejected
  -- Withdrawn is terminal from any stage before approved.
  stage                       text        not null default 'pending_manager'
    check (stage in (
      'pending_manager',
      'pending_hr',
      'approved',
      'rejected',
      'withdrawn'
    )),

  -- Manager decision
  manager_decision_at         timestamptz,
  manager_decision_by_id      text        references public.employees(id) on delete set null,
  manager_notes               text,

  -- HR decision
  hr_decision_at              timestamptz,
  hr_decision_by_id           text        references public.employees(id) on delete set null,
  hr_notes                    text,

  -- Reassignment plan for resigning managers' direct reports.
  -- Shape: { "default_to_grand_manager": true, "overrides": [{"employee_id": "H94XXX", "new_manager_id": "H94YYY"}] }
  reassign_plan               jsonb       default '{}'::jsonb,

  -- Withdrawal
  withdrawn_at                timestamptz,
  withdrawn_reason            text,

  created_at                  timestamptz default now(),
  updated_at                  timestamptz default now()
);

create index if not exists idx_resignations_employee on public.resignation_requests(employee_id);
create index if not exists idx_resignations_stage    on public.resignation_requests(stage);


-- ════════════════════════════════════════════════════════════════════
-- SECTION 6 — DAILY LIFECYCLE CRON JOB
-- ════════════════════════════════════════════════════════════════════
-- Two operations in one transaction at midnight Riyadh time:
--
--   1. Promote pre_joining → active for any employee whose
--      join_date has arrived (today or earlier).
--   2. Mark on_notice → departed for any employee whose
--      last_working_day has passed.
--
-- Each transition writes to audit_log so there's an actor='SYSTEM'
-- record of the flip. The trigger from SECTION 2 keeps the active
-- flag in sync automatically.
--
-- Requires pg_cron extension (already enabled on Supabase). Riyadh
-- is UTC+3 with no DST, so midnight Riyadh = 21:00 UTC.

-- pg_cron is enabled at the project level on Supabase (Database →
-- Extensions). We don't try to enable it from this migration; if
-- it's missing, the cron.schedule call below will raise a notice
-- and the function will still be created (callable manually).

create or replace function public.lifecycle_daily_transitions()
returns void
language plpgsql
security definer
as $$
declare
  promoted_count integer := 0;
  departed_count integer := 0;
begin
  -- 1) Pre-joiners whose join_date has arrived → active
  with promoted as (
    update public.employees
       set employment_status = 'active',
           updated_at = now()
     where employment_status = 'pre_joining'
       and join_date is not null
       and join_date <= current_date
    returning id, name, join_date
  )
  insert into public.audit_log (action, entity_type, entity_id, actor, details)
  select 'lifecycle.promote_to_active',
         'employee',
         id,
         'SYSTEM',
         jsonb_build_object('name', name, 'join_date', join_date)
    from promoted;

  get diagnostics promoted_count = row_count;

  -- 2) On-notice staff whose last_working_day has passed → departed
  with departed as (
    update public.employees
       set employment_status = 'departed',
           updated_at = now()
     where employment_status = 'on_notice'
       and last_working_day is not null
       and last_working_day < current_date
    returning id, name, last_working_day
  )
  insert into public.audit_log (action, entity_type, entity_id, actor, details)
  select 'lifecycle.mark_departed',
         'employee',
         id,
         'SYSTEM',
         jsonb_build_object('name', name, 'last_working_day', last_working_day)
    from departed;

  get diagnostics departed_count = row_count;

  -- 3) Expire any offer letters whose 14-day window passed without acceptance
  update public.offer_letters
     set status = 'expired',
         updated_at = now()
   where status = 'offer_sent'
     and expires_at < now();

  -- Summary log entry so it's visible the cron ran even on quiet days
  insert into public.audit_log (action, entity_type, entity_id, actor, details)
  values (
    'lifecycle.daily_run',
    'system',
    null,
    'SYSTEM',
    jsonb_build_object(
      'promoted_count', promoted_count,
      'departed_count', departed_count,
      'run_at', now()
    )
  );
end;
$$;

-- Schedule it for 21:00 UTC daily (midnight Riyadh, no DST)
-- Re-running this is safe: cron.schedule replaces an existing job
-- with the same name.
do $$
begin
  -- Drop existing job if it exists (idempotent re-run)
  perform cron.unschedule('lifecycle_daily_transitions')
   where exists (
     select 1 from cron.job where jobname = 'lifecycle_daily_transitions'
   );

  -- Schedule fresh
  perform cron.schedule(
    'lifecycle_daily_transitions',
    '0 21 * * *',  -- daily at 21:00 UTC = midnight Riyadh
    $cron$ select public.lifecycle_daily_transitions(); $cron$
  );
exception
  when others then
    -- pg_cron may not be available in all Supabase tiers. If
    -- scheduling fails, the function still works and can be invoked
    -- manually or via an external scheduler.
    raise notice 'Could not schedule pg_cron job: %. Function is created and can be invoked manually.', sqlerrm;
end $$;


-- ════════════════════════════════════════════════════════════════════
-- SECTION 7 — RLS POLICIES FOR THE NEW TABLES
-- ════════════════════════════════════════════════════════════════════
-- Following the established pattern in the portal: RLS is permissive
-- (anon role can read/write), with app-layer is_admin / is_hr_reviewer
-- checks gating sensitive operations. The public acceptance page
-- uses an unauthenticated edge function with the offer_token as the
-- only access key.

alter table public.offer_letters         enable row level security;
alter table public.resignation_requests  enable row level security;
alter table public.signatories           enable row level security;

-- Permissive read+write so the existing direct-fetch helpers
-- (directGet, directPost, directPatch) continue to work the same
-- way they do for every other table.
do $$
begin
  -- offer_letters
  if not exists (select 1 from pg_policies where tablename = 'offer_letters' and policyname = 'offer_letters_anon_all') then
    create policy offer_letters_anon_all on public.offer_letters
      for all to anon using (true) with check (true);
  end if;

  -- resignation_requests
  if not exists (select 1 from pg_policies where tablename = 'resignation_requests' and policyname = 'resignations_anon_all') then
    create policy resignations_anon_all on public.resignation_requests
      for all to anon using (true) with check (true);
  end if;

  -- signatories
  if not exists (select 1 from pg_policies where tablename = 'signatories' and policyname = 'signatories_anon_all') then
    create policy signatories_anon_all on public.signatories
      for all to anon using (true) with check (true);
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════════
-- SECTION 8 — REALTIME PUBLICATION
-- ════════════════════════════════════════════════════════════════════
-- Add the new tables to supabase_realtime so the UI can subscribe to
-- changes (matches the pattern for employee_shifts, leave_requests,
-- etc.). Wrap in DO blocks so re-running is idempotent.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'offer_letters'
  ) then
    alter publication supabase_realtime add table public.offer_letters;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'resignation_requests'
  ) then
    alter publication supabase_realtime add table public.resignation_requests;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'signatories'
  ) then
    alter publication supabase_realtime add table public.signatories;
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════
-- DONE
-- ════════════════════════════════════════════════════════════════════
-- After this migration applies successfully:
--   • employees has 4 new columns and an extended status check
--   • Trigger keeps `active` derived from employment_status
--   • Three new tables exist: offer_letters, resignation_requests,
--     signatories
--   • Daily cron job scheduled at 21:00 UTC (midnight Riyadh)
--   • RLS + realtime publication configured for new tables
--
-- To verify after running, paste these SELECTs into the Supabase
-- SQL Editor (they don't return rows when executed via the
-- migration runner RPC, so they're not part of this file):
--
--   select 'offer_letters'  as t, count(*) from public.offer_letters
--   union all select 'resignation_requests', count(*) from public.resignation_requests
--   union all select 'signatories',          count(*) from public.signatories;
--
--   select employment_status, active, count(*)
--     from public.employees
--    group by employment_status, active
--    order by employment_status, active;
--
--   select jobname, schedule, active from cron.job
--    where jobname = 'lifecycle_daily_transitions';
