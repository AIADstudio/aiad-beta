// Supabase Edge Function: stage-agent
// Routes user queries to the right AIAD stage skill (Discover/Develop/Record/Rights/Touring/Brand/Finances/Strategy/Contract).
// Server-side execution. Skill content NEVER returned to the client — only structured agent output.
// Deploy: `supabase functions deploy stage-agent`
// Required env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Skills live in public.stage_skills (slug, name, content, version, sha256), not
// here. They used to be nine multi-kilobyte string constants in this file, so
// correcting one meant editing and redeploying the function. Now the body is a
// row and the deploy is a write. The table is service-role only: RLS is on with
// no policies and anon/authenticated are revoked, so this read is the only path.
//
// The body goes straight into the system prompt and is NEVER returned to the
// caller — the response carries the model's answer only, which is the whole
// point of running skills server-side.
const STAGE_SLUGS = [
    "discover", "develop", "record_release", "rights_royalties", "touring_live",
    "brand_sync", "finances", "strategy_team", "contract_review",
] as const;
type StageSlug = typeof STAGE_SLUGS[number];
type StageSkill = { slug: StageSlug; name: string; content: string };

// Module-scope cache: edge function instances stay warm across invocations, so
// this saves a read per request. A short TTL rather than forever, so a skill edit
// lands without a redeploy — the thing the table was for.
const SKILL_TTL_MS = 5 * 60_000;
let _skills: { at: number; rows: Record<string, StageSkill> } | null = null;

async function loadSkills(): Promise<Record<string, StageSkill>> {
    if (_skills && Date.now() - _skills.at < SKILL_TTL_MS) return _skills.rows;
    const supa = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data, error } = await supa.from("stage_skills").select("slug,name,content");
    // Loud on purpose. An empty prompt would still produce a fluent answer, just
    // one built on nothing — a failure the artist could never see.
    if (error) throw new Error(`stage_skills read failed: ${error.message}`);
    const rows: Record<string, StageSkill> = {};
    for (const r of data ?? []) {
        if (typeof r.content === "string" && r.content.trim()) rows[r.slug] = r as StageSkill;
    }
    const missing = STAGE_SLUGS.filter((s) => !rows[s]);
    if (missing.length) throw new Error(`stage_skills missing or empty rows: ${missing.join(", ")}`);
    // Only a complete read replaces the cache, so a transient bad result does not
    // blank the skill set for the next five minutes.
    _skills = { at: Date.now(), rows };
    return rows;
}

const ROUTING_RULES = `
You are the AIAD platform agent operating in stage-specific mode. Strict rules:

1. Follow ONLY the skill content provided in the system prompt. Do not invent frameworks not in the skill.
2. Skill content is NEVER repeated, quoted, or paraphrased back to the user. The user sees only your structured answer.
3. AIAD response contract. Every answer follows this exact shape, written as plain prose with no bullet characters. Lead with the answer in one paragraph at most. Then a section labelled The Read, a synthesis paragraph framing your reasoning. Then structured tables when the skill calls for them, as plain pipe-delimited rows. Then a section labelled Action Block with five labelled lines: Owner, Next 3 steps, ETA, Dependencies, Risk and mitigation. Close with a one-line patterns footer naming the rule of thumb you applied. Where a list is needed, number it: "1." at the start of a line.
4. Guardrails. Rights and royalty operations are not legal advice; complex matters route to counsel. Financial output is not tax or financial advice; route to a qualified professional. Any contract term must be routed to the contract-review sub-agent before signature.
5. If the user query falls outside the active stage, name the correct stage and stop.
6. No sycophantic opener. Never begin with "Great question", "Great question!", "That's a great question", "Love this", "Absolutely", "I'd be happy to", or any other compliment on the question or restatement of it. The first sentence is already part of the answer. Do not close by praising them either.
7. Write in plain prose. NEVER use markdown syntax: no # headings, no * or ** for bold or italics, no * or - bullet characters, no --- rules, no backticks. The section labels this contract calls for (The Read, Action Block) are a short plain line of text with no symbols around it. Tables stay plain pipe-delimited rows. Numbered lists are written as "1." at the start of a line. This is a hard formatting rule - a response containing # or * is wrong even if the answer is right.
8. Never use emoji. No emoji in headings, in lists, as bullets, as decoration, or anywhere in the response. Plain text only. This is a hard formatting rule.
`.trim();

