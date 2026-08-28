// Retired. This was a short-lived diagnostic used once, on 2026-08-27, to discover
// which FAL video endpoints exist and what duration / resolution / aspect values
// they accept. Its findings are baked into the tier ladder in video-generate.
//
// It is left as a closed stub rather than deleted so the slug cannot be silently
// reused, and so the history of where the tier ladder came from is not lost.
// verify_jwt is on and the body answers nothing, so it has no reachable behaviour.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(() =>
    new Response(
        JSON.stringify({
            error: "gone",
            detail: "fal-probe was a one-off schema diagnostic and is retired.",
        }),
        { status: 410, headers: { "Content-Type": "application/json" } },
    )
);
