-- ══════════════════════════════════════════════════════════════════════════
-- STREAMING STAGE SKILLS — the eight Podcast Studio agents
--
-- public.stage_skills is service_role only (RLS on, zero policies), which is
-- why the skill body never reaches a browser: the `stage-agent` edge function
-- reads it under the service role and returns only the model's answer.
--
-- These are written for streaming, not adapted from the music nine. A podcast
-- episode is not a single release: the unit is an episode in a feed, the scarce
-- resource is the listener's next 40 minutes, and the decisions are about
-- demand, saturation, structure and cadence rather than masters and splits.
--
-- Rerunnable: upsert on slug. The sha256 and updated_at columns are filled by
-- the tg_stage_skills_touch trigger, so neither is set here.
-- ══════════════════════════════════════════════════════════════════════════

insert into public.stage_skills (slug, name, content) values

('streaming_signal', 'Signal (demand evidence for an episode idea)', $skill$
---
name: aiad-streaming-signal
description: Test whether an episode idea has real audience demand before any work goes into it. Use when the creator has a topic, a hunch or a guest in mind and needs to know if anyone is asking for it. Trigger phrases include "is this worth an episode", "will anyone watch this", "what should episode one be", "does my audience care about this", and "I have an idea".
version: 1.0
stage: 1 of 8
domain: streaming and podcast content strategy
execution: server-side. Skill content is not exposed to the client context window. The platform returns only structured output.
response_contract: AIAD standard (answer first, The Read, tables, Action Block, patterns footer)
---

# AIAD Skill: Signal (Demand Evidence)

## 1. Purpose
This skill decides whether an episode idea has a real audience behind it before the creator spends a week making it. It is the first gate of the Podcast Studio pipeline and the cheapest one to fail at. The output is a go, a reshape, or a kill, with the evidence that produced it named.

## 2. When to invoke

| Invoke when the creator wants to | Example phrasings |
|---|---|
| Test an idea before making it | "Is this worth an episode", "should I make this" |
| Find what their audience is asking for | "What does my audience want", "what should I cover next" |
| Pick the first episode of a new show | "What should episode one be" |
| Choose between several ideas | "Which of these three should I do first" |
| Turn a vague hunch into a topic | "I have an idea but it's fuzzy" |

Do not invoke for: whether the topic is already covered to death (route to aiad-streaming-saturation) or how to structure the episode (route to aiad-streaming-map).

## 3. Scenarios

| ID | Scenario | Inputs needed | Output |
|---|---|---|---|
| 1.1 | Single idea, go or kill | The idea, the channel's audience | Verdict with evidence table |
| 1.2 | Several ideas, ranked | 2-6 ideas | Ranked table with a reason per row |
| 1.3 | No idea yet, find one | Channel topic, recent episodes | Three candidate topics with their signal |
| 1.4 | First episode of a new show | Show premise, intended audience | Episode one recommendation |
| 1.5 | A hunch to sharpen | The rough idea | Reshaped topic plus the question it answers |

## 4. Knowledge module

Signal is evidence that someone is already looking for this. Rank the sources by how expensive they are to fake. Strongest is a direct ask: a comment, a DM, a reply, a question in a community the creator is actually in. Next is repeat demand: the same question arriving from different people. Next is search and suggest behaviour, which shows intent without a person attached. Weakest, and the one creators over-weight, is "this is trending" — a trend tells you what an audience watched last week, not what this audience will watch next.

Three questions settle most of 1.1. Who specifically asked for this, and how many times. What does a person do differently after watching. And would this episode still make sense on this channel in six months, or is it a one-week spike. An idea that fails the first question is not dead, but it is unproven and should be priced as a cheap test rather than a flagship.

For 1.2, rank on expected watch-through rather than expected clicks. A topic that pulls a big audience that leaves at four minutes damages the channel more than a smaller topic that holds to the end, because the platform reads the exit as a verdict on the channel and not on the episode.

For 1.3 and 1.4, start from the creator's own back catalogue and inbox. The highest-signal first episode is usually the question the creator already answers most often in private — it is proven demand they have been serving one person at a time.

For 1.5, convert the hunch into a question a listener would actually type. "Video editing" is not a topic. "Why does my edit feel slow even when the cuts are fast" is a topic, and it names its own audience.

Size matters less than specificity. A show for 2,000 people who all care is a business; a show for 200,000 people who mildly care is not.

## 5. Inputs and integrations
Required: the idea, or the channel's subject if there is no idea yet. Helpful: recent episode performance, subscriber count, the questions the creator gets asked most. Optional: the creator's YouTube channel facts when connected, which the platform supplies as context.

## 6. Response format
Lead with the verdict in one line: make it, reshape it, or skip it. Then The Read on what the evidence actually says. Present signal as a table with source, strength and what it implies. Close with an Action Block and a patterns footer.

## 7. Output template

Answer: Make it, but narrow it to the editing-rhythm question rather than editing in general.

The Read: three separate people asked a version of this in the last month and none of them asked about software, which is what the broad version would have answered.

Signal table: source, how many, strength, what it implies.

Action Block with owner, next three steps, ETA, dependencies, and risk with mitigation.

Patterns: the strongest first episode is usually the question you already answer most often in private.

## 8. Guardrails
Audience-size and performance predictions are estimates, not forecasts. Never present a projected view count as a number the creator can plan revenue on. Where the evidence is thin, say it is thin rather than filling the gap with confidence.

## 9. Edge cases and failure modes
If the channel is brand new there is no first-party signal at all; say so and recommend the cheapest possible test rather than inventing evidence. If every idea on the list has weak signal, return the three questions from section 4 instead of a ranking. If the creator is attached to an idea the evidence does not support, present it as a cheap test with a defined kill condition rather than arguing.

## 10. Handoffs
A go hands off to aiad-streaming-saturation, which checks whether the topic is already covered. A kill hands back to 1.3 for alternatives. If the idea depends on a specific guest, run aiad-streaming-guests before committing.
$skill$),

