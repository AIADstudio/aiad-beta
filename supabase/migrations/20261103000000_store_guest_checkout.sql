-- Guest checkout for storefronts. A buyer with no AIAD account has no row in
-- auth.users, so orders.buyer_id stays null and these two columns carry what we
-- do know: the email Stripe collected and the IP the attempt came from.
alter table public.orders add column if not exists guest_email text;
alter table public.orders add column if not exists guest_ip    text;

-- store-checkout counts a guest's orders in the last hour by IP before it will
-- talk to Stripe. Partial, because signed-in orders leave guest_ip null and
-- there is no reason to index them here.
create index if not exists idx_orders_guest_ip
  on public.orders (guest_ip, created_at desc)
  where guest_ip is not null;

-- store-receipt and store-webhook both find an order by its session id, and a
-- guest has nothing else to find it by.
create index if not exists idx_orders_stripe_session
  on public.orders (stripe_session_id);
