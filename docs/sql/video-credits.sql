-- ═══════════════════════════════════════════════════════════════════════════
-- Video credits: prepaid balance, reserve → settle → refund.
-- Apply as project owner. Idempotent; safe to re-run.
--
-- WHY THIS IS NEEDED AS ONE UNIT: purchased credits are today credited into
-- ai_credits.balance by stripe-webhook, and reset_ai_credits / the 30-day
-- rollover both do `balance = allowance`. That destroys purchased credits on
-- every plan change, cancellation and monthly reset. No money has been lost yet
-- only because nothing has been sold. The separate purchased_balance bucket
-- below is what makes "purchased credits never expire" true.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The non-expiring bucket ─────────────────────────────────────────────
-- Deliberately a column on the existing ledger, not a second table: one row per
-- user still holds the whole picture, and reset_ai_credits / spend_ai_credit
-- never name this column, so a reset cannot touch it.
alter table public.ai_credits
  add column if not exists purchased_balance integer not null default 0;

alter table public.ai_credits
  drop constraint if exists ai_credits_purchased_balance_nonneg;
alter table public.ai_credits
  add constraint ai_credits_purchased_balance_nonneg
  check (purchased_balance >= 0);


-- ── 2. Plan allowances absorb the monthly video grant ──────────────────────
-- The monthly video grant is absorbed into the single shared allowance:
-- free +0, starter +100, pro +250, premier +600. Supervisor and collaborator
-- plans are unchanged: they do not have the video tool.
create or replace function public.ai_allowance_for_plan(p text)
returns integer
language sql
immutable
set search_path to 'public'
as $function$
  select case p
    when 'artist_starter'      then 250   -- 150 + 100 video
    when 'artist_pro'          then 750   -- 500 + 250 video
    when 'artist_premier'      then 2600  -- 2000 + 600 video
    when 'supervisor_standard' then 500
    when 'supervisor_pro'      then 2000
    when 'collaborator'        then 150
    else 20  -- free / default
  end;
$function$;


-- ── 3. Per-second pricing ──────────────────────────────────────────────────
-- 100 credits = $1.00 retail, so draft is $0.15/s and cinematic $0.75/s.
create or replace function public.video_credit_rate(p_tier text)
returns integer
language sql
immutable
set search_path to 'public'
as $function$
  select case p_tier
    when 'draft'     then 15
    when 'standard'  then 25
    when 'premium'   then 45
    when 'cinematic' then 75
    else null                -- unknown tier: null, so reserve refuses rather
  end;                       -- than silently charging zero
$function$;

-- The models do NOT accept arbitrary durations. Probed against FAL on 2026-08-27.
-- Per-second pricing is our retail abstraction over a fixed menu, and reserve
-- refuses a duration the tier cannot deliver rather than charging for seconds the
-- model will never produce.
--
-- Ladder and real cost, confirmed against fal's pricing page on 2026-08-27 with
-- audio OFF (artists bring their own music, and audio doubles the veo rate):
--   draft     wan/v2.2-5b        $0.15 flat per video   vs  $0.15/s retail
--   standard  kling 1.6 standard $0.056/s               vs  $0.25/s retail
--   premium   veo3.1/fast        $0.10/s                vs  $0.45/s retail
--   cinematic veo3.1             $0.20/s                vs  $0.75/s retail
create or replace function public.video_tier_durations(p_tier text)
returns integer[]
language sql
immutable
set search_path to 'public'
as $function$
  select case p_tier
    when 'draft'     then array[5]          -- we drive num_frames
    when 'standard'  then array[5, 10]      -- duration literal '5' | '10'
    when 'premium'   then array[4, 6, 8]    -- duration literal '4s' | '6s' | '8s'
    when 'cinematic' then array[4, 6, 8]    -- duration literal '4s' | '6s' | '8s'
    else null
  end;
$function$;

create or replace function public.video_credit_cost(p_tier text, p_seconds numeric)
returns integer
language sql
immutable
set search_path to 'public'
as $function$
  select ceil(public.video_credit_rate(p_tier) * greatest(coalesce(p_seconds, 0), 0))::integer;
$function$;