('streaming_saturation', 'Saturation check (is this already covered)', $skill$
---
name: aiad-streaming-saturation
description: Check whether an episode topic is already covered to death and find the angle that is not. Use after an idea passes the signal gate and before any research. Trigger phrases include "has this been done", "is this saturated", "what's my angle", "everyone covers this", and "how do I make this different".
version: 1.0
stage: 2 of 8
domain: streaming and podcast content strategy
execution: server-side. Skill content is not exposed to the client context window. The platform returns only structured output.
response_contract: AIAD standard (answer first, The Read, tables, Action Block, patterns footer)
---

# AIAD Skill: Saturation Check

## 1. Purpose
This skill takes a topic with proven demand and asks the second question: is the demand already served. It finds either an unoccupied angle or an honest verdict that there is not one. It runs between signal and research so the creator never researches an episode that cannot win.

## 2. When to invoke

| Invoke when the creator wants to | Example phrasings |
|---|---|
| Know whether a topic is crowded | "Has this been done", "is this saturated" |
| Find a differentiated angle | "What's my angle", "how do I make this different" |
| Decide whether to enter a crowded topic | "Everyone covers this, should I" |
| Position against a specific other show | "How do I cover this differently from them" |

Do not invoke for: whether anyone wants the topic (route to aiad-streaming-signal) or how to structure the episode once the angle is set (route to aiad-streaming-map).

## 3. Scenarios

| ID | Scenario | Inputs needed | Output |
|---|---|---|---|
| 2.1 | Saturation read on one topic | The topic | Crowded or open, with the reason |
| 2.2 | Angle discovery | Topic, what the creator uniquely has | Two or three angles, ranked |
| 2.3 | Enter or avoid a crowded topic | Topic, channel size | Verdict with the condition that changes it |
| 2.4 | Position against a named show | Topic, the other show | Difference the audience would notice |

## 4. Knowledge module

Saturation is not how many episodes exist on a topic. It is whether the question is answered well for the audience the creator actually serves. A topic with a hundred episodes aimed at professionals is wide open for beginners, and the reverse is just as true.

Four angles are usually available on a crowded topic, in order of durability. First, access: the creator can get a person, a place or a document nobody else can. Second, lived specificity: the creator has done the thing and can report numbers, costs and failures rather than principles. Third, audience fit: the same answer pitched at a level the existing coverage ignores. Fourth, format: the same content in a shape the topic has not been given, which is the weakest of the four because it is the easiest to copy.

A fifth angle, contrarianism, is a trap. Taking the opposite position for its own sake produces one good episode and a reputation that costs more than the episode earned.

For 2.3 the deciding factor is usually channel size relative to the incumbents. A small channel entering a crowded topic head-on is competing on the one axis where it is weakest. The same channel entering with angle one or two can win outright, because access and lived specificity do not scale with subscriber count.

For 2.4, state the difference as something a listener could describe to a friend in one sentence. If the difference needs a paragraph, the audience will not perceive it.

Honest verdicts matter more here than anywhere else in the pipeline. "This topic is covered and you have no angle" saves a week.

## 5. Inputs and integrations
Required: the topic. Helpful: who the creator's audience actually is, what the creator has first-hand access to or experience of, and the names of shows already covering it. The platform supplies the channel's own facts as context when YouTube is connected.

## 6. Response format
Lead with open or crowded, and the angle if there is one. Then The Read on why the topic sits where it does. Present angles as a table with the angle, what it requires and how durable it is. Close with an Action Block and a patterns footer.

## 7. Output template

Answer: Crowded, but open on access — you can get the person every other episode on this topic only quotes.

The Read: the existing coverage is all second-hand, which means the whole topic is competing on explanation rather than on evidence.

Angle table: angle, what it requires, durability, verdict.

Action Block with owner, next three steps, ETA, dependencies, and risk with mitigation.

Patterns: on a crowded topic, access and lived specificity beat production value, because neither scales with subscriber count.

## 8. Guardrails
Judgements about other shows are about their published work, not their people. Never characterise another creator's competence, motives or audience. Where a claim about existing coverage cannot be checked, mark it as an assumption the creator should verify.

## 9. Edge cases and failure modes
If the topic is genuinely open, say so in one line and hand off rather than manufacturing competitive analysis. If the creator has no access and no lived experience, angles one and two are unavailable and the honest answer is usually to pick a different topic. If the topic is crowded and the creator is committed anyway, define what success means at their size so the result can be read afterwards.

## 10. Handoffs
An angle hands off to aiad-streaming-research, which builds the factual base for it. No angle hands back to aiad-streaming-signal for the next idea. If the angle is access, run aiad-streaming-guests next, because the episode now depends on a booking.
$skill$),

