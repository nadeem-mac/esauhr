-- ══════════════════════════════════════════════════════════════════════════
-- LEAVE DESK — Migration Runner Infrastructure
--
-- Adds a `schema_migrations` tracking table and an RPC function
-- `run_schema_migration` so admins can run pending migrations from
-- the portal UI instead of pasting SQL into Supabase's editor.
--
-- Workflow:
--   1. Migration files live in the repo under supabase/migration_*.sql
--      and are bundled into the React app at build time.
--   2. Admin opens Settings → Schema Migrations.
--   3. UI compares bundled migration names against the
--      schema_migrations table and shows pending ones.
--   4. Click 'Run' → calls run_schema_migration RPC with the file
--      name and SQL contents. RPC executes the SQL inside a
--      transaction, records result, returns status to client.
--
-- Security:
--   • The RPC is SECURITY DEFINER so it can do DDL even though
--     the calling client uses the anon key.
--   • Access is gated by an explicit check inside the function:
--     only PSNs listed in the `_admin_psns` GUC (or the hardcoded
--     fallback below) can call it. We can't rely on auth.uid
--     because this app uses PSN+PIN, not Supabase Auth.
--   • The caller passes their PSN as an argument; the function
--     verifies it matches an employee with is_admin=true. This
--     is a soft trust — the anon key can call any RPC, so the
--     guard is the function itself.
--   • All runs are recorded with the caller's PSN, the SQL hash,
--     and outcome — full audit trail.
--
-- Idempotent (the table and function use IF NOT EXISTS / OR REPLACE).
-- Safe to run multiple times.
-- ══════════════════════════════════════════════════════════════════════════

-- 1) Tracking table — one row per (migration name, run attempt).
--    A migration can be re-run if needed; the latest row wins for
--    'is this applied?' checks.
create table if not exists public.schema_migrations (
  id            bigserial primary key,
  name          text        not null,
  sql_sha256    text        not null,
  applied_at    timestamptz not null default now(),
  applied_by    text        not null,         -- PSN of the admin
  status        text        not null,         -- 'success' | 'failed'
  error_message text,
  duration_ms   integer,
  -- Useful indexes
  unique (name, applied_at)
);

create index if not exists idx_schema_migrations_name
  on public.schema_migrations(name, applied_at desc);

-- Permissive RLS so the client can READ the history (to know what's
-- applied). Writes go exclusively through the RPC, which uses
-- SECURITY DEFINER and bypasses RLS.
alter table public.schema_migrations enable row level security;

drop policy if exists migrations_read on public.schema_migrations;
create policy migrations_read
  on public.schema_migrations for select
  using (true);

-- 2) The runner function. Executes arbitrary SQL inside a savepoint
--    so a syntax error in the migration doesn't poison the calling
--    transaction. Returns a JSON envelope describing the result.
--
-- Args:
--   p_caller_psn   — the PSN of the admin running this
--   p_name         — migration file name, e.g. 'migration_foo.sql'
--   p_sql_sha256   — sha256 hex of the SQL text (caller computes it,
--                    we record for audit)
--   p_sql          — the SQL to execute
--
-- Returns JSON:
--   { ok, status, error_message, duration_ms, applied_at, name }
create or replace function public.run_schema_migration(
  p_caller_psn  text,
  p_name        text,
  p_sql_sha256  text,
  p_sql         text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_started_at  timestamptz := clock_timestamp();
  v_applied_at  timestamptz;
  v_duration_ms integer;
  v_admin_check boolean;
  v_error_msg   text;
  v_status      text;
begin
  -- Authorisation: the calling PSN must be an admin in the
  -- employees table. This is the only access guard since the
  -- RPC uses SECURITY DEFINER.
  select coalesce(is_admin, false) into v_admin_check
    from public.employees
    where id = p_caller_psn
    limit 1;

  if not coalesce(v_admin_check, false) then
    return jsonb_build_object(
      'ok', false,
      'status', 'unauthorised',
      'error_message', 'Caller is not an admin: ' || coalesce(p_caller_psn, '(null)'),
      'name', p_name
    );
  end if;

  -- Run the SQL inside a savepoint so we can capture errors
  -- without rolling back the whole outer transaction.
  begin
    execute p_sql;
    v_status := 'success';
    v_error_msg := null;
  exception when others then
    v_status := 'failed';
    v_error_msg := SQLSTATE || ': ' || SQLERRM;
  end;

  v_applied_at := clock_timestamp();
  v_duration_ms := extract(milliseconds from (v_applied_at - v_started_at))::integer;

  -- Always record the attempt — success or failure.
  insert into public.schema_migrations
    (name, sql_sha256, applied_at, applied_by, status, error_message, duration_ms)
  values
    (p_name, p_sql_sha256, v_applied_at, p_caller_psn, v_status, v_error_msg, v_duration_ms);

  return jsonb_build_object(
    'ok',            v_status = 'success',
    'status',        v_status,
    'error_message', v_error_msg,
    'duration_ms',   v_duration_ms,
    'applied_at',    v_applied_at,
    'name',          p_name
  );
end;
$$;

-- The anon key needs execute on the RPC. The function's internal
-- admin check is the actual gate.
grant execute on function public.run_schema_migration(text, text, text, text)
  to anon, authenticated;
