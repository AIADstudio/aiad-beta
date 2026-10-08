// YouTube OAuth, connection storage, and the read/write calls the streaming
// vertical makes against a creator's channel.
//
// verify_jwt stays FALSE: `exchange` is reached from the OAuth redirect, which
// cannot be guaranteed to carry a user JWT. Everything that touches stored
// credentials therefore verifies the caller itself, with requireUser() below —
// a missing or invalid token is a 401 and no row is read or written. Do not add
// an action that skips it.
//
// Two tables, split on who may read them:
//   public.youtube_tokens       access and refresh tokens. RLS on, zero
//                               policies, no grant to anon or authenticated.
//                               Service role only. Nothing here returns one.
//   public.youtube_connections  channel id, title, handle, thumbnail and the
//                               three counts. Owner-scoped RLS, so the client
//                               reads it directly and this function only writes.
//
// The pre-existing `channel` action is left exactly as it was. It takes an
// access token in the body and persists nothing, and the old settings page
// still calls it that way.
//
// REDIRECT_URI must match the value the client sent to /authorize EXACTLY or
// Google rejects the exchange with redirect_uri_mismatch.
//
// Required env: YOUTUBE_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy: `supabase functions deploy youtube-auth --no-verify-jwt`
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CLIENT_ID = '393323035976-ff9otd2jboj07op1ja5svke06hj9nlmm.apps.googleusercontent.com';
const REDIRECT_URI = 'https://aiad.studio/callback';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const admin = () => createClient(SUPABASE_URL, SERVICE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// The caller's own id, or null. The browser sends the anon key on the legacy
// calls, which is not a user token and resolves to null here — that is the
// signal to skip persistence rather than an error.
async function callerId(req: Request): Promise<string | null> {
  const auth = req.headers.get('Authorization') ?? '';
  const jwt = auth.replace(/^Bearer +/i, '').trim();
  if (!jwt || !SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const { data, error } = await admin().auth.getUser(jwt);
    if (error) return null;
    return data?.user?.id ?? null;
  } catch { return null; }
}

// ── Google ──────────────────────────────────────────────────────────────────
async function googleToken(params: Record<string, string>) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: Deno.env.get('YOUTUBE_CLIENT_SECRET') ?? '',
      ...params,
    }),
  });
  return await res.json();
}

async function fetchChannel(accessToken: string) {
  const res = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true',
    { headers: { 'Authorization': `Bearer ${accessToken}` } },
  );
  const data = await res.json();
  return data?.items?.[0] ?? null;
}

// Returns a usable access token for this user, refreshing when the stored one
// has expired. Null means they are not connected, or the refresh was rejected
// (revoked access, most often) — the caller turns that into a reconnect prompt.
// The token is returned to the caller *inside this function only*; no response
// built below ever carries it.
async function accessTokenFor(userId: string): Promise<string | null> {
  const db = admin();
  const { data: row, error } = await db.from('youtube_tokens')
    .select('access_token,refresh_token,expires_at').eq('user_id', userId).maybeSingle();
  if (error || !row) return null;

  const stillGood = row.expires_at && (new Date(row.expires_at).getTime() - Date.now() > 60_000);
  if (stillGood && row.access_token) return row.access_token;
  if (!row.refresh_token) return row.access_token ?? null;

  const refreshed = await googleToken({ refresh_token: row.refresh_token, grant_type: 'refresh_token' });
  if (!refreshed?.access_token) {
    console.error('[youtube-auth] refresh rejected', refreshed?.error ?? refreshed);
    return null;
  }
  const expires = new Date(Date.now() + (Number(refreshed.expires_in ?? 3600) * 1000)).toISOString();
  const { error: upErr } = await db.from('youtube_tokens').update({
    access_token: refreshed.access_token,
    // Google only returns a refresh token on the first consent; keep the one we
    // have when the refresh response omits it.
    ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
    expires_at: expires,
  }).eq('user_id', userId);
  if (upErr) console.error('[youtube-auth] token update', upErr);
  return refreshed.access_token;
}

// Channel facts, written to the client-readable table. Counts come back from
// the API as strings.
async function writeConnection(userId: string, channel: Record<string, any>, scopes?: string) {
  const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const st = channel?.statistics ?? {};
  const sn = channel?.snippet ?? {};
  const row = {
    user_id: userId,
    channel_id: channel?.id ?? null,
    channel_title: sn?.title ?? null,
    channel_handle: sn?.customUrl ?? null,
    thumbnail_url: sn?.thumbnails?.medium?.url ?? sn?.thumbnails?.default?.url ?? null,
    subscriber_count: n(st?.subscriberCount),
    video_count: n(st?.videoCount),
    view_count: n(st?.viewCount),
    last_synced_at: new Date().toISOString(),
    ...(scopes ? { scopes } : {}),
  };
  const { error } = await admin().from('youtube_connections').upsert(row, { onConflict: 'user_id' });
  // Loud: a connection that silently failed to save looks identical to one that
  // worked until the next page load, which is how this used to be lost.
  if (error) console.error('[youtube-auth] youtube_connections upsert', error);
  return { row, error };
}

