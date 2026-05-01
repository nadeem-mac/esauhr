-- Stage-advance guard for leave_requests
-- ──────────────────────────────────────────────────────────────────────────────
-- Defense-in-depth on top of advance_stage_on_substitute_decision(). The
-- existing trigger fires only on UPDATE OF substitute_decisions and only
-- acts when stage is currently 'pending_substitutes'. That's the happy
-- path — but it doesn't stop a row from being INSERTED directly at
-- 'pending_manager' or being UPDATEd straight from 'pending_substitutes'
-- to 'pending_manager' by some other code path (Supabase Studio edit,
-- admin override, future client bug, etc.).
--
-- This trigger refuses any insert or update that:
--   • Puts a substitute-bearing row at 'pending_manager', 'pending_hr',
--     or 'approved'…
--   • …while at least one substitute's decision is not 'accepted'.
--
-- Rows with no substitutes (substitute_ids is null or empty) are
-- completely untouched — those skip the substitutes stage by design.
-- Rows still at 'pending_substitutes' or any 'rejected_*' state pass
-- through; this trigger only gates the advancement.
--
-- Idempotent — drops and recreates so re-running is safe.

create or replace function public.enforce_substitute_chain()
returns trigger
language plpgsql
as $$
declare
  ids text[];
  psn text;
  dec text;
  raw jsonb;
begin
  -- Only enforce on rows that are advancing past the substitutes step.
  -- pending_substitutes itself is fine, rejected_by_substitute is fine,
  -- rejected_by_manager / rejected_by_hr are also fine (they're terminal
  -- states the chain can land at).
  if NEW.stage not in ('pending_manager', 'pending_hr', 'approved') then
    return NEW;
  end if;

  ids := coalesce(NEW.substitute_ids, ARRAY[]::text[]);

  -- No substitutes named → no chain to enforce. The request was
  -- submitted without coverage and goes directly to the manager.
  if array_length(ids, 1) is null then
    return NEW;
  end if;

  -- Walk every substitute. Bail with a friendly error the moment we
  -- find one whose decision isn't 'accepted'. The error includes the
  -- offending PSN so callers can see which substitute is blocking.
  foreach psn in array ids loop
    raw := NEW.substitute_decisions -> psn;
    if raw is null then
      dec := 'pending';
    elsif jsonb_typeof(raw) = 'string' then
      dec := trim(both '"' from raw::text);
    else
      dec := raw ->> 'decision';
    end if;

    if dec is distinct from 'accepted' then
      raise exception
        'Cannot advance leave_request % to %: substitute % has not accepted (current decision: %). All substitutes must accept before the manager can review.',
        NEW.id, NEW.stage, psn, coalesce(dec, 'pending')
        using errcode = 'check_violation';
    end if;
  end loop;

  return NEW;
end;
$$;

-- Drop any existing version and recreate. Fires BEFORE so the row is
-- never actually written when the chain isn't satisfied.
drop trigger if exists trg_enforce_substitute_chain on public.leave_requests;

create trigger trg_enforce_substitute_chain
before insert or update of stage, substitute_decisions, substitute_ids on public.leave_requests
for each row
execute function public.enforce_substitute_chain();

comment on function public.enforce_substitute_chain() is
  'Defense-in-depth: prevents leave_requests.stage from being advanced past pending_substitutes when any substitute has not accepted. Fires on insert and on updates that touch stage / substitute_decisions / substitute_ids.';
