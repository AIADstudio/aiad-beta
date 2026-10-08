// Supabase Edge Function: live-session
//
// Cloudflare Stream live inputs for the streaming vertical's Live view.
//
// The whole reason this runs server-side: creating a live input returns an
// ingest URL and a stream key, and a stream key is a WRITE credential — anyone
// holding it can broadcast as this creator. It is written to
// public.live_session_secrets, which has RLS on with zero policies and no grant
// to anon or authenticated, so only the service role can read it.
//
// Exactly ONE action returns it: `get_ingest`, and only to the owner of that
// session, because the creator has to put it into OBS. The service role does
// the read; the caller's JWT is used only to establish who they are, and the
// grants on live_session_secrets are never widened. Every other action returns
// the session id and the playback URL and nothing else. If you are adding an
// action, that is the rule to keep.
//
// verify_jwt stays TRUE. Every action is scoped to the caller: the row is read
// and written with `.eq('user_id', uid)` as well as by id, so the service role
// bypassing RLS cannot be turned into "any signed-in user can end any stream".
//
// Required env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   CF_ACCOUNT_ID       Cloudflare account id
//   CF_STREAM_TOKEN     API token with Stream:Edit on that account
// Optional env:
//   CF_CUSTOMER_SUBDOMAIN   e.g. "customer-abc123" — only needed for the HLS
//                           playback URL; without it the webRTC playback URL
//                           Cloudflare returns is used instead.
//
// Deploy: `supabase functions deploy live-session`
//
// SHIPPED DARK. Without CF_STREAM_TOKEN every action that would call Cloudflare
// returns { configured: false } with a 200 rather than an error, so the Live
// view can say "not connected yet" in the pre-flight card instead of failing at
// the Go live click. `action: "config"` exists to ask that question up front.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CF_ACCOUNT   = Deno.env.get("CF_ACCOUNT_ID") ?? "";
const CF_TOKEN     = Deno.env.get("CF_STREAM_TOKEN") ?? "";
const CF_SUBDOMAIN = Deno.env.get("CF_CUSTOMER_SUBDOMAIN") ?? "";

const CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const configured = () => Boolean(CF_ACCOUNT && CF_TOKEN);

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
        status, headers: { ...CORS, "Content-Type": "application/json", ...extra },
    });
}

// A refusal that says nothing. Not "not found", not "not yours" — a 403 with no
// body, so probing session ids tells an attacker nothing beyond the status code
// they would get for any id at all.
function forbidden() {
    return new Response(null, { status: 403, headers: CORS });
}

// Does this session belong to this caller? One id-and-owner read, used by the
// two actions that must answer 403 rather than 404. Typed explicitly because
// the untyped client infers `never` for a selected row.
type OwnedSession = { id: string; status: string; provider_live_input_id: string | null; title: string | null };
// deno-lint-ignore no-explicit-any
async function ownsSession(db: any, id: string, uid: string): Promise<OwnedSession | null> {
    const { data, error } = await db.from("live_sessions")
        .select("id,status,provider_live_input_id,title")
        .eq("id", id).eq("user_id", uid).maybeSingle();
    if (error) { console.error("[live-session] ownership check", error); return null; }
    return (data as OwnedSession | null) ?? null;
}

const CF_BASE = () => `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/stream`;