// The channel's uploads playlist is the only reliable way to list a creator's
// own videos in order; search?forMine is inconsistent and costs more quota.
async function recentVideos(accessToken: string, max = 12) {
  const ch = await fetchChannel(accessToken);
  const uploads = ch?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];
  const listRes = await fetch(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=${max}&playlistId=${uploads}`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } },
  );
  const list = await listRes.json();
  const ids = (list?.items ?? []).map((i: Record<string, any>) => i?.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return [];
  // One extra call gets duration and view count, which the playlist items do
  // not carry and the episode import needs.
  const detRes = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${ids.join(',')}`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } },
  );
  const det = await detRes.json();
  return (det?.items ?? []).map((v: Record<string, any>) => ({
    id: v?.id,
    title: v?.snippet?.title ?? '',
    description: v?.snippet?.description ?? '',
    published_at: v?.snippet?.publishedAt ?? null,
    thumbnail: v?.snippet?.thumbnails?.medium?.url ?? v?.snippet?.thumbnails?.default?.url ?? null,
    duration_seconds: isoDurationToSeconds(v?.contentDetails?.duration),
    views: Number(v?.statistics?.viewCount ?? 0) || 0,
    url: v?.id ? `https://www.youtube.com/watch?v=${v.id}` : null,
  }));
}

