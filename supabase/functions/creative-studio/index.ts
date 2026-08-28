// Creative Studio tools. Authenticated and metered SERVER-SIDE.
//
// This function used to run with verify_jwt:false and no auth check of its own,
// which made the Anthropic and FAL keys reachable by anyone with the URL. Worse,
// the credit charge lived in the browser, so calling this endpoint directly cost
// nothing at all. A client-side charge is not a charge.
//
// Now: the caller's JWT is verified here and the user id comes from the token, never
// from the body. The credit is spent BEFORE the provider is called, and refunded if
// the provider fails, so a failed generation is free but a successful one is always
// paid for.
//
// verify_jwt is also on at the platform level, but that alone is not enough: the
// anon key is itself a valid JWT and would satisfy it. getUser() below is the check
// that actually distinguishes a signed-in user from anyone holding the public key.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const FAL_KEY = Deno.env.get("FAL_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const TEXT_MODELS: Record<string, string> = {
    "sonnet": "claude-sonnet-4-5",
    "opus": "claude-opus-4-8",
    "haiku": "claude-haiku-4-5-20251001",
};
const IMAGE_MODELS: Record<string, string> = {
    "nano": "fal-ai/nano-banana",
    "nano-pro": "fal-ai/nano-banana-pro",
    "flux": "fal-ai/flux/dev",
};
function textModel(m?: string) { return (m && TEXT_MODELS[m]) ? TEXT_MODELS[m] : "claude-sonnet-4-5"; }
function imageModel(m?: string) { return (m && IMAGE_MODELS[m]) ? IMAGE_MODELS[m] : "fal-ai/nano-banana"; }

// Every tool this function serves, and whether it bills as text or as an image.
// An unknown tool is rejected before anything is spent or called.
const TOOL_KIND: Record<string, "text" | "image"> = {
    songwriting: "text",
    merch: "text",
    mixmedia: "image",
    coverart: "image",
    fashion_design: "image",
    fashion_moodboard: "image",
    fashion_techpack: "text",
    fashion_palette: "text",
    fashion_trends: "text",
};

// Charge for the model actually used, not a flat rate per tool: opus costs 5 where
// sonnet costs 1, and nano-pro costs 6 where nano costs 3. These action names are
// the ones public.ai_cost_for() understands.
function actionFor(tool: string, model?: string): string {
    if (TOOL_KIND[tool] === "image") {
        return model === "nano-pro" ? "image_nano_pro" : "image";
    }
    return model === "opus" ? "text_opus" : "text_sonnet";
}

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

async function claude(model: string, system: string, user: string, max: number) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: max || 1200, system, messages: [{ role: "user", content: user }] }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error((d && d.error && d.error.message) || ("claude " + r.status));
    return (d.content && d.content[0] && d.content[0].text) || "";
}

