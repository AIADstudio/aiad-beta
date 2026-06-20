// Supabase Edge Function: fetch-artist-stats
// Pulls public artist stats (no per-user OAuth) and caches in `artist_stats`.
// Sources: Spotify (Client Credentials flow, app-only), YouTube Data API v3, Last.fm.
// Deploy: `supabase functions deploy fetch-artist-stats`
// Required env: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, YOUTUBE_API_KEY, LASTFM_API_KEY,
//               SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional env: CHARTMETRIC_API_KEY (when you upgrade)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SPOTIFY_CLIENT_ID     = Deno.env.get("SPOTIFY_CLIENT_ID") ?? "";
const SPOTIFY_CLIENT_SECRET = Deno.env.get("SPOTIFY_CLIENT_SECRET") ?? "";
const YOUTUBE_API_KEY       = Deno.env.get("YOUTUBE_API_KEY") ?? "";
const LASTFM_API_KEY        = Deno.env.get("LASTFM_API_KEY") ?? "";
const CHARTMETRIC_API_KEY   = Deno.env.get("CHARTMETRIC_API_KEY") ?? ""; // optional
const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY           = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── Spotify (Client Credentials, app-only — NO user OAuth) ──────────────────
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

async function fetchSpotify(spotifyId: string) {
    const token = await getSpotifyToken();
    const headers = { "Authorization": `Bearer ${token}` };

    const [artist, top, related] = await Promise.all([
        fetch(`https://api.spotify.com/v1/artists/${spotifyId}`, { headers }).then((r) => r.json()),
        fetch(`https://api.spotify.com/v1/artists/${spotifyId}/top-tracks?market=US`, { headers }).then((r) => r.json()),
        fetch(`https://api.spotify.com/v1/artists/${spotifyId}/related-artists`, { headers }).then((r) => r.json()),
    ]);

    if (artist.error) throw new Error(`Spotify artist: ${artist.error.message}`);

    return {
        name:        artist.name,
        followers:   artist.followers?.total ?? 0,
        popularity:  artist.popularity ?? 0,         // 0-100 score
        genres:      artist.genres ?? [],
        image:       artist.images?.[0]?.url ?? null,
        top_tracks: (top.tracks ?? []).slice(0, 10).map((t: any) => ({
            name:        t.name,
            popularity:  t.popularity,
            preview_url: t.preview_url,
            album:       t.album?.name,
        })),
        related_artists: (related.artists ?? []).slice(0, 10).map((a: any) => ({
            name: a.name, popularity: a.popularity, id: a.id,
        })),
    };
}

// ─── YouTube Data API v3 (server API key — NO user OAuth) ────────────────────
async function fetchYouTube(handle: string) {
    if (!YOUTUBE_API_KEY) throw new Error("YouTube API key not set");
    // Resolve channel ID from handle (e.g., "@taylorswift" or "UC..." directly)
    let channelId = handle.startsWith("UC") ? handle : null;
    if (!channelId) {
        const cleanHandle = handle.replace(/^@/, "");
        const searchRes = await fetch(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(cleanHandle)}&maxResults=1&key=${YOUTUBE_API_KEY}`,
        );
        const sj = await searchRes.json();
        channelId = sj.items?.[0]?.snippet?.channelId ?? sj.items?.[0]?.id?.channelId ?? null;
        if (!channelId) throw new Error(`YouTube channel not found for "${handle}"`);
    }

    const chRes = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&id=${channelId}&key=${YOUTUBE_API_KEY}`,
    );
    const cj = await chRes.json();
    const channel = cj.items?.[0];
    if (!channel) throw new Error("YouTube channel data empty");

    // Pull last 5 uploads via the uploads playlist.
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
                title:      v.snippet?.title,
                published:  v.snippet?.publishedAt,
                views:      Number(v.statistics?.viewCount ?? 0),
                likes:      Number(v.statistics?.likeCount ?? 0),
                comments:   Number(v.statistics?.commentCount ?? 0),
            }));
        }
    }

    return {
        channel_id:    channelId,
        name:          channel.snippet?.title,
        description:   channel.snippet?.description,
        published:     channel.snippet?.publishedAt,
        country:       channel.snippet?.country,
        thumbnail:     channel.snippet?.thumbnails?.high?.url,
        subscribers:   Number(channel.statistics?.subscriberCount ?? 0),
        total_views:   Number(channel.statistics?.viewCount ?? 0),
        video_count:   Number(channel.statistics?.videoCount ?? 0),
        recent_videos,
    };
}

