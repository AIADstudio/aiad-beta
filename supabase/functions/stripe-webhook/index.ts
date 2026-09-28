import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET  = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const SUPABASE_URL   = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Accept either a single secret or a comma-separated list, so test-mode and
// live-mode endpoints (which have different signing secrets) can share this
// function, and so secret rotation doesn't take the endpoint down.
const WEBHOOK_SECRETS = [
    Deno.env.get("STRIPE_WEBHOOK_SECRET"),
    Deno.env.get("STRIPE_WEBHOOK_SECRET_TEST"),
]
    .filter((s): s is string => !!s && s.trim().length > 0)
    .flatMap((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

const TOLERANCE_SECONDS = 300;
const enc = new TextEncoder();

function timingSafeEqualHex(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return mismatch === 0;
}

/**
 * Verifies a Stripe-Signature header.
 * Never throws -- returns a reason string instead, so the caller can always
 * produce an HTTP response. A thrown error here is what took the endpoint
 * down previously: Stripe saw no response at all, not a 4xx.
 */
async function verifyStripeSig(
    payload: string,
    header: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
        if (!header) return { ok: false, reason: "missing stripe-signature header" };
        if (WEBHOOK_SECRETS.length === 0) {
            return { ok: false, reason: "no webhook signing secret configured" };
        }

        let ts = "";
        const v1: string[] = [];
        for (const part of header.split(",")) {
            const idx = part.indexOf("=");
            if (idx === -1) continue;
            const k = part.slice(0, idx).trim();
            const v = part.slice(idx + 1).trim();
            if (k === "t") ts = v;
            else if (k === "v1") v1.push(v); // rotation can send several
        }
        if (!ts || v1.length === 0) return { ok: false, reason: "malformed signature header" };

        const tsNum = Number(ts);
        if (!Number.isFinite(tsNum)) return { ok: false, reason: "bad timestamp" };
        const age = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
        if (age > TOLERANCE_SECONDS) {
            return { ok: false, reason: `timestamp outside tolerance (${age}s)` };
        }

        for (const secret of WEBHOOK_SECRETS) {
            const key = await crypto.subtle.importKey(
                "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
            );
            const macBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${payload}`));
            const hex = Array.from(new Uint8Array(macBuf))
                .map((b) => b.toString(16).padStart(2, "0")).join("");
            for (const candidate of v1) {
                if (timingSafeEqualHex(hex, candidate)) return { ok: true };
            }
        }
        return { ok: false, reason: "signature mismatch" };
    } catch (err) {
        return { ok: false, reason: `verification threw: ${String(err)}` };
    }
}

async function stripeGET(path: string) {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
        headers: { "Authorization": `Bearer ${STRIPE_SECRET}` },
    });
    if (!res.ok) throw new Error(`stripe GET ${path} -> ${res.status}`);
    return res.json();
}

function pickPeriodEnd(sub: any) {
    const u = sub?.current_period_end
        ?? sub?.items?.data?.[0]?.current_period_end
        ?? sub?.billing_cycle_anchor;
    return (typeof u === "number") ? new Date(u * 1000).toISOString() : null;
}

// ── Pledges (fan → artist) ──────────────────────────────────────────
// Stripe's subscription statuses are a superset of the CHECK constraint on
// fan_subscriptions, so they are mapped rather than passed through.
const PLEDGE_STATUS: Record<string, string> = {
    incomplete: "incomplete",
    incomplete_expired: "canceled",
    trialing: "trialing",
    active: "active",
    past_due: "past_due",
    canceled: "canceled",
    unpaid: "past_due",
    paused: "canceled",
};
function pledgeStatus(s: string): string {
    return PLEDGE_STATUS[s] ?? "incomplete";
}

function periodOf(sub: any) {
    const item = sub?.items?.data?.[0];
    const s = sub?.current_period_start ?? item?.current_period_start;
    const e = sub?.current_period_end ?? item?.current_period_end;
    return {
        start: typeof s === "number" ? new Date(s * 1000).toISOString() : null,
        end: typeof e === "number" ? new Date(e * 1000).toISOString() : null,
    };
}

/* Writes the pledge row. Keyed on (fan_id, artist_id), NOT on
   stripe_subscription_id: a fan who cancels and resubscribes keeps the same pair
   but gets a brand new subscription id, and upserting on the id would leave the
   stale canceled row behind and let has_streaming_access see two answers. */
async function upsertPledge(supa: any, sub: any): Promise<boolean> {
    const m = sub?.metadata ?? {};
    if (m.kind !== "pledge") return false;
    if (!m.fan_id || !m.artist_id) {
        console.error("[stripe-webhook] pledge without fan_id/artist_id", sub?.id);
        return false;
    }

    // amount_cents has a > 0 CHECK, so fall back to the live price rather than
    // writing a zero that the constraint would reject.
    let amount = parseInt(m.amount_cents ?? "", 10);
    if (!Number.isFinite(amount) || amount <= 0) {
        amount = Number(sub?.items?.data?.[0]?.price?.unit_amount ?? 0);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`pledge ${sub?.id}: could not resolve amount_cents`);
    }

    const p = periodOf(sub);
    const { error } = await supa.from("fan_subscriptions").upsert({
        fan_id: m.fan_id,
        artist_id: m.artist_id,               // auth user id — FKs artist_profiles(user_id)
        tier: m.tier,
        amount_cents: amount,
        billing_interval: m.billing_interval ?? "month",
        status: pledgeStatus(String(sub?.status ?? "")),
        stripe_subscription_id: sub?.id ?? null,
        stripe_customer_id: typeof sub?.customer === "string" ? sub.customer : (sub?.customer?.id ?? null),
        current_period_start: p.start,
        current_period_end: p.end,
        cancel_at_period_end: sub?.cancel_at_period_end ?? false,
        updated_at: new Date().toISOString(),
    }, { onConflict: "fan_id,artist_id" });
    if (error) throw new Error(`fan_subscriptions upsert: ${error.message}`);
    return true;
}

async function handleEvent(event: any) {
    const supa = createClient(SUPABASE_URL, SERVICE_KEY);

    switch (event.type) {
        case "checkout.session.completed": {
            const s = event.data.object;

            // A pledge is not a platform plan: it has no `plan` metadata and must be
            // handled before the guard below drops it.
            if (s.metadata?.kind === "pledge" && s.mode === "subscription" && s.subscription) {
                const sub = await stripeGET(`/subscriptions/${s.subscription}`);
                // The session carries the metadata even if subscription_data did not.
                sub.metadata = { ...(s.metadata ?? {}), ...(sub.metadata ?? {}) };
                await upsertPledge(supa, sub);
                return;
            }

            const user_id = s.metadata?.user_id;
            const plan    = s.metadata?.plan;
            if (!user_id || !plan) return;

            if (s.mode === "subscription" && s.subscription) {
                const sub = await stripeGET(`/subscriptions/${s.subscription}`);
                const interval = s.metadata?.interval
                    ?? sub?.items?.data?.[0]?.price?.recurring?.interval
                    ?? "month";

                const { error: subErr } = await supa.from("subscriptions").upsert({
                    user_id,
                    plan,
                    status:                 sub.status,
                    stripe_customer_id:     s.customer,
                    stripe_subscription_id: sub.id,
                    current_period_end:     pickPeriodEnd(sub),
                    cancel_at_period_end:   sub.cancel_at_period_end ?? false,
                }, { onConflict: "stripe_subscription_id" });
                if (subErr) throw new Error(`subscriptions upsert: ${subErr.message}`);

                const { error: profErr } = await supa.from("profiles")
                    .update({ plan, billing_interval: interval }).eq("id", user_id);
                if (profErr) throw new Error(`profiles update: ${profErr.message}`);

                const { error: credErr } = await supa.rpc("reset_ai_credits", { p_user: user_id, p_plan: plan });
                if (credErr) throw new Error(`reset_ai_credits: ${credErr.message}`);

                // Founding artists: number + trial assigned at checkout creation.
                // Sync the live Stripe status (trialing / active) onto artist_profiles.
                if (String(plan).startsWith("artist_")) {
                    const { error } = await supa.rpc("set_artist_subscription_status", {
                        p_user_id: user_id, p_status: sub.status,
                    });
                    if (error) throw new Error(`set_artist_subscription_status: ${error.message}`);
                }
            } else if (s.mode === "payment") {
                const credits    = parseInt(s.metadata?.credits ?? "0", 10);
                const creditType = s.metadata?.credit_type ?? "brief";

                if (credits > 0 && creditType === "ai") {
                    const { data: row, error: readErr } = await supa
                        .from("ai_credits").select("balance").eq("user_id", user_id).maybeSingle();
                    if (readErr) throw new Error(`ai_credits read: ${readErr.message}`);

                    if (row) {
                        const { error } = await supa.from("ai_credits").update({
                            balance: (row.balance ?? 0) + credits,
                            updated_at: new Date().toISOString(),
                        }).eq("user_id", user_id);
                        if (error) throw new Error(`ai_credits update: ${error.message}`);
                    } else {
                        const { error } = await supa.from("ai_credits").insert({
                            user_id, balance: credits, allowance: 0,
                            period_start: new Date().toISOString(),
                        });
                        if (error) throw new Error(`ai_credits insert: ${error.message}`);
                    }
                } else if (credits > 0) {
                    const { data: row, error: readErr } = await supa
                        .from("brief_credits")
                        .select("balance,lifetime_purchased")
                        .eq("user_id", user_id)
                        .maybeSingle();
                    if (readErr) throw new Error(`brief_credits read: ${readErr.message}`);

                    if (row) {
                        const { error } = await supa.from("brief_credits").update({
                            balance:            row.balance + credits,
                            lifetime_purchased: row.lifetime_purchased + credits,
                        }).eq("user_id", user_id);
                        if (error) throw new Error(`brief_credits update: ${error.message}`);
                    } else {
                        const { error } = await supa.from("brief_credits").insert({
                            user_id, balance: credits, lifetime_purchased: credits,
                        });
                        if (error) throw new Error(`brief_credits insert: ${error.message}`);
                    }

                    const { error } = await supa.from("brief_credit_transactions").insert({
                        user_id, delta: credits, reason: "purchase",
                        stripe_payment_intent_id: s.payment_intent,
                    });
                    if (error) throw new Error(`brief_credit_transactions insert: ${error.message}`);
                }
            }
            return;
        }

        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
            const sub = event.data.object;

            // Pledges live in fan_subscriptions and must not touch the artist plan
            // tables below, so they branch out before any of that runs.
            if (sub?.metadata?.kind === "pledge") {
                if (event.type === "customer.subscription.deleted") sub.status = "canceled";
                await upsertPledge(supa, sub);
                return;
            }

            const { error: updErr } = await supa.from("subscriptions").update({
                status:               sub.status,
                current_period_end:   pickPeriodEnd(sub),
                cancel_at_period_end: sub.cancel_at_period_end ?? false,
            }).eq("stripe_subscription_id", sub.id);
            if (updErr) throw new Error(`subscriptions update: ${updErr.message}`);

            let uid: string | undefined = sub.metadata?.user_id;
            if (!uid) {
                const { data: subRow, error } = await supa.from("subscriptions")
                    .select("user_id").eq("stripe_subscription_id", sub.id).maybeSingle();
                if (error) throw new Error(`subscriptions lookup: ${error.message}`);
                uid = subRow?.user_id;
            }
            if (!uid) return;

            const { error: statusErr } = await supa.rpc("set_artist_subscription_status", {
                p_user_id: uid, p_status: sub.status,
            });
            if (statusErr) throw new Error(`set_artist_subscription_status: ${statusErr.message}`);

            const ended = event.type === "customer.subscription.deleted" || sub.status === "canceled";
            if (ended) {
                // Downgrade plan and forfeit the founding rate (keeps the permanent
                // founding_number, but the 30%-off-forever entitlement is revoked).
                const { error: e1 } = await supa.from("profiles")
                    .update({ plan: "free", billing_interval: null }).eq("id", uid);
                if (e1) throw new Error(`profiles downgrade: ${e1.message}`);

                const { error: e2 } = await supa.rpc("reset_ai_credits", { p_user: uid, p_plan: "free" });
                if (e2) throw new Error(`reset_ai_credits: ${e2.message}`);

                const { error: e3 } = await supa.rpc("forfeit_founding_rate", { p_user_id: uid });
                if (e3) throw new Error(`forfeit_founding_rate: ${e3.message}`);
            }
            return;
        }

        case "invoice.payment_failed": {
            const inv = event.data.object;
            if (inv.subscription) {
                const { error } = await supa.from("subscriptions")
                    .update({ status: "past_due" }).eq("stripe_subscription_id", inv.subscription);
                if (error) throw new Error(`subscriptions past_due: ${error.message}`);
            }
            return;
        }

        default:
            // Unhandled event types are fine -- acknowledge and move on.
            return;
    }
}

serve(async (req) => {
    // Nothing below may throw uncaught: an unhandled throw means Stripe gets no
    // HTTP response at all, which it reports as "other errors" and which
    // eventually disables the endpoint.
    try {
        if (req.method !== "POST") {
            return new Response("method not allowed", { status: 405 });
        }

        let payload: string;
        try {
            payload = await req.text();
        } catch (err) {
            console.error("[stripe-webhook] could not read body:", String(err));
            return new Response("could not read body", { status: 400 });
        }

        const sigHeader = req.headers.get("stripe-signature") ?? "";
        const verified  = await verifyStripeSig(payload, sigHeader);
        if (!verified.ok) {
            console.error("[stripe-webhook] signature rejected:", verified.reason);
            return new Response(`signature rejected: ${verified.reason}`, { status: 400 });
        }

        let event: any;
        try {
            event = JSON.parse(payload);
        } catch (err) {
            console.error("[stripe-webhook] bad JSON:", String(err));
            return new Response("invalid json", { status: 400 });
        }

        if (!SUPABASE_URL || !SERVICE_KEY) {
            console.error("[stripe-webhook] missing SUPABASE_URL or SERVICE_ROLE_KEY");
            return new Response("server misconfigured", { status: 500 });
        }

        try {
            await handleEvent(event);
        } catch (err) {
            // 500 so Stripe retries -- the event is valid, our handling failed.
            console.error("[stripe-webhook] handler failed", event?.type, String(err));
            return new Response("handler error", { status: 500 });
        }

        return new Response("ok", { status: 200 });
    } catch (err) {
        console.error("[stripe-webhook] unexpected:", String(err));
        return new Response("unexpected error", { status: 500 });
    }
});
