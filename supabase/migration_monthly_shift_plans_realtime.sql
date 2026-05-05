-- ─────────────────────────────────────────────────────────────────────
-- Add monthly_shift_plans to the realtime publication
-- ─────────────────────────────────────────────────────────────────────
-- The shared ShiftMonthGrid (used by TeamShiftMonthCard,
-- MyShiftMonthCard, HrShiftMonthCard) subscribes to changes on
-- monthly_shift_plans so the manager-marked off-day pattern shows
-- live updates across surfaces — when Sonnie toggles Sun + Fri OFF
-- for FAHAD, Bashaier's HR view refreshes immediately, the manager's
-- team-view refreshes immediately, FAHAD's own staff view refreshes
-- immediately.
--
-- Without this membership, supabase.channel().on('postgres_changes',
-- { table: 'monthly_shift_plans' }) returns 'SUBSCRIBED' but no
-- events ever arrive — silent failure. Adding the table to
-- supabase_realtime fixes that.
--
-- Idempotent: guarded by NOT EXISTS check.
-- ─────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'monthly_shift_plans'
  ) then
    alter publication supabase_realtime add table public.monthly_shift_plans;
  end if;
end $$;