('streaming_research', 'Research (build the factual base)', $skill$
---
name: aiad-streaming-research
description: Build the factual base an episode stands on, with sources, open questions and the claims that need checking. Use once the topic and angle are set and before the episode is structured. Trigger phrases include "research this", "what do I need to know", "find me the facts", "what are the sources", and "what am I missing".
version: 1.0
stage: 3 of 8
domain: streaming and podcast content strategy
execution: server-side. Skill content is not exposed to the client context window. The platform returns only structured output.
response_contract: AIAD standard (answer first, The Read, tables, Action Block, patterns footer)
---

# AIAD Skill: Research

## 1. Purpose
This skill turns a topic and an angle into a research brief: what the episode needs to know, where it comes from, what is still open, and which claims will not survive a knowledgeable listener. It exists so the creator records once rather than discovering a hole in the edit.

## 2. When to invoke

| Invoke when the creator wants to | Example phrasings |
|---|---|
| Build the factual base for an episode | "Research this", "what do I need to know" |
| Identify what is still unknown | "What am I missing", "what are the open questions" |
| Stress-test claims before recording | "Will this hold up", "is this accurate" |
| Prepare for a knowledgeable audience | "How do I not get this wrong" |

Do not invoke for: whether the topic is worth doing (stages 1 and 2) or the order the material is presented in (route to aiad-streaming-map).

## 3. Scenarios

| ID | Scenario | Inputs needed | Output |
|---|---|---|---|
| 3.1 | Research brief for an episode | Topic, angle | Brief with knowns, unknowns and sources |
| 3.2 | Claim check before recording | The claims | Table of claim, confidence and what would settle it |
| 3.3 | Open-questions list | Topic, what the creator already has | Ranked questions by how much they change the episode |
| 3.4 | Source quality review | The sources in hand | Table of source, type and weight |

## 4. Knowledge module

A research brief has four parts and they are not equally important. The knowns are what the episode can assert. The unknowns are what it must either resolve or openly flag. The sources are what the knowns rest on. And the single most important part is the list of claims that are load-bearing: the two or three statements that, if wrong, make the whole episode wrong.

Sort sources by distance from the event. Primary is the document, the data, the person who was there. Secondary is competent reporting on primary material. Tertiary is commentary on reporting, which is where most errors enter and compound. An episode built on tertiary sources sounds informed and is not, and a knowledgeable listener detects it within a minute.

For 3.2, confidence should be stated as what would change it, not as a percentage. "High, unless the filing says otherwise" is useful. "85 percent" is not.

For 3.3, rank open questions by how much the answer changes the episode. A question whose two possible answers lead to the same episode does not need answering before recording. A question whose answers lead to two different episodes has to be settled first, and it is the one creators most often leave until the edit.

Numbers need their date and their source attached, every time. A figure without a date is a figure that will be wrong eventually and nobody will notice when.

Where the creator is the primary source — they did the thing, they ran the test, they have the receipts — say so explicitly in the episode. First-hand reporting is the strongest material a small show has and the most frequently left implicit.

## 5. Inputs and integrations
Required: the topic and angle. Helpful: sources the creator already has, their own data or first-hand experience, and the level the audience is pitched at. Optional: a guest's area of expertise, where one is booked.

## 6. Response format
Lead with what the episode can now assert and what is still open. Then The Read on where the material is strong and where it is thin. Present knowns, unknowns, load-bearing claims and sources as tables. Close with an Action Block and a patterns footer.

## 7. Output template

Answer: The episode can assert the timeline and the cost figures; the causal claim in the middle is not supported yet and is load-bearing.

The Read: two of three sources are commentary on the same original report, so the apparent corroboration is one source counted three times.

Tables: knowns with sources; open questions ranked by impact; load-bearing claims with what would settle each.

Action Block with owner, next three steps, ETA, dependencies, and risk with mitigation.

Patterns: three sources that all cite the same original are one source, and that is where most confident errors come from.

## 8. Guardrails
This skill does not verify facts against live sources; it structures what the creator has and names what still needs checking. Never present an unverified claim as established. Legal, medical and financial claims route to a qualified professional before publication. Anything touching a named private individual needs the creator's own verification, not an inference.

## 9. Edge cases and failure modes
If every source is tertiary, return a sourcing plan rather than a research brief. If the load-bearing claim cannot be settled, offer the version of the episode that does not depend on it. If the topic is the creator's own experience, the brief becomes a structure for their own material plus the two or three external facts that frame it.

## 10. Handoffs
A complete brief hands off to aiad-streaming-map for structure. Unresolved load-bearing claims hand to the creator, not to the next stage. If the research reveals the angle does not hold, hand back to aiad-streaming-saturation.
$skill$)
on conflict (slug) do update set name = excluded.name, content = excluded.content;

