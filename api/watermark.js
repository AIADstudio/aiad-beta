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

// The composer's six presets, as ffmpeg.
//
// CSS filters are matrix and affine operations in sRGB. ffmpeg's eq works in YUV, so
// eq=saturation=0 is NOT the same grey as CSS saturate(0) — measured against a solid
// patch it came out 86,89,85 where the browser produced 72,72,72. So saturate, sepia and
// hue-rotate are done here as a single colorchannelmixer using exactly the coefficients
// the CSS Filter Effects spec defines, which is the same arithmetic the browser runs.
// Only brightness and contrast are left to eq; both are small adjustments in these
// presets, and the residual difference is under a couple of levels.
//
// The preview is still a preview: this is close, not bit-identical.
const REC709 = [0.2126, 0.7152, 0.0722];

function mul(A, B) {                       // 3x3 * 3x3
    const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
        o[r][c] = A[r][0] * B[0][c] + A[r][1] * B[1][c] + A[r][2] * B[2][c];
    return o;
}
const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

// CSS saturate(s): luminance-preserving, Rec.709.
function satMatrix(s) {
    const [lr, lg, lb] = REC709;
    return [
        [lr + (1 - lr) * s, lg - lg * s,       lb - lb * s],
        [lr - lr * s,       lg + (1 - lg) * s, lb - lb * s],
        [lr - lr * s,       lg - lg * s,       lb + (1 - lb) * s]
    ];
}
// CSS sepia(a): identity mixed `a` of the way toward the spec's sepia matrix.
function sepiaMatrix(a) {
    const m = [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]];
    const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
        o[r][c] = IDENTITY[r][c] + (m[r][c] - IDENTITY[r][c]) * a;
    return o;
}
// CSS hue-rotate(deg), straight from the spec's matrix.
function hueMatrix(deg) {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    return [
        [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
        [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
        [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]
    ];
}
function mixer(M) {
    const f = (n) => n.toFixed(4);
    return 'colorchannelmixer=rr=' + f(M[0][0]) + ':rg=' + f(M[0][1]) + ':rb=' + f(M[0][2])
         + ':gr=' + f(M[1][0]) + ':gg=' + f(M[1][1]) + ':gb=' + f(M[1][2])
         + ':br=' + f(M[2][0]) + ':bg=' + f(M[2][1]) + ':bb=' + f(M[2][2]);
}

// Same numbers the composer's VPRESETS carry, in the order CSS applies them:
// brightness, contrast, saturate, sepia, hue-rotate.
function chainFor(b, c, sat, sepia, hue) {
    const parts = [];
    // Contrast is the only part left to eq. Brightness is a pure per-channel multiply, so
    // it folds into the matrix below and costs nothing in accuracy.
    if (c !== 100) parts.push('eq=contrast=' + (c / 100).toFixed(4));
    let M = satMatrix(sat / 100);
    if (sepia) M = mul(sepiaMatrix(sepia / 100), M);
    if (hue) M = mul(hueMatrix(hue), M);
    if (b !== 100) {
        const k = b / 100;
        M = M.map(function (row) { return row.map(function (v) { return v * k; }); });
    }
    // Only emit the matrix when it is not the identity.
    const isId = M.every((row, r) => row.every((v, cc) => Math.abs(v - IDENTITY[r][cc]) < 0.0005));
    if (!isId) parts.push(mixer(M));
    return parts.length ? parts.join(',') : null;
}

const FILTER_PRESETS = {
    none: null,
    mono: chainFor(105, 112, 0,   0,  0),
    fade: chainFor(108, 82,  88,  8,  0),
    warm: chainFor(103, 106, 112, 30, 0),
    cold: chainFor(100, 108, 96,  0,  -12),
    film: chainFor(98,  118, 86,  14, 4)
};

// Everything here arrives from a jsonb column the user controls, so nothing is passed
// through: the filter is chosen from a fixed table by key, and the times are clamped
// numbers. A value that is not a finite number, or a filter key that is not one of the
// six, is dropped rather than sanitised into something adjacent.
function normaliseEdit(raw, durationSeconds) {
    const out = { trimStart: 0, trimEnd: null, filterChain: null, coverTime: null };
    if (!raw || typeof raw !== 'object') return out;

    const dur = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null;
    const num = function (v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; };

    let a = num(raw.trimStart), b = num(raw.trimEnd);
    if (a != null && a > 0) out.trimStart = dur ? Math.min(a, dur) : a;
    if (b != null && b > 0) out.trimEnd = dur ? Math.min(b, dur) : b;
    // A trim that ends before it starts, or selects nothing, is not a trim.
    if (out.trimEnd != null && out.trimEnd - out.trimStart < 0.1) { out.trimStart = 0; out.trimEnd = null; }
    // A trim covering the whole clip is not worth the argument.
    if (out.trimEnd != null && dur && out.trimStart === 0 && out.trimEnd >= dur - 0.05) out.trimEnd = null;

    if (typeof raw.filter === 'string' && Object.prototype.hasOwnProperty.call(FILTER_PRESETS, raw.filter)) {
        out.filterChain = FILTER_PRESETS[raw.filter];
    }

    const c = num(raw.coverTime);
    if (c != null && c >= 0) out.coverTime = dur ? Math.min(c, dur) : c;
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
        const posterPath = join(dir, 'poster.jpg');

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

        // ---- the artist's edit, collected in the composer and applied here ----
        // The browser never re-encodes: a phone cannot trim and filter a clip without
        // freezing, so the composer previews with CSS and a seek and stores intent only.
        // This is where that intent becomes the file.
        const edit = normaliseEdit(media[itemIndex] && media[itemIndex].edit, info.seconds);

        // ---- one pass: trim, colour, overlay, poster ----
        const markW = Math.max(1, Math.round(info.width * MARK_WIDTH_FRACTION));
        const pad = Math.round(Math.min(info.width, info.height) * PAD_FRACTION);

        // The colour grade runs before the mark is composited, so the mark itself is never
        // tinted by the artist's filter.
        const grade = edit.filterChain ? ('[0:v]' + edit.filterChain + '[g];') : '';
        const base = edit.filterChain ? '[g]' : '[0:v]';
        const wantMark = process.env.WATERMARK_ENABLED !== 'false';
        // A filter_complex label feeds exactly one output, so the graph has to split:
        // [v] encodes the clip and [vp] supplies the single poster frame. Mapping [v]
        // twice is rejected outright ("already used elsewhere"), not silently ignored.
        const composed = wantMark
            ? (grade + '[1:v]scale=' + markW + ':-1[wm];'
               + base + '[wm]overlay=' + pad + ':main_h-overlay_h-' + pad + ':format=auto[vo]')
            : (edit.filterChain ? ('[0:v]' + edit.filterChain + '[vo]') : '[0:v]null[vo]');
        const filter = composed + ';[vo]split=2[v][vp]';

        // -ss and -to before -i so the seek is done by demuxing rather than by decoding
        // and discarding every frame up to the in-point.
        const trimArgs = [];
        if (edit.trimStart > 0) trimArgs.push('-ss', String(edit.trimStart));
        if (edit.trimEnd != null) trimArgs.push('-to', String(edit.trimEnd));

        // The poster is a second OUTPUT of the same invocation, not a second run of
        // ffmpeg: one decode, both files. Its time is relative to the trimmed clip.
        const posterAt = Math.max(0, Math.min(
            edit.coverTime == null ? 0 : (edit.coverTime - edit.trimStart),
            Math.max(0, (edit.trimEnd == null ? (info.seconds || 0) : edit.trimEnd) - edit.trimStart - 0.05)
        ));

        const enc = await runFfmpeg([
            '-hide_banner', '-nostdin', '-y',
            ...trimArgs,
            '-i', inPath,
            ...(wantMark ? ['-i', MARK_PATH] : []),
            '-filter_complex', filter,
            '-map', '[v]',
            '-map', '0:a?',              // silent clips must not fail the encode
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-pix_fmt', 'yuv420p',       // iOS and Instagram both reject 4:4:4
            '-profile:v', 'high', '-level', '4.0',
            '-c:a', 'copy',
            '-movflags', '+faststart',
            outPath,
            // second output of the SAME invocation: one decode, two files
            '-map', '[vp]', '-ss', String(posterAt), '-frames:v', '1', '-q:v', '3',
            '-update', '1',
            posterPath
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

        // ---- the cover frame, written beside the clip ----
        // Best effort: a post whose video processed fine must not be held back because
        // its poster did not, so a failure here just leaves poster_url unset.
        let posterUrl = null;
        try {
            const posterStat = await stat(posterPath);
            if (posterStat && posterStat.size) {
                const pPath = user.id + '/watermarked/' + postId + '-' + itemIndex + '.jpg';
                const pUp = await supa.storage.from(BUCKET).upload(pPath, await readFile(posterPath), {
                    contentType: 'image/jpeg',
                    upsert: true
                });
                if (!pUp.error) posterUrl = SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + pPath;
            }
        } catch (e) {}

        // ---- read/modify/write the jsonb array, keeping every other item intact ----
        const next = media.slice();
        // Add fields; never rewrite url. The original stays addressable forever, which is
        // what lets the trim, the filter and the mark all be reconsidered later.
        const patch = { watermarked_url: publicUrl };
        if (posterUrl) patch.poster_url = posterUrl;
        next[itemIndex] = Object.assign({}, next[itemIndex], patch);
        const wrote = await supa.from('artist_posts').update({ media: next }).eq('id', postId);
        if (wrote.error) {
            console.warn('[watermark] media update failed', wrote.error.message);
            return send(res, 200, { watermarked: false, url: videoUrl, reason: 'row_update_failed' });
        }

        return send(res, 200, { watermarked: true, url: publicUrl, poster: posterUrl });
    } catch (e) {
        console.warn('[watermark] ' + (e && e.message));
        return send(res, 200, { watermarked: false, url: videoUrl, reason: 'error' });
    } finally {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(function () {});
    }
}
