-- Substitute auto-advance trigger
-- ──────────────────────────────────────────────────────────────────────────────
-- When a staff member submits a leave request with substitute_ids, the row
-- starts at stage='pending_substitutes' and substitute_decisions is seeded
-- with { psn: { decision: 'pending' } } for each substitute.
--
-- Each substitute opens their Personal Dashboard, sees the request, and
-- clicks Accept or Decline. The client patches substitute_decisions[psn].
--
-- This trigger watches every UPDATE to substitute_decisions and advances
-- the stage automatically:
--   • if ANY substitute has decision='declined' → stage='rejected_by_substitute'
--   • else if ALL substitutes have decision='accepted' → stage='pending_manager'
--   • else (some still 'pending') → stage stays 'pending_substitutes'
--
-- Idempotent: drops and recreates so re-running is safe. The current DB
-- already has this — committing the migration so the source of truth lives
-- in git instead of only in Studio.

create or replace function public.advance_stage_on_substitute_decision()
returns trigger
language plpgsql
security definer
as $$
declare
  decisions jsonb;
  ids       text[];
  psn       text;
  raw       jsonb;
  dec       text;
  any_declined boolean := false;
  all_accepted boolean := true;
  pending_count int := 0;
begin
  -- Only act on rows that are still in the substitutes stage
  if NEW.stage is distinct from 'pending_substitutes' then
    return NEW;
  end if;

  -- Skip when substitute_decisions hasn't actually changed
  if NEW.substitute_decisions is not distinct from OLD.substitute_decisions then
    return NEW;
  end if;

  decisions := coalesce(NEW.substitute_decisions, '{}'::jsonb);
  ids := coalesce(NEW.substitute_ids, ARRAY[]::text[]);

  if array_length(ids, 1) is null then
    return NEW;
  end if;

  foreach psn in array ids loop
    raw := decisions -> psn;
    if raw is null then
      dec := 'pending';
    elsif jsonb_typeof(raw) = 'string' then
      dec := trim(both '"' from raw::text);
    else
      dec := raw ->> 'decision';
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
    NEW.stage := 'pending_manager';
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_advance_stage_on_substitute_decision on public.leave_requests;

create trigger trg_advance_stage_on_substitute_decision
before update of substitute_decisions on public.leave_requests
for each row
execute function public.advance_stage_on_substitute_decision();

comment on function public.advance_stage_on_substitute_decision() is
  'Auto-advances leave_requests.stage based on substitute_decisions. Fires before update of substitute_decisions only.';