-- ── 4. Jobs ────────────────────────────────────────────────────────────────
-- reserved_allowance / reserved_purchased record which bucket each credit came
-- out of. A refund returns to those same buckets, which is what stops a refund
-- laundering expiring allowance credits into non-expiring purchased ones.
create table if not exists public.video_jobs (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  tier               text not null check (tier in ('draft','standard','premium','cinematic')),
  requested_seconds  numeric(6,2) not null check (requested_seconds > 0),
  actual_seconds     numeric(6,2),
  estimated_credits  integer not null check (estimated_credits >= 0),
  settled_credits    integer,
  reserved_allowance integer not null default 0 check (reserved_allowance >= 0),
  reserved_purchased integer not null default 0 check (reserved_purchased >= 0),
  status             text not null default 'reserved'
                     check (status in ('reserved','submitted','succeeded','failed','refunded')),
  fal_model          text,
  fal_request_id     text,
  prompt             text,
  output_url         text,
  error_reason       text,
  created_at         timestamptz not null default now(),
  settled_at         timestamptz
);

create index if not exists video_jobs_user_created_idx
  on public.video_jobs (user_id, created_at desc);
create unique index if not exists video_jobs_fal_request_idx
  on public.video_jobs (fal_request_id) where fal_request_id is not null;

alter table public.video_jobs enable row level security;
drop policy if exists video_jobs_select_own on public.video_jobs;
create policy video_jobs_select_own on public.video_jobs
  for select using (auth.uid() = user_id);
-- No insert/update/delete policy on purpose: rows are only ever written by the
-- SECURITY DEFINER functions below, or by the service role from the webhook.


-- ── 5. Audit trail ─────────────────────────────────────────────────────────
-- Every movement of credit, with the bucket split, so a refund can be proven to
-- have landed rather than merely claimed.
create table if not exists public.ai_credit_transactions (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,
  delta                    integer not null,               -- negative = charge
  from_allowance           integer not null default 0,
  from_purchased           integer not null default 0,
  reason                   text not null
                           check (reason in ('purchase','reserve','settle','refund','spend','grant')),
  video_job_id             uuid references public.video_jobs(id) on delete set null,
  stripe_payment_intent_id text,
  note                     text,
  created_at               timestamptz not null default now()
);

create index if not exists ai_credit_tx_user_created_idx
  on public.ai_credit_transactions (user_id, created_at desc);

alter table public.ai_credit_transactions enable row level security;
drop policy if exists ai_credit_tx_select_own on public.ai_credit_transactions;
create policy ai_credit_tx_select_own on public.ai_credit_transactions
  for select using (auth.uid() = user_id);


-- ── 6. Balance read ────────────────────────────────────────────────────────
-- Returns a table, not a composite: a composite return type comes back from
-- PostgREST as a row of all-nulls when empty, which reads as a real answer.
create or replace function public.video_credit_balance(p_user uuid)
returns table(allowance_balance integer, purchased_balance integer,
              total_balance integer, monthly_allowance integer, unlimited boolean)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_plan text; v_allow int; v_rec public.ai_credits%rowtype;
begin
  if auth.uid() is distinct from p_user
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
  then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select plan into v_plan from public.profiles where id = p_user;
  v_allow := public.effective_allowance(p_user, coalesce(v_plan, 'free'));
  select * into v_rec from public.ai_credits where user_id = p_user;

  if not found then
    return query select v_allow, 0, v_allow, v_allow, (v_allow >= 999999);
    return;
  end if;

  -- Report the post-rollover figure rather than a stale one, so the number the
  -- artist is shown matches what a reserve would actually find.
  if v_rec.period_start < now() - interval '30 days' then
    v_rec.balance := v_allow;
  end if;

  return query select v_rec.balance, v_rec.purchased_balance,
                      v_rec.balance + v_rec.purchased_balance,
                      v_allow, (v_allow >= 999999);
end;
$function$;


-- ── 7. Reserve ─────────────────────────────────────────────────────────────
-- Deducts the estimate up front and writes the job row in the same transaction.
-- `for update` on the ai_credits row is what serialises two concurrent submits:
-- the second blocks until the first has committed its deduction, so they cannot
-- both pass the same balance check.
create or replace function public.reserve_video_credits(
  p_user uuid, p_tier text, p_seconds numeric, p_prompt text, p_model text)
