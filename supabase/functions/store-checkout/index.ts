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

// GUEST CHECKOUT: this function runs with verify_jwt FALSE, so auth is optional.
// A shopper who has never heard of AIAD can buy from a storefront; a signed-in
// buyer still gets their order tied to their account. The only caller the gateway
// guarantees is the anon key, which is not a user — see the bearer handling below.

// Abuse limits. On 2026-09-14 a single account ran ~63 charges across ~63 distinct
// card numbers through this endpoint in under 25 minutes — card testing. Nothing
// here limited them; only Stripe Radar stood in the way. These checks run before
// any Stripe call, so a bad actor never reaches the card network through us.
// Guests get a looser cap than accounts because an IP is shared (an office, a
// campus, a carrier NAT) in a way an account id never is.
const MAX_ORDERS_PER_HOUR   = 5;
const GUEST_ORDERS_PER_HOUR = 8;
const MIN_SECONDS_PER_ITEM  = 60;
const REUSE_SESSION_MINUTES = 30;

// stripe_accounts is keyed (user_id, livemode). The same artist has a different
// acct_ id in test and live, and neither works in the other mode — charging against
// the wrong one fails at the moment a real buyer is paying.
const LIVEMODE = STRIPE_SECRET.startsWith("sk_live_");

const SHIP_COUNTRIES = ["US","CA","GB","AU","NZ","IE","DE","FR","ES","IT","NL","BE","AT","CH","PT","SE","NO","DK","FI","JP"];

// Deliberately strict: this value only ever reaches Stripe as customer_email, and a
// malformed one fails the whole session instead of just being ignored.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// First hop in x-forwarded-for is the client as the edge saw it; the rest is our
// own proxy chain. Spoofable in principle, which is why it is a rate-limit key and
// never an identity.
function clientIp(req: Request): string {
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const ip = xff || (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? "").trim();
  return (ip || "unknown").slice(0, 64);
}

// Fallback cap for guests, used only when the guest_ip query fails — i.e. before
// the migration lands. One isolated instance's memory is weak protection (the next
// request may land elsewhere), but an unmetered path to the card network is worse.
const ipHits = new Map<string, number[]>();
function ipFallbackExceeded(ip: string, nowMs: number): boolean {
  const cutoff = nowMs - 60 * 60 * 1000;
  const hits = (ipHits.get(ip) ?? []).filter((t) => t > cutoff);
  if (hits.length >= GUEST_ORDERS_PER_HOUR) { ipHits.set(ip, hits); return true; }
  hits.push(nowMs);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) if (!v.some((t) => t > cutoff)) ipHits.delete(k);
  }
  return false;
}

