-- ══════════════════════════════════════════════════════════════════════════
-- aiad_access_state — has_card must mean a LIVE subscription
--
-- The old predicate was `stripe_customer_id is not null` with no status
-- filter. That is correct about abandoned checkouts (no subscriptions row is
-- written until the webhook fires on checkout.session.completed, so an
-- abandoner never passes) but wrong about cancellation: the
-- customer.subscription.deleted branch of stripe-webhook sets status to
-- 'canceled' and leaves stripe_customer_id intact, so a canceled subscriber
-- passed this gate forever. The founder's three June rows are that case.
--
-- Function body only. The founder short-circuit, the not_artist branch, the
-- enforce master switch and the fail-open default are untouched.
-- ══════════════════════════════════════════════════════════════════════════
create or replace function public.aiad_access_state(p_user uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid        uuid := coalesce(p_user, auth.uid());
  v_enforce  boolean;
  v_deadline timestamptz;
  v_role     text;
  v_email    text;
  v_card     boolean;
begin
  select enforce, deadline into v_enforce, v_deadline from public.aiad_billing_config where id;
  v_enforce  := coalesce(v_enforce, false);
  v_deadline := coalesce(v_deadline, timestamptz '2026-10-15 00:00:00 America/New_York');

  if uid is null then
    return jsonb_build_object('entitled', false, 'reason', 'no_user',
                              'deadline', v_deadline, 'has_card', false, 'role', null);
  end if;

  -- A signed-in user may only read their own state. Service-role callers
  -- (auth.uid() null) are trusted and pass through.
  if auth.uid() is not null and uid <> auth.uid() then
    raise exception 'forbidden';
  end if;

  select role, email into v_role, v_email from public.profiles where id = uid;

  -- A customer id alone only proves a checkout once completed; it survives
  -- cancellation. Only a live subscription counts as a card on file.
  -- past_due is deliberately in: the card is on file and Stripe dunning is
  -- still retrying, so one failed charge must not blank the dashboard.
  -- 'canceled', 'incomplete', 'incomplete_expired', 'unpaid' and 'paused'
  -- all fail the gate.
  v_card := exists (
    select 1 from public.subscriptions
     where user_id = uid
       and stripe_customer_id is not null
       and status in ('trialing', 'active', 'past_due')
  );

  -- Master switch. While enforcement is off everything is open and free, and
  -- the reason is deliberately NOT 'before_deadline' so the front end renders
  -- neither the countdown banner nor the blocking overlay.
  if not v_enforce then
    return jsonb_build_object('entitled', true, 'reason', 'open_access',
                              'deadline', null, 'has_card', v_card, 'role', v_role);
  end if;

  -- Founder is checked by the profile row directly rather than is_founder(),
  -- so this still resolves when called with no JWT.
  if coalesce(v_email, '') = 'founder@aiad.studio' then
    return jsonb_build_object('entitled', true, 'reason', 'founder',
                              'deadline', v_deadline, 'has_card', v_card, 'role', v_role);
  end if;

  -- The card terms cover artists only. Collaborators and supervisors are
  -- outside this rule and are never gated by it.
  if coalesce(v_role, '') <> 'artist' then
    return jsonb_build_object('entitled', true, 'reason', 'not_artist',
                              'deadline', v_deadline, 'has_card', v_card, 'role', v_role);
  end if;

  if v_card then
    return jsonb_build_object('entitled', true, 'reason', 'has_card',
                              'deadline', v_deadline, 'has_card', true, 'role', v_role);
  end if;

  if now() < v_deadline then
    return jsonb_build_object('entitled', true, 'reason', 'before_deadline',
                              'deadline', v_deadline, 'has_card', false, 'role', v_role);
  end if;

  return jsonb_build_object('entitled', false, 'reason', 'card_required',
                            'deadline', v_deadline, 'has_card', false, 'role', v_role);
end;
$$;

-- Unchanged from the gate's own migration: PUBLIC holds function grants on
-- this database and anon inherits them, so both are revoked and the two
-- intended roles re-granted. CREATE OR REPLACE preserves the existing ACL,
-- so these are assertions rather than changes.
revoke all on function public.aiad_access_state(uuid) from public;
revoke all on function public.aiad_access_state(uuid) from anon;
grant execute on function public.aiad_access_state(uuid) to authenticated;
grant execute on function public.aiad_access_state(uuid) to service_role;
