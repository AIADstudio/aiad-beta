import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type' };
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';

// Opus, to match the answer quality of the seeded demo rows (which all record
// claude-opus-4-6). max_tokens was 1000, which truncated real strategy answers
// mid-thought; 4000 lets a full rollout plan land.
const MODEL = 'claude-opus-4-6';
const MAX_TOKENS = 4000;

// The credit the client spends before calling us, so a failure can hand it back.
const CREDIT_ACTION = 'agent_chat';

const SYSTEM = `You are AIAD's career advisor - a sharp, experienced music-industry strategist (a great manager crossed with an A&R) embedded in the AIAD platform for independent artists.

NON-NEGOTIABLE RULES:
1. EVERY answer must be built on THIS artist's real data provided below - their actual subscriber/follower counts, views, genre, sound, stated goal, and biggest challenge. Open by reflecting their real situation back with specific numbers when you have them.
2. NEVER give a generic framework or checklist that could apply to any artist. Replace anything generic with something specific to THIS artist's numbers, genre, and goal.
3. Answer the artist's actual question directly and substantively - real strategy on release timing, rollout, pricing, audience growth, positioning, monetization.
4. If a key data point is missing (e.g. Spotify not connected), say so plainly, tell them exactly what to connect, and still give your best read from what IS known.
5. Calibrate to their scale: advice for 137 subscribers differs from 137K.
6. AIAD has tools (Creative Studio for songwriting/music/artwork/merch, a collaborator network, fan features). Only mention a tool when it's the genuine next action.
7. Keep it tight, structured, and specific. Lead with the answer.
8. career_stage describes where they are in their CAREER (Emerging / Developing / Established). It is never a billing plan. aiad_plan is their subscription tier and says nothing about their career - never treat it as career stage or reference it as such.`;

// Billing/plan words that must never be mistaken for a career stage.
const PLAN_WORDS = new Set(['free','starter','pro','premier','artist_starter','artist_pro','artist_premier','trial','trialing','active','inactive','none','collaborator','supervisor','supervisor_standard','supervisor_pro','paid','premium','basic','plus']);
function sanitizeStage(v){
  if(v==null) return null;
  const s = String(v).trim();
  if(!s) return null;
  if(PLAN_WORDS.has(s.toLowerCase().replace(/[\s-]+/g,'_'))) return null;
  return s;
}

function summarizeYT(y){ if(!y||typeof y!=='object') return null; return { channel:y.name, subscribers:(y.subscribers??y.subscriber_count??null), total_views:(y.total_views??y.views??null), recent_video_count:(Array.isArray(y.recent_videos)?y.recent_videos.length:null) }; }
function summarizeSP(s){
  if(!s||typeof s!=='object') return null;
  const base={};
  if(s.name) base.name=s.name;
  if(s.followers!=null) base.followers=s.followers;
  if(s.popularity!=null) base.popularity=s.popularity;
  if(Array.isArray(s.genres)) base.genres=s.genres;
  const ml = s.monthly_listeners ?? s.monthlyListeners ?? (s.self_reported && (s.self_reported.monthly_listeners ?? s.self_reported.spotify_monthly_listeners));
  if(ml!=null) base.monthly_listeners=ml;
  const cs = s.career_streams ?? (s.self_reported && s.self_reported.career_streams);
  if(cs!=null) base.career_streams=cs;
  if(Array.isArray(s.top_tracks)) base.top_tracks=s.top_tracks.slice(0,5).map(t=>t&&(t.name||t.title||(typeof t==='string'?t:null))).filter(Boolean);
  if(s.self_reported) base.self_reported=s.self_reported;
  return Object.keys(base).length?base:null;
}

