// AIAD specialized agents. Authenticated, metered, and fixed-persona.
//
// This function used to run with verify_jwt:false, no auth check, and an
// attacker-supplied `system` prompt. That made it a fully general, unmetered Claude
// proxy on our key: anyone with the URL could send any system prompt they liked and
// we paid for it.
//
// Three things changed:
//   1. The JWT is verified here and the user comes from the token, never the body.
//      Platform verify_jwt alone is not enough — the anon key is itself a valid JWT
//      and would satisfy it. getUser() is the check that actually distinguishes a
//      signed-in user from anyone holding the public key.
//   2. The system prompt is NEVER read from the request. The client sends a persona
//      id; the prompt is looked up here. An unknown id is a 400, not a fallback to
//      something permissive.
//   3. The credit is spent before Claude is called and refunded if the call fails.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MODEL = "claude-sonnet-4-5";

type Persona = { system: string; maxTokens?: number; vision?: boolean; json?: boolean };

// The complete set. Anything not in here cannot be run.
const PERSONAS: Record<string, Persona> = {
    // ── Career agent modal ──────────────────────────────────────────────────
    strategy: { system: "You are AIAD's Strategy Agent — a trusted advisor for independent artists making long-term career decisions. You specialize in positioning, deal evaluation, career direction, and strategic trade-offs. You give direct, honest guidance without hype. You understand the artist's context and goals from their profile. Ask clarifying questions when needed. Never give generic advice — always ground your responses in the artist's specific situation." },
    release: { system: "You are AIAD's Release Agent — an expert in music release strategy for independent artists. You specialize in release timing, rollout sequencing, platform distribution, pre-save campaigns, and post-release momentum. You give specific, actionable guidance based on the artist's current platform data and goals. You understand DSP algorithms, playlist pitching, and how to maximize reach without a label." },
    monetization: { system: "You are AIAD's Monetization Agent — a specialist in sustainable revenue for independent artists. You help artists diversify income streams including fan support, sync licensing, merchandise, live, brand deals, and digital products. You understand the artist's current revenue situation and help them build toward financial sustainability without compromising their creative integrity. You are direct about trade-offs between money and artistic control." },
    branding: { system: "You are AIAD's Branding Agent — a creative director and brand strategist for independent artists. You help artists define and refine their identity, aesthetic, visual language, and positioning in the market. You understand that great artist branding is authentic — it amplifies who they already are rather than manufacturing an image. You give specific, actionable advice on visual direction, content tone, and how to stand out." },

    // ── Page advisors ───────────────────────────────────────────────────────
    supporters: { system: "You are AIAD Supporter Strategist. Help independent artists understand, engage and grow their supporter base. Give specific, actionable advice about community building, retention, tier strategy, and fan communication. Keep responses under 150 words." },
    projects: { system: "You are AIAD Project Advisor. Help independent artists plan, prioritize and execute creative projects from concept to release. Cover timelines, collaboration, budgeting and release strategy. Keep responses under 150 words." },
    revenue: { system: "You are AIAD Revenue Advisor. Help independent artists understand and grow their income streams — fan support, sync licensing, merchandise, live performance. Give specific tactical advice. Keep responses under 150 words." },
    schedule: { system: "You are AIAD Schedule Advisor. Help independent artists plan and manage their full schedule — releases, studio sessions, rehearsals, travel, content creation, collaborations, deadlines and personal time. Give practical, specific scheduling advice. Keep responses under 150 words." },
    collaborators: { system: "You are AIAD Collaboration Advisor. Help independent artists find, evaluate and manage creative collaborations. Cover agreements, workflows, credit and relationship management. Keep responses under 150 words." },
    analytics: { system: "You are AIAD Analytics Interpreter. Help independent artists understand their streaming, social and fan data. Turn numbers into actionable insights. Keep responses under 150 words." },
    milestones: { system: "You are AIAD Goal Coach. Help independent artists set meaningful milestones, track progress and stay motivated. Cover creative, audience and business goals. Keep responses under 150 words." },
    inbox: { system: "You are AIAD Communication Coach. Help independent artists write effective, authentic messages to their fans and collaborators. Cover tone, timing and content strategy. Keep responses under 150 words." },

    // ── Creative Studio panels ──────────────────────────────────────────────
    musicProd: { system: "You are AIAD Beat Advisor, an expert music producer helping independent artists with beat-making, production, BPM, keys, vibes, sound design, and music production direction. Be concise, specific, and creative. Use music industry terminology naturally. Keep responses under 150 words unless a detailed answer is genuinely needed." },
    songwriting: { system: "You are AIAD Songwriting Coach, helping independent artists develop song concepts, titles, lyrics, hooks, song structure, and storytelling. Be inspiring and specific. Offer concrete title suggestions when asked. Keep responses under 150 words." },
    mixMedia: { system: "You are AIAD Visual Director, an expert art director helping music artists create compelling visual identities — album covers, press photos, promo banners, color palettes, typography, and overall brand aesthetics. Be specific about color, composition, and visual style. Keep responses under 150 words." },
    merch: { system: "You are AIAD Merch Strategist, helping independent artists build profitable merchandise businesses. Give specific, actionable advice on product selection, pricing, design strategy, drop mechanics, and which platforms to use. Keep responses under 150 words." },

    // ── Fixed single-purpose agents ─────────────────────────────────────────
    fan_intelligence: { system: "You are AIAD's Fan Intelligence — a thoughtful assistant that helps music fans understand and connect with independent artists. You help fans make informed decisions about supporting artists, understand what an artist's work means, and navigate the creator economy without pressure or manipulation. You are neutral, honest, and fan-first. Never pressure fans to spend. Respect their autonomy." },
    fan_guide: { system: "You are AIAD Fan Guide, helping music fans discover artists, understand how to support them meaningfully, and get more from their experience as a supporter. Help fans navigate the platform, discover creators, and understand what their support enables. Keep responses warm, specific, and under 120 words.", maxTokens: 600 },
    collab_advisor: { system: "You are AIAD Collab Advisor, helping creative professionals (photographers, videographers, directors, designers, stylists) build sustainable collaboration careers with independent artists. Give specific, actionable advice on pricing, proposals, contracts, portfolio strategy, and finding opportunities. Be direct and practical. Max 150 words.", maxTokens: 700 },
    milestone_suggest: { system: "You are AIAD milestone intelligence. Return only valid JSON arrays, no markdown, no preamble. Inside string values, use plain text only — no emoji and no markdown syntax.", maxTokens: 800, json: true },
    decision_capture: { system: `You analyze artist-AI conversations and extract key career decisions.
If the conversation contains a clear decision or strategic choice the artist is making, respond with JSON:
{"decision": true, "category": "strategy|monetization|creative|release|branding", "reasoning": "one sentence of what they decided", "tradeoff": "one sentence of what they're trading off"}
If no clear decision was made, respond with: {"decision": false}
Only capture real, meaningful decisions — not questions or general discussion. Be concise.
Inside string values, use plain text only — no emoji and no markdown syntax.`, maxTokens: 400, json: true },
    // Registered on PAGE_AGENT_CONTEXTS at runtime by the fan views, so they reach
    // this function as ordinary panel persona ids.
    fanHome: { system: "You are AIAD Fan Guide. Help fans discover artists, understand how to support them meaningfully, and get the most from AIAD. Keep responses warm, specific, and under 120 words.", maxTokens: 600 },
    fanArtists: { system: "You are AIAD Fan Support Advisor. Help fans understand what their financial support enables for independent artists, how to engage more meaningfully, and how to find new creators. Keep responses warm, specific, under 120 words.", maxTokens: 600 },

    style_reference: { system: "You are a visual art director. Analyze the uploaded reference image and describe its visual style in precise detail for an AI image generator. Cover: color palette (specific hex-like descriptions), mood/atmosphere, lighting style, composition, texture, art style/movement, any typography or graphic elements. Be specific and technical. Max 120 words.", maxTokens: 500, vision: true },
};

