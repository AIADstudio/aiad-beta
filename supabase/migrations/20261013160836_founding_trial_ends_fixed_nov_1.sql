-- ══════════════════════════════════════════════════════════════════════════
-- enroll_founding_artist — one trial end date, not two
--
-- The function set trial_ends_at to a rolling now() + 30 days while the
-- founding trial is a fixed window. artist_profiles.trial_ends_at is what the
-- dashboard shows the artist, so the two dates disagreeing is visible to them.
-- It is now pinned to the same instant: 2026-11-01 00:00 America/New_York,
-- floored at now() so a signup after that date is never written with a trial
-- that already expired.
--
-- Function body only. Same return signature, SECURITY DEFINER, search_path,
-- the `for update` row lock on founding_program, the returning-member
-- short-circuit and the programme-closed early return.
-- ══════════════════════════════════════════════════════════════════════════
create or replace function public.enroll_founding_artist(p_user_id uuid)
returns table(founding_number int, trial_ends_at timestamptz, is_new boolean, rate_active boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_open boolean; v_num int; v_trial timestamptz; v_active boolean;
begin
  perform 1 from public.founding_program where id = 1 for update;

  -- Returning user who already holds a number: no new trial, no counter change.
  select ap.founding_number, ap.trial_ends_at, ap.founding_rate_active
    into v_num, v_trial, v_active
  from public.artist_profiles ap
  where ap.user_id = p_user_id and ap.founding_number is not null
  limit 1;
  if found then
    return query select v_num, v_trial, false, coalesce(v_active, false);
    return;
  end if;

  select (fp.is_open and fp.enrolled_count < fp.cap and now() < fp.deadline)
    into v_open from public.founding_program fp where fp.id = 1;
  if not coalesce(v_open, false) then
    return; -- program closed: caller treats as non-founding
  end if;

  update public.founding_program
     set enrolled_count = enrolled_count + 1,
         is_open        = (enrolled_count + 1 < cap)
   where id = 1
   returning enrolled_count into v_num;

  -- The fixed end of the founding trial, not 30 days from whenever they signed
  -- up. greatest() keeps a post-deadline signup from being handed a trial that
  -- expired before it was written.
  v_trial := greatest(timestamptz '2026-11-01 00:00:00 America/New_York', now());
  update public.artist_profiles
     set is_founding_artist   = true,
         founding_number      = v_num,
         founding_rate_active = true,
         subscription_status  = 'trialing',
         trial_started_at     = now(),
         trial_ends_at        = v_trial
   where user_id = p_user_id;

  return query select v_num, v_trial, true, true;
end;
$$;

-- Unchanged: service_role only. The function is called by stripe-checkout
-- under the service key and by nothing in the browser. CREATE OR REPLACE
-- preserves the existing ACL, so these are assertions rather than changes.
revoke all on function public.enroll_founding_artist(uuid) from public;
revoke all on function public.enroll_founding_artist(uuid) from anon;
revoke all on function public.enroll_founding_artist(uuid) from authenticated;
grant execute on function public.enroll_founding_artist(uuid) to service_role;