// Turn the artist's saved Guidance Mode settings into a communication directive.
function guidanceDirective(g){
  if(!g||typeof g!=='object') return '';
  const parts=[];
  const mode=g.mode||'strategic';
  if(mode==='reflective') parts.push('Reflective - ask clarifying questions and mirror the artist\'s own thinking back to them; help them reach their own conclusion rather than handing them one.');
  else if(mode==='direct') parts.push('Direct - give a clear recommendation up front with minimal back-and-forth; be decisive.');
  else parts.push('Strategic - lay out structured options with their trade-offs and consequences so they can choose.');
  if(g.never_tell_me_what_to_do) parts.push('Avoid imperatives; frame everything as options, never as commands.');
  if(g.challenge_my_assumptions) parts.push('Actively push back on shaky assumptions and name blind spots.');
  if(g.push_me_when_stuck) parts.push('If they seem stuck or circular, nudge them toward one concrete next step.');
  return parts.length ? ('\n\nHOW THIS ARTIST WANTS YOU TO COMMUNICATE (honor this):\n- '+parts.join('\n- ')) : '';
}

// agent_results is read back under `auth.uid() = fan_id OR auth.uid() = artist_id`,
// so the requester's id has to land in one of those two columns or the row is
// invisible to the person who asked for it. Every pre-existing row has artist_id
// NULL, which is exactly that bug. Only a 'fan' goes in fan_id; every other role
// (artist, creator, collaborator, supervisor) is on the artist side of the tool.
function ownerColumn(role){
  return String(role||'').toLowerCase() === 'fan' ? 'fan_id' : 'artist_id';
}