returns table(ok boolean, shortfall integer, job_id uuid,
              estimated_credits integer, balance_after integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cost int; v_plan text; v_allow int; v_rec public.ai_credits%rowtype;
  v_from_allow int := 0; v_from_purch int := 0; v_job uuid; v_total int;
begin
  -- `auth.uid() is not null and ...` would SKIP the check entirely for any caller
  -- with no JWT. Assume nothing about callers: a mismatch is refused, and only the
  -- named service roles are allowed to act for another user.
  if auth.uid() is distinct from p_user
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
  then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_cost := public.video_credit_cost(p_tier, p_seconds);
  if v_cost is null then
    raise exception 'unknown video tier: %', p_tier using errcode = '22023';
  end if;
  if coalesce(p_seconds, 0) <= 0 then
    raise exception 'requested_seconds must be positive' using errcode = '22023';
  end if;
  if not (round(p_seconds)::integer = any(public.video_tier_durations(p_tier))) then
    raise exception '% does not offer a %s clip; it offers %',
      p_tier, round(p_seconds)::integer,
      array_to_string(public.video_tier_durations(p_tier), ', ')
      using errcode = '22023';
  end if;

  select plan into v_plan from public.profiles where id = p_user;
  v_allow := public.effective_allowance(p_user, coalesce(v_plan, 'free'));

  select * into v_rec from public.ai_credits where user_id = p_user for update;
  if not found then
    insert into public.ai_credits(user_id, balance, allowance, period_start)
    values (p_user, v_allow, v_allow, now())
    returning * into v_rec;
  end if;

  -- Same period/allowance maintenance spend_ai_credit does, so the two agree.
  if v_rec.allowance <> v_allow then
    update public.ai_credits set allowance = v_allow where user_id = p_user;
    v_rec.allowance := v_allow;
  end if;
  if v_rec.period_start < now() - interval '30 days' then
    update public.ai_credits
       set balance = v_allow, period_start = now(), updated_at = now()
     where user_id = p_user;
    v_rec.balance := v_allow;
  end if;

  if v_allow < 999999 then
    v_total := v_rec.balance + v_rec.purchased_balance;
    if v_total < v_cost then
      -- No job row, no deduction. The caller renders the shortfall and a top-up.
      return query select false, v_cost - v_total, null::uuid, v_cost, v_total;
      return;
    end if;
    -- Allowance first, purchased second: spend the credits that expire before
    -- the ones that never do.
    v_from_allow := least(v_rec.balance, v_cost);
    v_from_purch := v_cost - v_from_allow;
    update public.ai_credits
       set balance           = balance - v_from_allow,
           purchased_balance = purchased_balance - v_from_purch,
           updated_at        = now()
     where user_id = p_user;
  end if;

  insert into public.video_jobs(
    user_id, tier, requested_seconds, estimated_credits,
    reserved_allowance, reserved_purchased, status, prompt, fal_model)
  values (p_user, p_tier, p_seconds, v_cost,
          v_from_allow, v_from_purch, 'reserved', p_prompt, p_model)
  returning id into v_job;

  insert into public.ai_credit_transactions(
    user_id, delta, from_allowance, from_purchased, reason, video_job_id, note)
  values (p_user, -v_cost, v_from_allow, v_from_purch, 'reserve', v_job,
          p_tier || ' ' || p_seconds || 's estimate');

  select balance + purchased_balance into v_total
    from public.ai_credits where user_id = p_user;

  return query select true, 0, v_job, v_cost, v_total;
end;
$function$;


-- ── 8. Settle ──────────────────────────────────────────────────────────────
-- Idempotent: a retried webhook finds the job already out of 'reserved' and
-- returns the settled figure instead of charging twice.
create or replace function public.settle_video_credits(
  p_job_id uuid, p_actual_seconds numeric, p_output_url text, p_fal_request_id text)
returns table(ok boolean, settled integer, refunded integer, extra_charged integer,
              uncollected integer, balance_after integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_job public.video_jobs%rowtype; v_actual_cost int; v_diff int;
  v_ret_purch int := 0; v_ret_allow int := 0;
  v_take_allow int := 0; v_take_purch int := 0; v_uncollected int := 0;
  v_rec public.ai_credits%rowtype; v_total int;
begin
  select * into v_job from public.video_jobs where id = p_job_id for update;
  if not found then raise exception 'no such job: %', p_job_id using errcode = '22023'; end if;

  if v_job.status <> 'reserved' and v_job.status <> 'submitted' then
    select balance + purchased_balance into v_total
      from public.ai_credits where user_id = v_job.user_id;
    return query select true, coalesce(v_job.settled_credits, v_job.estimated_credits),
                        0, 0, 0, coalesce(v_total, 0);
    return;
  end if;

  v_actual_cost := public.video_credit_cost(v_job.tier, coalesce(p_actual_seconds, v_job.requested_seconds));
  v_diff := v_actual_cost - v_job.estimated_credits;

  select * into v_rec from public.ai_credits where user_id = v_job.user_id for update;

  if v_job.reserved_allowance = 0 and v_job.reserved_purchased = 0 then
    v_diff := 0;   -- unlimited user: nothing was taken, nothing settles
    v_actual_cost := 0;
  elsif v_diff < 0 then
    -- Shorter than asked for. Give back the never-expiring credits first, but
    -- never more than came out of that bucket, so this cannot be used to convert
    -- allowance credits into purchased ones.
    v_ret_purch := least(-v_diff, v_job.reserved_purchased);
    v_ret_allow := (-v_diff) - v_ret_purch;
    update public.ai_credits
       set balance           = balance + v_ret_allow,
           purchased_balance = purchased_balance + v_ret_purch,
           updated_at        = now()
     where user_id = v_job.user_id;
    insert into public.ai_credit_transactions(
      user_id, delta, from_allowance, from_purchased, reason, video_job_id, note)
    values (v_job.user_id, -v_diff, v_ret_allow, v_ret_purch, 'settle', v_job.id,
            'clip came in short: ' || coalesce(p_actual_seconds, 0) || 's of ' || v_job.requested_seconds || 's');
  elsif v_diff > 0 then
    -- Longer than asked for. The clip already exists, so collect what is there
    -- and record any remainder rather than driving the balance negative.
    v_take_allow := least(v_rec.balance, v_diff);
    v_take_purch := least(v_rec.purchased_balance, v_diff - v_take_allow);
    v_uncollected := v_diff - v_take_allow - v_take_purch;
    update public.ai_credits
       set balance           = balance - v_take_allow,
           purchased_balance = purchased_balance - v_take_purch,
           updated_at        = now()
     where user_id = v_job.user_id;
    insert into public.ai_credit_transactions(
      user_id, delta, from_allowance, from_purchased, reason, video_job_id, note)
    values (v_job.user_id, -(v_take_allow + v_take_purch), v_take_allow, v_take_purch, 'settle', v_job.id,
            'clip ran long: ' || coalesce(p_actual_seconds, 0) || 's of ' || v_job.requested_seconds || 's'
            || case when v_uncollected > 0 then '; ' || v_uncollected || ' uncollected' else '' end);
  end if;

  update public.video_jobs
     set status          = 'succeeded',
         actual_seconds  = p_actual_seconds,
         settled_credits = v_actual_cost - v_uncollected,
         output_url      = coalesce(p_output_url, output_url),
         fal_request_id  = coalesce(p_fal_request_id, fal_request_id),
         settled_at      = now()
   where id = p_job_id;

  select balance + purchased_balance into v_total
    from public.ai_credits where user_id = v_job.user_id;

  return query select true, v_actual_cost - v_uncollected,
                      greatest(-v_diff, 0), greatest(v_diff, 0), v_uncollected, coalesce(v_total, 0);
end;
$function$;


-- ── 9. Refund ──────────────────────────────────────────────────────────────
-- Full reversal of the reservation, to the exact buckets it came from.
-- Idempotent, for the same webhook-retry reason as settle.
create or replace function public.refund_video_credits(p_job_id uuid, p_reason text)
returns table(ok boolean, refunded integer, to_allowance integer,
              to_purchased integer, balance_after integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_job public.video_jobs%rowtype; v_total int;
begin
  select * into v_job from public.video_jobs where id = p_job_id for update;
  if not found then raise exception 'no such job: %', p_job_id using errcode = '22023'; end if;

  if v_job.status not in ('reserved', 'submitted') then
    select balance + purchased_balance into v_total
      from public.ai_credits where user_id = v_job.user_id;
    return query select true, 0, 0, 0, coalesce(v_total, 0);
    return;
  end if;

  if v_job.reserved_allowance > 0 or v_job.reserved_purchased > 0 then
    update public.ai_credits
       set balance           = balance + v_job.reserved_allowance,
           purchased_balance = purchased_balance + v_job.reserved_purchased,
           updated_at        = now()
     where user_id = v_job.user_id;

    insert into public.ai_credit_transactions(
      user_id, delta, from_allowance, from_purchased, reason, video_job_id, note)
    values (v_job.user_id, v_job.reserved_allowance + v_job.reserved_purchased,
            v_job.reserved_allowance, v_job.reserved_purchased, 'refund', v_job.id,
            coalesce(p_reason, 'generation failed'));
  end if;

  update public.video_jobs
     set status          = 'refunded',
         settled_credits = 0,
         error_reason    = coalesce(p_reason, 'generation failed'),
         settled_at      = now()
   where id = p_job_id;

  select balance + purchased_balance into v_total
    from public.ai_credits where user_id = v_job.user_id;

  return query select true, v_job.reserved_allowance + v_job.reserved_purchased,
                      v_job.reserved_allowance, v_job.reserved_purchased, coalesce(v_total, 0);
end;
$function$;


-- ── 10. Purchased credits are spendable on everything ──────────────────────
-- Both spend_ai_credit overloads stopped at `balance`, which would have made a
-- purchased balance unusable for text and image tools. They now fall through to
-- the purchased bucket, still allowance-first.
create or replace function public.spend_ai_credit(p_user uuid, p_action text)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare rec public.ai_credits%rowtype; plan_txt text; allow int; cost int;
        take_allow int; take_purch int;
begin
  if auth.uid() is not null and p_user <> auth.uid() then raise exception 'forbidden'; end if;
  cost := public.ai_cost_for(p_action);
  select plan into plan_txt from public.profiles where id = p_user;
  allow := public.effective_allowance(p_user, coalesce(plan_txt,'free'));
  select * into rec from public.ai_credits where user_id = p_user for update;
  if not found then
    insert into public.ai_credits(user_id, balance, allowance, period_start)
    values (p_user, allow, allow, now()) returning * into rec;
  end if;
  if rec.allowance <> allow then
    update public.ai_credits set allowance = allow where user_id = p_user;
    rec.allowance := allow;
  end if;
  if rec.period_start < now() - interval '30 days' then
    update public.ai_credits set balance = allow, period_start = now(), updated_at = now()
      where user_id = p_user;
    rec.balance := allow;
  end if;
  if allow >= 999999 then return 999999; end if;
  if rec.balance + rec.purchased_balance < cost then return -1; end if;

  take_allow := least(rec.balance, cost);
  take_purch := cost - take_allow;
  update public.ai_credits
     set balance = balance - take_allow,
         purchased_balance = purchased_balance - take_purch,
         updated_at = now()
   where user_id = p_user;

  insert into public.ai_credit_transactions(
    user_id, delta, from_allowance, from_purchased, reason, note)
  values (p_user, -cost, take_allow, take_purch, 'spend', p_action);

  return rec.balance + rec.purchased_balance - cost;
end;
$function$;

create or replace function public.spend_ai_credit(p_user uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- The single-argument form was a 1-credit spend; express it as the general one
  -- so there is only one place where the bucket order lives.
  return public.spend_ai_credit(p_user, 'default');
end;
$function$;


-- ── 11. Refunds respect the bucket split ───────────────────────────────────
-- spend_ai_credit takes allowance first, then purchased. refund_ai_credit put
-- everything back into balance, which would let a user convert expiring allowance
-- credits into non-expiring purchased ones by failing generations on purpose.
-- Filling allowance up to its ceiling and spilling the rest into purchased is the
-- exact inverse of how the spend was taken.
create or replace function public.refund_ai_credit(p_user uuid, p_action text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  plan_txt text; allow int; cost int; rec public.ai_credits%rowtype;
  give_allow int; give_purch int;
begin
  select plan into plan_txt from public.profiles where id = p_user;
  allow := public.effective_allowance(p_user, coalesce(plan_txt,'free'));
  if allow >= 999999 then return; end if;   -- unlimited users are never charged
  cost := public.ai_cost_for(p_action);

  select * into rec from public.ai_credits where user_id = p_user for update;
  if not found then return; end if;

  give_allow := least(cost, greatest(allow - rec.balance, 0));
  give_purch := cost - give_allow;

  update public.ai_credits
     set balance           = balance + give_allow,
         purchased_balance = purchased_balance + give_purch,
         updated_at        = now()
   where user_id = p_user;

  insert into public.ai_credit_transactions(
    user_id, delta, from_allowance, from_purchased, reason, note)
  values (p_user, cost, give_allow, give_purch, 'refund', p_action);
end;
$function$;


-- ── 12. Grants ─────────────────────────────────────────────────────────────
grant execute on function public.video_credit_rate(text)                    to authenticated;
grant execute on function public.video_credit_cost(text, numeric)           to authenticated;
grant execute on function public.video_tier_durations(text)                 to authenticated;
grant execute on function public.video_credit_balance(uuid)                 to authenticated;
grant execute on function public.reserve_video_credits(uuid, text, numeric, text, text) to authenticated;
-- settle and refund are service-role only: they are called by the FAL webhook,
-- never by a browser.
--
-- WARNING: omitting a grant is NOT the same as denying one. Postgres grants
-- EXECUTE on every new function to PUBLIC, and Supabase's default privileges also
-- grant it to anon by name, so both roles could call these until the explicit
-- revokes in docs/sql/publish-flow.sql. Verify with has_function_privilege()
-- rather than assuming.
