// Supabase Edge Function: fetch-artist-stats
// Pulls public artist stats (no per-user OAuth) and caches in `artist_stats`.
// Sources: Spotify (Client Credentials flow, app-only), YouTube Data API v3, Last.fm.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SPOTIFY_CLIENT_ID     = Deno.env.get("SPOTIFY_CLIENT_ID") ?? "";
const SPOTIFY_CLIENT_SECRET = Deno.env.get("SPOTIFY_CLIENT_SECRET") ?? "";
const YOUTUBE_API_KEY       = Deno.env.get("YOUTUBE_API_KEY") ?? "";
const LASTFM_API_KEY        = Deno.env.get("LASTFM_API_KEY") ?? "";
const CHARTMETRIC_API_KEY   = Deno.env.get("CHARTMETRIC_API_KEY") ?? "";
const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY           = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

let _spotifyToken: { value: string; expiresAt: number } | null = null;
async function getSpotifyToken(): Promise<string> {
    if (_spotifyToken && Date.now() < _spotifyToken.expiresAt - 5000) return _spotifyToken.value;
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) throw new Error("Spotify credentials not set");
    const creds = btoa(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`);
    const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`Spotify token: ${j.error_description ?? res.status}`);
    _spotifyToken = { value: j.access_token, expiresAt: Date.now() + (j.expires_in * 1000) };
    return _spotifyToken.value;
}

async function spotifyGet(url: string, headers: Record<string, string>) {
    try {
        const res = await fetch(url, { headers });
        const text = await res.text();
        if (!res.ok) return { _failed: true, _status: res.status, _body: text.slice(0, 200) };
        try { return JSON.parse(text); } catch { return { _failed: true, _body: text.slice(0, 200) }; }
    } catch (e) { return { _failed: true, _body: String(e) }; }
}

// Try US first; if a market yields no top tracks, retry a couple of common ones so
// artists distributed outside the US still get their tracks.
async function spotifyTopTracks(spotifyId: string, headers: Record<string, string>) {
    for (const market of ["US", "GB", "NG", "DE"]) {
        const r = await spotifyGet(`https://api.spotify.com/v1/artists/${spotifyId}/top-tracks?market=${market}`, headers);
        if (!r._failed && Array.isArray(r.tracks) && r.tracks.length > 0) {
            console.log(`[spotify] top-tracks hit market=${market} count=${r.tracks.length}`);
            return r;
        }
        console.log(`[spotify] top-tracks market=${market} failed=${!!r._failed} status=${r._status ?? ""} count=${(r.tracks || []).length}`);
    }
    return { tracks: [] };
}

async function fetchSpotify(spotifyId: string) {
    const token = await getSpotifyToken();
    const headers = { "Authorization": `Bearer ${token}` };
    const artist = await spotifyGet(`https://api.spotify.com/v1/artists/${spotifyId}`, headers);
    console.log(`[spotify] artist id=${spotifyId} failed=${!!artist._failed} status=${artist._status ?? ""} name=${artist.name ?? ""} popularity=${artist.popularity ?? "n/a"} followers=${artist.followers?.total ?? "n/a"} body=${artist._body ?? ""}`);
    if (artist._failed || artist.error) {
        // 403 with the premium-subscription body is an APP-LEVEL block, not a bad artist id.
        if (artist._status === 403 && /premium subscription required for the owner of the app/i.test(String(artist._body ?? ""))) {
            throw new Error("Spotify app blocked: the Spotify account that owns the AIAD client ID has no active Premium subscription. This affects every artist, not this one.");
        }
        throw new Error(`Spotify artist: ${artist.error?.message ?? artist._body ?? "unknown"}`);
    }
    const top = await spotifyTopTracks(spotifyId, headers);
    return {
        name:        artist.name,
        followers:   artist.followers?.total ?? 0,
        popularity:  artist.popularity ?? 0,
        genres:      artist.genres ?? [],
        image:       artist.images?.[0]?.url ?? null,
        top_tracks: (top.tracks ?? []).slice(0, 10).map((t: any) => ({
            name: t.name, popularity: t.popularity, preview_url: t.preview_url, album: t.album?.name,
        })),
        // Per-platform freshness stamp. Written ONLY on a successful Spotify fetch, so a
        // row whose YouTube scan succeeded cannot make stale Spotify numbers look current.
        _fetched_at: new Date().toISOString(),
    };
}

