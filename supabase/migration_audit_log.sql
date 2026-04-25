-- ══════════════════════════════════════════════════════════════════════════
-- LEAVE DESK — Audit Log Migration  (v2 — drops any prior audit_log)
-- Run this AFTER migration_psn_auth.sql.  Idempotent.
-- ══════════════════════════════════════════════════════════════════════════

-- An earlier session may have created audit_log with a different shape.
-- Drop it cleanly so this migration always installs the canonical schema.
drop view  if exists public.v_audit_log cascade;
drop table if exists public.audit_log cascade;

create table public.audit_log (
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

create index idx_audit_actor_created on public.audit_log(actor_user_id, created_at desc);
create index idx_audit_psn_created   on public.audit_log(actor_psn, created_at desc);
create index idx_audit_action        on public.audit_log(action, created_at desc);
create index idx_audit_created       on public.audit_log(created_at desc);

alter table public.audit_log enable row level security;

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