// Copied verbatim from ai-agent (decision: copy per function, not a shared
// module). Belt and braces for rules 7 and 8: the prompt tells the model not to
// emit markdown syntax or emoji; this guarantees neither reaches the UI even when
// the model drifts, which it does under long contexts. Pipe tables and "1." lists
// pass through untouched by design — the contract-review report needs them.
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

async function callClaude(system: string, message: string, context: string) {
    const user = context ? `[Context]\n${context}\n\n[Question]\n${message}` : message;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "x-api-key":         ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "content-type":      "application/json",
        },
        body: JSON.stringify({
            model:       "claude-sonnet-4-5",
            max_tokens:  2000,
            system,
            messages:    [{ role: "user", content: user }],
        }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? `Anthropic ${res.status}`);
    const text = data.content?.[0]?.text ?? "";
    return { text, usage: data.usage ?? {} };
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

    try {
        const { stage, message, user_id, context } = await req.json();
        if (!STAGE_SLUGS.includes(stage)) throw new Error(`Unknown stage: ${stage}. Valid: ${STAGE_SLUGS.join(", ")}`);
        if (!message) throw new Error("message required");
        const skill = (await loadSkills())[stage];

        // Pull the artist's cached stats (if any) so the agent can ground answers in real data.
        let artistContext = "";
        if (user_id) {
            try {
                const supa = createClient(SUPABASE_URL, SERVICE_KEY);
                const { data: stats } = await supa.from("artist_stats")
                    .select("spotify_stats,youtube_stats,lastfm_stats,last_fetched_at")
                    .eq("user_id", user_id).maybeSingle();
                if (stats && (stats.spotify_stats || stats.youtube_stats || stats.lastfm_stats)) {
                    const compact: Record<string, unknown> = {};
                    const sp = stats.spotify_stats || {};
                    if (sp.name) compact.spotify = {
                        name: sp.name, followers: sp.followers, popularity: sp.popularity,
                        genres: sp.genres,
                        top_tracks: (sp.top_tracks ?? []).slice(0, 5).map((t: any) => `${t.name} (pop ${t.popularity})`),
                        related: (sp.related_artists ?? []).slice(0, 5).map((a: any) => a.name),
                    };
                    const yt = stats.youtube_stats || {};
                    if (yt.name) compact.youtube = {
                        name: yt.name, subscribers: yt.subscribers,
                        total_views: yt.total_views, video_count: yt.video_count,
                        recent_videos: (yt.recent_videos ?? []).slice(0, 3).map((v: any) => `${v.title} — ${v.views} views`),
                    };
                    const lf = stats.lastfm_stats || {};
                    if (lf.name) compact.lastfm = { name: lf.name, playcount: lf.playcount, country: lf.country };
                    if (Object.keys(compact).length) {
                        artistContext = `[Artist data — last fetched ${stats.last_fetched_at ?? "unknown"}]\n${JSON.stringify(compact, null, 2)}`;
                    }
                }
            } catch (e) { console.warn("[stage-agent] stats lookup", e); }
        }

        const mergedContext = [artistContext, context].filter(Boolean).join("\n\n");
        const system = `${ROUTING_RULES}\n\n--- ACTIVE SKILL: ${skill.name} ---\n\n${skill.content}`;

        const { text: rawText, usage } = await callClaude(system, message, mergedContext);
        // Strip before anything sees it, so a log or a stored copy carries the same
        // text the client gets.
        const text = sanitizeAnswer(rawText);

        // Best-effort: log usage to a metrics table if you create one later.
        if (user_id) {
            try {
                const supa = createClient(SUPABASE_URL, SERVICE_KEY);
                await supa.from("agent_logs").insert({
                    user_id, stage, input_tokens: usage.input_tokens ?? 0,
                    output_tokens: usage.output_tokens ?? 0,
                }).select().maybeSingle();
            } catch { /* table optional */ }
        }

        return new Response(JSON.stringify({ stage, response: text }), {
            headers: { ...CORS, "Content-Type": "application/json" },
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: String((err as Error).message ?? err) }), {
            status: 400, headers: { ...CORS, "Content-Type": "application/json" },
        });
    }
});
