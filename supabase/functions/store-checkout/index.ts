import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// DIRECT CHARGES: money charges on the SELLER's connected account; platform takes a
// 10% application fee. Stripe holds the artist's funds and pays them out; the artist
// (not the platform) is liable for refunds/chargebacks.
const STRIPE_SECRET = Deno.env.get("STRIPE_STORE_KEY")!;
const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
const PLATFORM_FEE_PCT = 0.10;

// stripe_accounts is keyed (user_id, livemode). The same artist has a different
// acct_ id in test and live, and neither works in the other mode — charging against
// the wrong one fails at the moment a real buyer is paying.
const LIVEMODE = STRIPE_SECRET.startsWith("sk_live_");

const SHIP_COUNTRIES = ["US","CA","GB","AU","NZ","IE","DE","FR","ES","IT","NL","BE","AT","CH","PT","SE","NO","DK","FI","JP"];

function normalizeAppUrl(raw: string | undefined): string {
  let u = (raw ?? "").trim();
  if (!u) u = "https://www.aiad.studio";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  u = u.replace(/\/+$/, "");
  try { new URL(u); } catch { u = "https://www.aiad.studio"; }
  return u;
}
const APP_URL = normalizeAppUrl(Deno.env.get("APP_URL") ?? Deno.env.get("SITE_URL"));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function stripeAPI(path: string, body: URLSearchParams, account?: string) {
  if (!STRIPE_SECRET) throw new Error("STRIPE_STORE_KEY not set");
  const headers: Record<string,string> = { "Authorization": `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" };
  if (account) headers["Stripe-Account"] = account;
  const res = await fetch(`https://api.stripe.com/v1${path}`, { method: "POST", headers, body });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? `Stripe ${res.status}`);
  return data;
}
async function stripeGET(path: string) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, { headers: { "Authorization": `Bearer ${STRIPE_SECRET}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? `Stripe ${res.status}`);
  return data;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: uErr } = await userClient.auth.getUser();
    if (uErr || !user) throw new Error("Not authenticated");
    const buyer_id = user.id;
    const email = user.email ?? "";

    const body = await req.json().catch(() => ({}));
    const product_id = body.product_id;
    const quantity = Math.max(1, parseInt(String(body.quantity ?? 1), 10) || 1);
    if (!product_id) throw new Error("product_id required");

    // Selected variant (single stock pool — size/color are informational for fulfillment).
    const rawVariant = (body.variant && typeof body.variant === "object") ? body.variant : {};
    const variant: Record<string, string> = {};
    if (rawVariant.size)  variant.size  = String(rawVariant.size).slice(0, 60);
    if (rawVariant.color) variant.color = String(rawVariant.color).slice(0, 60);
    const variantParts: string[] = [];
    if (variant.size)  variantParts.push(`Size: ${variant.size}`);
    if (variant.color) variantParts.push(`Color: ${variant.color}`);
    const variantLabel = variantParts.join("  ·  ");

    const supa = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: p, error: pErr } = await supa.from("products")
      .select("id, artist_id, name, price, currency, product_kind, is_active, inventory")
      .eq("id", product_id).maybeSingle();
    if (pErr || !p) throw new Error("Product not found");
    if (!p.is_active) throw new Error("Product is not available");
    if (p.artist_id === buyer_id) throw new Error("You can't buy your own product");
    const isPhysical = p.product_kind === "physical";
    if (isPhysical && p.inventory != null && Number(p.inventory) < quantity) throw new Error("Out of stock");

    // Seller must have a payouts-ready connected account IN THIS MODE (direct
    // charges require it). Never fall back to the other mode's row.
    const { data: acct } = await supa.from("stripe_accounts")
      .select("stripe_account_id")
      .eq("user_id", p.artist_id).eq("livemode", LIVEMODE).maybeSingle();
    if (!acct?.stripe_account_id) throw new Error("This artist hasn't set up payouts yet");
    const liveAcct = await stripeGET(`/accounts/${acct.stripe_account_id}`);
    if (!liveAcct.charges_enabled) throw new Error("This artist can't accept payments yet");

    const unit = Math.round(Number(p.price) * 100);
    if (!(unit > 0)) throw new Error("Invalid product price");
    const amountCents = unit * quantity;
    const feeCents = Math.round(amountCents * PLATFORM_FEE_PCT);
    const currency = (p.currency || "usd").toLowerCase();

    const params = new URLSearchParams({
      mode: "payment",
      customer_email: email,
      success_url: `${APP_URL}/?store=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_URL}/?store=canceled`,
      "line_items[0][price_data][currency]": currency,
      "line_items[0][price_data][product_data][name]": String(p.name || "Product"),
      "line_items[0][price_data][unit_amount]": String(unit),
      "line_items[0][quantity]": String(quantity),
      "payment_intent_data[application_fee_amount]": String(feeCents),
      "metadata[kind]": "store_order",
      "metadata[product_id]": String(p.id),
      "metadata[artist_id]": String(p.artist_id),
      "metadata[buyer_id]": buyer_id,
      "metadata[quantity]": String(quantity),
      "payment_intent_data[metadata][kind]": "store_order",
      "payment_intent_data[metadata][product_id]": String(p.id),
      "payment_intent_data[metadata][buyer_id]": buyer_id,
    });
    // Attach the chosen variant so the seller sees exactly what was ordered.
    if (variantLabel) params.set("line_items[0][price_data][product_data][description]", variantLabel);
    if (variant.size)  { params.set("metadata[size]",  variant.size);  params.set("payment_intent_data[metadata][size]",  variant.size); }
    if (variant.color) { params.set("metadata[color]", variant.color); params.set("payment_intent_data[metadata][color]", variant.color); }
    if (isPhysical) {
      SHIP_COUNTRIES.forEach((c, i) => params.set(`shipping_address_collection[allowed_countries][${i}]`, c));
    }

    // Direct charge ON the connected account.
    const session = await stripeAPI("/checkout/sessions", params, acct.stripe_account_id);

    await supa.from("orders").insert({
      buyer_id, artist_id: p.artist_id, product_id: p.id, product_name: p.name, quantity, variant,
      amount: amountCents / 100, platform_fee: feeCents / 100, artist_earnings: (amountCents - feeCents) / 100,
      currency, status: "pending", fulfillment_status: isPhysical ? "unfulfilled" : "n/a",
      stripe_session_id: session.id,
    });

    return new Response(JSON.stringify({ url: session.url }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error).message ?? err) }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