// PT1H2M3S to seconds. Written as a character-class match so this file stays
// free of backslash escapes, which the deploy path decodes.
function isoDurationToSeconds(iso: unknown): number | null {
  const s = String(iso ?? '');
  if (!s.startsWith('PT')) return null;
  let total = 0, num = '';
  for (const ch of s.slice(2)) {
    if (ch >= '0' && ch <= '9') { num += ch; continue; }
    const v = Number(num || '0');
    if (ch === 'H') total += v * 3600;
    else if (ch === 'M') total += v * 60;
    else if (ch === 'S') total += v;
    num = '';
  }
  return total || null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  // Everything except `exchange` and the legacy `channel` acts on stored
  // credentials and so requires a real user.
  const needsUser = action !== 'exchange' && action !== 'channel';
  const uid = await callerId(req);
  if (needsUser && !uid) return json({ error: 'not authenticated' }, 401);

  // ── exchange: OAuth code for tokens, and persist when we know who it is ──
  if (action === 'exchange') {
    const tokenData = await googleToken({
      code: String((body as Record<string, unknown>).code ?? ''),
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    });

    if (tokenData?.access_token && uid) {
      const expires = new Date(Date.now() + (Number(tokenData.expires_in ?? 3600) * 1000)).toISOString();
      const { error } = await admin().from('youtube_tokens').upsert({
        user_id: uid,
        access_token: tokenData.access_token,
        // Only present on first consent. Never overwrite a good one with null.
        ...(tokenData.refresh_token ? { refresh_token: tokenData.refresh_token } : {}),
        expires_at: expires,
      }, { onConflict: 'user_id' });
      if (error) console.error('[youtube-auth] youtube_tokens upsert', error);
      const channel = await fetchChannel(tokenData.access_token);
      if (channel) await writeConnection(uid, channel, tokenData.scope);
    }

    // The legacy shape, unchanged: the settings page still reads access_token
    // off this response. Persistence above is additive.
    return json(tokenData);
  }

  // ── channel: unchanged. Takes a token in the body, stores nothing. ──
  if (action === 'channel') {
    const accessToken = String((body as Record<string, unknown>).access_token ?? '');
    const channelRes = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
      { headers: { 'Authorization': `Bearer ${accessToken}` } },
    );
    const channelData = await channelRes.json();
    const videosRes = await fetch(
      'https://www.googleapis.com/youtube/v3/search?part=snippet&forMine=true&type=video&order=viewCount&maxResults=5',
      { headers: { 'Authorization': `Bearer ${accessToken}` } },
    );
    const videosData = await videosRes.json();
    // Opportunistic: when this call does carry a user token, keep the connection
    // row current off the answer we already have.
    if (uid && channelData?.items?.[0]) await writeConnection(uid, channelData.items[0]);
    return json({ channel: channelData, videos: videosData });
  }

  // ── status: is this creator connected? Facts only, never a token. ──
  if (action === 'status') {
    const { data, error } = await admin().from('youtube_connections')
      .select('channel_id,channel_title,channel_handle,thumbnail_url,subscriber_count,video_count,view_count,scopes,connected_at,last_synced_at')
      .eq('user_id', uid).maybeSingle();
    if (error) return json({ error: error.message }, 400);
    return json({ connected: Boolean(data), connection: data ?? null });
  }

  // ── sync: refresh the counts from the API using the stored token ──
  if (action === 'sync') {
    const token = await accessTokenFor(uid as string);
    if (!token) return json({ connected: false, error: 'reconnect_required' }, 200);
    const channel = await fetchChannel(token);
    if (!channel) return json({ connected: false, error: 'no_channel' }, 200);
    const { row, error } = await writeConnection(uid as string, channel);
    if (error) return json({ error: error.message }, 400);
    return json({ connected: true, connection: row });
  }

  // ── videos: the creator's recent uploads, for the import list ──
  if (action === 'videos') {
    const token = await accessTokenFor(uid as string);
    if (!token) return json({ connected: false, error: 'reconnect_required' }, 200);
    const max = Math.min(25, Math.max(1, Number((body as Record<string, unknown>).max ?? 12)));
    try {
      return json({ connected: true, videos: await recentVideos(token, max) });
    } catch (e) {
      console.error('[youtube-auth] videos', e);
      return json({ error: String((e as Error).message ?? e) }, 400);
    }
  }

  // ── upload: push a finished episode to the channel ──
  //
  // Resumable upload: ask Google for a session URL with the metadata, then PUT
  // the bytes. The bytes are streamed straight from the episode's video_url to
  // Google rather than buffered, but this still runs inside the edge function's
  // wall-clock budget — a long episode on a slow origin will time out. That is
  // a real limit and the client says so before starting rather than after.
  //
  // Uploads land as PRIVATE. Publishing is a separate, deliberate act and is
  // not something this should do on a creator's behalf.
  if (action === 'upload') {
    const episodeId = String((body as Record<string, unknown>).episode_id ?? '');
    if (!episodeId) return json({ error: 'episode_id required' }, 400);
    const token = await accessTokenFor(uid as string);
    if (!token) return json({ connected: false, error: 'reconnect_required' }, 200);

    const db = admin();
    const { data: ep, error: epErr } = await db.from('episodes')
      .select('id,title,summary,video_url,destinations')
      .eq('id', episodeId).eq('user_id', uid).maybeSingle();
    if (epErr) return json({ error: epErr.message }, 400);
    if (!ep) return json({ error: 'not found' }, 404);
    if (!ep.video_url) return json({ error: 'This episode has no video file to upload.' }, 400);

    const meta = {
      snippet: { title: String(ep.title ?? 'Untitled episode').slice(0, 100), description: String(ep.summary ?? '').slice(0, 5000) },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
    };

    const start = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      },
    );
    if (!start.ok) {
      const err = await start.json().catch(() => ({}));
      console.error('[youtube-auth] upload session', start.status, err);
      return json({ error: err?.error?.message ?? `YouTube refused the upload (${start.status})` }, 400);
    }
    const sessionUrl = start.headers.get('location');
    if (!sessionUrl) return json({ error: 'YouTube did not return an upload session.' }, 400);

    const src = await fetch(ep.video_url);
    if (!src.ok || !src.body) return json({ error: `Could not read the episode video (${src.status})` }, 400);
    const put = await fetch(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Type': src.headers.get('content-type') ?? 'video/*' },
      body: src.body,
    });
    const result = await put.json().catch(() => ({}));
    if (!put.ok || !result?.id) {
      console.error('[youtube-auth] upload put', put.status, result);
      return json({ error: result?.error?.message ?? `Upload failed (${put.status})` }, 400);
    }

    // Record it on the episode the same way the AIAD destination is recorded, so
    // the Publish view can read one shape.
    const dests = Array.isArray(ep.destinations) ? ep.destinations : [];
    const next = dests.filter((d: { target?: string }) => d?.target !== 'youtube').concat([{
      target: 'youtube', status: 'published', url: `https://www.youtube.com/watch?v=${result.id}`,
      video_id: result.id, privacy: 'private', published_at: new Date().toISOString(),
    }]);
    const { error: dErr } = await db.from('episodes').update({ destinations: next })
      .eq('id', episodeId).eq('user_id', uid);
    if (dErr) console.error('[youtube-auth] destinations update', dErr);

    return json({ ok: true, video_id: result.id, url: `https://www.youtube.com/watch?v=${result.id}`, privacy: 'private' });
  }

  // ── disconnect: drop both rows. The token is gone from here either way; the
  //    creator revokes AIAD's access on their Google account page. ──
  if (action === 'disconnect') {
    const db = admin();
    const a = await db.from('youtube_tokens').delete().eq('user_id', uid);
    const b = await db.from('youtube_connections').delete().eq('user_id', uid);
    if (a.error || b.error) return json({ error: (a.error ?? b.error)?.message }, 400);
    return json({ ok: true });
  }

  return json({ error: 'Unknown action' }, 400);
});