async function stripeAPI(path: string, body: URLSearchParams, account?: string) {
  if (!STRIPE_SECRET) throw new Error("STRIPE_STORE_KEY not set");
  const headers: Record<string,string> = { "Authorization": `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" };
  if (account) headers["Stripe-Account"] = account;
  const res = await fetch(`https://api.stripe.com/v1${path}`, { method: "POST", headers, body });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? `Stripe ${res.status}`);
  return data;
}
async function stripeGET(path: string, account?: string) {
  const headers: Record<string,string> = { "Authorization": `Bearer ${STRIPE_SECRET}` };
  if (account) headers["Stripe-Account"] = account;
  const res = await fetch(`https://api.stripe.com/v1${path}`, { headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? `Stripe ${res.status}`);
  return data;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // Auth is optional. The anon key is what an unauthenticated browser sends as its
    // bearer, so it has to be told apart from a real user token — otherwise every
    // guest would look like a failed sign-in. An expired or unreadable user token is
    // treated as a guest too: a lapsed session shouldn't cost the seller a sale.
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    let buyer_id: string | null = null;
    let email = "";
    if (bearer && bearer !== ANON_KEY) {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
      const { data: { user } } = await userClient.auth.getUser();
      if (user) { buyer_id = user.id; email = user.email ?? ""; }
    }
    const guest_ip = buyer_id ? null : clientIp(req);

    const body = await req.json().catch(() => ({}));
    const product_id = body.product_id;
    const quantity = Math.max(1, parseInt(String(body.quantity ?? 1), 10) || 1);
    if (!product_id) throw new Error("product_id required");

    // A guest may hand us an email; if it is well-formed we prefill Stripe with it,
    // and if it is not we send nothing and let Stripe's own page collect one.
    const bodyEmail = typeof body.email === "string" ? body.email.trim().slice(0, 254) : "";
    const guestEmail = (!buyer_id && EMAIL_RE.test(bodyEmail)) ? bodyEmail : "";
    const knownEmail = buyer_id ? email : guestEmail;

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

    // ── Abuse control ──────────────────────────────────────────────
    // Counts every order row regardless of status: an abandoned or failed attempt
    // is exactly what a card tester generates, so those must count toward the cap.
    const nowMs = Date.now();
    const sinceIso = new Date(nowMs - 60 * 60 * 1000).toISOString();
    const COLS = "id, product_id, status, stripe_session_id, created_at";
    let recentRows: any[] = [];

    if (buyer_id) {
      const { data, error } = await supa.from("orders").select(COLS)
        .eq("buyer_id", buyer_id).gte("created_at", sinceIso)
        .order("created_at", { ascending: false });
      if (error) throw new Error("Could not verify recent activity");
      recentRows = data ?? [];
      if (recentRows.length >= MAX_ORDERS_PER_HOUR) {
        return jsonResponse({ error: "Too many checkout attempts. Please try again later." }, 429);
      }
    } else {
      const { data, error } = await supa.from("orders").select(COLS)
        .eq("guest_ip", guest_ip).gte("created_at", sinceIso)
        .order("created_at", { ascending: false });
      if (error) {
        // guest_ip isn't there yet. Hold the line in memory and accept that this
        // guest gets no same-item floor and no session reuse this time around.
        console.error("[store-checkout] guest_ip query failed, using in-process cap:", error.message);
        if (ipFallbackExceeded(guest_ip!, nowMs)) {
          return jsonResponse({ error: "Too many checkout attempts. Please try again later." }, 429);
        }
      } else {
        recentRows = data ?? [];
        if (recentRows.length >= GUEST_ORDERS_PER_HOUR) {
          return jsonResponse({ error: "Too many checkout attempts. Please try again later." }, 429);
        }
      }
    }

    const sameItem = recentRows.filter((o: any) => o.product_id === product_id);
    const lastSameItemMs = sameItem.length ? nowMs - new Date(sameItem[0].created_at).getTime() : Infinity;
    if (lastSameItemMs < MIN_SECONDS_PER_ITEM * 1000) {
      return jsonResponse({ error: "Your previous checkout is still open. Give it a moment." }, 429);
    }

    const { data: p, error: pErr } = await supa.from("products")
      .select("id, artist_id, name, price, currency, product_kind, is_active, inventory, digital_file_url")
      .eq("id", product_id).maybeSingle();
    if (pErr || !p) throw new Error("Product not found");
    if (!p.is_active) throw new Error("Product is not available");
    // Only an account can be the seller, so only a signed-in buyer can be the seller.
    if (buyer_id && p.artist_id === buyer_id) throw new Error("You can't buy your own product");
    const isPhysical = p.product_kind === "physical";
    if (isPhysical && p.inventory != null && Number(p.inventory) < quantity) throw new Error("Out of stock");

    // A digital product with no file would take the buyer's money and deliver
    // nothing. The database now refuses to list one, but never charge for it here
    // either — a listing could predate that rule.
    if (p.product_kind === "digital" && !p.digital_file_url) {
      throw new Error("This download isn't ready yet");
    }

    // Seller must have a payouts-ready connected account IN THIS MODE (direct
    // charges require it). Never fall back to the other mode's row.
    const { data: acct } = await supa.from("stripe_accounts")
      .select("stripe_account_id")
      .eq("user_id", p.artist_id).eq("livemode", LIVEMODE).maybeSingle();
    if (!acct?.stripe_account_id) throw new Error("This artist hasn't set up payouts yet");
    const liveAcct = await stripeGET(`/accounts/${acct.stripe_account_id}`);
    if (!liveAcct.charges_enabled) throw new Error("This artist can't accept payments yet");

    // Hand back the still-open session instead of minting a second one for the
    // same item. A buyer who reloads or retries gets one order row, not twenty.
    const reusable = sameItem.find((o: any) =>
      o.status === "pending" && o.stripe_session_id &&
      (nowMs - new Date(o.created_at).getTime()) < REUSE_SESSION_MINUTES * 60 * 1000);
    if (reusable) {
      try {
        const existing = await stripeGET(`/checkout/sessions/${reusable.stripe_session_id}`, acct.stripe_account_id);
        if (existing?.status === "open" && existing?.url) {
          return jsonResponse({ url: existing.url });
        }
      } catch (_e) {
        // Session expired or unreadable — fall through and create a fresh one.
      }
    }

    const unit = Math.round(Number(p.price) * 100);
    if (!(unit > 0)) throw new Error("Invalid product price");
    const amountCents = unit * quantity;
    const feeCents = Math.round(amountCents * PLATFORM_FEE_PCT);
    const currency = (p.currency || "usd").toLowerCase();

    // A guest has no app to go back to. Send them where they came from — the
    // seller's storefront — so the receipt renders on a page they recognise.
    let returnBase = APP_URL + "/";
    if (!buyer_id) {
      const { data: seller } = await supa.from("profiles")
        .select("username").eq("id", p.artist_id).maybeSingle();
      if (seller?.username) returnBase = `${APP_URL}/store/${encodeURIComponent(seller.username)}`;
    }

    const params = new URLSearchParams({
      mode: "payment",
      success_url: `${returnBase}?store=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${returnBase}?store=canceled`,
      "line_items[0][price_data][currency]": currency,
      "line_items[0][price_data][product_data][name]": String(p.name || "Product"),
      "line_items[0][price_data][unit_amount]": String(unit),
      "line_items[0][quantity]": String(quantity),
      "payment_intent_data[application_fee_amount]": String(feeCents),
      "metadata[kind]": "store_order",
      "metadata[product_id]": String(p.id),
      "metadata[artist_id]": String(p.artist_id),
      "metadata[quantity]": String(quantity),
      "payment_intent_data[metadata][kind]": "store_order",
      "payment_intent_data[metadata][product_id]": String(p.id),
    });
    // Prefill only an address we actually have. Sent empty, Stripe rejects the
    // session; left out, Stripe's page asks for it — which is what a guest needs.
    if (knownEmail) params.set("customer_email", knownEmail);
    if (buyer_id) {
      params.set("metadata[buyer_id]", buyer_id);
      params.set("payment_intent_data[metadata][buyer_id]", buyer_id);
    } else {
      params.set("metadata[guest]", "1");
      params.set("payment_intent_data[metadata][guest]", "1");
    }
    // Attach the chosen variant so the seller sees exactly what was ordered.
    if (variantLabel) params.set("line_items[0][price_data][product_data][description]", variantLabel);
    if (variant.size)  { params.set("metadata[size]",  variant.size);  params.set("payment_intent_data[metadata][size]",  variant.size); }
    if (variant.color) { params.set("metadata[color]", variant.color); params.set("payment_intent_data[metadata][color]", variant.color); }
    if (isPhysical) {
      SHIP_COUNTRIES.forEach((c, i) => params.set(`shipping_address_collection[allowed_countries][${i}]`, c));
    }

    // Direct charge ON the connected account.
    const session = await stripeAPI("/checkout/sessions", params, acct.stripe_account_id);

    const order = {
      buyer_id, artist_id: p.artist_id, product_id: p.id, product_name: p.name, quantity, variant,
      amount: amountCents / 100, platform_fee: feeCents / 100, artist_earnings: (amountCents - feeCents) / 100,
      currency, status: "pending", fulfillment_status: isPhysical ? "unfulfilled" : "n/a",
      stripe_session_id: session.id,
    };
    const guestCols = buyer_id ? {} : { guest_email: guestEmail || null, guest_ip };
    const { error: insErr } = await supa.from("orders").insert({ ...order, ...guestCols });
    if (insErr) {
      // The card is already about to be charged. If the guest columns are what the
      // insert choked on, keep the order and lose the trail — a paid session with no
      // order row is an undeliverable sale the webhook can't fix.
      console.error("[store-checkout] order insert failed:", insErr.message);
      if (!buyer_id) {
        const { error: retryErr } = await supa.from("orders").insert(order);
        if (retryErr) console.error("[store-checkout] retry without guest columns failed:", retryErr.message);
      }
    }

    return jsonResponse({ url: session.url });
  } catch (err) {
    return jsonResponse({ error: String((err as Error).message ?? err) }, 400);
  }
});
