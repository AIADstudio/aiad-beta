import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// What a guest gets instead of an order history. A guest has no account, so after
// Stripe sends them back to the storefront the checkout session id is the only
// handle they hold on their own order — this function turns it into a receipt.
//
// That makes the session id a bearer token, and it is a weak one: it sits in a URL,
// in browser history, in a referrer. So this returns only what the person who just
// paid already knows — what they bought, what it cost, whether it went through —
// and NEVER the buyer's email or the shipping address. A guessed or shared session
// id must not become a way to read a stranger's home address.
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
    const { data: ord, error } = await supa.from("orders")
      .select("id, artist_id, product_name, quantity, amount, currency, variant, status, fulfillment_status, digital_download_url")
      .eq("stripe_session_id", session_id).maybeSingle();
    if (error) throw new Error("Could not load order");
    if (!ord) return jsonResponse({ error: "Order not found" }, 404);

    // The webhook is what flips pending -> paid, and it may not have landed yet —
    // Stripe redirects the buyer the instant payment succeeds, often first. Ask
    // Stripe directly so the buyer isn't told "pending" about money already taken.
    let status = String(ord.status);
    if (status === "pending") {
      try {
        const { data: acct } = await supa.from("stripe_accounts")
          .select("stripe_account_id")
          .eq("user_id", ord.artist_id).eq("livemode", LIVEMODE).maybeSingle();
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

    // digital_download_url only once the money is actually in. "processing" means
    // Stripe says paid but the webhook hasn't delivered yet — there is nothing to
    // hand over at that point anyway.
    const paid = status === "paid";
    return jsonResponse({
      status,
      product_name: ord.product_name ?? null,
      quantity: ord.quantity,
      amount: ord.amount,
      currency: ord.currency,
      variant: ord.variant ?? {},
      fulfillment_status: ord.fulfillment_status,
      download_url: paid ? (ord.digital_download_url ?? null) : null,
    });
  } catch (err) {
    return jsonResponse({ error: String((err as Error).message ?? err) }, 400);
  }
});
