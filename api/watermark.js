// Burns the AIAD mark into a posted video, the way _watermarkImageFile burns it into a
// photo. Canvas cannot touch video and iOS Safari has no captureStream, so the encode has
// to happen off the device. Called fire-and-forget straight after the post insert; the
// client never waits on it and never surfaces a failure, so every exit here is a plain
// JSON body rather than something a caller has to interpret.
//
// Everything talks to Supabase as the USER, with the bearer token they sent. There is no
// service-role key in this file on purpose: RLS is the only thing deciding whether this
// request may touch the row and the bucket.
import { createClient } from '@supabase/supabase-js';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hobby is capped at 300s and this project is on Hobby, so this is the ceiling, not a guess.
export const config = { maxDuration: 300 };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uapiytquwuhtewqieegx.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhcGl5dHF1d3VodGV3cWllZWd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NzcwMTksImV4cCI6MjA4OTI1MzAxOX0.BLs2RdStghm0_cF8t70cBTX1GWcowGRwID7TAG8Mg38';

const BUCKET = 'artist-media';
const MAX_BYTES = 200 * 1024 * 1024;   // 200MB
const MAX_SECONDS = 120;

// Same geometry as _watermarkImageFile: bottom-left, padding 4.5% of the short edge.
const MARK_WIDTH_FRACTION = 0.22;
const PAD_FRACTION = 0.045;

const MARK_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'aiad-mark.png');

function send(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
}

// Returns { code, stderr }. Never rejects on a non-zero exit — callers decide what that means.
function runFfmpeg(args, timeoutMs) {
    return new Promise(function (resolve, reject) {
        const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        let done = false;
        const timer = setTimeout(function () {
            if (!done) { done = true; proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }
        }, timeoutMs);
        // ffmpeg writes its stream summary to stderr; cap it so a chatty encode cannot
        // grow without bound while we wait.
        proc.stderr.on('data', function (d) { if (stderr.length < 200000) stderr += d.toString(); });
        proc.on('error', function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } });
        proc.on('close', function (code) { if (!done) { done = true; clearTimeout(timer); resolve({ code: code, stderr: stderr }); } });
    });
}