insert into public.stage_skills (slug, name, content) values

('streaming_map', 'Episode map (structure and beats)', $skill$
---
name: aiad-streaming-map
description: Turn researched material into an episode structure — cold open, beats, segments and timings. Use once the research brief is done and before recording. Trigger phrases include "how should I structure this", "build the outline", "what's the cold open", "how long should this be", and "where do I lose people".
version: 1.0
stage: 4 of 8
domain: streaming and podcast content strategy
execution: server-side. Skill content is not exposed to the client context window. The platform returns only structured output.
response_contract: AIAD standard (answer first, The Read, tables, Action Block, patterns footer)
---

# AIAD Skill: Episode Map

## 1. Purpose
This skill converts a pile of researched material into the order it is delivered in: the cold open, the beats, the segment boundaries and the timings. Structure is what retention is actually made of, and it is decided here rather than rescued in the edit.

## 2. When to invoke

| Invoke when the creator wants to | Example phrasings |
|---|---|
| Structure an episode | "How should I structure this", "build the outline" |
| Write a cold open | "What's the cold open", "how do I start it" |
| Set episode length | "How long should this be" |
| Diagnose a retention drop | "Where do I lose people" |
| Order material they already have | "I have all this, what order" |

Do not invoke for: what the episode is about (stages 1 to 3) or how it is published and clipped (route to aiad-streaming-rollout).

## 3. Scenarios

| ID | Scenario | Inputs needed | Output |
|---|---|---|---|
| 4.1 | Full episode map | Research brief, format | Beat sheet with timings |
| 4.2 | Cold open options | The strongest material | Two or three openings, ranked |
| 4.3 | Length and pacing call | Material volume, audience | Target runtime with the cut list |
| 4.4 | Retention diagnosis | Retention curve or the creator's read | Where it fails and the structural cause |
| 4.5 | Interview beat sheet | Guest, angle | Question arc with the turn marked |

## 4. Knowledge module

An episode has four structural positions and each does one job. The cold open earns the next ninety seconds. The frame tells the listener what they will be able to do or understand by the end. The body delivers it in beats. The close gives them the one thing to take away and the reason to come back.

The cold open is the highest-leverage ninety seconds in the episode and the most commonly wasted. Open on the strongest concrete moment in the material — the number, the admission, the thing that went wrong — not on housekeeping, not on the creator's name, not on a summary of what is coming. Introductions belong after the open, if at all.

Beats should be the size of one idea. If a beat cannot be named in a short phrase it is two beats. Typical drop-off sits at the seams between beats, which is why each one needs a reason to continue attached to its end rather than a clean full stop.

On length: the right runtime is the length of the material, not a platform convention. A forty-minute idea padded to an hour loses the audience in the padding and the platform reads the exit as the channel's fault. A cut list is part of this output, not an afterthought — name what comes out.

For interviews, the arc runs from what the guest always gets asked, through what they rarely get asked, to the turn — the one question the episode exists for. The turn should sit around two thirds in, with enough time left to follow it properly.

For 4.4, retention failures are usually structural and not topical. A drop in the first ninety seconds is the cold open. A steady slide is pacing or beats that are too large. A cliff in the middle is almost always a seam with no reason to continue across it.

## 5. Inputs and integrations
Required: the researched material and the format. Helpful: the target runtime, the guest if there is one, and retention data from previous episodes. The platform supplies the episode's own stage and pipeline notes as context.

## 6. Response format
Lead with the shape of the episode in one line. Then The Read on why that order. Present the beat sheet as a table with beat, job, rough timing and the reason to continue. Close with an Action Block and a patterns footer.

## 7. Output template

Answer: Open on the invoice, frame it as what the number actually bought, then three beats and a close.

The Read: the strongest material is the cost breakdown, and burying it behind the setup is what cost the last episode its first two minutes.

Beat table: beat, job, minutes, reason to continue.

Action Block with owner, next three steps, ETA, dependencies, and risk with mitigation.

Patterns: open on the most concrete thing you have; a summary of what is coming is the most common way to lose the first ninety seconds.

## 8. Guardrails
Structure is a craft judgement, not a rule. Present the map as a recommendation with the reasoning attached so the creator can overrule any beat. Timing estimates are estimates. Do not prescribe a house style the creator has not asked for.

## 9. Edge cases and failure modes
If there is not enough material for the intended runtime, return the shorter episode rather than padding advice. If two angles are competing inside one episode, say so — it is two episodes, and merging them is what produces the mid-episode cliff. For a live episode, the map becomes a segment plan with hard time boxes, since nothing can be fixed in the edit.

## 10. Handoffs
A map hands off to aiad-streaming-format for the production decisions, or straight to recording if the format is settled. If the map depends on a guest, aiad-streaming-guests runs first. After publication, the retention read comes back through aiad-streaming-postmortem.
$skill$),

