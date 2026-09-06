# `store-checkout` contract

Deployed Supabase edge function, **version 9**, `verify_jwt = true`. It is **not in this
repo** — like `store-download` and `store-balance`, it exists only in the Supabase project.
This document is the contract the client and the shopping agent are written against; if the
deployed function and this file disagree, the function is right and this file is stale.

Called from `index.html` through `invokeMsg('store-checkout', …)` (`buyProduct()`), and by
`store-agent` only as a handoff — see [Agent boundary](#agent-boundary).

## Request

`POST` JSON, with the buyer's JWT (`verify_jwt = true`, so an anonymous call is rejected
before the handler runs).

```json
{ "product_id": "uuid", "quantity": 1, "variant": { "size": "M", "color": "Black" } }
```

| Field | Required | Notes |
|---|---|---|
| `product_id` | yes | `products.id` |
| `quantity` | no | defaults to 1 |
| `variant.size` | no | free text, recorded on the order |
| `variant.color` | no | free text, recorded on the order |

## What the server does

1. Loads `products(id, artist_id, name, price, currency, product_kind, is_active, inventory)`.
2. Refuses, as `400 {"error": …}`:
   - the product is not `is_active`
   - the buyer is the artist (self-purchase)
   - `product_kind = 'physical'` and it is out of stock
3. Requires a `stripe_accounts` row for `(artist_id, livemode)` — where `livemode` is
   `key.startsWith('sk_live_')` — with `charges_enabled` true. No connected account, no sale.
4. Creates a Stripe Checkout Session as a **direct charge on the artist's connected
   account**, with `payment_intent_data.application_fee_amount` set to **10%**. The artist
   is the merchant of record; AIAD takes the platform fee and never holds the balance.
5. Inserts an `orders` row:

   ```
   buyer_id, artist_id, product_id, product_name, quantity, variant,
   amount, platform_fee, artist_earnings, currency,
   status: 'pending',
   fulfillment_status: product_kind === 'physical' ? 'unfulfilled' : 'n/a',
   stripe_session_id
   ```

   `status` moves to `'paid'` in `stripe-webhook`, not here.
6. Returns `{ "url": … }`.

## Redirects

| Outcome | URL |
|---|---|
| Success | `APP_URL/?store=success&session=…` |
| Cancelled | `APP_URL/?store=canceled` |

## Shipping

Ship-to countries: `US CA GB AU NZ IE DE FR ES IT NL BE AT CH PT SE NO DK FI JP`.

## Errors

Every refusal is `400` with `{"error": "<human-readable reason>"}`. `invokeMsg` unwraps that
body, so the string reaches `buyProduct`'s `toast()` as written — these messages are read by
buyers and should stay in plain language.

## Agent boundary

`store-agent` never calls this function with model-supplied arguments and never puts the
returned `url` into model context. The agent proposes a product; the buyer presses the
existing **Buy** button, and `buyProduct()` makes the call. This mirrors the reference
architecture in `anthropics/commerce-agents`, where `checkout` renders the cart for the host
to complete and `checkout_handoff` URLs are attached server-side after the model's turn.

Consequence for anyone extending the agent: adding a "buy it for me" tool would move a
payment behind a model decision. That is a deliberate no.
