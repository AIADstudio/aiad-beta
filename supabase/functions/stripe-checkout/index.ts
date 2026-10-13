import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY")!;
const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── Founding-artist launch (playbook) ────────────────────────────────────
//  First 100 artists to check out = the founding cohort. Each gets:
//    • a permanent founding_number (assigned in signup order, 1..100)
//    • a 30-day free trial
//    • the founding coupon: 20% off monthly or 30% off yearly, 12 months
//  Artist tiers are priced by real Stripe price IDs ($29 / $59 / $99).
//  Once the 100 spots are gone, artists pay standard price, no trial/coupon.
//
//  Collaborator / Supervisor / credit plans are UNCHANGED from before.
const TRIAL_DAYS = 60;              // collaborator / supervisor trial (unchanged)
const FOUNDING_ARTIST_CAP = 100;   // collaborator trial gate (unchanged)
const SONG_LIBRARY_CAP = 100;      // supervisor trial gate (unchanged)
const FOUNDER_EMAIL = "founder@aiad.studio";
const ARTIST_TRIAL_DAYS = 30;      // founding-artist trial

function normalizeAppUrl(raw: string | undefined): string {
    let u = (raw ?? "").trim();
    if (!u) u = "https://www.aiad.studio";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    u = u.replace(/\/+$/, "");
    try { new URL(u); } catch { u = "https://www.aiad.studio"; }
    return u;
}
// Accept APP_URL (original) or SITE_URL (go-live playbook), whichever is set.
const APP_URL = normalizeAppUrl(Deno.env.get("APP_URL") ?? Deno.env.get("SITE_URL"));

const CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PLANS: Record<string, { name: string; amount: number; recurring: boolean }> = {
    artist_starter:      { name: "AIAD Artist · Starter",       amount:  2900, recurring: true  },
    artist_pro:          { name: "AIAD Artist · Pro",           amount:  5900, recurring: true  },
    artist_premier:      { name: "AIAD Artist · Premier",       amount:  9900, recurring: true  },
    collaborator:        { name: "AIAD Collaborator",           amount:  1900, recurring: true  },
    supervisor_standard: { name: "AIAD Music Supervisor · Std", amount:  7900, recurring: true  },
    supervisor_pro:      { name: "AIAD Music Supervisor · Pro", amount: 14900, recurring: true  },
    brief_credits_5:     { name: "5 Brief Credits",             amount: 12500, recurring: false },
    brief_credits_10:    { name: "10 Brief Credits",            amount: 25000, recurring: false },
    brief_credits_25:    { name: "25 Brief Credits",            amount: 62500, recurring: false },
    ai_credits_50:       { name: "50 AI Credits",              amount:   500, recurring: false },
    ai_credits_100:      { name: "100 AI Credits",             amount:   900, recurring: false },
    ai_credits_200:      { name: "200 AI Credits",             amount:  1600, recurring: false },
    ai_credits_500:      { name: "500 AI Credits",             amount:  3500, recurring: false },
};
const CREDIT_PACKS: Record<string, number> = { brief_credits_5: 5, brief_credits_10: 10, brief_credits_25: 25 };
const AI_TOPUP_PACKS: Record<string, number> = { ai_credits_50: 50, ai_credits_100: 100, ai_credits_200: 200, ai_credits_500: 500 };

// Artist tier → Stripe price ID (set as project secrets).
const ARTIST_PRICE_ENV: Record<string, string> = {
    artist_starter: "PRICE_STARTER",
    artist_pro:     "PRICE_PRO",
    artist_premier: "PRICE_PREMIER",
};

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
async function stripeGET(path: string) {
    const res = await fetch(`https://api.stripe.com/v1${path}`, { headers: { "Authorization": `Bearer ${STRIPE_SECRET}` } });
    return { ok: res.ok, data: await res.json() };
}
// ── Founding coupon ──────────────────────────────────────────────────────
// Both coupons are duration=repeating, 12 months. Nothing here may create or
// apply a forever discount. The code this replaces POSTed a fresh 30%/forever
// coupon whenever one was missing, so the discount could not be retired:
// deleting it in Stripe only got it recreated on the next artist checkout.
const FOUNDING_COUPONS: Record<string, { id: string; env: string; percent: string; name: string }> = {
    month: {
        id: "FOUNDING20MONTH", env: "STRIPE_FOUNDING_COUPON_MONTH", percent: "20",
        name: "AIAD Founding Artist — 20% off monthly for 12 months",
    },
    year: {
        id: "FOUNDING30YEAR", env: "STRIPE_FOUNDING_COUPON_YEAR", percent: "30",
        name: "AIAD Founding Artist — 30% off yearly for 12 months",
    },
};

