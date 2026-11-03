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

// ONE BAG, ONE SELLER. A direct charge happens ON a connected account, and a single
// Checkout Session cannot be split across two of them — so a bag that mixed two
// artists could not be paid for at all. Storefronts are per-artist, so the bag is
// scoped to the store it was filled from and this function refuses anything else.

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
//
// Both caps count CHECKOUTS, not order rows: one bag writes one row per line, so
// counting rows would let a six-item bag trip the guest cap on its own.
const MAX_CHECKOUTS_PER_HOUR   = 5;
const GUEST_CHECKOUTS_PER_HOUR = 8;
const MIN_SECONDS_PER_CHECKOUT = 60;
const REUSE_SESSION_MINUTES    = 30;
const MAX_LINES = 8;

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
  if (hits.length >= GUEST_CHECKOUTS_PER_HOUR) { ipHits.set(ip, hits); return true; }
  hits.push(nowMs);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) if (!v.some((t) => t > cutoff)) ipHits.delete(k);
  }
  return false;
}

type Line = { product_id: string; quantity: number; variant: Record<string, string> };

function readVariant(raw: unknown): Record<string, string> {
  const v: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (r.size)  v.size  = String(r.size).slice(0, 60);
    if (r.color) v.color = String(r.color).slice(0, 60);
  }
  return v;
}
function variantLabel(v: Record<string, string>): string {
  const parts: string[] = [];
  if (v.size)  parts.push(`Size: ${v.size}`);
  if (v.color) parts.push(`Color: ${v.color}`);
  return parts.join("  ·  ");
}
function readQty(raw: unknown): number {
  return Math.max(1, parseInt(String(raw ?? 1), 10) || 1);
}
// A bag is identified by what is in it, so a pending session can only be handed back
// for the SAME bag — never for a different one the buyer has since changed.
function bagKey(rows: { product_id: string; quantity: number }[]): string {
  return rows.map((r) => `${r.product_id}:${r.quantity}`).sort().join("|");
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

    // ── Request shape ──────────────────────────────────────────────
    // Two shapes. { items: [...] } is the bag; { product_id, quantity, variant } is
    // the single product index.html's in-app store view still posts, and it is
    // normalised into a one-line bag so everything below has one path to reason
    // about. Shape is checked before the abuse queries, so a malformed request
    // costs nothing and consumes no allowance.
    let lines: Line[];
    if (Array.isArray(body.items)) {
      if (body.items.length < 1 || body.items.length > MAX_LINES) {
        throw new Error(`A bag holds 1 to ${MAX_LINES} items`);
      }
      lines = body.items.map((it: Record<string, unknown>) => ({
        product_id: String(it?.product_id ?? ""),
        quantity: readQty(it?.quantity),
        variant: readVariant(it?.variant),
      }));
    } else {
      lines = [{
        product_id: String(body.product_id ?? ""),
        quantity: readQty(body.quantity),
        variant: readVariant(body.variant),
      }];
    }
    if (lines.some((l) => !l.product_id)) throw new Error("product_id required");

    // A guest may hand us an email; if it is well-formed we prefill Stripe with it,
    // and if it is not we send nothing and let Stripe's own page collect one.
    const bodyEmail = typeof body.email === "string" ? body.email.trim().slice(0, 254) : "";
    const guestEmail = (!buyer_id && EMAIL_RE.test(bodyEmail)) ? bodyEmail : "";
    const knownEmail = buyer_id ? email : guestEmail;

    const supa = createClient(SUPABASE_URL, SERVICE_KEY);

    // ── Abuse control ──────────────────────────────────────────────
    // Counts every order row regardless of status: an abandoned or failed attempt
    // is exactly what a card tester generates, so those must count toward the cap.
    // Rows are then collapsed to their session, so a bag counts once.
    const nowMs = Date.now();
    const sinceIso = new Date(nowMs - 60 * 60 * 1000).toISOString();
    const COLS = "id, product_id, quantity, status, stripe_session_id, created_at";
    let recentRows: Record<string, unknown>[] = [];

    if (buyer_id) {
      const { data, error } = await supa.from("orders").select(COLS)
        .eq("buyer_id", buyer_id).gte("created_at", sinceIso)
        .order("created_at", { ascending: false });
      if (error) throw new Error("Could not verify recent activity");
      recentRows = data ?? [];
      const checkouts = new Set(recentRows.map((o) => o.stripe_session_id).filter(Boolean));
      if (checkouts.size >= MAX_CHECKOUTS_PER_HOUR) {
        return jsonResponse({ error: "Too many checkout attempts. Please try again later." }, 429);
      }
    } else {
      const { data, error } = await supa.from("orders").select(COLS)
        .eq("guest_ip", guest_ip).gte("created_at", sinceIso)
        .order("created_at", { ascending: false });
      if (error) {
        // guest_ip isn't there yet. Hold the line in memory and accept that this
        // guest gets no same-bag floor and no session reuse this time around.
        console.error("[store-checkout] guest_ip query failed, using in-process cap:", error.message);
        if (ipFallbackExceeded(guest_ip!, nowMs)) {
          return jsonResponse({ error: "Too many checkout attempts. Please try again later." }, 429);
        }
      } else {
        recentRows = data ?? [];
        const checkouts = new Set(recentRows.map((o) => o.stripe_session_id).filter(Boolean));
        if (checkouts.size >= GUEST_CHECKOUTS_PER_HOUR) {
          return jsonResponse({ error: "Too many checkout attempts. Please try again later." }, 429);
        }
      }
    }

    // One checkout a minute, not one per item: a bag writes several rows at once, so
    // a per-item floor would refuse the very bag it just accepted.
    if (recentRows.length) {
      const newest = new Date(String(recentRows[0].created_at)).getTime();
      if (nowMs - newest < MIN_SECONDS_PER_CHECKOUT * 1000) {
        return jsonResponse({ error: "Your previous checkout is still open. Give it a moment." }, 429);
      }
    }

    // ── The bag ────────────────────────────────────────────────────
    const ids = [...new Set(lines.map((l) => l.product_id))];
    const { data: prods, error: pErr } = await supa.from("products")
      .select("id, artist_id, name, price, currency, product_kind, is_active, inventory, digital_file_url")
      .in("id", ids);
    if (pErr) throw new Error("Could not load products");
    const byId = new Map((prods ?? []).map((p) => [String(p.id), p]));
    if (byId.size !== ids.length) throw new Error("Product not found");

    // One Checkout Session charges one connected account, so a mixed bag is not a
    // thing we can price, let alone collect.
    const artistIds = [...new Set((prods ?? []).map((p) => String(p.artist_id)))];
    if (artistIds.length !== 1) throw new Error("One bag holds one store's items — start a separate bag for another artist");
    const artist_id = artistIds[0];
    // Only an account can be the seller, so only a signed-in buyer can be the seller.
    if (buyer_id && artist_id === buyer_id) throw new Error("You can't buy your own product");

    // Stripe prices a session in a single currency.
    const currencies = [...new Set((prods ?? []).map((p) => String(p.currency || "usd").toLowerCase()))];
    if (currencies.length !== 1) throw new Error("Everything in one bag must share a currency");
    const currency = currencies[0];

    // Stock is checked on the TOTAL per product, because two lines can be the same
    // product in different sizes and neither one alone would look short.
    const qtyByProduct = new Map<string, number>();
    for (const l of lines) qtyByProduct.set(l.product_id, (qtyByProduct.get(l.product_id) ?? 0) + l.quantity);
    for (const [pid, qty] of qtyByProduct) {
      const p = byId.get(pid)!;
      if (!p.is_active) throw new Error(`${p.name} is no longer available`);
      if (p.product_kind === "physical" && p.inventory != null && Number(p.inventory) < qty) {
        throw new Error(`${p.name} doesn't have that many left`);
      }
      // A digital product with no file would take the buyer's money and deliver
      // nothing. The database now refuses to list one, but never charge for it here
      // either — a listing could predate that rule.
      if (p.product_kind === "digital" && !p.digital_file_url) {
        throw new Error(`${p.name} isn't ready to download yet`);
      }
    }

    // One file is one file: a digital line is clamped to a single copy rather than
    // billing a buyer twice for the same download. The storefront caps it too.
    const priced = lines.map((l) => {
      const p = byId.get(l.product_id)!;
      const unit = Math.round(Number(p.price) * 100);
      if (!(unit > 0)) throw new Error("Invalid product price");
      const quantity = p.product_kind === "digital" ? 1 : l.quantity;
      return { ...l, p, unit, quantity, cents: unit * quantity };
    });
    const cartCents = priced.reduce((s, x) => s + x.cents, 0);
    const feeTotal = Math.round(cartCents * PLATFORM_FEE_PCT);

    // Split the platform fee across the lines in proportion to their value, with the
    // rounding remainder landing on the last line, so the per-row fees add up to
    // exactly the fee Stripe is told to take — not a cent more or less.
    let allocated = 0;
    const fees = priced.map((x, i) => {
      if (i === priced.length - 1) return feeTotal - allocated;
      const f = Math.floor((feeTotal * x.cents) / cartCents);
      allocated += f;
      return f;
    });

    // Seller must have a payouts-ready connected account IN THIS MODE (direct
    // charges require it). Never fall back to the other mode's row. Checked once —
    // the whole bag is one seller by now.
    const { data: acct } = await supa.from("stripe_accounts")
      .select("stripe_account_id")
      .eq("user_id", artist_id).eq("livemode", LIVEMODE).maybeSingle();
    if (!acct?.stripe_account_id) throw new Error("This artist hasn't set up payouts yet");
    const liveAcct = await stripeGET(`/accounts/${acct.stripe_account_id}`);
    if (!liveAcct.charges_enabled) throw new Error("This artist can't accept payments yet");

    // Hand back the still-open session instead of minting a second one for the same
    // bag. A buyer who reloads or retries gets one set of order rows, not twenty.
    // Matched on bag contents: a session for a bag they have since edited is not a
    // session they should be sent back to.
    const wantKey = bagKey(priced.map((x) => ({ product_id: x.product_id, quantity: x.quantity })));
    const bySession = new Map<string, { product_id: string; quantity: number }[]>();
    for (const o of recentRows) {
      const sid = o.stripe_session_id ? String(o.stripe_session_id) : "";
      if (!sid || o.status !== "pending") continue;
      if ((nowMs - new Date(String(o.created_at)).getTime()) >= REUSE_SESSION_MINUTES * 60 * 1000) continue;
      const arr = bySession.get(sid) ?? [];
      arr.push({ product_id: String(o.product_id), quantity: Number(o.quantity) });
      bySession.set(sid, arr);
    }
    for (const [sid, rows] of bySession) {
      if (bagKey(rows) !== wantKey) continue;
      try {
        const existing = await stripeGET(`/checkout/sessions/${sid}`, acct.stripe_account_id);
        if (existing?.status === "open" && existing?.url) return jsonResponse({ url: existing.url });
      } catch (_e) {
        // Session expired or unreadable — fall through and create a fresh one.
      }
      break;
    }

    // A guest has no app to go back to. Send them where they came from — the
    // seller's storefront — so the receipt renders on a page they recognise.
    let returnBase = APP_URL + "/";
    if (!buyer_id) {
      const { data: seller } = await supa.from("profiles")
        .select("username").eq("id", artist_id).maybeSingle();
      if (seller?.username) returnBase = `${APP_URL}/store/${encodeURIComponent(seller.username)}`;
    }

    const anyPhysical = priced.some((x) => x.p.product_kind === "physical");
    const params = new URLSearchParams({
      mode: "payment",
      success_url: `${returnBase}?store=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${returnBase}?store=canceled`,
      "payment_intent_data[application_fee_amount]": String(feeTotal),
      "metadata[kind]": "store_order",
      "metadata[artist_id]": artist_id,
      "metadata[item_count]": String(priced.length),
      "payment_intent_data[metadata][kind]": "store_order",
      "payment_intent_data[metadata][item_count]": String(priced.length),
    });

    // One line_item per bag line, each carrying its own variant so the seller sees
    // exactly what was ordered without opening anything else.
    priced.forEach((x, i) => {
      params.set(`line_items[${i}][price_data][currency]`, currency);
      params.set(`line_items[${i}][price_data][product_data][name]`, String(x.p.name || "Product"));
      params.set(`line_items[${i}][price_data][unit_amount]`, String(x.unit));
      params.set(`line_items[${i}][quantity]`, String(x.quantity));
      const label = variantLabel(x.variant);
      if (label) params.set(`line_items[${i}][price_data][product_data][description]`, label);
    });

    // Stripe caps a metadata value at 500 characters.
    const idList = priced.map((x) => x.product_id).join(",").slice(0, 500);
    params.set("metadata[product_ids]", idList);
    // A one-line bag keeps the metadata the single-product sessions have always
    // carried, so nothing reading a Stripe dashboard loses what it used to see.
    if (priced.length === 1) {
      const only = priced[0];
      params.set("metadata[product_id]", only.product_id);
      params.set("metadata[quantity]", String(only.quantity));
      params.set("payment_intent_data[metadata][product_id]", only.product_id);
      if (only.variant.size)  { params.set("metadata[size]",  only.variant.size);  params.set("payment_intent_data[metadata][size]",  only.variant.size); }
      if (only.variant.color) { params.set("metadata[color]", only.variant.color); params.set("payment_intent_data[metadata][color]", only.variant.color); }
    }
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
    if (anyPhysical) {
      SHIP_COUNTRIES.forEach((c, i) => params.set(`shipping_address_collection[allowed_countries][${i}]`, c));
    }

    // Direct charge ON the connected account.
    const session = await stripeAPI("/checkout/sessions", params, acct.stripe_account_id);

    // One row per line, all sharing this session id — that shared id is how the
    // webhook, the receipt and the download all find the bag again.
    const rows = priced.map((x, i) => ({
      buyer_id, artist_id, product_id: x.product_id, product_name: x.p.name,
      quantity: x.quantity, variant: x.variant,
      amount: x.cents / 100,
      platform_fee: fees[i] / 100,
      artist_earnings: (x.cents - fees[i]) / 100,
      currency, status: "pending",
      fulfillment_status: x.p.product_kind === "physical" ? "unfulfilled" : "n/a",
      stripe_session_id: session.id,
    }));
    const guestCols = buyer_id ? {} : { guest_email: guestEmail || null, guest_ip };
    const { error: insErr } = await supa.from("orders").insert(rows.map((r) => ({ ...r, ...guestCols })));
    if (insErr) {
      // The card is already about to be charged. If the guest columns are what the
      // insert choked on, keep the order and lose the trail — a paid session with no
      // order rows is an undeliverable sale the webhook can't fix.
      console.error("[store-checkout] order insert failed:", insErr.message);
      if (!buyer_id) {
        const { error: retryErr } = await supa.from("orders").insert(rows);
        if (retryErr) console.error("[store-checkout] retry without guest columns failed:", retryErr.message);
      }
    }

    return jsonResponse({ url: session.url });
  } catch (err) {
    return jsonResponse({ error: String((err as Error).message ?? err) }, 400);
  }
});
