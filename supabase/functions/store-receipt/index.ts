import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// What a guest gets instead of an order history. A guest has no account, so after
// Stripe sends them back to the storefront the checkout session id is the only
// handle they hold on their own order — this function turns it into a receipt.
//
// A bag is several orders rows sharing one session id, so the receipt is a list.
//
// The session id is a bearer token, and a weak one: it sits in a URL, in browser
// history, in a referrer. So this returns only what the person who just paid
// already knows — what they bought, what it cost, whether it went through — and
// NEVER the buyer's email or the shipping address. A guessed or shared session id
// must not become a way to read a stranger's home address.
const STRIPE_SECRET = Deno.env.get("STRIPE_STORE_KEY")!;
const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const LIVEMODE = STRIPE_SECRET.startsWith("sk_live_");

// Stripe's own format. Checked before the id reaches the database or Stripe, so a
// junk value costs one regex instead of a round trip.
const SESSION_RE = /^cs_[A-Za-z0-9_]{10,200}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const session_id = typeof body.session_id === "string" ? body.session_id.trim() : "";
    if (!SESSION_RE.test(session_id)) return jsonResponse({ error: "Invalid session id" }, 400);

    const supa = createClient(SUPABASE_URL, SERVICE_KEY);
    // One insert gives every line the same created_at, so id breaks the tie and the
    // receipt lists the bag in a stable order on every reload.
    const { data: rows, error } = await supa.from("orders")
      .select("id, artist_id, product_id, product_name, quantity, amount, currency, variant, status, fulfillment_status, digital_download_url")
      .eq("stripe_session_id", session_id)
      .order("created_at", { ascending: true }).order("id", { ascending: true });
    if (error) throw new Error("Could not load order");
    if (!rows || !rows.length) return jsonResponse({ error: "Order not found" }, 404);

    // The webhook flips the whole bag together, so the lines agree in practice; take
    // "paid" only when every one of them says so.
    let status = rows.every((r) => r.status === "paid") ? "paid" : String(rows[0].status);

    // The webhook is what flips pending -> paid, and it may not have landed yet —
    // Stripe redirects the buyer the instant payment succeeds, often first. Ask
    // Stripe directly so the buyer isn't told "pending" about money already taken.
    if (status === "pending") {
      try {
        const { data: acct } = await supa.from("stripe_accounts")
          .select("stripe_account_id")
          .eq("user_id", rows[0].artist_id).eq("livemode", LIVEMODE).maybeSingle();
        if (acct?.stripe_account_id) {
          // Direct charge: the session lives on the seller's account, not ours.
          const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${session_id}`, {
            headers: {
              "Authorization": `Bearer ${STRIPE_SECRET}`,
              "Stripe-Account": acct.stripe_account_id,
            },
          });
          const s = await res.json();
          if (res.ok && s?.payment_status === "paid") status = "processing";
        }
      } catch (e) {
        // Stripe unreachable: report the order as it stands rather than fail the
        // receipt. The webhook still settles it, and a reload will catch up.
        console.error("[store-receipt] stripe lookup failed:", String((e as Error).message ?? e));
      }
    }

    // Whether a download EXISTS, never where it lives: digital_download_url holds a
    // path inside the private store-digital bucket, and handing that to an
    // unauthenticated caller would publish the seller's own folder name for nothing
    // in return. The guest trades their session id for a short-lived signed URL at
    // store-download, at the moment they click. Only once the money is actually in —
    // "processing" means Stripe says paid but the webhook has not delivered yet, so
    // there is nothing to hand over at that point anyway.
    const paid = status === "paid";
    const items = rows.map((r) => ({
      product_id: r.product_id,
      product_name: r.product_name ?? null,
      quantity: r.quantity,
      amount: r.amount,
      variant: r.variant ?? {},
      fulfillment_status: r.fulfillment_status,
      download_ready: paid && !!r.digital_download_url,
    }));
    // Summed in cents: adding the numerics directly drifts (35.00 + 150.10 and
    // friends), and a receipt that is a cent off is a support ticket.
    const order_total = Math.round(rows.reduce((s, r) => s + Math.round(Number(r.amount || 0) * 100), 0)) / 100;

    const first = rows[0];
    return jsonResponse({
      status,
      currency: first.currency,
      items,
      item_count: items.length,
      order_total,
      // The single-item fields this endpoint has always returned, taken from the
      // first line, so an older client keeps rendering something sensible.
      product_name: first.product_name ?? null,
      quantity: first.quantity,
      amount: first.amount,
      variant: first.variant ?? {},
      fulfillment_status: first.fulfillment_status,
      download_ready: paid && !!first.digital_download_url,
    });
  } catch (err) {
    return jsonResponse({ error: String((err as Error).message ?? err) }, 400);
  }
});
