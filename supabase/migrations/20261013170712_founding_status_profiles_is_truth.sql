-- ══════════════════════════════════════════════════════════════════════════
-- Founding status: profiles is the single source of truth
--
-- Two systems disagreed. public.profiles holds 39 badged founding artists
-- numbered 1..39, written by the grant_founding_artist signup trigger — and
-- that badge and number are what the artist sees. founding_program sat at
-- enrolled_count 1 with deadline 2026-09-01, and enroll_founding_artist gated
-- on `now() < fp.deadline`, six weeks past, so at checkout it returned zero
-- rows: rate_active came back false, no coupon was applied, and a badged
-- artist would have been charged full list price at a checkout that shows
-- them a Founding Artist badge. The signup trigger caps at 100 but never
-- checked a deadline, which is how the two drifted apart.
--
-- Decision: honour every badged artist. profiles wins.
--   * the deadline gate is gone — the signup cap is the only control
--   * artist_profiles is written with an upsert: 5 badged artists have no
--     artist_profiles row, and the bare UPDATE wrote nothing for them, so
--     they were silently given no trial
--   * founding_program.enrolled_count stops being a gate and is synced once
--     here to the live figure. It is a reporting mirror from now on.
--
-- Not touched: aiad_access_state, the Oct 15 card deadline, the card gate.
-- ══════════════════════════════════════════════════════════════════════════

