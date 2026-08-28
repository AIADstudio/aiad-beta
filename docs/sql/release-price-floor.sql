-- Release price floor — server-side enforcement.
--
-- The client computes the same floor in AIADRelease.releaseFloorCents(), but the
-- client is not trusted. This makes the rule authoritative in one place that both
-- the wizard's UPDATE and any future purchase-checkout function must pass through.
--
-- Rule (keyed on releases.release_type, the field the artist sets on step 1):
--   single  -> the dearest track floor on the release, minimum $2.00
--   ep      -> $2.00 x track count, capped at $7.00
--   album   -> $7.00
--
-- Known gap: the trigger fires on releases, not on tracks. Raising a track above
-- the release price after the release row was last written will not re-check it.
-- The wizard revalidates on every save, so this only matters for direct edits.
--
-- Run as the project owner. Safe to re-run.

create or replace function public.release_price_floor_cents(p_release_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case r.release_type
    when 'album' then 700
    when 'ep' then least(
      200 * greatest(1, (select count(*) from tracks t where t.release_id = r.id)),
      700
    )
    else greatest(
      200,
      coalesce((select max(t.min_price_cents) from tracks t where t.release_id = r.id), 200)
    )
  end
  from releases r
  where r.id = p_release_id;
$$;

grant execute on function public.release_price_floor_cents(uuid) to authenticated;

-- Reject a release priced under its own floor. Only fires when a price is actually
-- set, so drafts can still be saved half-filled; the wizard's own validation is what
-- blocks submission with a null price.
create or replace function public.enforce_release_price_floor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  floor_cents integer;
begin
  if new.min_price_cents is null or new.purchasable is not true then
    return new;
  end if;

  floor_cents := case new.release_type
    when 'album' then 700
    when 'ep' then least(
      200 * greatest(1, (select count(*) from tracks t where t.release_id = new.id)),
      700
    )
    else greatest(
      200,
      coalesce((select max(t.min_price_cents) from tracks t where t.release_id = new.id), 200)
    )
  end;

  if new.min_price_cents < floor_cents then
    raise exception
      'Release minimum is %.2f for a %, but % was given',
      floor_cents / 100.0, new.release_type, new.min_price_cents
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_release_price_floor on public.releases;
create trigger trg_enforce_release_price_floor
  before insert or update of min_price_cents, release_type, purchasable
  on public.releases
  for each row
  execute function public.enforce_release_price_floor();
