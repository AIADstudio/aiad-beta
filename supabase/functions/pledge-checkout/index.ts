// Pledge checkout — a fan subscribing to an artist.
//
// The client sends an artist id, a tier name and an interval. Nothing else is
// believed: the amount comes from the table below, and the fan comes from the JWT.
// An `amount` in the request body is ignored outright.
//
// verify_jwt is on at the platform level, but that alone proves nothing here: the
// anon key is itself a valid JWT and satisfies it. getUser() is the check that
// distinguishes a signed-in fan from anyone holding the public key. This has bitten
// this codebase twice already.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function normalizeAppUrl(raw: string | undefined): string {
    let u = (raw ?? "").trim();
    if (!u) u = "https://www.aiad.studio";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    u = u.replace(/\/+$/, "");
    try { new URL(u); } catch { u = "https://www.aiad.studio"; }
    return u;
}
const APP_URL = normalizeAppUrl(Deno.env.get("APP_URL") ?? Deno.env.get("SITE_URL"));

// The only source of truth for what a pledge costs. Monthly cents; a year is ten
// months, so an annual pledge is two months free rather than a separate price list.
const TIERS: Record<string, { name: string; monthly: number }> = {
    supporter:    { name: "Supporter",    monthly:  500 },
    patron:       { name: "Patron",       monthly: 1000 },
    collector:    { name: "Collector",    monthly: 3000 },
    inner_circle: { name: "Inner Circle", monthly: 6000 },
};
const INTERVALS = new Set(["month", "year"]);
const APPLICATION_FEE_PERCENT = "8";

// Derived from the key in use, so a test-mode run can never pick up a live-mode
// product id or the reverse. stripe_accounts is keyed (user_id, livemode) for the
// same reason: an artist has a different acct_ id in each mode and neither works
// in the other.
const LIVEMODE = STRIPE_SECRET.startsWith("sk_live_");

const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function stripeAPI(path: string, body: URLSearchParams) {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? `Stripe ${res.status}`);
    return data;
}

/* One product per tier, cached in stripe_pledge_products. Created on first use.
   The insert is an upsert so two fans checking out simultaneously cannot end up
   with two products for the same tier — the loser of the race re-reads the winner's
   row rather than overwriting it. */