async function resolveFoundingCoupon(interval: string): Promise<string> {
    const spec = FOUNDING_COUPONS[interval === "year" ? "year" : "month"];
    const id = Deno.env.get(spec.env) || spec.id;

    const got = await stripeGET(`/coupons/${encodeURIComponent(id)}`);
    if (got.ok && got.data?.id) {
        // An override pointing at a forever coupon is the thing being removed.
        if (got.data.duration === "forever") {
            throw new Error(`Founding coupon ${id} is duration=forever; refusing to apply it`);
        }
        return got.data.id;
    }

    // stripeAPI throws on any non-2xx, so a failed create fails the checkout.
    const created = await stripeAPI("/coupons", new URLSearchParams({
        id, percent_off: spec.percent, duration: "repeating", duration_in_months: "12",
        name: spec.name,
    }));
    if (!created?.id) throw new Error(`Could not resolve founding coupon ${id}`);
    return created.id;
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    try {
        const { plan, user_id, email, interval } = await req.json();
        const cfg = PLANS[plan];
        if (!cfg) throw new Error(`Unknown plan: ${plan}`);
        if (!user_id) throw new Error("user_id required");

        const supa = createClient(SUPABASE_URL, SERVICE_KEY);

        // Reuse existing Stripe customer if we have one.
        const { data: existing } = await supa
            .from("subscriptions").select("stripe_customer_id")
            .eq("user_id", user_id).not("stripe_customer_id", "is", null)
            .limit(1).maybeSingle();
        let customerId = existing?.stripe_customer_id;
        if (!customerId) {
            const cust = await stripeAPI("/customers", new URLSearchParams({ email: email ?? "", "metadata[user_id]": user_id }));
            customerId = cust.id;
        }

        // ARTIST TIERS — founding cohort, price IDs, 30-day trial, coupon.
        if (plan.startsWith("artist_")) {
            const priceId = Deno.env.get(ARTIST_PRICE_ENV[plan] ?? "");
            if (!priceId) throw new Error(`Artist price not configured: ${ARTIST_PRICE_ENV[plan]}`);

            // Claim a founding spot. is_new => first-time claim (grant trial);
            // rate_active => still entitled to the founding coupon.
            let foundingNumber: number | null = null;
            let isNew = false;
            let rateActive = false;
            const { data: enr } = await supa.rpc("enroll_founding_artist", { p_user_id: user_id });
            const row = Array.isArray(enr) ? enr[0] : enr;
            if (row && row.founding_number) {
                foundingNumber = row.founding_number;
                isNew = !!row.is_new;
                rateActive = !!row.rate_active;
            }
            const founding = foundingNumber != null;

            const params = new URLSearchParams({
                mode:                 "subscription",
                customer:             customerId!,
                success_url:          `${APP_URL}/?billing=success&plan=${plan}`,
                cancel_url:           `${APP_URL}/?billing=canceled`,
                "metadata[user_id]":  user_id,
                "metadata[plan]":     plan,
                "metadata[interval]": "month",
                "line_items[0][price]":    priceId,
                "line_items[0][quantity]": "1",
            });
            params.set("subscription_data[metadata][user_id]", user_id);
            params.set("subscription_data[metadata][plan]",    plan);
            params.set("subscription_data[metadata][interval]", "month");
            if (founding) {
                params.set("metadata[founding]", "true");
                params.set("metadata[founding_number]", String(foundingNumber));
                params.set("subscription_data[metadata][founding]", "true");
                params.set("subscription_data[metadata][founding_number]", String(foundingNumber));
            }
            if (isNew) {
                // Fresh founding member: 30-day free trial.
                params.set("subscription_data[trial_period_days]", String(ARTIST_TRIAL_DAYS));
                params.set("metadata[trial_days]", String(ARTIST_TRIAL_DAYS));
                params.set("subscription_data[metadata][trial_days]", String(ARTIST_TRIAL_DAYS));
            }
            if (rateActive) {
                // Artist tiers check out monthly today, so this asks for
                // FOUNDING20MONTH; the yearly work passes "year" and gets
                // FOUNDING30YEAR. An unresolvable coupon throws out of this
                // handler rather than falling through to full price: a founding
                // artist silently charged list price is a refund and a support
                // ticket, where an error is one retry.
                params.set("discounts[0][coupon]", await resolveFoundingCoupon("month"));
            }

            let session;
            try {
                session = await stripeAPI("/checkout/sessions", params);
            } catch (e) {
                // Only roll back a brand-new claim (returning members keep their number).
                if (isNew) { try { await supa.rpc("unenroll_founding_artist", { p_user_id: user_id }); } catch (_) { /* noop */ } }
                throw e;
            }

            return new Response(JSON.stringify({
                url: session.url, founding: rateActive, founding_number: foundingNumber,
                trial_days: isNew ? ARTIST_TRIAL_DAYS : 0,
            }), { headers: { ...CORS, "Content-Type": "application/json" } });
        }

        // ALL OTHER PLANS — unchanged (collaborator, supervisor, credits).
        const yearly = cfg.recurring && interval === "year";
        const amount = yearly ? cfg.amount * 10 : cfg.amount;
        const intervalLabel = yearly ? "year" : "month";

        // Trial gates (unchanged).
        let trialDays = 0;
        if (plan === "collaborator") {
            const { count: artistCount } = await supa
                .from("profiles").select("id", { count: "exact", head: true })
                .eq("role", "artist").neq("email", FOUNDER_EMAIL);
            if ((artistCount ?? 0) < FOUNDING_ARTIST_CAP) trialDays = TRIAL_DAYS;
        } else if (plan === "supervisor_standard" || plan === "supervisor_pro") {
            const { count: songCount } = await supa
                .from("tracks").select("id", { count: "exact", head: true });
            if ((songCount ?? 0) <= SONG_LIBRARY_CAP) trialDays = TRIAL_DAYS;
        }

        const params = new URLSearchParams({
            mode:                  cfg.recurring ? "subscription" : "payment",
            customer:              customerId!,
            success_url:           `${APP_URL}/?billing=success&plan=${plan}`,
            cancel_url:            `${APP_URL}/?billing=canceled`,
            "metadata[user_id]":   user_id,
            "metadata[plan]":      plan,
            "metadata[interval]":  intervalLabel,
            "line_items[0][price_data][currency]":              "usd",
            "line_items[0][price_data][product_data][name]":    yearly ? `${cfg.name} (Annual)` : cfg.name,
            "line_items[0][price_data][unit_amount]":           String(amount),
            "line_items[0][quantity]":                          "1",
        });
        if (cfg.recurring) {
            params.set("line_items[0][price_data][recurring][interval]", intervalLabel);
            params.set("subscription_data[metadata][user_id]", user_id);
            params.set("subscription_data[metadata][plan]",    plan);
            params.set("subscription_data[metadata][interval]", intervalLabel);
            if (trialDays > 0) {
                params.set("subscription_data[trial_period_days]", String(trialDays));
                params.set("metadata[trial_days]", String(trialDays));
                params.set("subscription_data[metadata][trial_days]", String(trialDays));
            }
        } else {
            const aiPack = AI_TOPUP_PACKS[plan];
            const credits = aiPack ?? CREDIT_PACKS[plan] ?? 0;
            const creditType = aiPack ? "ai" : "brief";
            params.set("metadata[credits]",     String(credits));
            params.set("metadata[credit_type]", creditType);
            params.set("payment_intent_data[metadata][user_id]",     user_id);
            params.set("payment_intent_data[metadata][credits]",     String(credits));
            params.set("payment_intent_data[metadata][credit_type]", creditType);
            params.set("payment_intent_data[metadata][plan]",        plan);
        }

        const session = await stripeAPI("/checkout/sessions", params);
        return new Response(JSON.stringify({ url: session.url, founding: false, trial_days: trialDays }), {
            headers: { ...CORS, "Content-Type": "application/json" },
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: String((err as Error).message ?? err) }), {
            status: 400, headers: { ...CORS, "Content-Type": "application/json" },
        });
    }
});