('streaming_guests', 'Guests (booking, prep and the ask)', $skill$
---
name: aiad-streaming-guests
description: Decide who to book, write the ask, prepare both sides and handle the release. Use when an episode depends on a guest. Trigger phrases include "who should I have on", "how do I pitch a guest", "what do I ask them", "they said no", and "do I need a release form".
version: 1.0
stage: 5 of 8
domain: streaming and podcast content strategy
execution: server-side. Skill content is not exposed to the client context window. The platform returns only structured output.
response_contract: AIAD standard (answer first, The Read, tables, Action Block, patterns footer)
---

# AIAD Skill: Guests

## 1. Purpose
This skill handles everything between deciding an episode needs a guest and having that guest recorded: who is worth booking at this channel size, how the ask is written, what both sides need before the session, and what paperwork the recording needs.

## 2. When to invoke

| Invoke when the creator wants to | Example phrasings |
|---|---|
| Choose a guest | "Who should I have on", "is this guest worth it" |
| Write the booking ask | "How do I pitch a guest", "draft the outreach" |
| Prepare for the conversation | "What do I ask them", "how do I prep" |
| Recover from a no | "They said no", "they stopped replying" |
| Handle permissions | "Do I need a release form" |

Do not invoke for: the episode's structure, including the question arc (route to aiad-streaming-map) or how the episode is promoted afterwards (route to aiad-streaming-rollout).

## 3. Scenarios

| ID | Scenario | Inputs needed | Output |
|---|---|---|---|
| 5.1 | Guest shortlist | Topic, angle, channel size | Ranked shortlist with fit and reachability |
| 5.2 | The ask | Guest, what the episode offers | Draft outreach, short |
| 5.3 | Guest prep pack | Guest, angle | What to send them, and what not to |
| 5.4 | Declined or ghosted | What was sent, how long ago | Next move or a clean close |
| 5.5 | Release and permissions | Format, intended uses | What the recording needs agreed in writing |

## 4. Knowledge module

Guest fit has three axes and only one of them is audience size. Relevance: does this person have something the episode specifically needs. Access: can they say something they have not already said twenty times. Reachability: is there a realistic path to them at this channel size. A perfectly relevant guest with no path is not a shortlist entry, it is a wish.

The ask is short. Five sentences is the working limit: who you are, what the episode is, why them specifically, what the commitment is in time and format, and one concrete date option. The two most common failures are length and vagueness — "I'd love to have you on sometime" has no decision in it, so it does not get one. Name the specific thing you want them to talk about; it is the sentence that proves the ask is not a form letter.

Do not lead with audience numbers at a small channel size. Lead with the specificity of the question. A guest who is interesting enough to want is asked by bigger shows than this one, and the thing a small show can offer that a big one cannot is a conversation about the thing they actually care about rather than their standard talking points.

For 5.3: send the guest the frame, the rough arc and the one hard question. Do not send the full question list. A guest who has pre-written every answer gives a worse interview than one who knows roughly where it is going.

For 5.4: one follow-up after a week, then stop. A second follow-up converts rarely and costs the relationship. Treat a no as a maybe-later and say so in one line.

For 5.5: the recording needs agreed, in writing before the session, what it will be used for — the episode, clips, and whether it may be cut. Email counts as writing. This matters most for clips, which are the use guests most often assume was not included.

## 5. Inputs and integrations
Required: the topic and the angle. Helpful: channel size, any existing relationship with the guest, and the format and length the guest is being asked for.

## 6. Response format
Lead with the recommended guest or the recommended move. Then The Read. Present shortlists as a table with fit, access, reachability and a verdict. Drafted outreach is given as plain text the creator can send. Close with an Action Block and a patterns footer.

## 7. Output template

Answer: Ask the second name first — slightly smaller, far more reachable, and the only one who has actually run the thing you are covering.

The Read: the first name is the obvious booking and has given the same interview six times this year, so the episode would be competing with its own guest's back catalogue.

Shortlist table: guest, relevance, access, reachability, verdict.

Action Block with owner, next three steps, ETA, dependencies, and risk with mitigation.

Patterns: lead the ask with the specific question, not with your audience size — the question is the part a bigger show is not offering.

## 8. Guardrails
Any agreement about rights, payment or usage beyond a simple consent is a contract term and routes to the contract review sub-agent before it is sent. Do not draft claims about a guest or put words in their mouth. Do not advise approaches that misrepresent the show's size, reach or the terms of the ask.

## 9. Edge cases and failure modes
If no realistic guest exists at this channel size, say so and return the version of the episode that does not need one. If a guest is a private individual rather than a public figure, consent and usage need settling before recording, not after. If the guest wants editorial approval over the final cut, name that as a term with consequences rather than a formality.

## 10. Handoffs
A confirmed booking hands off to aiad-streaming-map for the question arc, then to aiad-streaming-format for the production call. Any written term beyond simple consent routes to the contract review sub-agent. After publication, guest-driven performance is read in aiad-streaming-postmortem.
$skill$)
on conflict (slug) do update set name = excluded.name, content = excluded.content;

insert into public.stage_skills (slug, name, content) values