async function productForTier(supa: any, tier: string): Promise<string> {
    const { data: cached, error: readErr } = await supa
        .from("stripe_pledge_products")
        .select("product_id").eq("tier", tier).eq("livemode", LIVEMODE).maybeSingle();
    if (readErr) throw new Error(`product cache read: ${readErr.message}`);
    if (cached?.product_id) return cached.product_id;

    const product = await stripeAPI("/products", new URLSearchParams({
        name: `AIAD Pledge · ${TIERS[tier].name}`,
        "metadata[tier]": tier,
        "metadata[kind]": "pledge",
    }));

    const { error: insErr } = await supa.from("stripe_pledge_products")
        .upsert({ tier, livemode: LIVEMODE, product_id: product.id }, { onConflict: "tier,livemode" });
    if (insErr) {
        // The row is what matters, not who wrote it. Re-read before giving up.
        const { data: again } = await supa.from("stripe_pledge_products")
            .select("product_id").eq("tier", tier).eq("livemode", LIVEMODE).maybeSingle();
        if (again?.product_id) return again.product_id;
        throw new Error(`product cache write: ${insErr.message}`);
    }
    return product.id;
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    try {
        if (!STRIPE_SECRET) return json({ error: "server misconfigured" }, 500);
        if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "server misconfigured" }, 500);
        const supa = createClient(SUPABASE_URL, SERVICE_KEY);

        // ── the fan is whoever the token says, never whoever the body says ──
        const auth = req.headers.get("Authorization") ?? "";
        if (!auth.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
        const { data: ud, error: ue } = await supa.auth.getUser(auth.slice(7));
        if (ue || !ud?.user) return json({ error: "unauthorized" }, 401);
        const fanId = ud.user.id;
        const fanEmail = ud.user.email ?? "";

        let body: any;
        try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

        const artistId = String(body?.artist_id ?? "");
        const tier = String(body?.tier ?? "");
        const interval = String(body?.billing_interval ?? "month");

        if (!artistId) return json({ error: "artist_id required" }, 400);
        if (!TIERS[tier]) return json({ error: `unknown tier: ${tier}` }, 400);
        if (!INTERVALS.has(interval)) return json({ error: `unknown billing_interval: ${interval}` }, 400);
        if (artistId === fanId) return json({ error: "You cannot pledge to yourself." }, 400);

        // Resolved here, never read from the request. body.amount is ignored.
        const amount = interval === "year" ? TIERS[tier].monthly * 10 : TIERS[tier].monthly;

        // ── the artist must actually be able to receive money, IN THIS MODE ──
        const { data: acct, error: acctErr } = await supa
            .from("stripe_accounts")
            .select("stripe_account_id, payouts_enabled, onboarding_complete")
            .eq("user_id", artistId).eq("livemode", LIVEMODE).maybeSingle();
        if (acctErr) return json({ error: `account lookup: ${acctErr.message}` }, 500);

        // A structured refusal, not a raw Stripe error: no artist has completed
        // Connect onboarding yet, so this is the expected path today and the UI has
        // to be able to say something useful about it. Never falls back to the other
        // mode's row — that acct_ id is invisible to this key.
        if (!acct || !acct.stripe_account_id || !acct.payouts_enabled) {
            const { data: ap } = await supa.from("artist_profiles")
                .select("artist_name").eq("user_id", artistId).maybeSingle();
            return json({
                error: "artist_not_payable",
                reason: !acct || !acct.stripe_account_id ? "no_connect_account" : "payouts_disabled",
                artist_name: ap?.artist_name ?? null,
                message: (ap?.artist_name ?? "This artist") +
                    " isn't set up to receive payments yet. We'll let them know you tried to pledge.",
            }, 409);
        }

        /* The account rows are written by connect-onboard, which authenticates with
           STRIPE_STORE_KEY, while this function charges with STRIPE_SECRET_KEY. If
           those are different Stripe platforms (or somehow different modes), the
           destination is invisible here and Stripe answers "No such account" at the
           moment a fan is paying. Check it up front and refuse cleanly instead. */
        const acctRes = await fetch(`https://api.stripe.com/v1/accounts/${acct.stripe_account_id}`, {
            headers: { "Authorization": `Bearer ${STRIPE_SECRET}` },
        });
        if (!acctRes.ok) {
            const { data: ap } = await supa.from("artist_profiles")
                .select("artist_name").eq("user_id", artistId).maybeSingle();
            console.error("[pledge-checkout] destination unreachable with the charging key",
                acct.stripe_account_id, "livemode", LIVEMODE, "status", acctRes.status);
            return json({
                error: "artist_not_payable",
                reason: "account_not_visible_to_charging_key",
                artist_name: ap?.artist_name ?? null,
                message: (ap?.artist_name ?? "This artist") +
                    " isn't set up to receive payments yet. We'll let them know you tried to pledge.",
            }, 409);
        }

        const productId = await productForTier(supa, tier);

        // Reuse the fan's Stripe customer across artists so one person is one
        // customer, however many artists they support.
        const { data: existing } = await supa
            .from("fan_subscriptions").select("stripe_customer_id")
            .eq("fan_id", fanId).not("stripe_customer_id", "is", null)
            .limit(1).maybeSingle();
        let customerId: string | undefined = existing?.stripe_customer_id ?? undefined;
        if (!customerId) {
            const cust = await stripeAPI("/customers", new URLSearchParams({
                email: fanEmail, "metadata[user_id]": fanId, "metadata[kind]": "fan",
            }));
            customerId = cust.id;
        }

        const params = new URLSearchParams({
            mode: "subscription",
            customer: customerId!,
            success_url: `${APP_URL}/?pledge=success&artist=${encodeURIComponent(artistId)}`,
            cancel_url: `${APP_URL}/?pledge=canceled`,
            "line_items[0][quantity]": "1",
            // Inline price_data against the cached product: no Price objects to keep
            // in step with the tier table.
            "line_items[0][price_data][currency]": "usd",
            "line_items[0][price_data][product]": productId,
            "line_items[0][price_data][unit_amount]": String(amount),
            "line_items[0][price_data][recurring][interval]": interval,
        });

        // Connect: the artist is paid directly, AIAD keeps 8%.
        params.set("subscription_data[application_fee_percent]", APPLICATION_FEE_PERCENT);
        params.set("subscription_data[transfer_data][destination]", acct.stripe_account_id);

        // The webhook reads these to write fan_subscriptions. They ride on the
        // subscription too, so subscription.updated/deleted can be identified long
        // after the checkout session is gone.
        const meta: Record<string, string> = {
            kind: "pledge",
            fan_id: fanId,
            artist_id: artistId,
            tier,
            billing_interval: interval,
            amount_cents: String(amount),
        };
        for (const [k, v] of Object.entries(meta)) {
            params.set(`metadata[${k}]`, v);
            params.set(`subscription_data[metadata][${k}]`, v);
        }

        const session = await stripeAPI("/checkout/sessions", params);
        return json({ url: session.url, tier, billing_interval: interval, amount_cents: amount });
    } catch (err) {
        console.error("[pledge-checkout]", String((err as Error)?.message ?? err));
        return json({ error: String((err as Error)?.message ?? err) }, 400);
    }
});