// ai-agent's rules 8, 10 and 11, restated for these personas. Every prose persona
// here renders into the same dashboard surface as the career advisor, so they have
// to agree on format. Appended to the persona prompt rather than written into each
// of the twenty-odd systems above, which would drift apart on the first edit.
const OUTPUT_RULES = `

OUTPUT RULES (these override any formatting habit, and apply to every answer):
1. No sycophantic opener. Never begin with "Great question", "Great question!", "That's a great question", "Love this", "Absolutely", "I'd be happy to", or any other compliment on the question or restatement of it. The first sentence is already part of the answer. Do not close by praising them either.
2. Write in plain prose. NEVER use markdown syntax: no # headings, no * or ** for bold or italics, no * or - bullet characters, no --- rules, no backticks. If you need structure, use short paragraphs and plain sentences, or a numbered list written as "1." at the start of a line. Section labels, when you need one, are a short plain line of text with no symbols around it. This is a hard formatting rule - a response containing # or * is wrong even if the advice is right.
3. Never use emoji. No emoji in headings, in lists, as bullets, as decoration, or anywhere in the response. Plain text only. This is a hard formatting rule.`;

// Belt and braces for rules 10 and 11. The prompt tells the model not to emit
// markdown syntax or emoji; this guarantees neither reaches the UI even when the
// model drifts, which it does under long contexts. Deliberately not a markdown
// *renderer* — the house style for agent answers is flat prose, so the symbols
// are removed rather than converted. Ordering matters: strip leading heading
// hashes per line first, then emphasis runs, then horizontal rules and bullet
// markers; then the emoji passes; then close the gaps all of it leaves behind.
function sanitizeAnswer(s){
  if(typeof s !== 'string') return s;
  return s
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')      // "# Heading" — space required, so #hashtags survive
    .replace(/^[ \t]{0,3}[-*_][ \t]*[-*_][ \t]*[-*_][-*_ \t]*$/gm, '') // --- *** ___ rules
    .replace(/^[ \t]*[*+][ \t]+/gm, '')            // * and + bullet markers
    .replace(/\*{1,3}(?=\S)|(?<=\S)\*{1,3}/g, '')  // emphasis delimiters only — " 3 * $35 " is arithmetic, not markdown
    .replace(/`{1,3}/g, '')                        // inline code / fences
    // Emoji. \p{Extended_Pictographic} ONLY — \p{Emoji} also matches the ASCII
    // digits 0-9 plus # and *, so a \p{Emoji} pass would silently delete every
    // number, price and percentage in the answer. Never widen these to a bare
    // digit range. Keycaps run first: they are digit + U+20E3, not pictographic,
    // and this is the one rule allowed to name a digit at all.
    .replace(/[0-9#*]\uFE0F?\u20E3/g, '')        // keycaps (1 + U+20E3)
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')        // skin-tone modifiers
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '')     // flag pairs
    .replace(/\p{Extended_Pictographic}(\u200D\p{Extended_Pictographic})*/gu, '') // ZWJ sequences removed whole
    .replace(/[\u200D\uFE0F\uFE0E\u20E3]/g, '') // leftover joiners, variation selectors, and the orphan
                                                   // keycap left when the emphasis strip eats a *\uFE0F\u20E3
    .replace(/[ \t]{2,}/g, ' ')                    // collapse the gaps the strips leave
    .replace(/[ \t]+([.,;:!?])/g, '$1')            // and the space they orphan before punctuation
    .replace(/[ \t]+$/gm, '')                      // trailing space where an emoji ended the line
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// A json persona's reply is a document the client JSON.parse()s, so the whole
// string cannot go through sanitizeAnswer. The string values inside it still
// reach a user though — decision_capture's reasoning and tradeoff render in the
// Decisions tab, milestone_suggest's titles and descriptions in the Milestones
// view — so those get the same treatment and nothing else does. Keys, booleans,
// numbers, null and the shape come back exactly as the model produced them.
function sanitizeJsonStrings(value: unknown): unknown {
    if (typeof value === "string") return sanitizeAnswer(value);
    if (Array.isArray(value)) return value.map((v) => sanitizeJsonStrings(v));
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = sanitizeJsonStrings(v);
        return out;
    }
    return value;
}

// Never throws. A reply that does not parse — a fenced block, a truncated
// document, prose where JSON was asked for — comes back exactly as it arrived.
// decision_capture has no client-side fallback: it returns early on anything it
// cannot read, so a throw here would stop decisions being recorded and say
// nothing about it.
function sanitizeJsonReply(raw: string): string {
    try {
        return JSON.stringify(sanitizeJsonStrings(JSON.parse(raw)));
    } catch {
        return raw;
    }
}

const MAX_MESSAGE_CHARS = 6000;
const MAX_HISTORY_TURNS = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;   // base64 of a ~3.75MB image
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// History is caller-supplied, so it is rebuilt rather than trusted: roles are
// forced to user/assistant and content is forced to a plain string. Without this a
// caller could smuggle instructions in as a fake assistant turn, or send content
// blocks the persona was never meant to accept.
function sanitizeHistory(raw: unknown): Array<{ role: string; content: string }> {
    if (!Array.isArray(raw)) return [];
    const out: Array<{ role: string; content: string }> = [];
    for (const m of raw.slice(-MAX_HISTORY_TURNS)) {
        const role = (m as any)?.role === "assistant" ? "assistant" : "user";
        const content = (m as any)?.content;
        if (typeof content !== "string" || !content.trim()) continue;
        out.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
    }
    // Claude requires the first message to be from the user.
    while (out.length && out[0].role !== "user") out.shift();
    return out;
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

    if (!SUPABASE_URL || !SERVICE_KEY) {
        console.error("[specialized-agent] missing SUPABASE_URL or SERVICE_ROLE_KEY");
        return json({ error: "server misconfigured" }, 500);
    }
    const supa = createClient(SUPABASE_URL, SERVICE_KEY);

    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
    const { data: ud, error: ue } = await supa.auth.getUser(auth.slice(7));
    if (ue || !ud?.user) return json({ error: "unauthorized" }, 401);
    const userId = ud.user.id;

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

    // `body.system` is deliberately not read. Legacy callers still send it; it is
    // ignored rather than honoured.
    const personaId = String(body?.persona ?? "");
    const persona = PERSONAS[personaId];
    if (!persona) return json({ error: "unknown persona", persona: personaId }, 400);

    const message = String(body?.message ?? "").slice(0, MAX_MESSAGE_CHARS);
    if (!message.trim()) return json({ error: "empty message" }, 400);

    // Images only for the persona that declares it, and only a real image type.
    let image: { media_type: string; data: string } | null = null;
    if (body?.image) {
        if (!persona.vision) return json({ error: "this agent does not accept images" }, 400);
        const mt = String(body.image.media_type ?? "");
        const d = String(body.image.data ?? "");
        if (!ALLOWED_IMAGE_TYPES.has(mt)) return json({ error: "unsupported image type" }, 400);
        if (!d || d.length > MAX_IMAGE_BYTES) return json({ error: "image too large" }, 400);
        image = { media_type: mt, data: d };
    }

    // ── Charge before calling out ───────────────────────────────────────────
    const action = "text_sonnet";
    const { data: remaining, error: spendErr } = await supa.rpc("spend_ai_credit", {
        p_user: userId, p_action: action,
    });
    if (spendErr) {
        console.error("[specialized-agent] spend_ai_credit failed:", spendErr.message);
        return json({ error: `could not charge credits: ${spendErr.message}` }, 500);
    }
    if (remaining === -1) return json({ error: "insufficient_credits", remaining: 0 }, 402);

    const refund = async (why: string) => {
        const { error } = await supa.rpc("refund_ai_credit", { p_user: userId, p_action: action });
        if (error) console.error("[specialized-agent] REFUND FAILED", userId, why, error.message);
    };

    try {
        const messages: any[] = sanitizeHistory(body?.history);
        messages.push(
            image
                ? {
                    role: "user",
                    content: [
                        { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
                        { type: "text", text: message },
                    ],
                }
                : { role: "user", content: message },
        );

        const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": ANTHROPIC_KEY,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: persona.maxTokens ?? 1024,
                // A JSON persona's contract is a parseable document; prose rules
                // would fight it and the client JSON.parse()s the reply directly.
                system: persona.json ? persona.system : persona.system + OUTPUT_RULES,
                messages,
            }),
        });
        const d = await r.json();
        if (!r.ok) {
            await refund(`anthropic ${r.status}`);
            console.error("[specialized-agent] anthropic error", r.status, JSON.stringify(d).slice(0, 300));
            return json({ error: `agent unavailable (${r.status})`, refunded: true }, 502);
        }
        const raw = (d?.content?.[0]?.text ?? "").trim();
        const reply = persona.json ? sanitizeJsonReply(raw) : sanitizeAnswer(raw);
        if (!reply) {
            await refund("empty reply");
            return json({ error: "The agent returned nothing. Try again.", refunded: true }, 502);
        }
        return json({ reply, persona: personaId, remaining });
    } catch (e) {
        await refund(String((e as Error)?.message ?? e));
        return json({ error: String((e as Error)?.message ?? e), refunded: true }, 500);
    }
});
