// Short-lived diagnostic. Reports which FAL video endpoints exist and what their
// schemas say, so the tier ladder is built against real slugs rather than guesses.
//
// It never generates a clip: it POSTs an empty body, which a live endpoint rejects
// with 422 (validation) and a nonexistent one rejects with 404/405. That tells us
// existence for free. FAL_KEY stays server-side; nothing here echoes it.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FAL_KEY = Deno.env.get("FAL_KEY") ?? "";
const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const CANDIDATES = [
    "fal-ai/ltx-video",
    "fal-ai/ltx-video-13b-distilled",
    "fal-ai/ltxv-13b-098-distilled",
    "fal-ai/wan-t2v",
    "fal-ai/wan/v2.2-a14b/text-to-video",
    "fal-ai/wan/v2.2-5b/text-to-video",
    "fal-ai/kling-video/v1/standard/text-to-video",
    "fal-ai/kling-video/v1.6/standard/text-to-video",
    "fal-ai/kling-video/v2/master/text-to-video",
    "fal-ai/kling-video/v2.1/master/text-to-video",
    "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
    "fal-ai/minimax/hailuo-02/standard/text-to-video",
    "fal-ai/minimax/hailuo-02/pro/text-to-video",
    "fal-ai/veo2",
    "fal-ai/veo3",
    "fal-ai/veo3/fast",
    "fal-ai/pika/v2/text-to-video",
    "fal-ai/hunyuan-video",
    "fal-ai/mochi-v1",
    "fal-ai/luma-dream-machine",
    "fal-ai/cogvideox-5b",
    "fal-ai/seedance/v1/lite/text-to-video",
    "fal-ai/seedance/v1/pro/text-to-video",
];

async function probe(slug: string) {
    try {
        // Empty body: a real endpoint fails validation (422) and often names the
        // fields it wanted, which is exactly the schema information we need.
        const r = await fetch(`https://fal.run/${slug}`, {
            method: "POST",
            headers: { "Authorization": `Key ${FAL_KEY}`, "Content-Type": "application/json" },
            body: "{}",
        });
        let detail: unknown = null;
        try { detail = await r.json(); } catch { detail = await r.text().catch(() => null); }
        return {
            slug,
            status: r.status,
            exists: r.status === 422 || r.status === 400,
            // 422 bodies list the missing/invalid fields — that is where duration
            // and resolution options show up.
            detail: JSON.stringify(detail).slice(0, 900),
        };
    } catch (e) {
        return { slug, status: 0, exists: false, detail: `threw: ${String(e)}` };
    }
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    try {
        if (!FAL_KEY) return json({ error: "FAL_KEY not set" }, 500);
        // Deliberately takes no input: the candidate list is fixed in source, and the
        // only request this function can ever send FAL is an empty body. It cannot be
        // steered into generating anything, so it costs nothing if called by anyone.
        // Short-lived diagnostic — closed off again as soon as the ladder is chosen.
        const results = [];
        for (const slug of CANDIDATES) results.push(await probe(slug));
        return json({ probed: results.length, results });
    } catch (e) {
        return json({ error: String((e as Error)?.message ?? e) }, 500);
    }
});
