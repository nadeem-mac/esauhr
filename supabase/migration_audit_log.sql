-- ══════════════════════════════════════════════════════════════════════════
-- LEAVE DESK — Audit Log Migration
-- Run this AFTER migration_psn_auth.sql.  Idempotent.
-- ══════════════════════════════════════════════════════════════════════════

create table if not exists public.audit_log (
  id            bigserial   primary key,
  actor_user_id uuid,
  actor_psn     text,
  actor_name    text,
  action        text        not null,
  target_type   text,
  target_id     text,
  target_label  text,
  details       jsonb,
  user_agent    text,
  created_at    timestamptz default now()
);

create index if not exists idx_audit_actor_created on public.audit_log(actor_user_id, created_at desc);
create index if not exists idx_audit_psn_created   on public.audit_log(actor_psn, created_at desc);
create index if not exists idx_audit_action        on public.audit_log(action, created_at desc);
create index if not exists idx_audit_created       on public.audit_log(created_at desc);

alter table public.audit_log enable row level security;

drop policy if exists "audit_insert_authenticated" on public.audit_log;
drop policy if exists "audit_select_admin"         on public.audit_log;

-- Anyone signed-in can append (only for themselves).
create policy "audit_insert_authenticated"
  on public.audit_log for insert
  with check (
    auth.role() = 'authenticated'
    and (actor_user_id is null or actor_user_id = auth.uid())
  );

-- Only admins can read.
create policy "audit_select_admin"
  on public.audit_log for select
  using (
    exists (
      select 1 from public.employees e
      where e.auth_user_id = auth.uid() and e.is_admin = true
    )
  );