// Normalise whatever the artist pasted into an exact YouTube lookup key.
// Accepts: full URLs, /channel/UC..., /c/name, /user/name, @handle, bare UC id, bare name.
function parseYouTubeRef(raw: string): { channelId?: string; handle?: string; legacy?: string; term: string } {
    let s = String(raw ?? "").trim();
    s = s.replace(/^https?:\/\//i, "").replace(/^(www\.|m\.)/i, "").replace(/^youtube\.com\//i, "");
    s = s.replace(/[?#].*$/, "").replace(/\/+$/, "");
    if (/^channel\//i.test(s))     return { channelId: s.replace(/^channel\//i, ""), term: s };
    if (/^(c|user)\//i.test(s))    return { legacy: s.replace(/^(c|user)\//i, ""), term: s };
    if (/^UC[\w-]{22}$/.test(s))   return { channelId: s, term: s };
    if (s.startsWith("@"))         return { handle: s, term: s };
    if (s) return { handle: "@" + s, legacy: s, term: s };
    return { term: s };
}

async function ytChannelsBy(query: string) {
    const res = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&${query}&key=${YOUTUBE_API_KEY}`,
    );
    const j = await res.json();
    return j.items?.[0] ?? null;
}

async function fetchYouTube(handle: string) {
    if (!YOUTUBE_API_KEY) throw new Error("YouTube API key not set");
    const ref = parseYouTubeRef(handle);

    // Exact lookups first. Keyword search is NOT used as a silent fallback: it returns
    // the closest-matching channel, which is how an artist ends up staring at someone
    // else's subscriber count.
    let channel = null;
    if (ref.channelId) channel = await ytChannelsBy(`id=${encodeURIComponent(ref.channelId)}`);
    if (!channel && ref.handle) channel = await ytChannelsBy(`forHandle=${encodeURIComponent(ref.handle)}`);
    if (!channel && ref.legacy) channel = await ytChannelsBy(`forUsername=${encodeURIComponent(ref.legacy)}`);

    // Last resort: search, but only accept a hit whose own handle/title matches what
    // was asked for. Anything else is discarded and we fail loudly instead.
    if (!channel) {
        const want = (ref.handle ?? ref.term).replace(/^@/, "").toLowerCase();
        const searchRes = await fetch(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(want)}&maxResults=5&key=${YOUTUBE_API_KEY}`,
        );
        const sj = await searchRes.json();
        for (const item of (sj.items ?? [])) {
            const cid = item?.snippet?.channelId ?? item?.id?.channelId;
            if (!cid) continue;
            const cand = await ytChannelsBy(`id=${encodeURIComponent(cid)}`);
            const custom = String(cand?.snippet?.customUrl ?? "").replace(/^@/, "").toLowerCase();
            const title  = String(cand?.snippet?.title ?? "").toLowerCase();
            if (custom === want || title === want) { channel = cand; break; }
        }
        console.log(`[youtube] exact lookup missed for "${handle}"; verified-search ${channel ? "matched" : "found nothing"}`);
    }

    if (!channel) throw new Error(`YouTube channel not found for "${handle}" - no channel with that exact handle or ID. Check the handle on the artist's profile.`);

    const channelId = channel.id;
    console.log(`[youtube] resolved "${handle}" -> ${channelId} (${channel.snippet?.customUrl ?? ""} / ${channel.snippet?.title ?? ""}) subs=${channel.statistics?.subscriberCount ?? "n/a"}`);

    const uploadsId = channel.contentDetails?.relatedPlaylists?.uploads;
    let recent_videos: any[] = [];
    if (uploadsId) {
        const plRes = await fetch(
            `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${uploadsId}&maxResults=5&key=${YOUTUBE_API_KEY}`,
        );
        const pj = await plRes.json();
        const videoIds = (pj.items ?? []).map((i: any) => i.contentDetails?.videoId).filter(Boolean).join(",");
        if (videoIds) {
            const vRes = await fetch(
                `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoIds}&key=${YOUTUBE_API_KEY}`,
            );
            const vj = await vRes.json();
            recent_videos = (vj.items ?? []).map((v: any) => ({
                title: v.snippet?.title, published: v.snippet?.publishedAt,
                views: Number(v.statistics?.viewCount ?? 0),
                likes: Number(v.statistics?.likeCount ?? 0),
                comments: Number(v.statistics?.commentCount ?? 0),
            }));
        }
    }
    return {
        channel_id: channelId, name: channel.snippet?.title,
        handle: channel.snippet?.customUrl ?? null,
        description: channel.snippet?.description, published: channel.snippet?.publishedAt,
        country: channel.snippet?.country, thumbnail: channel.snippet?.thumbnails?.high?.url,
        subscribers: Number(channel.statistics?.subscriberCount ?? 0),
        total_views: Number(channel.statistics?.viewCount ?? 0),
        video_count: Number(channel.statistics?.videoCount ?? 0),
        recent_videos,
        _fetched_at: new Date().toISOString(),
    };
}

async function fetchLastfm(user: string) {
    if (!LASTFM_API_KEY) throw new Error("Last.fm API key not set");
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getinfo&user=${encodeURIComponent(user)}&api_key=${LASTFM_API_KEY}&format=json`;
    const res = await fetch(url);
    const j = await res.json();
    if (j.error) throw new Error(`Last.fm: ${j.message}`);
    const u = j.user ?? {};
    return {
        name: u.name, playcount: Number(u.playcount ?? 0),
        registered: u.registered?.unixtime ? Number(u.registered.unixtime) : null,
        country: u.country, image: (u.image ?? []).slice(-1)[0]?.["#text"] ?? null,
        _fetched_at: new Date().toISOString(),
    };
}

async function fetchChartmetric(_spotifyId: string) {
    if (!CHARTMETRIC_API_KEY) return { _stub: "Chartmetric not configured." };
    return { _stub: "Chartmetric integration scaffolded." };
}

// Map legacy self_reported keys -> canonical keys used by artist_stats.self_reported
// (the authoritative column the dashboard headline reads). Keeps the two stores in sync.
const SELF_REPORTED_NUM_MAP: Record<string, string> = {
    monthly_listeners:   "spotify_monthly_listeners",
    spotify_followers:   "spotify_followers",
    instagram_followers: "instagram_followers",
    tiktok_followers:    "tiktok_followers",
    youtube_subscribers: "youtube_subscribers",
};
function canonicalizeSelfReported(sr: Record<string, unknown>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [legacyKey, canonKey] of Object.entries(SELF_REPORTED_NUM_MAP)) {
        const raw = sr[legacyKey];
        if (raw === undefined || raw === null || raw === "") continue;
        const cleaned = String(raw).replace(/[^0-9.]/g, "");
        if (!cleaned) continue;
        const mult = /m/i.test(String(raw)) ? 1_000_000 : /k/i.test(String(raw)) ? 1_000 : 1;
        const n = Math.floor(Number(cleaned) * mult);
        if (Number.isFinite(n) && n >= 0) out[canonKey] = n;
    }
    return out;
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    try {
        const body = await req.json();
        const { user_id, spotify_id, youtube_handle, lastfm_user, instagram_handle, tiktok_handle, action, self_reported } = body;
        if (!user_id) throw new Error("user_id required");
        const supa = createClient(SUPABASE_URL, SERVICE_KEY);

        let mergedSelfReported: Record<string, unknown> | null = null;
        if (action === "save_handles" || action === "fetch") {
            const update: Record<string, unknown> = { user_id };
            if (spotify_id      !== undefined) update.spotify_id      = spotify_id;
            if (youtube_handle  !== undefined) update.youtube_handle  = youtube_handle;
            if (lastfm_user     !== undefined) update.lastfm_user     = lastfm_user;
            if (instagram_handle!== undefined) update.instagram_handle= instagram_handle;
            if (tiktok_handle   !== undefined) update.tiktok_handle   = tiktok_handle;
            if (self_reported && typeof self_reported === "object") {
                const { data: prev } = await supa.from("artist_stats").select("spotify_stats, self_reported").eq("user_id", user_id).maybeSingle();
                const prevSpotify = (prev?.spotify_stats ?? {}) as Record<string, unknown>;
                const prevSelf = (prevSpotify.self_reported ?? {}) as Record<string, unknown>;
                mergedSelfReported = { ...prevSelf, ...self_reported, _updated_at: new Date().toISOString() };
                update.spotify_stats = { ...prevSpotify, self_reported: mergedSelfReported };

                // Mirror the numeric fields into the authoritative top-level column so
                // artist_stats.self_reported (what the dashboard headline reads) never drifts.
                const canon = canonicalizeSelfReported(self_reported as Record<string, unknown>);
                if (Object.keys(canon).length) {
                    const prevNew = (prev?.self_reported ?? {}) as Record<string, unknown>;
                    update.self_reported = { ...prevNew, ...canon, source: "edge_mirror", updated_at: new Date().toISOString() };
                }
            }
            const { error: upErr } = await supa.from("artist_stats").upsert(update, { onConflict: "user_id" });
            if (upErr) console.log(`[save] upsert failed user=${user_id} err=${upErr.message}`);
        }

        if (action === "save_handles") {
            return new Response(JSON.stringify({ ok: true, saved: true }), {
                headers: { ...CORS, "Content-Type": "application/json" },
            });
        }

        const { data: row } = await supa.from("artist_stats").select("*").eq("user_id", user_id).maybeSingle();
        const handles = {
            spotify_id:      spotify_id      ?? row?.spotify_id,
            youtube_handle:  youtube_handle  ?? row?.youtube_handle,
            lastfm_user:     lastfm_user     ?? row?.lastfm_user,
        };

        const errors: Record<string, string> = {};
        const [spotifyResult, youtubeResult, lastfmResult, chartmetricResult] = await Promise.allSettled([
            handles.spotify_id     ? fetchSpotify(handles.spotify_id)         : Promise.resolve(null),
            handles.youtube_handle ? fetchYouTube(handles.youtube_handle)     : Promise.resolve(null),
            handles.lastfm_user    ? fetchLastfm(handles.lastfm_user)         : Promise.resolve(null),
            handles.spotify_id     ? fetchChartmetric(handles.spotify_id)    : Promise.resolve(null),
        ]);
        const pick = (p: PromiseSettledResult<any>, name: string) => {
            if (p.status === "fulfilled") return p.value;
            errors[name] = String((p as PromiseRejectedResult).reason?.message ?? p.reason);
            return null;
        };
        const spotify_stats     = pick(spotifyResult, "spotify");
        const youtube_stats     = pick(youtubeResult, "youtube");
        const lastfm_stats      = pick(lastfmResult, "lastfm");
        const chartmetric_stats = pick(chartmetricResult, "chartmetric");

        const preservedSelfReported = mergedSelfReported ?? (row?.spotify_stats as any)?.self_reported ?? null;
        const prevSpotifyBlob = (row?.spotify_stats ?? null) as Record<string, unknown> | null;

        // A FAILED Spotify fetch must never erase what we already had. The old else-branch
        // rebuilt the blob as { self_reported } alone, so a single scan during an outage
        // permanently destroyed followers/popularity/top_tracks for that artist. Now the
        // prior blob carries forward untouched - stale _fetched_at included, which is
        // exactly what lets the UI mark it stale rather than Live.
        const finalSpotify = spotify_stats
            ? { ...spotify_stats, ...(preservedSelfReported ? { self_reported: preservedSelfReported } : {}) }
            : (prevSpotifyBlob || preservedSelfReported
                ? { ...(prevSpotifyBlob ?? {}), ...(preservedSelfReported ? { self_reported: preservedSelfReported } : {}) }
                : undefined);

        if (finalSpotify || youtube_stats || lastfm_stats || chartmetric_stats) {
            await supa.from("artist_stats").upsert({
                user_id,
                ...(finalSpotify      ? { spotify_stats: finalSpotify } : {}),
                ...(youtube_stats     ? { youtube_stats }     : {}),
                ...(lastfm_stats      ? { lastfm_stats }      : {}),
                ...(chartmetric_stats ? { chartmetric_stats } : {}),
                last_fetched_at: new Date().toISOString(),
            }, { onConflict: "user_id" });
        }

        return new Response(JSON.stringify({
            ok: true, handles,
            spotify_stats: finalSpotify ?? spotify_stats,
            youtube_stats, lastfm_stats, chartmetric_stats,
            self_reported: preservedSelfReported,
            errors: Object.keys(errors).length ? errors : undefined,
            fetched_at: new Date().toISOString(),
        }), { headers: { ...CORS, "Content-Type": "application/json" } });
    } catch (err) {
        return new Response(JSON.stringify({ error: String((err as Error).message ?? err) }), {
            status: 400, headers: { ...CORS, "Content-Type": "application/json" },
        });
    }
});
