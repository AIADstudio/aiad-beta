-- ═══════════════════════════════════════════════════════════════════════════
-- Pledge checkout support. APPLIED 2026-08-27 (migration stripe_pledge_products).
-- No SQL functions are created by this feature, so there are no EXECUTE grants
-- to revoke — verified by querying pg_proc for pledge/fan_subscription functions
-- and getting none.
-- ═══════════════════════════════════════════════════════════════════════════

-- One Stripe Product per tier, created on first use and reused thereafter, so
-- pledge checkout can pass inline price_data instead of sixteen hardcoded Price
-- objects that would turn every tier change into a two-mode dashboard migration.
--
-- livemode is in the primary key so a test-mode product can never be handed to a
-- live-mode session or the reverse.
create table if not exists public.stripe_pledge_products (
  tier        text        not null check (tier in ('supporter','patron','collector','inner_circle')),
  livemode    boolean     not null,
  product_id  text        not null,
  created_at  timestamptz not null default now(),
  primary key (tier, livemode)
);

alter table public.stripe_pledge_products enable row level security;

-- Deliberately no policies. Only the service role touches this table, and the
-- service role bypasses RLS; with RLS on and no policy, anon and authenticated get
-- nothing even though Supabase's default grants give them table privileges.
revoke all on public.stripe_pledge_products from anon, authenticated;

-- Verified afterwards rather than assumed:
--   anon_select=false, auth_select=false, service_select=true, rls_on=true, policies=0

-- Prices live in the pledge-checkout edge function, NOT here and NOT in Stripe
-- Price objects: supporter 500, patron 1000, collector 3000, inner_circle 6000
-- cents monthly; a year is monthly x 10.


-- ── stripe_accounts is keyed (user_id, livemode) ───────────────────────────
-- Applied outside this file. Recorded here because every reader of the table
-- must now filter on the mode it is operating in.
--
-- Stripe test and live are separate environments: the same artist has a different
-- acct_ id in each and neither works in the other. With one row per user, a live
-- onboarding would overwrite the test row and any code holding live keys while
-- reading a test acct_ id fails every transfer_data.destination with "No such
-- account" — at the moment a real fan is paying.
--
-- Every call site derives the mode from the secret key it actually uses:
--   connect-onboard       STRIPE_STORE_KEY   select + upsert (user_id, livemode)
--   store-balance         STRIPE_STORE_KEY   select + update
--   store-checkout        STRIPE_STORE_KEY   select
--   store-withdraw        STRIPE_STORE_KEY   select + update
--   store-dashboard-link  STRIPE_STORE_KEY   select
--   pledge-checkout       STRIPE_SECRET_KEY  select
--
-- NOTE the key split: connect-onboard CREATES accounts with STRIPE_STORE_KEY,
-- but pledge-checkout CHARGES with STRIPE_SECRET_KEY. If those two secrets are
-- different Stripe platforms, a destination written by one is invisible to the
-- other regardless of mode. pledge-checkout therefore retrieves the account with
-- its own charging key before creating a session and returns the structured
-- refusal (reason: account_not_visible_to_charging_key) rather than letting
-- Stripe fail mid-payment.