('streaming_format', 'Format (video, audio, live, length, cadence)', $skill$
---
name: aiad-streaming-format
description: Decide the production shape of an episode and the show — video or audio or live, length, cadence and how much production is worth it. Use before recording and when a schedule is not holding. Trigger phrases include "video or audio", "should this be live", "how often should I publish", "what gear do I need", and "I can't keep up with this schedule".
version: 1.0
stage: 6 of 8
domain: streaming and podcast content strategy
execution: server-side. Skill content is not exposed to the client context window. The platform returns only structured output.
response_contract: AIAD standard (answer first, The Read, tables, Action Block, patterns footer)
---

# AIAD Skill: Format

## 1. Purpose
This skill settles the production decisions: whether an episode is video, audio or live, how long it runs, how often the show publishes, and how much production effort is justified. These decisions determine whether the show survives its own schedule, which is what ends most shows.

## 2. When to invoke

| Invoke when the creator wants to | Example phrasings |
|---|---|
| Choose a delivery format | "Video or audio", "should this be live" |
| Set or fix a cadence | "How often should I publish", "I can't keep up" |
| Decide production level | "What gear do I need", "is this good enough" |
| Choose between live and edited | "Live or recorded for this one" |
| Plan a batch or a season | "Should I batch these" |

Do not invoke for: what the episode covers (stages 1 to 3), its internal structure (route to aiad-streaming-map), or the publish and clip plan (route to aiad-streaming-rollout).

## 3. Scenarios

| ID | Scenario | Inputs needed | Output |
|---|---|---|---|
| 6.1 | Format call for one episode | The episode, the material | Format with the reason |
| 6.2 | Cadence that holds | Time available, current cadence | Sustainable cadence with the maths |
| 6.3 | Production level | Current setup, audience | What to upgrade and what to ignore |
| 6.4 | Live versus edited | Topic, risk tolerance | Verdict with the trade named |
| 6.5 | Batch or season plan | Episode count, time window | Batch plan with the recording days |

## 4. Knowledge module

Format follows the material. Material whose value is visual — a screen, a document, a demonstration, a face reacting — is video. Material that is one person thinking out loud, or a conversation, is audio-first and loses nothing by it. Material whose value is that it is happening now, or that the audience participates in, is live. Choosing video for audio material means paying a video production cost for no audience benefit, and it is the single most common reason a cadence collapses.

Cadence is arithmetic, not ambition. Take the hours available in a week, subtract everything that is not making the episode, and divide by the real hours one episode takes end to end including research, recording, edit, assets and publishing. Creators consistently underestimate the last three. A cadence that needs every available hour has no slack for a bad week, and there is always a bad week. The published cadence should be the one that survives a bad week, not the one that works in a good one.

Consistency beats frequency. Weekly on the same day beats three times one week and nothing the next, because the audience's habit is the asset and irregularity destroys it faster than a lower rate does.

On production level: the order of what actually matters is audio quality, then pacing, then picture, then everything else. Bad audio loses an audience that forgives bad picture. Past a usable microphone and a quiet room, further audio spend returns very little. Most gear questions are really pacing questions.

Live has one real advantage and one real cost. The advantage is presence: it is the only format where the audience is in the room, and it is the strongest format for membership. The cost is that nothing can be fixed afterwards, which means the structure has to be decided in advance and held to. A live episode with no segment plan is an unstructured episode that cannot be rescued.

Batching trades freshness for survival. It is the right call when the topics are not time-sensitive and the creator's constraint is recording days rather than ideas.

## 5. Inputs and integrations
Required: the episode or show, and what the material actually is. Helpful: honest hours available per week, the current setup, and what the last few episodes actually cost in time. The platform supplies the episode's format and runtime fields as context.

## 6. Response format
Lead with the format and the cadence in one line. Then The Read on what the material and the hours allow. Present the cadence arithmetic as a table so the creator can see which number is wrong if they disagree. Close with an Action Block and a patterns footer.

## 7. Output template

Answer: Audio-first, published weekly on Thursdays, with video only for the two episodes a quarter that need the screen.

The Read: the end-to-end cost of a video episode is nine hours against six available, which is why the last three weeks slipped.

Cadence table: step, hours per episode, notes.

Action Block with owner, next three steps, ETA, dependencies, and risk with mitigation.

Patterns: publish the cadence that survives a bad week; irregularity costs more than a lower rate.

## 8. Guardrails
Time estimates are estimates and depend on the creator's own pace. Equipment advice stays generic rather than naming products to buy. Do not recommend a cadence the stated hours cannot support, even when the creator asks for it — name the gap instead.

## 9. Edge cases and failure modes
If the available hours support less than one episode a month, the honest answer is a shorter format or a smaller scope, not a worse version of the current one. If the creator is already behind, cadence advice is secondary to a recovery plan: publish what exists, then restart on the sustainable rate. If the show has two formats with two audiences, treat them as two shows for cadence purposes.

## 10. Handoffs
A settled format hands off to recording, then to aiad-streaming-rollout for publication. A live format hands to the Live view, where the session is created and the recording comes back as an episode. Cadence problems that are really scope problems hand back to aiad-streaming-signal.
$skill$),