// ffmpeg-static ships ffmpeg but not ffprobe, so the probe is ffmpeg reading the file with
// no output: it prints Duration and the video stream line to stderr and exits non-zero.
export function parseProbe(stderr) {
    const out = { seconds: null, width: null, height: null };
    const d = stderr.match(/Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/);
    if (d) out.seconds = (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);
    // Take the dimensions off a Video stream line, not the first NxN anywhere in the log.
    const v = stderr.match(/Stream #\d+:\d+[^\n]*: Video:[^\n]*?(\d{2,5})x(\d{2,5})/);
    if (v) { out.width = +v[1]; out.height = +v[2]; }
    return out;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });

    // ---- auth: the user's token, verified, or nothing ----
    const auth = req.headers.authorization || req.headers.Authorization || '';
    const token = /^Bearer\s+(.+)$/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
    if (!token) return send(res, 401, { error: 'unauthorized' });

    const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: 'Bearer ' + token } }
    });

    let user = null;
    try {
        const got = await supa.auth.getUser(token);
        user = got && got.data && got.data.user;
        if (got && got.error) user = null;
    } catch (e) { user = null; }
    if (!user || !user.id) return send(res, 401, { error: 'unauthorized' });

    // Second half of the launch-era branding switch (the first is window.AIAD_WATERMARK in
    // index.html). Setting WATERMARK_ENABLED=false in the Vercel project env stops marking
    // new uploads with no client deploy at all. Unset means enabled, so a missing var can
    // never silently turn branding off. Nothing already stored is touched either way —
    // originals keep their own URLs, so this is reversible by flipping the var back.
    // Deliberately after the auth check: killing the feature must not turn this into an
    // endpoint that answers 200 to anonymous callers.
    if (process.env.WATERMARK_ENABLED === 'false') return send(res, 200, { skipped: true });

    // ---- input ----
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad_request' });

    const postId = String(body.postId || '');
    const itemIndex = Number(body.itemIndex);
    const videoUrl = String(body.videoUrl || '');
    if (!postId || !videoUrl || !Number.isInteger(itemIndex) || itemIndex < 0) {
        return send(res, 400, { error: 'bad_request' });
    }
    // Only ever pull media back out of our own storage origin.
    if (videoUrl.indexOf(SUPABASE_URL + '/storage/v1/object/public/') !== 0) {
        return send(res, 400, { error: 'unsupported_source', url: videoUrl });
    }

    let dir = null;
    try {
        // ---- the row must be one RLS lets this user read and own ----
        const read = await supa.from('artist_posts').select('media,user_id').eq('id', postId).single();
        if (read.error || !read.data) return send(res, 404, { error: 'post_not_found' });
        if (read.data.user_id !== user.id) return send(res, 403, { error: 'forbidden' });

        let media = read.data.media;
        if (typeof media === 'string') { try { media = JSON.parse(media); } catch (e) { media = null; } }
        if (!Array.isArray(media) || !media[itemIndex]) return send(res, 400, { error: 'no_such_item' });

        // ---- size gate before anything lands on disk ----
        const head = await fetch(videoUrl, { method: 'HEAD' });
        if (!head.ok) return send(res, 200, { watermarked: false, url: videoUrl, reason: 'source_unreachable' });
        const declared = Number(head.headers.get('content-length') || 0);
        if (declared > MAX_BYTES) {
            return send(res, 200, { watermarked: false, url: videoUrl, reason: 'too_large' });
        }

        dir = await mkdtemp(join(tmpdir(), 'aiad-wm-'));
        const inPath = join(dir, 'in.mp4');
        const outPath = join(dir, 'out.mp4');

        const dl = await fetch(videoUrl);
        if (!dl.ok) return send(res, 200, { watermarked: false, url: videoUrl, reason: 'source_unreachable' });
        const buf = Buffer.from(await dl.arrayBuffer());
        // A server that declared no length still has to fit under the cap.
        if (buf.length > MAX_BYTES) {
            return send(res, 200, { watermarked: false, url: videoUrl, reason: 'too_large' });
        }
        await writeFile(inPath, buf);

        // ---- probe ----
        const probe = await runFfmpeg(['-hide_banner', '-i', inPath], 60000);
        const info = parseProbe(probe.stderr);
        if (!info.width || !info.height) {
            return send(res, 200, { watermarked: false, url: videoUrl, reason: 'undecodable' });
        }
        if (info.seconds != null && info.seconds > MAX_SECONDS) {
            return send(res, 200, { watermarked: false, url: videoUrl, reason: 'too_long' });
        }

        // ---- overlay ----
        const markW = Math.max(1, Math.round(info.width * MARK_WIDTH_FRACTION));
        const pad = Math.round(Math.min(info.width, info.height) * PAD_FRACTION);
        const filter = '[1:v]scale=' + markW + ':-1[wm];'
            + '[0:v][wm]overlay=' + pad + ':main_h-overlay_h-' + pad + ':format=auto[v]';

        const enc = await runFfmpeg([
            '-hide_banner', '-nostdin', '-y',
            '-i', inPath,
            '-i', MARK_PATH,
            '-filter_complex', filter,
            '-map', '[v]',
            '-map', '0:a?',              // silent clips must not fail the encode
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-pix_fmt', 'yuv420p',       // iOS and Instagram both reject 4:4:4
            '-profile:v', 'high', '-level', '4.0',
            '-c:a', 'copy',
            '-movflags', '+faststart',
            outPath
        ], 240000);

        if (enc.code !== 0) {
            console.warn('[watermark] ffmpeg exit', enc.code, enc.stderr.slice(-800));
            return send(res, 200, { watermarked: false, url: videoUrl, reason: 'encode_failed' });
        }
        const outStat = await stat(outPath).catch(function () { return null; });
        if (!outStat || !outStat.size) {
            return send(res, 200, { watermarked: false, url: videoUrl, reason: 'encode_empty' });
        }

        // ---- store it under the user's own prefix so the update policy matches on re-runs ----
        // The marked copy goes to its OWN path and the original is never touched: uploads
        // land under posts/<uid>/, this lands under <uid>/watermarked/, and media[i].url
        // keeps pointing at the original. That separation is the whole reason the branding
        // can be switched off later without re-encoding or restoring anything, so the
        // upsert below must never be pointed at an upload path.
        const path = user.id + '/watermarked/' + postId + '-' + itemIndex + '.mp4';
        const up = await supa.storage.from(BUCKET).upload(path, await readFile(outPath), {
            contentType: 'video/mp4',
            upsert: true
        });
        if (up.error) {
            console.warn('[watermark] upload failed', up.error.message);
            return send(res, 200, { watermarked: false, url: videoUrl, reason: 'upload_failed' });
        }
        const publicUrl = SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + path;

        // ---- read/modify/write the jsonb array, keeping every other item intact ----
        const next = media.slice();
        // Add a field; never rewrite url. The original stays addressable forever.
        next[itemIndex] = Object.assign({}, next[itemIndex], { watermarked_url: publicUrl });
        const wrote = await supa.from('artist_posts').update({ media: next }).eq('id', postId);
        if (wrote.error) {
            console.warn('[watermark] media update failed', wrote.error.message);
            return send(res, 200, { watermarked: false, url: videoUrl, reason: 'row_update_failed' });
        }

        return send(res, 200, { watermarked: true, url: publicUrl });
    } catch (e) {
        console.warn('[watermark] ' + (e && e.message));
        return send(res, 200, { watermarked: false, url: videoUrl, reason: 'error' });
    } finally {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(function () {});
    }
}