async function cf(path: string, init: RequestInit = {}) {
    const res = await fetch(`${CF_BASE()}${path}`, {
        ...init,
        headers: {
            "Authorization": `Bearer ${CF_TOKEN}`,
            "Content-Type":  "application/json",
            ...(init.headers ?? {}),
        },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
        // Cloudflare puts the useful part in errors[].message; the HTTP status on
        // its own says almost nothing.
        const msg = data?.errors?.map((e: { message?: string }) => e?.message).filter(Boolean).join("; ")
            || `Cloudflare ${res.status}`;
        throw new Error(msg);
    }
    return data.result;
}

// A live input's playback URL. Prefer the HLS manifest when the customer
// subdomain is configured, because it plays in an ordinary <video> with hls.js;
// fall back to the webRTC playback URL Cloudflare hands back, which needs their
// own player. Never the ingest side of the input.
function playbackUrl(input: Record<string, any>): string | null {
    if (CF_SUBDOMAIN && input?.uid) {
        return `https://${CF_SUBDOMAIN}.cloudflarestream.com/${input.uid}/manifest/video.m3u8`;
    }
    return input?.webRTCPlayback?.url ?? null;
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

    try {
        // The caller's own JWT identifies them. verify_jwt has already rejected a
        // missing or invalid one; this turns it into a user id.
        const auth = req.headers.get("Authorization") ?? "";
        // No backslash escape anywhere in this file, on purpose: it is deployed
        // through a path that decodes JSON escapes in source, and " +" matches
        // the one or more spaces an Authorization header actually uses.
        const jwt  = auth.replace(/^Bearer +/i, "");
        const admin = createClient(SUPABASE_URL, SERVICE_KEY);
        const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
        const uid = userData?.user?.id;
        if (userErr || !uid) return json({ error: "not authenticated" }, 401);

        const body = await req.json().catch(() => ({}));
        const action = String(body?.action ?? "");

        // ── config: can this account go live at all? No secrets in the answer. ──
        if (action === "config") {
            return json({ configured: configured(), provider: "cloudflare" });
        }

        // ── create: a scheduled session plus its Cloudflare live input ──
        if (action === "create") {
            const title = String(body?.title ?? "").trim() || "Untitled stream";
            const membersOnly = Boolean(body?.members_only);
            const scheduledFor = body?.scheduled_for ? String(body.scheduled_for) : null;
            const episodeId = body?.episode_id ? String(body.episode_id) : null;
            // Targets only — never a destination's own stream key. Those are passed
            // per-call on `simulcast` below and handed straight to Cloudflare.
            const simulcast = Array.isArray(body?.simulcast)
                ? body.simulcast.map((t: { target?: string }) => ({ target: String(t?.target ?? ""), status: "pending" }))
                                .filter((t: { target: string }) => t.target)
                : [];

            let inputId: string | null = null;
            let playback: string | null = null;
            let ingestUrl: string | null = null;
            let streamKey: string | null = null;

            if (configured()) {
                const input = await cf("/live_inputs", {
                    method: "POST",
                    body: JSON.stringify({
                        meta: { name: title },
                        // Record automatically so "end the stream" has something to
                        // hand back as an episode.
                        recording: { mode: "automatic", requireSignedURLs: false, timeoutSeconds: 10 },
                    }),
                });
                inputId   = input?.uid ?? null;
                playback  = playbackUrl(input);
                ingestUrl = input?.rtmps?.url ?? null;
                streamKey = input?.rtmps?.streamKey ?? null;
            }

            const { data: row, error } = await admin.from("live_sessions").insert({
                user_id: uid,
                episode_id: episodeId,
                title,
                status: "scheduled",
                scheduled_for: scheduledFor,
                provider: "cloudflare",
                provider_live_input_id: inputId,
                playback_url: playback,
                members_only: membersOnly,
                simulcast,
            }).select("id,title,status,playback_url,members_only,simulcast,scheduled_for").single();
            if (error) return json({ error: error.message }, 400);

            // The secrets go to their own table and are not echoed back.
            if (ingestUrl || streamKey) {
                const { error: secErr } = await admin.from("live_session_secrets")
                    .insert({ session_id: row.id, ingest_url: ingestUrl, stream_key: streamKey });
                // A session whose key was not stored cannot be broadcast to, so this
                // is reported rather than swallowed.
                if (secErr) return json({ error: `session created but ingest not stored: ${secErr.message}`, session: row }, 500);
            }

            return json({ configured: configured(), session: row });
        }

        const id = String(body?.id ?? "");
        if (!id) return json({ error: "id required" }, 400);

        // ── get_ingest: the one action that returns the stream key ──────────
        //
        // The creator cannot broadcast without it — it goes into OBS. So it is
        // readable, by its owner, through here and nowhere else:
        //   - the read is done by the service-role client, because
        //     live_session_secrets grants nothing to authenticated and that
        //     stays true;
        //   - the caller's JWT only establishes identity, and a session that is
        //     not theirs returns 403 with no body;
        //   - it is returned in this response and never written anywhere else —
        //     not onto live_sessions, not into a URL, not to a log.
        // no-store so it does not sit in a proxy or the browser's HTTP cache.
        if (action === "get_ingest") {
            const own = await ownsSession(admin, id, uid);
            if (!own) return forbidden();
            const { data: sec, error } = await admin.from("live_session_secrets")
                .select("ingest_url,stream_key").eq("session_id", id).maybeSingle();
            if (error) return json({ error: error.message }, 400, { "Cache-Control": "no-store" });
            return json({
                ingest_url: sec?.ingest_url ?? null,
                stream_key: sec?.stream_key ?? null,
                configured: configured(),
            }, 200, { "Cache-Control": "no-store" });
        }

        // ── reset_key: cycle the stream key ─────────────────────────────────
        //
        // Cloudflare has no rotate-key endpoint on a live input, so cycling it
        // means a new input. The new one is created FIRST and the row only
        // moves once it exists, so a failure leaves the creator with the key
        // they already had rather than none. The old input is deleted after,
        // best-effort.
        //
        // Only while the session is still scheduled. Deleting a live input
        // deletes its recordings with it, so a key cannot be cycled out from
        // under a stream that is on air or has already produced a recording.
        if (action === "reset_key") {
            const own = await ownsSession(admin, id, uid);
            if (!own) return forbidden();
            if (!configured()) return json({ error: "live streaming is not connected yet" }, 400);
            if (own.status !== "scheduled") {
                return json({ error: "A key can only be reset before the stream starts — cycling it deletes the Cloudflare input and any recording with it." }, 400);
            }
            const oldInput = own.provider_live_input_id;
            let input: Record<string, unknown>;
            try {
                input = await cf("/live_inputs", {
                    method: "POST",
                    body: JSON.stringify({
                        meta: { name: own.title ?? "Untitled stream" },
                        recording: { mode: "automatic", requireSignedURLs: false, timeoutSeconds: 10 },
                    }),
                });
            } catch (e) {
                return json({ error: String((e as Error).message ?? e) }, 400);
            }
            const rtmps = (input as Record<string, any>)?.rtmps ?? {};
            const { error: upErr } = await admin.from("live_sessions").update({
                provider_live_input_id: (input as Record<string, any>)?.uid ?? null,
                playback_url: playbackUrl(input as Record<string, any>),
            }).eq("id", id).eq("user_id", uid);
            if (upErr) return json({ error: upErr.message }, 400);
            // Overwrite rather than insert: the row is keyed on session_id and
            // the old key must not survive anywhere.
            const { error: secErr } = await admin.from("live_session_secrets").upsert({
                session_id: id, ingest_url: rtmps.url ?? null, stream_key: rtmps.streamKey ?? null,
            }, { onConflict: "session_id" });
            if (secErr) return json({ error: `new key not stored: ${secErr.message}` }, 500);
            if (oldInput) {
                try { await cf(`/live_inputs/${oldInput}`, { method: "DELETE" }); }
                catch (e) { console.error("[live-session] old input delete", e); }
            }
            return json({
                ingest_url: rtmps.url ?? null,
                stream_key: rtmps.streamKey ?? null,
            }, 200, { "Cache-Control": "no-store" });
        }

        // Everything below works on one session the caller owns.
        const { data: sess, error: sessErr } = await admin.from("live_sessions")
            .select("id,user_id,status,provider_live_input_id,playback_url,episode_id,title,simulcast")
            .eq("id", id).eq("user_id", uid).maybeSingle();
        if (sessErr) return json({ error: sessErr.message }, 400);
        if (!sess) return json({ error: "not found" }, 404);

        // ── golive ──
        if (action === "golive") {
            const { data, error } = await admin.from("live_sessions")
                .update({ status: "live", started_at: new Date().toISOString() })
                .eq("id", id).eq("user_id", uid)
                .select("id,status,started_at,playback_url").single();
            if (error) return json({ error: error.message }, 400);
            return json({ session: data });
        }

        // ── end: stop, then attach whatever Cloudflare recorded ──
        if (action === "end") {
            let recording: string | null = null;
            let thumbnail: string | null = null;
            if (configured() && sess.provider_live_input_id) {
                try {
                    const vids = await cf(`/live_inputs/${sess.provider_live_input_id}/videos`);
                    // Newest first; the one that is ready is the one worth attaching.
                    const ready = (Array.isArray(vids) ? vids : []).find((v: Record<string, any>) => v?.readyToStream);
                    const vid = ready ?? (Array.isArray(vids) ? vids[0] : null);
                    if (vid) {
                        recording = vid?.playback?.hls ?? vid?.preview ?? null;
                        thumbnail = vid?.thumbnail ?? null;
                    }
                } catch (e) {
                    // A missing recording must not stop the stream from ending. The
                    // row still flips; the recording can be attached on a later end.
                    console.error("[live-session] recording lookup", e);
                }
            }
            const patch: Record<string, unknown> = { status: "ended", ended_at: new Date().toISOString() };
            if (recording) patch.recording_url = recording;
            if (thumbnail) patch.thumbnail_url = thumbnail;
            const { data, error } = await admin.from("live_sessions")
                .update(patch).eq("id", id).eq("user_id", uid)
                .select("id,status,ended_at,recording_url,thumbnail_url,title,episode_id").single();
            if (error) return json({ error: error.message }, 400);
            return json({ session: data });
        }

        // ── viewers: poll the live count, keep the peak ──
        if (action === "viewers") {
            if (!configured() || !sess.provider_live_input_id) return json({ configured: configured(), viewers: null });
            let viewers: number | null = null;
            try {
                const st = await cf(`/live_inputs/${sess.provider_live_input_id}`);
                // Cloudflare reports connection state on the input; a viewer count is
                // only present once there is a live video behind it.
                viewers = typeof st?.status?.current?.ingestion === "object"
                    ? (st?.status?.current?.ingestion?.viewers ?? null) : null;
                if (viewers == null && typeof st?.status?.liveViewers === "number") viewers = st.status.liveViewers;
            } catch (e) {
                console.error("[live-session] viewers", e);
                return json({ viewers: null });
            }
            if (typeof viewers === "number") {
                const { data: cur } = await admin.from("live_sessions")
                    .select("peak_viewers").eq("id", id).eq("user_id", uid).maybeSingle();
                const peak = Math.max(viewers, Number(cur?.peak_viewers ?? 0));
                await admin.from("live_sessions").update({ peak_viewers: peak })
                    .eq("id", id).eq("user_id", uid);
            }
            return json({ viewers });
        }

        // ── simulcast: add a destination. Its key is used and not stored. ──
        if (action === "simulcast") {
            if (!configured() || !sess.provider_live_input_id) return json({ error: "live streaming is not connected yet" }, 400);
            const target = String(body?.target ?? "").trim();
            const url    = String(body?.url ?? "").trim();
            const key    = String(body?.stream_key ?? "").trim();
            if (!target || !url || !key) return json({ error: "target, url and stream_key required" }, 400);
            let outputId: string | null = null;
            try {
                const out = await cf(`/live_inputs/${sess.provider_live_input_id}/outputs`, {
                    method: "POST",
                    body: JSON.stringify({ url, streamKey: key, enabled: true }),
                });
                outputId = out?.uid ?? null;
            } catch (e) {
                return json({ error: String((e as Error).message ?? e) }, 400);
            }
            // The destination's key is deliberately NOT persisted. Cloudflare holds
            // it from here; a copy in this database would be a second place for a
            // creator's YouTube credentials to leak from.
            const existing = Array.isArray(sess.simulcast) ? sess.simulcast : [];
            const next = existing.filter((t: { target?: string }) => t?.target !== target)
                .concat([{ target, status: "enabled", output_id: outputId }]);
            const { data, error } = await admin.from("live_sessions")
                .update({ simulcast: next }).eq("id", id).eq("user_id", uid)
                .select("id,simulcast").single();
            if (error) return json({ error: error.message }, 400);
            return json({ session: data });
        }

        return json({ error: `unknown action: ${action}` }, 400);
    } catch (err) {
        return json({ error: String((err as Error).message ?? err) }, 400);
    }
});