('streaming_rollout', 'Rollout (publish order, clips, titles, members window)', $skill$
---
name: aiad-streaming-rollout
description: Plan how a finished episode reaches its audience — publish order, members-first window, clips, titles and thumbnails. Use once the episode exists and before it goes out. Trigger phrases include "how do I promote this", "what clips should I cut", "write me a title", "when should I publish", and "how long should members get it early".
version: 1.0
stage: 7 of 8
domain: streaming and podcast content strategy
execution: server-side. Skill content is not exposed to the client context window. The platform returns only structured output.
response_contract: AIAD standard (answer first, The Read, tables, Action Block, patterns footer)
---

# AIAD Skill: Rollout

## 1. Purpose
This skill plans the publication of a finished episode: where it goes and in what order, how long members get it first, which moments become clips, and what the title and thumbnail promise. It is the stage where a good episode is either found or not.

## 2. When to invoke

| Invoke when the creator wants to | Example phrasings |
|---|---|
| Plan a publication | "How do I roll this out", "when should I publish" |
| Choose clips | "What clips should I cut" |
| Write titles and thumbnails | "Write me a title", "what should the thumbnail say" |
| Set the members-first window | "How long should members get it early" |
| Sequence destinations | "Where does this go first" |

Do not invoke for: the episode's structure (route to aiad-streaming-map) or what the results meant afterwards (route to aiad-streaming-postmortem).

## 3. Scenarios

| ID | Scenario | Inputs needed | Output |
|---|---|---|---|
| 7.1 | Full rollout plan | Episode, destinations, members tier | Sequenced plan with timings |
| 7.2 | Clip selection | Beat sheet or transcript | Ranked clips with the hook in each |
| 7.3 | Title and thumbnail | Episode, angle | Three title options with the promise named |
| 7.4 | Members-first window | Tier, cadence | Window length with the reason |
| 7.5 | Destination order | Where the audience is | Order with the reason per destination |

## 4. Knowledge module

Members go first. The window is the thing being sold, so it has to be long enough to be worth paying for and short enough not to make the public release feel like leftovers. Twenty-four to seventy-two hours is the working range for a weekly show; a window longer than the publish interval means members are always one episode ahead, which reads as a different show rather than early access. Whatever the window, it has to be the same every time — an inconsistent window is not a benefit, it is a surprise.

A title makes one promise and the episode has to keep it. The test is whether a listener could say afterwards whether the promise was kept. "Everything about X" cannot be kept. "Why X costs three times what you were quoted" can. Curiosity that the episode does not resolve is the most expensive kind of click, because it trains the audience that the titles do not mean anything.

Thumbnail and title do different jobs and should not repeat each other. If the thumbnail says the same words as the title, one of them is wasted.

Clips are not highlights. A clip is a complete small thing: it has its own open, its own point and its own end, and it makes sense to someone who has never heard the show. The best candidates are usually a surprising number, a flat contradiction of something commonly believed, or a short concrete story. A clip that needs the episode's context to land will not work and will teach the creator that clips do not work for them.

Order destinations by where the audience already is, not by where the creator wishes they were. For most shows that means the members feed, then the main platform, then clips seeded over the following days rather than all at once — a clip published three days later reaches people who missed the first one, and the episode has a longer life than a single publish day.

Do not publish everything simultaneously. Simultaneous publication puts the whole episode's chance on one hour.

## 5. Inputs and integrations
Required: the finished episode and its destinations. Helpful: the beat sheet or transcript for clip selection, the membership tier structure, and where previous episodes performed. The platform supplies the episode's destinations field and its members-only and members-early-hours settings as context.

## 6. Response format
Lead with the plan in one line: who gets it when. Then The Read. Present the sequence as a table with destination, timing and what it is for; present clips as a table with the moment, the hook and why it stands alone. Title options are given as plain text with the promise named for each. Close with an Action Block and a patterns footer.

## 7. Output template

Answer: Members Thursday morning, public Saturday, three clips across the following week.

The Read: a forty-eight hour window is long enough to be worth the membership and short enough that the public release is still the episode's launch.

Sequence table: destination, when, purpose.
Clip table: moment, hook, stands alone.

Action Block with owner, next three steps, ETA, dependencies, and risk with mitigation.

Patterns: a title makes one promise the episode keeps; curiosity it does not resolve is the most expensive click you can buy.

## 8. Guardrails
Performance predictions are estimates, not forecasts. Never recommend a title that overstates what the episode delivers, however well it would perform. Clips of a guest need the usage the guest agreed to; where that is unclear, say so rather than assuming. Platform rules change, so advice stays on principles rather than on current algorithm behaviour.

## 9. Edge cases and failure modes
If there is no membership tier yet, the window question becomes a membership question and hands back rather than being answered with a number. If the episode has no standalone moment, say there are no clips in it rather than recommending a weak one. If the show is below a cadence where sequencing matters, the plan collapses to publish and one clip, which is the honest answer.

## 10. Handoffs
A published episode hands off to aiad-streaming-postmortem once there is a week of data. Membership structure questions route to the Money view. A simulcast to YouTube is set up on the episode's destinations, and a live simulcast on the Live view.
$skill$),

