# stripe-webhook

Deployed function source is fetched from Supabase rather than duplicated here by
hand, because a hand-copy of a money-handling function is a drift risk in itself.

To pull the live source into this directory before editing:

    supabase functions download stripe-webhook --project-ref uapiytquwuhtewqieegx

## What it does

Authenticates by Stripe HMAC signature, not by JWT — `verify_jwt` is deliberately
`false`, because Stripe cannot present one. Accepts a comma-separated list of
signing secrets so test and live endpoints can share the function and so secret
rotation does not take it down.

Handled events:

- `checkout.session.completed`
  - **pledges** (`metadata.kind === 'pledge'`) — upserts `fan_subscriptions`.
    Branches out *before* the platform-plan guard, which requires `metadata.plan`
    that a pledge does not have.
  - platform plans — `subscriptions`, `profiles.plan`, `reset_ai_credits`,
    founding status.
  - one-off payments — AI and brief credit packs.
- `customer.subscription.updated` / `.deleted`
  - **pledges** branch out first, so they never touch artist plan tables,
    `set_artist_subscription_status` or founding-rate forfeiture.
  - platform plans — status sync and downgrade on cancel.
- `invoice.payment_failed` — marks the platform subscription `past_due`.

## Pledge upsert

Conflict target is `(fan_id, artist_id)`, **not** `stripe_subscription_id`. A fan
who cancels and resubscribes keeps the same pair but gets a new subscription id;
keying on the id would strand the canceled row where `has_streaming_access` can
still see it, and the fan would keep access after cancelling.

`artist_id` is the auth user id — it FKs `artist_profiles(user_id)`, never
`artist_profiles.id`.

Stripe's subscription statuses are a superset of the `fan_subscriptions` CHECK
constraint, so they are mapped: `incomplete_expired` and `paused` become
`canceled`, `unpaid` becomes `past_due`, anything unrecognised becomes
`incomplete`.

`amount_cents` has a `> 0` CHECK, so it falls back to the live price on the
subscription item when the metadata is missing rather than writing a zero the
constraint would reject.
