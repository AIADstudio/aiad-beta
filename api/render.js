// Clip Studio's encoder. The editor page collects INTENT — cuts, framing, text, music —
// and this turns it into a file. Nothing is encoded in the browser: iOS Safari has no
// video.captureStream(), and a phone re-encoding a 4K clip freezes, which is exactly why
// api/watermark.js already works this way. Same posture here.
//
// Everything talks to Supabase as the USER, with the bearer token they sent. There is no
// service-role key in this file on purpose: RLS is the only thing deciding whether this
// request may touch the bucket.
//
// Text is NOT drawn by ffmpeg. drawtext needs a font file shipped into the lambda and
// still would not match the browser's rendering, so the editor rasterises each text layer
// to a transparent PNG at the exact output resolution and uploads it. Here they are plain
// overlays gated by `enable`. That keeps the preview and the render identical by
// construction, and keeps fonts out of the deployment entirely.
import { createClient } from '@supabase/supabase-js';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hobby is capped at 300s and this project is on Hobby, so this is the ceiling, not a guess.
export const config = { maxDuration: 300 };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uapiytquwuhtewqieegx.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhcGl5dHF1d3VodGV3cWllZWd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NzcwMTksImV4cCI6MjA4OTI1MzAxOX0.BLs2RdStghm0_cF8t70cBTX1GWcowGRwID7TAG8Mg38';

const BUCKET = 'artist-media';
const PUBLIC_PREFIX = SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/';

const MAX_SOURCE_BYTES = 350 * 1024 * 1024;
const MAX_SOURCE_SECONDS = 600;
const MAX_OUTPUT_SECONDS = 300;
const MAX_TEXT_LAYERS = 8;
const MAX_SEGMENTS = 20;
const MAX_DIMENSION = 1920;

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
        proc.stderr.on('data', function (d) { if (stderr.length < 200000) stderr += d.toString(); });
        proc.on('error', function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } });
        proc.on('close', function (code) { if (!done) { done = true; clearTimeout(timer); resolve({ code: code, stderr: stderr }); } });
    });
}

// ffmpeg-static ships ffmpeg but not ffprobe, so the probe is ffmpeg reading the file with
// no output: it prints Duration and the stream lines to stderr and exits non-zero.
export function parseProbe(stderr) {
    const out = { seconds: null, width: null, height: null, hasAudio: false };
    const d = stderr.match(/Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/);
    if (d) out.seconds = (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);
    const v = stderr.match(/Stream #\d+:\d+[^\n]*: Video:[^\n]*?(\d{2,5})x(\d{2,5})/);
    if (v) { out.width = +v[1]; out.height = +v[2]; }
    // A source with no audio track must not have [0:a] referenced in the graph — that is a
    // hard filter_complex error, not a warning, so the whole render would die on a silent clip.
    out.hasAudio = /Stream #\d+:\d+[^\n]*: Audio:/.test(stderr);
    return out;
}

// ── colour, identical arithmetic to api/watermark.js ────────────────────────────────
// CSS filters are matrix and affine operations in sRGB; ffmpeg's eq works in YUV, so the
// presets are expressed as a single colorchannelmixer built from the coefficients the CSS
// Filter Effects spec defines. Kept byte-for-byte in step with watermark.js so a filter
// means the same thing on a post and in Clip Studio.
const REC709 = [0.2126, 0.7152, 0.0722];
const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function mul(A, B) {
    const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
        o[r][c] = A[r][0] * B[0][c] + A[r][1] * B[1][c] + A[r][2] * B[2][c];
    return o;
}
function satMatrix(s) {
    const [lr, lg, lb] = REC709;
    return [
        [lr + (1 - lr) * s, lg - lg * s,       lb - lb * s],
        [lr - lr * s,       lg + (1 - lg) * s, lb - lb * s],
        [lr - lr * s,       lg - lg * s,       lb + (1 - lb) * s]
    ];
}
function sepiaMatrix(a) {
    const m = [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]];
    const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
        o[r][c] = IDENTITY[r][c] + (m[r][c] - IDENTITY[r][c]) * a;
    return o;
}
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
function chainFor(b, c, sat, sepia, hue) {
    const parts = [];
    if (c !== 100) parts.push('eq=contrast=' + (c / 100).toFixed(4));
    let M = satMatrix(sat / 100);
    if (sepia) M = mul(sepiaMatrix(sepia / 100), M);
    if (hue) M = mul(hueMatrix(hue), M);
    if (b !== 100) {
        const k = b / 100;
        M = M.map(function (row) { return row.map(function (v) { return v * k; }); });
    }
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

// ── input hygiene ───────────────────────────────────────────────────────────────────
// Every value here arrives from the browser, so nothing is passed through to the command
// line as given: filters are chosen from a fixed table by key, numbers are clamped, and
// media is only ever pulled from our own storage origin.
const num = function (v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; };
const clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };

