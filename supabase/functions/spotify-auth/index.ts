// Spotify OAuth code exchange and profile read.
//
// verify_jwt stays false: this is reached from the OAuth redirect, which cannot
// carry a user JWT. CSRF protection is the `state` parameter, generated and checked
// in the browser against localStorage. No token is persisted server-side — the
// access token is returned to the caller and lives only in that browser — so there
// is no server-side account binding for a forged callback to hijack.
//
// REDIRECT_URI must match the value the client sent to /authorize EXACTLY or Spotify
// rejects the exchange with invalid_grant. It was still pointing at the old
// aiad-beta.vercel.app deployment while the client had moved to aiad.studio, which
// meant every exchange failed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CLIENT_ID = '78d436e1bd134f9a8d96c6e21695b6ce';
const REDIRECT_URI = 'https://aiad.studio/callback';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  // Exchange code for token
  if (action === 'exchange') {
    const { code } = await req.json();
    const CLIENT_SECRET = Deno.env.get('SPOTIFY_CLIENT_SECRET') ?? '';

    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json();
    return new Response(JSON.stringify(tokenData), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Fetch artist data
  if (action === 'artist') {
    const { access_token } = await req.json();

    // Get user profile first
    const profileRes = await fetch('https://api.spotify.com/v1/me', {
      headers: { 'Authorization': `Bearer ${access_token}` },
    });
    const profile = await profileRes.json();

    // Get top tracks
    const topTracksRes = await fetch('https://api.spotify.com/v1/me/top/tracks?limit=5&time_range=short_term', {
      headers: { 'Authorization': `Bearer ${access_token}` },
    });
    const topTracks = await topTracksRes.json();

    // Get recently played
    const recentRes = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=5', {
      headers: { 'Authorization': `Bearer ${access_token}` },
    });
    const recent = await recentRes.json();

    return new Response(JSON.stringify({ profile, topTracks, recent }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Unknown action' }), {
    status: 400,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
