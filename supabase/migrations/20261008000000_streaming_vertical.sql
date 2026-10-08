-- ══════════════════════════════════════════════════════════════════════════
-- STREAMING VERTICAL — live sessions + YouTube connection
-- Additive only. Nothing here drops, renames or alters an existing object.
--
-- Two of these four tables hold secrets that must never reach a browser:
-- live_session_secrets (Cloudflare ingest URL + stream key) and youtube_tokens
-- (OAuth access/refresh). RLS has no column filter, so a "stream_key" column on
-- live_sessions would be readable by any policy that let the owner read the row.
-- The secrets therefore live in their own tables with RLS on, ZERO policies and
-- no grants to anon or authenticated — service_role (which bypasses RLS) only.
--
-- Grants: PUBLIC holds table grants on this database and `anon` inherits them,
-- so revoking from anon alone leaves the table reachable. Every table below
-- revokes from PUBLIC *and* anon, then re-grants explicitly. The final SELECT
-- re-checks the result with has_table_privilege rather than assuming.
-- ══════════════════════════════════════════════════════════════════════════

-- ── live_sessions ────────────────────────────────────────────────────────
create table if not exists public.live_sessions (
    id                     uuid primary key default gen_random_uuid(),
    user_id                uuid not null default auth.uid()
                             references auth.users (id) on delete cascade,
    episode_id             uuid references public.episodes (id) on delete set null,
    title                  text,
    status                 text not null default 'scheduled'
                             check (status in ('scheduled', 'live', 'ended', 'errored')),
    scheduled_for          timestamptz,
    started_at             timestamptz,
    ended_at               timestamptz,
    provider               text not null default 'cloudflare',
    provider_live_input_id text,
    playback_url           text,
    recording_url          text,
    thumbnail_url          text,
    members_only           boolean not null default false,
    peak_viewers           integer not null default 0,
    total_views            integer not null default 0,
    -- jsonb array of { target, status, url } — the simulcast fan-out targets.
    simulcast              jsonb not null default '[]'::jsonb
                             check (jsonb_typeof(simulcast) = 'array'),
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now()
);

create index if not exists live_sessions_user_created_idx
    on public.live_sessions (user_id, created_at desc);
create index if not exists live_sessions_episode_idx
    on public.live_sessions (episode_id);
-- The "am I already live?" lookup the pre-flight card runs on open.
create index if not exists live_sessions_user_status_idx
    on public.live_sessions (user_id, status);

drop trigger if exists live_sessions_touch on public.live_sessions;
create trigger live_sessions_touch before update on public.live_sessions
    for each row execute function public.tg_touch_updated_at();

alter table public.live_sessions enable row level security;

drop policy if exists live_sessions_select_own on public.live_sessions;
create policy live_sessions_select_own on public.live_sessions
    for select using (user_id = auth.uid());
drop policy if exists live_sessions_insert_own on public.live_sessions;
create policy live_sessions_insert_own on public.live_sessions
    for insert with check (user_id = auth.uid());
drop policy if exists live_sessions_update_own on public.live_sessions;
create policy live_sessions_update_own on public.live_sessions
    for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists live_sessions_delete_own on public.live_sessions;
create policy live_sessions_delete_own on public.live_sessions
    for delete using (user_id = auth.uid());

revoke all on public.live_sessions from public;
revoke all on public.live_sessions from anon;
grant select, insert, update, delete on public.live_sessions to authenticated;
grant all on public.live_sessions to service_role;

-- ── live_session_secrets — service_role only ─────────────────────────────
-- The stream key is a write credential: anyone holding it can broadcast as this
-- creator. It is returned by the Cloudflare API once, written here by the
-- `live-session` edge function under the service role, and never selected by a
-- client. The function hands the browser the playback URL and nothing else.
create table if not exists public.live_session_secrets (
    session_id uuid primary key
                 references public.live_sessions (id) on delete cascade,
    ingest_url text,
    stream_key text,
    created_at timestamptz not null default now()
);

alter table public.live_session_secrets enable row level security;
-- Deliberately zero policies. RLS on with no policy denies every non-superuser
-- role that does not bypass RLS, which is exactly service_role and nothing else.

revoke all on public.live_session_secrets from public;
revoke all on public.live_session_secrets from anon;
revoke all on public.live_session_secrets from authenticated;
grant all on public.live_session_secrets to service_role;