function ourStorageUrl(u) {
    return typeof u === 'string' && u.indexOf(PUBLIC_PREFIX) === 0 && u.indexOf('..') === -1;
}

function even(n) { const v = Math.round(n); return v % 2 === 0 ? v : v - 1; }

// Cover-crop: fill the target frame from the source without letterboxing, with the part
// that survives chosen by the artist's focus (0 = top/left, 1 = bottom/right). Framing a
// 16:9 shot into 9:16 throws away most of the width, so which slice is kept is a creative
// decision, not a default.
function frameFor(sw, sh, ratio, focusX, focusY) {
    let cw, ch;
    if (sw / sh > ratio) { ch = sh; cw = Math.round(sh * ratio); }
    else { cw = sw; ch = Math.round(sw / ratio); }
    cw = Math.min(cw, sw); ch = Math.min(ch, sh);
    const x = Math.round((sw - cw) * clamp(focusX, 0, 1));
    const y = Math.round((sh - ch) * clamp(focusY, 0, 1));

    let ow = cw, oh = ch;
    if (Math.max(ow, oh) > MAX_DIMENSION) {
        const k = MAX_DIMENSION / Math.max(ow, oh);
        ow = ow * k; oh = oh * k;
    }
    return { cw: even(cw), ch: even(ch), x: x, y: y, ow: Math.max(2, even(ow)), oh: Math.max(2, even(oh)) };
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

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad_request' });

    const sourceUrl = String(body.sourceUrl || '');
    if (!ourStorageUrl(sourceUrl)) return send(res, 400, { error: 'unsupported_source' });

    let dir = null;
    try {
        // ---- size gate before anything lands on disk ----
        const head = await fetch(sourceUrl, { method: 'HEAD' });
        if (!head.ok) return send(res, 400, { error: 'source_unreachable' });
        if (Number(head.headers.get('content-length') || 0) > MAX_SOURCE_BYTES) {
            return send(res, 413, { error: 'too_large' });
        }

        dir = await mkdtemp(join(tmpdir(), 'aiad-clip-'));
        const inPath = join(dir, 'in.mp4');
        const outPath = join(dir, 'out.mp4');
        const posterPath = join(dir, 'poster.jpg');

        const dl = await fetch(sourceUrl);
        if (!dl.ok) return send(res, 400, { error: 'source_unreachable' });
        const buf = Buffer.from(await dl.arrayBuffer());
        if (buf.length > MAX_SOURCE_BYTES) return send(res, 413, { error: 'too_large' });
        await writeFile(inPath, buf);

        const probe = await runFfmpeg(['-hide_banner', '-i', inPath], 60000);
        const info = parseProbe(probe.stderr);
        if (!info.width || !info.height) return send(res, 422, { error: 'undecodable' });
        if (info.seconds != null && info.seconds > MAX_SOURCE_SECONDS) {
            return send(res, 413, { error: 'too_long' });
        }
        const dur = info.seconds || 0;

        // ---- segments: what survives the cuts, in order ----
        let segments = Array.isArray(body.segments) ? body.segments : [];
        segments = segments
            .map(function (s) {
                const a = num(s && s.start), b = num(s && s.end);
                if (a == null || b == null) return null;
                const start = clamp(a, 0, dur || a);
                const end = clamp(b, 0, dur || b);
                return end - start >= 0.1 ? { start: start, end: end } : null;
            })
            .filter(Boolean)
            .slice(0, MAX_SEGMENTS);
        if (!segments.length) segments = [{ start: 0, end: dur || 0 }];

        let total = 0;
        for (const s of segments) total += (s.end - s.start);
        if (total > MAX_OUTPUT_SECONDS) return send(res, 413, { error: 'output_too_long' });

        // ---- framing ----
        const ratioRaw = num(body.aspectRatio);
        const ratio = ratioRaw && ratioRaw > 0.2 && ratioRaw < 5 ? ratioRaw : (info.width / info.height);
        const frame = frameFor(info.width, info.height, ratio,
            num(body.focusX) == null ? 0.5 : body.focusX,
            num(body.focusY) == null ? 0.5 : body.focusY);

        const filterKey = typeof body.filter === 'string'
            && Object.prototype.hasOwnProperty.call(FILTER_PRESETS, body.filter) ? body.filter : 'none';
        const grade = FILTER_PRESETS[filterKey];

        // ---- text layers, already rasterised by the editor ----
        const layers = (Array.isArray(body.textLayers) ? body.textLayers : [])
            .filter(function (l) { return l && ourStorageUrl(l.url); })
            .slice(0, MAX_TEXT_LAYERS)
            .map(function (l) {
                const a = num(l.start), b = num(l.end);
                return {
                    url: l.url,
                    start: a == null ? 0 : clamp(a, 0, total),
                    end: b == null ? total : clamp(b, 0, total)
                };
            })
            .filter(function (l) { return l.end - l.start >= 0.05; });

        const musicUrl = body.music && ourStorageUrl(body.music.url) ? body.music.url : null;
        const musicVolume = musicUrl ? clamp(num(body.music.volume) == null ? 1 : body.music.volume, 0, 2) : 0;
        const sourceVolume = clamp(num(body.sourceVolume) == null ? 1 : body.sourceVolume, 0, 2);
        const keepSourceAudio = info.hasAudio && sourceVolume > 0.001;

        // ---- fetch the overlay assets ----
        const inputs = ['-i', inPath];
        const layerIndex = [];
        let nextInput = 1;
        for (let i = 0; i < layers.length; i++) {
            const r = await fetch(layers[i].url);
            if (!r.ok) continue;
            const p = join(dir, 'text' + i + '.png');
            await writeFile(p, Buffer.from(await r.arrayBuffer()));
            inputs.push('-i', p);
            layerIndex.push({ idx: nextInput++, start: layers[i].start, end: layers[i].end });
        }
        let musicIdx = null;
        if (musicUrl) {
            const r = await fetch(musicUrl);
            if (r.ok) {
                const p = join(dir, 'music.m4a');
                await writeFile(p, Buffer.from(await r.arrayBuffer()));
                inputs.push('-i', p);
                musicIdx = nextInput++;
            }
        }

        // ---- the graph ----
        const parts = [];

        // Cuts first, then one concat. Trimming with -ss/-to would only give a single range;
        // the editor can remove a slice from the middle, so the cuts have to live inside the
        // graph where several kept ranges can be stitched back together.
        const vLabels = [];
        segments.forEach(function (s, i) {
            parts.push('[0:v]trim=start=' + s.start.toFixed(3) + ':end=' + s.end.toFixed(3)
                + ',setpts=PTS-STARTPTS[sv' + i + ']');
            vLabels.push('[sv' + i + ']');
        });
        let vCur;
        if (segments.length === 1) { vCur = '[sv0]'; }
        else { parts.push(vLabels.join('') + 'concat=n=' + segments.length + ':v=1:a=0[vc]'); vCur = '[vc]'; }

        // Grade before framing and before any overlay, so the text sits on top of the
        // finished picture and is never tinted by the artist's filter.
        if (grade) { parts.push(vCur + grade + '[vg]'); vCur = '[vg]'; }

        parts.push(vCur + 'crop=' + frame.cw + ':' + frame.ch + ':' + frame.x + ':' + frame.y
            + ',scale=' + frame.ow + ':' + frame.oh + ',setsar=1[vf]');
        vCur = '[vf]';

        layerIndex.forEach(function (l, i) {
            // The PNG was authored at output resolution, but scale defensively so a stale
            // cached layer from an earlier aspect choice cannot shift the composition.
            parts.push('[' + l.idx + ':v]scale=' + frame.ow + ':' + frame.oh + '[tl' + i + ']');
            const next = '[vt' + i + ']';
            parts.push(vCur + '[tl' + i + ']overlay=0:0:format=auto:enable=\'between(t,'
                + l.start.toFixed(3) + ',' + l.end.toFixed(3) + ')\'' + next);
            vCur = next;
        });
        parts.push(vCur + 'split=2[v][vp]');

        // Audio mirrors the same cuts so picture and sound stay locked.
        let aOut = null;
        if (keepSourceAudio) {
            const aLabels = [];
            segments.forEach(function (s, i) {
                parts.push('[0:a]atrim=start=' + s.start.toFixed(3) + ':end=' + s.end.toFixed(3)
                    + ',asetpts=PTS-STARTPTS[sa' + i + ']');
                aLabels.push('[sa' + i + ']');
            });
            if (segments.length === 1) { parts.push('[sa0]volume=' + sourceVolume.toFixed(3) + '[ao]'); }
            else {
                parts.push(aLabels.join('') + 'concat=n=' + segments.length + ':v=0:a=1[ac]');
                parts.push('[ac]volume=' + sourceVolume.toFixed(3) + '[ao]');
            }
            aOut = '[ao]';
        }
        if (musicIdx != null) {
            // Music is cut to the finished length and faded out, so a three-minute song under
            // a twelve-second clip ends on a decision rather than a hard stop.
            const fade = Math.min(1.5, total / 4);
            parts.push('[' + musicIdx + ':a]atrim=start=0:end=' + total.toFixed(3)
                + ',asetpts=PTS-STARTPTS,volume=' + musicVolume.toFixed(3)
                + ',afade=t=out:st=' + Math.max(0, total - fade).toFixed(3) + ':d=' + fade.toFixed(3) + '[mu]');
            if (aOut) {
                parts.push(aOut + '[mu]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[am]');
                aOut = '[am]';
            } else { aOut = '[mu]'; }
        }

        const args = [
            '-hide_banner', '-nostdin', '-y',
            ...inputs,
            '-filter_complex', parts.join(';'),
            '-map', '[v]'
        ];
        if (aOut) args.push('-map', aOut);
        args.push(
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-pix_fmt', 'yuv420p',          // iOS and Instagram both reject 4:4:4
            '-profile:v', 'high', '-level', '4.0',
            '-movflags', '+faststart'
        );
        if (aOut) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
        args.push('-t', String(Math.min(total, MAX_OUTPUT_SECONDS) + 0.5), outPath);
        // The poster is a second OUTPUT of the same invocation, not a second ffmpeg run.
        args.push('-map', '[vp]', '-frames:v', '1', '-q:v', '3', '-update', '1', posterPath);

        const enc = await runFfmpeg(args, 260000);
        if (enc.code !== 0) {
            console.warn('[render] ffmpeg exit', enc.code, enc.stderr.slice(-1200));
            return send(res, 422, { error: 'encode_failed' });
        }
        const outStat = await stat(outPath).catch(function () { return null; });
        if (!outStat || !outStat.size) return send(res, 422, { error: 'encode_empty' });

        // ---- store under the user's own prefix so the RLS policy matches on re-renders ----
        const id = (typeof body.renderId === 'string' ? body.renderId : '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40)
            || String(Date.now());
        const path = user.id + '/clips/' + id + '.mp4';
        const up = await supa.storage.from(BUCKET).upload(path, await readFile(outPath), {
            contentType: 'video/mp4',
            upsert: true
        });
        if (up.error) {
            console.warn('[render] upload failed', up.error.message);
            return send(res, 500, { error: 'upload_failed' });
        }

        let posterUrl = null;
        try {
            const ps = await stat(posterPath);
            if (ps && ps.size) {
                const pPath = user.id + '/clips/' + id + '.jpg';
                const pUp = await supa.storage.from(BUCKET).upload(pPath, await readFile(posterPath), {
                    contentType: 'image/jpeg', upsert: true
                });
                if (!pUp.error) posterUrl = PUBLIC_PREFIX + pPath;
            }
        } catch (e) {}

        return send(res, 200, {
            ok: true,
            url: PUBLIC_PREFIX + path,
            poster: posterUrl,
            width: frame.ow,
            height: frame.oh,
            duration: Number(total.toFixed(2)),
            bytes: outStat.size
        });
    } catch (e) {
        console.warn('[render] ' + (e && e.message));
        return send(res, 500, { error: 'error' });
    } finally {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(function () {});
    }
}
