-- ═══════════════════════════════════════════════════════════════════════════
-- Publish flow: founder review, approval, scheduled go-live.
-- APPLIED 2026-08-27 (migrations publish_flow_01_policy_and_rpcs,
-- lock_down_service_only_functions, revoke_anon_from_guarded_functions).
-- Kept here so the repo shows what is in the database.
-- ═══════════════════════════════════════════════════════════════════════════

-- The founder could read releases, destinations, rights and contributors for any
-- artist, but NOT tracks: this policy was `is_public or own`, with no founder
-- clause. A review queue that cannot list the tracks it is reviewing is useless.
drop policy if exists select_tracks_visibility on public.tracks;
create policy select_tracks_visibility on public.tracks
  for select using (
    is_public = true
    or user_id = (select auth.uid())
    or public.is_founder()
  );

-- Publishing is one operation in one place, so the review queue and the cron job
-- cannot drift about what "live" means.
create or replace function public.publish_release(p_release_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
begin
  update public.releases
     set status = 'live', updated_at = now()
   where id = p_release_id and status in ('approved', 'live');

  -- Only the AIAD streaming layer goes live. aiad_distribution stays 'pending'
  -- because nothing delivers to LabelGrid yet, and external_distributor is not
  -- ours to move at all.
  update public.release_destinations
     set status = 'live', delivered_at = coalesce(delivered_at, now()), updated_at = now()
   where release_id = p_release_id and destination = 'aiad_streaming' and status <> 'live';
end;
$function$;

-- Called by pg_cron every 5 minutes. SKIP LOCKED so an overlapping run never
-- double-publishes.
create or replace function public.publish_due_releases()
returns integer
language plpgsql security definer set search_path to 'public'
as $function$
declare n int := 0; r record;
begin
  for r in
    select id from public.releases
     where status = 'approved' and go_live_at is not null and go_live_at <= now()
     for update skip locked
  loop
    perform public.publish_release(r.id);
    n := n + 1;
  end loop;
  return n;
end;
$function$;

-- Every founder decision goes through here so the state machine lives in one
-- place. Returns a row rather than raising for a refused transition: the queue
-- needs to render the reason, not a 500.
create or replace function public.founder_release_action(
  p_release_id uuid, p_action text, p_notes text default null)
returns table(ok boolean, new_status text, message text)
language plpgsql security definer set search_path to 'public'
as $function$
declare r public.releases%rowtype;
begin
  if not public.is_founder() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into r from public.releases where id = p_release_id for update;
  if not found then
    raise exception 'no such release: %', p_release_id using errcode = '22023';
  end if;

  if p_action = 'approve' then
    if r.status not in ('submitted', 'in_review', 'changes_requested') then
      return query select false, r.status, 'Only a submitted release can be approved.'; return;
    end if;
    update public.releases
       set status = 'approved', approved_at = now(), review_notes = null, updated_at = now()
     where id = p_release_id;
    return query select true, 'approved'::text,
      case when r.go_live_at is null
           then 'Approved. No go-live date on this release — use Publish now.'
           else 'Approved. Goes live ' || to_char(r.go_live_at at time zone 'UTC', 'DD Mon YYYY HH24:MI') || ' UTC.'
      end;

  elsif p_action = 'request_changes' then
    if coalesce(btrim(p_notes), '') = '' then
      return query select false, r.status, 'Say what needs fixing — the artist sees this verbatim.'; return;
    end if;
    update public.releases
       set status = 'changes_requested', review_notes = p_notes, updated_at = now()
     where id = p_release_id;
    return query select true, 'changes_requested'::text, 'Changes requested.';

  elsif p_action = 'reject' then
    if coalesce(btrim(p_notes), '') = '' then
      return query select false, r.status, 'A rejection needs a reason.'; return;
    end if;
    update public.releases
       set status = 'rejected', review_notes = p_notes, updated_at = now()
     where id = p_release_id;
    return query select true, 'rejected'::text, 'Rejected.';

  elsif p_action = 'publish_now' then
    if r.status not in ('approved', 'live') then
      return query select false, r.status, 'Approve the release before publishing it.'; return;
    end if;
    perform public.publish_release(p_release_id);
    return query select true, 'live'::text, 'Published.';

  else
    raise exception 'unknown action: %', p_action using errcode = '22023';
  end if;
end;
$function$;

-- Postgres grants EXECUTE on every new function to PUBLIC, and Supabase's default
-- privileges additionally grant it to anon by name. A `revoke ... from
-- authenticated, anon` alone therefore does nothing about the PUBLIC grant, and a
-- `revoke ... from public` alone does nothing about the anon grant. Both are
-- needed. Before this, any signed-in user could publish someone else's release.
revoke execute on function public.publish_release(uuid) from public;
revoke execute on function public.publish_due_releases() from public;
revoke execute on function public.founder_release_action(uuid, text, text) from public, anon;
grant  execute on function public.founder_release_action(uuid, text, text) to authenticated;

-- The same fix for the video-credit functions, which had the same wrong pattern.
revoke execute on function public.settle_video_credits(uuid, numeric, text, text) from public;
revoke execute on function public.refund_video_credits(uuid, text) from public;
revoke execute on function public.reserve_video_credits(uuid, text, numeric, text, text) from public, anon;
revoke execute on function public.video_credit_balance(uuid) from public, anon;
grant  execute on function public.reserve_video_credits(uuid, text, numeric, text, text) to authenticated;
grant  execute on function public.video_credit_balance(uuid) to authenticated;

-- Scheduler:
--   select cron.schedule('publish-due-releases', '*/5 * * * *',
--                        $$select public.publish_due_releases();$$);


-- ── Public artist page readability (applied 2026-08-27) ────────────────────
-- artist_profiles granted SELECT only to `authenticated`, so a signed-out fan
-- could not resolve any artist and every public profile rendered "Artist not
-- found". The table also holds commercial state (subscription_status, trial
-- dates, founding_rate_active) that has no business being world-readable, so
-- this is a row policy AND a column grant.
drop policy if exists "Anon can read public artist profiles" on public.artist_profiles;
create policy "Anon can read public artist profiles" on public.artist_profiles
  for select to anon
  using (is_public is not false);

-- Column grants bind anon only; `authenticated` keeps full access, so the
-- signed-in select('*') paths for a user's own profile are unaffected.
--
-- Grants are ADDITIVE: a later, narrower grant does not remove an earlier wider
-- one. My first version of this included is_founding_artist and founding_number,
-- which had to be revoked by name afterwards. This is the settled set.
revoke select on public.artist_profiles from anon;
grant select (
  id, user_id, username, artist_name, avatar_url, location, primary_genre,
  short_bio, full_bio, tagline, store_title, follower_count, is_public, created_at
) on public.artist_profiles to anon;
revoke select (is_founding_artist, founding_number) on public.artist_profiles from anon;

-- OPEN, not fixed here: the "Authenticated can read artist profiles" policy is
-- `qual: true` and `authenticated` holds TABLE-wide SELECT, so any signed-in user
-- can read every artist's subscription_status, trial_started_at, trial_ends_at and
-- founding_rate_active. Column grants cannot narrow a table-wide grant.