async function falImage(model: string, prompt: string) {
    const r = await fetch(`https://fal.run/${model}`, {
        method: "POST",
        headers: { "Authorization": `Key ${FAL_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, num_images: 1 }),
    });
    const d = await r.json();
    const url = (d && d.images && d.images[0] && d.images[0].url) || (d && d.image && d.image.url) || null;
    return { url, err: url ? null : ((d && (d.detail || d.error || (d.error && d.error.message))) || "Image generation failed") };
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

    if (!SUPABASE_URL || !SERVICE_KEY) {
        console.error("[creative-studio] missing SUPABASE_URL or SERVICE_ROLE_KEY");
        return json({ error: "server misconfigured" }, 500);
    }
    const supa = createClient(SUPABASE_URL, SERVICE_KEY);

    // ── Identity comes from the token, never from the body ──────────────────
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
    const { data: ud, error: ue } = await supa.auth.getUser(auth.slice(7));
    if (ue || !ud?.user) return json({ error: "unauthorized" }, 401);
    const userId = ud.user.id;

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

    const { tool, prompt, artistName, genre, style, model } = body ?? {};
    if (!tool || !TOOL_KIND[tool]) return json({ error: "Unknown tool" }, 400);

    const brand = body.brand || artistName || "an independent designer";
    const focus = body.focus || genre || "ready-to-wear";
    const season = body.season || "the current season";

    if (TOOL_KIND[tool] === "image" && !FAL_KEY) return json({ result: null, tool, error: "FAL_KEY not set" }, 500);

    // ── Charge first ────────────────────────────────────────────────────────
    const action = actionFor(tool, model);
    const { data: remaining, error: spendErr } = await supa.rpc("spend_ai_credit", {
        p_user: userId, p_action: action,
    });
    if (spendErr) {
        console.error("[creative-studio] spend_ai_credit failed:", spendErr.message);
        return json({ error: `could not charge credits: ${spendErr.message}` }, 500);
    }
    if (remaining === -1) {
        return json({ error: "insufficient_credits", tool, action, remaining: 0 }, 402);
    }

    // Any failure past this point must hand the credit back — the artist got nothing.
    const refund = async (why: string) => {
        const { error } = await supa.rpc("refund_ai_credit", { p_user: userId, p_action: action });
        if (error) console.error("[creative-studio] REFUND FAILED", userId, action, why, error.message);
    };

    try {
        let out: { result: string | null; error?: string };

        if (tool === "songwriting") {
            const result = await claude(textModel(model), `You are a professional songwriter and creative director writing for ${artistName || "an independent artist"} in the ${genre || "music"} genre. Style: ${style || "authentic, emotional, original"}. When asked for lyrics, hooks, or song concepts, deliver complete, polished, ready-to-use creative content. Label sections clearly (Verse 1, Chorus, Bridge, etc).`, prompt, 1500);
            out = { result: result || null };
        } else if (tool === "merch") {
            const result = await claude(textModel(model), `You are a merch and brand strategist for independent music artists. You help ${artistName || "artists"} (genre: ${genre || "music"}) design and conceptualize merchandise that resonates with their fanbase. Provide specific product ideas, design concepts, color palettes, and compelling product descriptions ready for a print-on-demand store.`, prompt, 1000);
            out = { result: result || null };
        } else if (tool === "mixmedia") {
            const r = await falImage(imageModel(model), `Photorealistic product mockup of a ${prompt}. Professional studio product photography, realistic material and fabric texture, soft lighting, clean neutral background, high detail. Merchandise for music artist ${artistName || "independent artist"}.`);
            out = { result: r.url, error: r.err ?? undefined };
        } else if (tool === "coverart") {
            const r = await falImage(imageModel(model), `Album cover art, square 1:1 composition. ${prompt}. Striking, professional, high detail, cinematic lighting, evocative of the music's mood. Absolutely no text, no words, no letters, no typography.`);
            out = { result: r.url, error: r.err ?? undefined };
        } else if (tool === "fashion_design") {
            const r = await falImage(imageModel(model), `High-fashion editorial photograph. ${prompt}. ${style ? ("Aesthetic: " + style + ". ") : ""}Designed by ${brand}, ${focus}. Full look on a model or detailed garment shot, professional fashion lookbook photography, realistic fabric texture, drape and construction, editorial studio lighting, clean background, high detail, vogue-quality. No text, no watermark, no logo.`);
            out = { result: r.url, error: r.err ?? undefined };
        } else if (tool === "fashion_moodboard") {
            const r = await falImage(imageModel(model), `Fashion mood board collage for a ${focus} collection concept: ${prompt}. ${style ? ("Aesthetic: " + style + ". ") : ""}A curated grid of fabric swatches, color palette, textures, silhouette references and material studies, editorial art direction, cohesive tones, designer studio flat-lay photography, high detail. No text.`);
            out = { result: r.url, error: r.err ?? undefined };
        } else if (tool === "fashion_techpack") {
            const result = await claude(textModel(model), `You are a senior technical designer and production manager for fashion brands. You produce clear, factory-ready tech pack specifications for ${brand} (${focus}). For the described garment, output a structured tech pack with these sections: GARMENT OVERVIEW, MATERIALS & FABRICATION (fabric, weight/GSM, composition), COLORWAYS, MEASUREMENTS & POINTS OF MEASURE (key POMs with sample sizing), CONSTRUCTION & STITCHING, TRIMS & HARDWARE, LABELING & PACKAGING, and SUGGESTED MOQ & TARGET COST RANGE. Be specific and realistic. Use clear headers and concise bullet-style lines.`, prompt, 1600);
            out = { result: result || null };
        } else if (tool === "fashion_palette") {
            const result = await claude(textModel(model), `You are a color and materials expert / trend forecaster for fashion collections. For ${brand} (${focus}), given the collection concept, deliver: (1) a COLOR PALETTE of 6-8 colors with descriptive names AND their closest Pantone TCX references and hex codes, (2) recommended FABRICS & MATERIALS with weights and why they suit the concept, (3) suggested MILLS / SOURCING directions and typical MOQs, and (4) a short note on how the palette reads for ${season}. Be concrete and usable.`, prompt, 1300);
            out = { result: result || null };
        } else {
            const result = await claude(textModel(model), `You are a fashion trend forecaster (think WGSN/Pantone-level analysis) advising ${brand}, a ${focus} label. Produce a sharp, actionable trend report for ${season}. Cover: KEY SILHOUETTES & SHAPES, COLOR DIRECTION, FABRICS & TEXTURES, PRINTS & GRAPHICS, EMERGING THEMES/MOOD, and 3 CONCRETE MOVES this designer should make to ride these trends (product, drop timing, positioning). Ground it in what is realistically current. Use clear headers and tight bullet lines.`, prompt || `Give me the trend report for ${brand}.`, 1500);
            out = { result: result || null };
        }

        // A provider that answers 200 with nothing is still a failure to the artist.
        if (!out.result) {
            await refund("empty result");
            return json({ result: null, tool, error: out.error || "Generation returned nothing. Try again.", refunded: true }, 502);
        }

        return json({ result: out.result, tool, action, remaining });
    } catch (e) {
        await refund(String((e as Error)?.message ?? e));
        return json({ error: String((e as Error)?.message ?? e), tool, refunded: true }, 500);
    }
});