-- ── enroll_founding_artist ────────────────────────────────────────────────
-- Body only. Same RETURNS TABLE signature, SECURITY DEFINER, search_path and
-- the `for update` row lock on founding_program.
create or replace function public.enroll_founding_artist(p_user_id uuid)
returns table(founding_number int, trial_ends_at timestamptz, is_new boolean, rate_active boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_badged  boolean;
  v_role    text;
  v_num     int;
  v_had_num int;
  v_trial   timestamptz;
  v_new     boolean;
begin
  -- Kept so concurrent checkouts serialise here. It no longer guards a
  -- counter: nothing in this function writes founding_program any more.
  perform 1 from public.founding_program where id = 1 for update;

  -- profiles decides. founding_number is a PER-ROLE sequence (artists 1..39,
  -- collaborators 1..2), so the role filter is load-bearing: without it a
  -- collaborator's number would be handed out as an artist's.
  select coalesce(p.founding_member, false), p.founding_role, p.founding_number
    into v_badged, v_role, v_num
  from public.profiles p
  where p.id = p_user_id;

  if not coalesce(v_badged, false) or coalesce(v_role, '') <> 'artist' then
    return; -- not a founding artist; the caller treats no rows as non-founding
  end if;

  -- The checkout-side mirror. A number already here means this artist has been
  -- through checkout before: they keep that trial rather than starting another.
  select ap.founding_number, ap.trial_ends_at
    into v_had_num, v_trial
  from public.artist_profiles ap
  where ap.user_id = p_user_id;

  v_new := v_had_num is null;

  if v_new then
    -- The same fixed instant Stripe's trial_end is pinned to, floored at now()
    -- so a late signup is never written with a trial that already expired.
    v_trial := greatest(timestamptz '2026-11-01 00:00:00 America/New_York', now());

    -- Upsert, not update: a badged artist may have no artist_profiles row yet,
    -- and 5 of them do not.
    insert into public.artist_profiles (
      user_id, is_founding_artist, founding_number, founding_rate_active,
      subscription_status, trial_started_at, trial_ends_at)
    values (p_user_id, true, v_num, true, 'trialing', now(), v_trial)
    on conflict (user_id) do update
       set is_founding_artist   = true,
           founding_number      = excluded.founding_number,
           founding_rate_active = true,
           subscription_status  = 'trialing',
           trial_started_at     = excluded.trial_started_at,
           trial_ends_at        = excluded.trial_ends_at;
  else
    -- Returning member. The number is still taken from profiles, because the
    -- two tables can disagree and profiles wins, but the trial is left alone:
    -- no second trial, and no 'trialing' status over an expired one.
    update public.artist_profiles
       set is_founding_artist   = true,
           founding_number      = v_num,
           founding_rate_active = true
     where user_id = p_user_id;
  end if;

  return query select v_num, v_trial, v_new, true;
end;
$$;

-- ── unenroll_founding_artist ──────────────────────────────────────────────
-- Body only, one deletion: enroll_founding_artist no longer increments
-- enrolled_count, so this must not decrement it. Left paired with an
-- increment that no longer happens, it would walk the reporting mirror down
-- by one on every failed checkout. Clearing the artist_profiles mirror stays:
-- the next checkout re-derives everything from profiles.
create or replace function public.unenroll_founding_artist(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.founding_program where id = 1 for update;
  if exists (select 1 from public.artist_profiles where user_id = p_user_id and founding_number is not null) then
    update public.artist_profiles
       set is_founding_artist   = false,
           founding_number      = null,
           founding_rate_active = false,
           subscription_status  = 'none',
           trial_started_at     = null,
           trial_ends_at        = null
     where user_id = p_user_id;
  end if;
end;
$$;

-- ── grant_founding_artist ─────────────────────────────────────────────────
-- Comment only. Everything else in this trigger is byte-identical.
create or replace function public.grant_founding_artist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_artists integer;
  taken_collabs    integer;
  next_num integer;
begin
  if coalesce(NEW.founding_member, false) then
    return NEW;
  end if;

  -- Founder (artist 0) excluded from the founding cohort.
  if NEW.role = 'artist' and coalesce(NEW.email,'') <> 'founder@aiad.studio' then
    select count(*) into existing_artists
    from public.profiles
    where role = 'artist' and id <> NEW.id and coalesce(email,'') <> 'founder@aiad.studio';

    -- The cap is the ONLY control on the founding cohort, deliberately. There
    -- is no deadline check here and there must not be one: founding_program's
    -- deadline passed on 2026-09-01 while this trigger kept minting numbers,
    -- and enroll_founding_artist used to gate checkout on that same deadline,
    -- so badged artists would have been billed list price. That function now
    -- reads profiles and ignores the deadline. Adding a deadline check back
    -- here would silently reopen the gap between the badge and the bill.
    if existing_artists < 100 then
      NEW.verified := true;
      NEW.verified_pending := false;
      NEW.founding_member := true;
      NEW.founding_role := coalesce(NEW.founding_role, 'artist');
      if NEW.founding_number is null then
        select coalesce(max(founding_number), 0) + 1 into next_num
        from public.profiles where founding_role = 'artist' and coalesce(email,'') <> 'founder@aiad.studio';
        NEW.founding_number := next_num;
      end if;
      -- REMOVED: NEW.plan := 'artist_pro' and the 300-credit grant.
      -- Founding artists now start Free; they become paid only via start_artist_trial or a
      -- real checkout. Their founding perks (badge, number, and the 60-day window below) stay.
    end if;
  end if;

  -- Founding Collaborator: first 100 collaborators (unchanged).
  if NEW.role = 'collaborator' and coalesce(NEW.email,'') <> 'founder@aiad.studio' then
    select count(*) into taken_collabs
    from public.profiles
    where founding_member = true and founding_role = 'collaborator' and id <> NEW.id;

    if taken_collabs < 100 then
      NEW.founding_member   := true;
      NEW.founding_role     := 'collaborator';
      NEW.verified_pending  := true;
      if NEW.founding_number is null then
        select coalesce(max(founding_number), 0) + 1 into next_num
        from public.profiles where founding_role = 'collaborator';
        NEW.founding_number := next_num;
      end if;
    end if;
  end if;

  -- 60-day founding window for everyone except the founder (unchanged).
  if NEW.founding_free_until is null and coalesce(NEW.email,'') <> 'founder@aiad.studio' then
    NEW.founding_free_until := now() + interval '60 days';
  end if;

  return NEW;
end;
$$;

-- ── founding_program: mirror, not gate ────────────────────────────────────
-- One-off sync to the live figure. Nothing reads enrolled_count as a gate any
-- more; the deadline column is left in place and is read by nothing.
with live as (
  select count(*)::int as n
    from public.profiles
   where founding_member and founding_role = 'artist'
)
update public.founding_program fp
   set enrolled_count = live.n,
       is_open        = (live.n < fp.cap)
  from live
 where fp.id = 1;

-- Unchanged: all three are service_role only — called by stripe-checkout under
-- the service key and by the signup trigger, never from a browser. CREATE OR
-- REPLACE preserves the existing ACL, so these are assertions, not changes.
revoke all on function public.enroll_founding_artist(uuid)   from public, anon, authenticated;
revoke all on function public.unenroll_founding_artist(uuid) from public, anon, authenticated;
revoke all on function public.grant_founding_artist()        from public, anon, authenticated;
grant execute on function public.enroll_founding_artist(uuid)   to service_role;
grant execute on function public.unenroll_founding_artist(uuid) to service_role;
grant execute on function public.grant_founding_artist()        to service_role;
