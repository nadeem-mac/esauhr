-- ══════════════════════════════════════════════════════════════════════════
-- ATTENDANCE — upload audit trail + permission pinning on violations
-- Run this in your Supabase project's SQL editor.
-- It is idempotent: safe to re-run.
--
-- Why this exists:
--   1. Every Time Card xlsx that gets processed leaves a record (who,
--      when, what file, what date, how many rows). A SHA-256 hash of
--      the file bytes makes accidental double-uploads of the same
--      file detectable — the second upload returns the existing row.
--   2. When Bashaier emails a staffer about a late or early arrival,
--      we now pin the permission_id (or null) that was on file at
--      that exact moment. If a permission is added or revoked later,
--      the historical record reflects what HR saw when the email
--      went out.
-- ══════════════════════════════════════════════════════════════════════════

-- ─────────────── ATTENDANCE_UPLOADS ───────────────
-- One row per Time Card file processed. The (data_date, file_sha256)
-- composite unique key ensures the same file for the same date can
-- only be recorded once — a duplicate upload returns 23505 which the
-- app handles by re-using the existing record rather than creating a
-- new one.
create table if not exists public.attendance_uploads (
  id              uuid          primary key default gen_random_uuid(),
  uploaded_by     text          not null references public.employees(id),
  uploaded_at     timestamptz   not null default now(),
  data_date       date          not null,                                  -- the date the punches are FOR (not the export date)
  sheet_name      text,                                                    -- the xlsx sheet name (typically YYYYMMDD)
  file_name       text          not null,
  file_size_bytes integer,
  file_sha256     text          not null,                                  -- 64-char hex
  row_count       integer       not null,
  unique(data_date, file_sha256)
);

create index if not exists idx_uploads_data_date    on public.attendance_uploads(data_date);
create index if not exists idx_uploads_uploaded_by  on public.attendance_uploads(uploaded_by);
create index if not exists idx_uploads_uploaded_at  on public.attendance_uploads(uploaded_at);

-- ─────────────── ATTENDANCE_VIOLATIONS — new columns ───────────────
-- Pin which upload produced this violation (forensic trail) and
-- which permission (if any) was on file at the moment the email
-- was sent. permission_id can be null — that's the explicit
-- "no-permission" violation.
alter table public.attendance_violations
  add column if not exists upload_id     uuid references public.attendance_uploads(id) on delete set null;
alter table public.attendance_violations
  add column if not exists permission_id uuid;
-- permission_requests has uuid id; FK is loose (no cascade) so a
-- deleted permission keeps the audit trail intact.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'attendance_violations'
      and constraint_name = 'attendance_violations_permission_id_fkey'
  ) then
    -- Add the FK only if permission_requests has a uuid pk; skip silently if schema differs.
    begin
      alter table public.attendance_violations
        add constraint attendance_violations_permission_id_fkey
        foreign key (permission_id) references public.permission_requests(id) on delete set null;
    exception when others then
      raise notice 'Skipping permission_id FK — permission_requests not present or PK type mismatch.';
    end;
  end if;
end $$;

create index if not exists idx_violations_upload_id     on public.attendance_violations(upload_id);
create index if not exists idx_violations_permission_id on public.attendance_violations(permission_id);

-- ─────────────── ROW LEVEL SECURITY ───────────────
alter table public.attendance_uploads enable row level security;

do $$
declare r record;
begin
  for r in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename = 'attendance_uploads'
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy "auth_read_uploads"   on public.attendance_uploads for select to authenticated using (true);
create policy "auth_write_uploads"  on public.attendance_uploads for all    to authenticated using (true) with check (true);
