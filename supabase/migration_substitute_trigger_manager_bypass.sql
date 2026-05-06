-- ──────────────────────────────────────────────────────────────────────────
-- Migration — substitute-accept trigger gets manager-bypass awareness
-- ──────────────────────────────────────────────────────────────────────────
-- Per Nadeem (2026-05-06):
--   • ALL STAFF annual leave: → SUBSTITUTES → MANAGER → BASHAIER (final)
--   • BASHAIER  annual leave: → SUBSTITUTES → MANAGER (final, Fahad)
--   • FAHAD     annual leave: → SUBSTITUTES → BASHAIER (final, no manager)
--
-- The original substitute trigger (migration_substitute_trigger.sql)
-- always advanced pending_substitutes → pending_manager once all
-- subs accepted. That's correct for ALL STAFF and Bashaier, but wrong
-- for Fahad — his manager-bypass means there's no manager step at all,
-- the row should go straight to pending_hr for Bashaier to finalise.
--
-- This migration replaces the trigger function with one that checks
-- whether the requester has an HR-only direct report (i.e., a
-- non-admin is_hr_reviewer report) — that's the same Fahad-detection
-- rule used in the client-side initialApprovalStage helper. When
-- detected, the trigger routes pending_substitutes → pending_hr.
-- Otherwise the original behaviour is preserved.
--
-- Idempotent: drops and recreates so re-running is safe.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.handle_substitute_decisions()
returns trigger
language plpgsql
as $$
declare
  sub_psn text;
  sub_decision jsonb;
  dec text;
  any_declined boolean := false;
  all_accepted boolean := true;
  pending_count int := 0;
  has_hr_only_deputy boolean := false;
begin
  -- Only act on rows that are still in the substitutes stage
  if NEW.stage is distinct from 'pending_substitutes' then
    return NEW;
  end if;

  -- Skip when substitute_decisions hasn't actually changed
  if NEW.substitute_decisions is not distinct from OLD.substitute_decisions then
    return NEW;
  end if;

  -- Walk through the decisions map
  for sub_psn, sub_decision in
    select * from jsonb_each(coalesce(NEW.substitute_decisions, '{}'::jsonb))
  loop
    -- Decision can be a bare string or a {decision, …} object
    if jsonb_typeof(sub_decision) = 'string' then
      dec := sub_decision::text;
      dec := trim(both '"' from dec);
    elsif jsonb_typeof(sub_decision) = 'object' then
      dec := sub_decision ->> 'decision';
    else
      dec := null;
    end if;

    if dec = 'declined' then
      any_declined := true;
      all_accepted := false;
    elsif dec <> 'accepted' then
      all_accepted := false;
      pending_count := pending_count + 1;
    end if;
  end loop;

  if any_declined then
    NEW.stage := 'rejected_by_substitute';
  elsif all_accepted then
    -- Manager-bypass awareness: if the requester (NEW.employee_id)
    -- has a direct report who is an HR-only reviewer (is_hr_reviewer
    -- AND not admin), they are a Fahad-style manager. Their request
    -- skips pending_manager and goes straight to pending_hr.
    select exists (
      select 1
      from public.employees e
      where e.manager_id = NEW.employee_id
        and e.is_hr_reviewer is true
        and coalesce(e.is_admin, false) = false
    ) into has_hr_only_deputy;

    if has_hr_only_deputy then
      NEW.stage := 'pending_hr';
    else
      NEW.stage := 'pending_manager';
    end if;
  end if;

  return NEW;
end;
$$;

-- Re-attach the trigger (drop+create to be idempotent). Trigger fires
-- on UPDATE OF substitute_decisions, BEFORE the row is written, so the
-- stage mutation in NEW propagates to the persisted row.
drop trigger if exists trg_handle_substitute_decisions on public.leave_requests;
create trigger trg_handle_substitute_decisions
before update of substitute_decisions on public.leave_requests
for each row execute function public.handle_substitute_decisions();

-- Quick smoke check (read-only, no commit needed) — verify Fahad's
-- existing rows would route correctly given the current employees data.
-- Run manually:
-- select e.id, e.name,
--        exists (
--          select 1 from public.employees x
--          where x.manager_id = e.id
--            and x.is_hr_reviewer is true
--            and coalesce(x.is_admin, false) = false
--        ) as would_skip_manager
-- from public.employees e
-- where e.id in ('H94712','H94830','H94076','H94152');
