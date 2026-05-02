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

-- DELIBERATELY PERMISSIVE — see migration_psn_auth.sql for the full
-- rationale. Short version: auth.uid() is null under PSN+PIN auth
-- with the anon key, so any policy referencing it locks the table.
-- Authorisation is enforced in JS instead.
--
-- An earlier version of this file shipped a recursive admin policy
-- (exists from public.employees ...) that referenced auth.uid() AND
-- queried employees from inside an audit_log policy. The audit_log
-- table didn't recurse on itself, but the admin check still
-- evaluated to false (auth.uid() = null), locking selects. The
-- separate migration_audit_log_fix_rls.sql was added to repair this.
-- We collapse the two by making the original migration safe from
-- the start.
do $$
declare r record;
begin
  for r in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'audit_log'
  loop
    execute format('drop policy %I on public.audit_log', r.policyname);
  end loop;
end $$;

create policy "audit_read_all"
  on public.audit_log for select using (true);

create policy "audit_write_all"
  on public.audit_log for all using (true) with check (true);