// ─── Last.fm (free public API, no auth beyond a key) ─────────────────────────
async function fetchLastfm(user: string) {
    if (!LASTFM_API_KEY) throw new Error("Last.fm API key not set");
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getinfo&user=${encodeURIComponent(user)}&api_key=${LASTFM_API_KEY}&format=json`;
    const res = await fetch(url);
    const j = await res.json();
    if (j.error) throw new Error(`Last.fm: ${j.message}`);
    const u = j.user ?? {};
    return {
        name:        u.name,
        playcount:   Number(u.playcount ?? 0),
        registered:  u.registered?.unixtime ? Number(u.registered.unixtime) : null,
        country:     u.country,
        image:       (u.image ?? []).slice(-1)[0]?.["#text"] ?? null,
    };
}

// ─── Chartmetric stub (turn on when you subscribe) ───────────────────────────
async function fetchChartmetric(_spotifyId: string) {
    if (!CHARTMETRIC_API_KEY) return { _stub: "Chartmetric not configured. Subscribe + set CHARTMETRIC_API_KEY for cross-platform analytics." };
    // TODO: real Chartmetric calls. https://api.chartmetric.com/api/
    // POST /api/token with refreshtoken → /artist/{id} for cross-platform stats.
    return { _stub: "Chartmetric integration scaffolded; finish when API key is available." };
}

// ─── Main handler ────────────────────────────────────────────────────────────
serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

    try {
        const body = await req.json();
        const { user_id, spotify_id, youtube_handle, lastfm_user, instagram_handle, tiktok_handle, action } = body;
        if (!user_id) throw new Error("user_id required");

        const supa = createClient(SUPABASE_URL, SERVICE_KEY);

        // 1. Save/update handles if provided.
        if (action === "save_handles" || action === "fetch") {
            const update: Record<string, unknown> = { user_id };
            if (spotify_id      !== undefined) update.spotify_id      = spotify_id;
            if (youtube_handle  !== undefined) update.youtube_handle  = youtube_handle;
            if (lastfm_user     !== undefined) update.lastfm_user     = lastfm_user;
            if (instagram_handle!== undefined) update.instagram_handle= instagram_handle;
            if (tiktok_handle   !== undefined) update.tiktok_handle   = tiktok_handle;
            await supa.from("artist_stats").upsert(update, { onConflict: "user_id" });
        }

        if (action === "save_handles") {
            return new Response(JSON.stringify({ ok: true, saved: true }), {
                headers: { ...CORS, "Content-Type": "application/json" },
            });
        }

        // 2. Load current handles for this user.
        const { data: row } = await supa.from("artist_stats").select("*").eq("user_id", user_id).maybeSingle();
        const handles = {
            spotify_id:      spotify_id      ?? row?.spotify_id,
            youtube_handle:  youtube_handle  ?? row?.youtube_handle,
            lastfm_user:     lastfm_user     ?? row?.lastfm_user,
        };

        // 3. Fetch each source in parallel (skip if no handle).
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

        // 4. Persist freshly-fetched stats.
        await supa.from("artist_stats").upsert({
            user_id,
            ...(spotify_stats     ? { spotify_stats }     : {}),
            ...(youtube_stats     ? { youtube_stats }     : {}),
            ...(lastfm_stats      ? { lastfm_stats }      : {}),
            ...(chartmetric_stats ? { chartmetric_stats } : {}),
            last_fetched_at: new Date().toISOString(),
        }, { onConflict: "user_id" });

        return new Response(JSON.stringify({
            ok: true,
            handles,
            spotify_stats,
            youtube_stats,
            lastfm_stats,
            chartmetric_stats,
            errors: Object.keys(errors).length ? errors : undefined,
            fetched_at: new Date().toISOString(),
        }), { headers: { ...CORS, "Content-Type": "application/json" } });

    } catch (err) {
        return new Response(JSON.stringify({ error: String((err as Error).message ?? err) }), {
            status: 400, headers: { ...CORS, "Content-Type": "application/json" },
        });
    }
});
