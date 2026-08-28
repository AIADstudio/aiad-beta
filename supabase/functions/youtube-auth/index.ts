// YouTube OAuth code exchange and channel read.
//
// verify_jwt stays false: this is reached from the OAuth redirect, which cannot
// carry a user JWT. CSRF protection is the `state` parameter, generated and checked
// in the browser against localStorage. No token is persisted server-side, so there
// is no server-side account binding for a forged callback to hijack.
//
// REDIRECT_URI must match the value the client sent to /authorize EXACTLY or Google
// rejects the exchange with redirect_uri_mismatch. It was still pointing at the old
// aiad-beta.vercel.app deployment while the client had moved to aiad.studio, which
// meant every exchange failed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CLIENT_ID = '393323035976-ff9otd2jboj07op1ja5svke06hj9nlmm.apps.googleusercontent.com';
const REDIRECT_URI = 'https://aiad.studio/callback';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  // Exchange code for token
  if (action === 'exchange') {
    const { code } = await req.json();
    const CLIENT_SECRET = Deno.env.get('YOUTUBE_CLIENT_SECRET') ?? '';

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenRes.json();
    return new Response(JSON.stringify(tokenData), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Fetch YouTube channel data
  if (action === 'channel') {
    const { access_token } = await req.json();

    // Get channel info
    const channelRes = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
      { headers: { 'Authorization': `Bearer ${access_token}` } }
    );
    const channelData = await channelRes.json();

    // Get top videos
    const videosRes = await fetch(
      'https://www.googleapis.com/youtube/v3/search?part=snippet&forMine=true&type=video&order=viewCount&maxResults=5',
      { headers: { 'Authorization': `Bearer ${access_token}` } }
    );
    const videosData = await videosRes.json();

    return new Response(JSON.stringify({ channel: channelData, videos: videosData }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Unknown action' }), {
    status: 400,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