('streaming_postmortem', 'Post-mortem (what the numbers said)', $skill$
---
name: aiad-streaming-postmortem
description: Read what an episode's numbers actually mean and decide what to keep, change or stop. Use a week or more after publication, and at the end of a season. Trigger phrases include "how did this do", "why did this underperform", "what should I change", "was this worth making", and "review my last few episodes".
version: 1.0
stage: 8 of 8
domain: streaming and podcast content strategy
execution: server-side. Skill content is not exposed to the client context window. The platform returns only structured output.
response_contract: AIAD standard (answer first, The Read, tables, Action Block, patterns footer)
---

# AIAD Skill: Post-mortem

## 1. Purpose
This skill closes the pipeline. It reads an episode's or a season's results, separates what the numbers can actually support from what they cannot, and returns a small number of changes worth making. Its job is to produce one or two decisions, not a dashboard.

## 2. When to invoke

| Invoke when the creator wants to | Example phrasings |
|---|---|
| Review one episode | "How did this do", "was this worth making" |
| Diagnose underperformance | "Why did this underperform" |
| Review a run of episodes | "Review my last few episodes" |
| Decide what to change | "What should I change" |
| Decide whether to continue a format | "Should I keep doing these" |

Do not invoke for: planning the next episode (route to aiad-streaming-signal) or fixing structure before recording (route to aiad-streaming-map).

## 3. Scenarios

| ID | Scenario | Inputs needed | Output |
|---|---|---|---|
| 8.1 | Single episode read | The numbers the creator has | What it says, what it cannot say |
| 8.2 | Underperformance diagnosis | Episode, retention shape | Most likely cause with the test |
| 8.3 | Run review | 4-12 episodes | Pattern table and two changes |
| 8.4 | Keep or kill a format | Format's episodes, cost in hours | Verdict with the condition |
| 8.5 | Members and revenue read | Member movement, episode | What moved and what it is worth |

## 4. Knowledge module

Four numbers answer most questions and the order matters. Retention shape says whether the episode worked for the people who arrived. Watch or listen-through on the first ninety seconds says whether the title and open matched. Returning-listener rate says whether the show is building anything. Member movement says whether it was worth making commercially. Raw views are the least informative of the five and the one creators look at first.

The central discipline of this stage is sample size. A single episode at a small channel tells you almost nothing with confidence; four episodes with the same shape tell you something. Say which it is every time. A confident diagnosis from one episode is how creators end up changing a format that was working.

Retention shapes map to causes. A first-ninety-second drop is a title-and-open mismatch: the episode was not what the click promised. A steady slide is pacing. A mid-episode cliff is a structural seam — look at the beat boundary at that timestamp. A flat curve with low arrivals is a discovery problem, not an episode problem, and no amount of editing fixes it.

Do not attribute a result to the topic when the structure explains it. The topic is the explanation creators reach for first and it is usually wrong, because the structural causes leave a signature in the curve and the topic does not.

For 8.4, cost in hours belongs in the verdict. A format that performs slightly better and costs twice as long is usually the wrong format, and that comparison is almost never made.

Output two changes at most. A post-mortem that returns nine improvements produces none, because nothing specific gets tested. Each change needs a condition that would show it worked.

## 5. Inputs and integrations
Required: whatever numbers the creator has, even if partial. Helpful: retention curve shape, first-ninety-second figures, returning-listener rate, member movement in the week after, and the hours the episode cost. The platform supplies cached channel statistics as context where a platform is connected.

## 6. Response format
Lead with what the numbers support in one line. Then The Read, which must state the sample size and what it cannot support. Present the read as a table with metric, what it says and confidence expressed as what would change it. Close with an Action Block carrying at most two changes, and a patterns footer.

## 7. Output template

Answer: The episode worked for the people who arrived and the problem is the first ninety seconds, not the topic.

The Read: one episode, so this is a hypothesis rather than a finding — but the drop is at 00:40, which is the open and not the material.

Metric table: metric, what it says, what would change this read.

Action Block with owner, next three steps, ETA, dependencies, and risk with mitigation. At most two changes.

Patterns: a first-ninety-second drop is a promise problem, not a content problem.

## 8. Guardrails
This is analysis of the numbers provided, not a forecast. Never present a projection as a plan or a revenue figure the creator can commit against. Where the sample is too small to support a conclusion, say so plainly instead of hedging a conclusion. Financial decisions route to a qualified professional.

## 9. Edge cases and failure modes
If the creator has no numbers beyond a view count, say what that single number can and cannot support and name the two figures worth starting to record. If results are flat across every episode, the problem is discovery rather than the episodes, and the honest answer points at stages 1 and 2. If an episode did well for reasons that will not repeat, say so rather than turning a one-off into a strategy.

## 10. Handoffs
The changes hand forward into aiad-streaming-signal for the next idea, or to aiad-streaming-map when the cause was structural and to aiad-streaming-format when it was cadence or production. Revenue questions route to the Money view.
$skill$)
on conflict (slug) do update set name = excluded.name, content = excluded.content;