// fan_questions.topic is CHECK-constrained to these four; anything else fails the
// insert outright. agent_results.topic is free text, so it keeps whatever the
// caller actually sent.
const FQ_TOPICS = ['Brand','Release','Content/Social','Other'];
function fanQuestionTopic(t){
  const raw = String(t == null ? '' : t).trim();
  if(!raw) return 'Other';
  const hit = FQ_TOPICS.find(x => x.toLowerCase() === raw.toLowerCase());
  return hit || 'Other';
}

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors});

  let admin = null;
  let questionId = null;
  let ownerKey = 'artist_id';
  let userId = null;
  let topic = null;
  let question = '';

  try{
    const body = await req.json();
    const { message, conversationHistory, artistName, genre, location, level, user_id, systemContext } = body;
    userId = user_id || null;
    topic = (body.topic != null && String(body.topic).trim()) ? String(body.topic).trim() : null;
    question = String(message ?? '');

    if(SUPABASE_URL && SERVICE_KEY) admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Resolve which side of agent_results/fan_questions this caller owns.
    let role = null;
    if(admin && userId){
      try{
        const r = await admin.from('profiles').select('role').eq('id', userId).maybeSingle();
        role = r.data && r.data.role;
      }catch(e){}
      ownerKey = ownerColumn(role);
    }

    // Record the question up front, so a question survives even if the model call
    // dies. agent_results.question_id points at this row.
    if(admin && userId && question){
      try{
        const q = await admin.from('fan_questions')
          .insert({ [ownerKey]: userId, question, topic: fanQuestionTopic(topic) })
          .select('id').maybeSingle();
        if(q.data) questionId = q.data.id;
        else if(q.error) console.error('[ai-agent] fan_questions insert:', q.error.message);
      }catch(e){ console.error('[ai-agent] fan_questions threw:', String(e)); }
    }

    let systemPrompt;
    if (systemContext && String(systemContext).trim().length > 20) {
      systemPrompt = String(systemContext);
    } else {
      let stats=null, onboarding=null, profile=null;
      if(userId && admin){
        try{
          const [a,b,c] = await Promise.all([
            admin.from('artist_stats').select('spotify_stats,youtube_stats,self_reported').eq('user_id',userId).maybeSingle(),
            admin.from('artist_onboarding').select('data').eq('user_id',userId).maybeSingle(),
            admin.from('artist_profiles').select('career_stage,primary_genre,location,artist_name').eq('user_id',userId).maybeSingle(),
          ]);
          stats=a.data; onboarding=b.data&&b.data.data; profile=c.data;
        }catch(e){}
      }
      const ob = onboarding||{};
      const pf = profile||{};
      const sp = summarizeSP(stats&&stats.spotify_stats);
      const stage = sanitizeStage(pf.career_stage) || sanitizeStage(ob.career_stage) || sanitizeStage(level) || 'Unknown';
      const ctx = {
        name: artistName||pf.artist_name||ob.artist_name||'Unknown', genre: genre||pf.primary_genre||ob.primary_genre||'Unknown', sound: ob.sound||null,
        location: location||pf.location||ob.city||ob.location||'Unknown', career_stage: stage, aiad_plan: (level!=null&&String(level).trim())?String(level).trim():null, years_active: ob.years_active||null,
        youtube: summarizeYT(stats&&stats.youtube_stats), spotify: sp||'NOT CONNECTED',
        other_platforms: (stats&&stats.self_reported&&Object.keys(stats.self_reported).length)?stats.self_reported:null,
        self_reported_monthly_listeners: ob.monthly_listeners||(sp&&sp.monthly_listeners)||null, goal_next_12_months: ob.goal_12mo||ob.goal_next_12_months||null,
        biggest_challenge: ob.biggest_challenge||null, core_audience: ob.audience||ob.core_audience||null, three_year_vision: ob.success_3yr||ob.three_year_vision||null,
        release_cadence: ob.release_cadence||null, team: ob.team||ob.team_size||null,
      };
      systemPrompt = SYSTEM + `\n\nARTIST YOU ARE ADVISING (real data - build your answer on this, cite the numbers):\n` + JSON.stringify(ctx,null,2);
    }
    if(userId && admin){
      try{
        const gs = await admin.from('user_settings').select('guidance').eq('user_id',userId).maybeSingle();
        systemPrompt += guidanceDirective(gs.data && gs.data.guidance);
      }catch(e){}
    }

    const messages=[];
    if(Array.isArray(conversationHistory)) for(const m of conversationHistory) if(m&&m.role&&m.content) messages.push({role:m.role,content:m.content});
    messages.push({role:'user',content:question});

    const r = await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:MODEL,max_tokens:MAX_TOKENS,system:systemPrompt,messages})});
    const data = await r.json();

    // An HTTP error, a refusal, or a shape we don't recognise are all failures —
    // none of them may be written down as if they were an answer.
    if(!r.ok || data.error || !(data.content && data.content[0] && data.content[0].text)){
      const detail = (data && data.error && data.error.message) ? data.error.message
                   : ('anthropic http ' + r.status);
      throw new Error(detail);
    }
    const answer = data.content[0].text;

    if(admin && userId){
      try{
        const ins = await admin.from('agent_results').insert({
          question_id: questionId, [ownerKey]: userId,
          question, topic, answer, model: MODEL, status: 'Answered',
        });
        if(ins.error) console.error('[ai-agent] agent_results insert:', ins.error.message);
      }catch(e){ console.error('[ai-agent] agent_results threw:', String(e)); }
    }

    return new Response(JSON.stringify({answer, question_id: questionId, model: MODEL}),{headers:{...cors,'Content-Type':'application/json'}});

  }catch(e){
    const msg = String((e&&e.message)||e);

    // Write the failure down and hand the credit back. Returning a soft empty
    // state here is what made these disappear: the artist was charged, saw
    // filler text, and nothing was ever recorded.
    if(admin && userId){
      try{
        await admin.from('agent_results').insert({
          question_id: questionId, [ownerKey]: userId,
          question, topic, answer: msg, model: MODEL, status: 'Failed',
        });
      }catch(_){}
      try{
        await admin.rpc('refund_ai_credit', { p_user: userId, p_action: CREDIT_ACTION });
      }catch(_){}
    }
    return new Response(JSON.stringify({error: msg}),{status:500,headers:{...cors,'Content-Type':'application/json'}});
  }
});