-- ── youtube_connections — the client-readable channel facts ──────────────
create table if not exists public.youtube_connections (
    user_id          uuid primary key
                       references auth.users (id) on delete cascade,
    channel_id       text,
    channel_title    text,
    channel_handle   text,
    thumbnail_url    text,
    subscriber_count bigint,
    video_count      bigint,
    view_count       bigint,
    scopes           text,
    connected_at     timestamptz not null default now(),
    last_synced_at   timestamptz
);

alter table public.youtube_connections enable row level security;

drop policy if exists youtube_connections_select_own on public.youtube_connections;
create policy youtube_connections_select_own on public.youtube_connections
    for select using (user_id = auth.uid());
drop policy if exists youtube_connections_insert_own on public.youtube_connections;
create policy youtube_connections_insert_own on public.youtube_connections
    for insert with check (user_id = auth.uid());
drop policy if exists youtube_connections_update_own on public.youtube_connections;
create policy youtube_connections_update_own on public.youtube_connections
    for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists youtube_connections_delete_own on public.youtube_connections;
create policy youtube_connections_delete_own on public.youtube_connections
    for delete using (user_id = auth.uid());

revoke all on public.youtube_connections from public;
revoke all on public.youtube_connections from anon;
grant select, insert, update, delete on public.youtube_connections to authenticated;
grant all on public.youtube_connections to service_role;

-- ── youtube_tokens — service_role only ───────────────────────────────────
create table if not exists public.youtube_tokens (
    user_id       uuid primary key
                    references auth.users (id) on delete cascade,
    access_token  text,
    refresh_token text,
    expires_at    timestamptz,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

drop trigger if exists youtube_tokens_touch on public.youtube_tokens;
create trigger youtube_tokens_touch before update on public.youtube_tokens
    for each row execute function public.tg_touch_updated_at();

alter table public.youtube_tokens enable row level security;
-- Zero policies, same reasoning as live_session_secrets.

revoke all on public.youtube_tokens from public;
revoke all on public.youtube_tokens from anon;
revoke all on public.youtube_tokens from authenticated;
grant all on public.youtube_tokens to service_role;

-- ── Streaming self-reported numbers ──────────────────────────────────────
-- record_self_reported_stats() has a fixed nine-argument signature built around
-- Spotify monthly listeners, which a streaming creator does not have. Rather
-- than widen that function (and change a signature three call sites depend on),
-- this writes the streaming figures into the same artist_stats.self_reported
-- jsonb under their own keys. Same merge rule: nulls are stripped, so a blank
-- field never clobbers a saved number.
create or replace function public.record_streaming_stats(
    p_youtube_handle             text   default null,
    p_youtube_subscribers        bigint default null,
    p_youtube_views              bigint default null,
    p_youtube_watch_hours        bigint default null,
    p_spotify_podcast_followers  bigint default null,
    p_apple_podcasts_followers   bigint default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    v_uid    uuid := auth.uid();
    v_new    jsonb;
    v_merged jsonb;
begin
    if v_uid is null then
        raise exception 'not authenticated';
    end if;

    v_new := jsonb_strip_nulls(jsonb_build_object(
        'youtube_subscribers',       p_youtube_subscribers,
        'youtube_views',             p_youtube_views,
        'youtube_watch_hours',       p_youtube_watch_hours,
        'spotify_podcast_followers', p_spotify_podcast_followers,
        'apple_podcasts_followers',  p_apple_podcasts_followers
    ));

    insert into public.artist_stats (user_id, youtube_handle, self_reported, updated_at)
    values (
        v_uid,
        p_youtube_handle,
        v_new || jsonb_build_object('source', 'streaming', 'updated_at', now()),
        now()
    )
    on conflict (user_id) do update set
        youtube_handle = coalesce(excluded.youtube_handle, artist_stats.youtube_handle),
        self_reported  = coalesce(artist_stats.self_reported, '{}'::jsonb) || v_new
                           || jsonb_build_object('source', 'streaming', 'updated_at', now()),
        updated_at     = now()
    returning self_reported into v_merged;

    return v_merged;
end;
$$;

revoke all on function public.record_streaming_stats(text, bigint, bigint, bigint, bigint, bigint) from public;
revoke all on function public.record_streaming_stats(text, bigint, bigint, bigint, bigint, bigint) from anon;
grant execute on function public.record_streaming_stats(text, bigint, bigint, bigint, bigint, bigint) to authenticated, service_role;
