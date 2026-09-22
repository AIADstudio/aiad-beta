// Server-rendered share previews for /store/:username, /artist/:username and /post/:id.
//
// The three pages set document.title from JS once their data lands, which is fine for a
// person and useless for a crawler: Slack, iMessage, X and Facebook read the static head
// and never run the script, so every shared link previewed as "Store — AIAD" with no
// image. This function serves the same three files with the head rewritten from the same
// public RPCs the pages themselves call. The body and the client JS are untouched — the
// page still renders exactly as it does today.
//
// FAIL OPEN. A preview is a nice-to-have; the store is not. Every failure path below ends
// in "serve the file as-is with a 200", and the only thing a bad RPC costs is a generic
// preview. Failures are logged, never swallowed.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The publishable keys the three pages already embed (store.html:152-153). Anon only —
// this function reads exactly what an anonymous visitor's browser reads.
const SUPABASE_URL = 'https://uapiytquwuhtewqieegx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhcGl5dHF1d3VodGV3cWllZWd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NzcwMTksImV4cCI6MjA4OTI1MzAxOX0.BLs2RdStghm0_cF8t70cBTX1GWcowGRwID7TAG8Mg38';

// The canonical host: the apex 308s to www, and a crawler that will not follow a
// redirect on og:image would render the fallback icon as nothing at all.
const SITE = 'https://www.aiad.studio';
const FALLBACK_IMAGE = SITE + '/icon-512.png';
const TIMEOUT_MS = 3000;
const MAX_DESC = 160;

const PAGES = { store: 'store.html', artist: 'artist.html', post: 'post.html' };

// Read once per lambda instance; these files do not change under a running function.
const _fileCache = {};
const _here = dirname(fileURLToPath(import.meta.url));

function pageHtml(kind) {
    if (_fileCache[kind]) return _fileCache[kind];
    const name = PAGES[kind];
    if (!name) return null;
    // includeFiles puts them at the root of the bundle, which is process.cwd(); the
    // second path is what a local `vercel dev` or a different bundle layout gives.
    for (const p of [join(process.cwd(), name), join(_here, '..', name)]) {
        try {
            const html = readFileSync(p, 'utf8');
            _fileCache[kind] = html;
            return html;
        } catch (e) { /* try the next candidate */ }
    }
    return null;
}

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 160 chars, cut on a word so a description never ends mid-name.
function clamp(s, n = MAX_DESC) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    if (t.length <= n) return t;
    const cut = t.slice(0, n - 1);
    const sp = cut.lastIndexOf(' ');
    return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:—-]+$/, '') + '…';
}

// og:image has to be absolute. A stored value is either already a full URL (Supabase
// storage hands back https) or a site-relative path.
function absUrl(u) {
    const s = String(u == null ? '' : u).trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('//')) return 'https:' + s;
    return SITE + (s.startsWith('/') ? s : '/' + s);
}

// A video URL in og:image renders nothing, which is the bug this function exists to fix.
function mediaImage(media, mediaType, mediaUrl) {
    const items = Array.isArray(media) ? media : [];
    for (const m of items) {
        const url = typeof m === 'string' ? m : (m && m.url);
        const type = typeof m === 'string' ? '' : String((m && m.type) || '');
        if (url && !/video/i.test(type)) return url;
    }
    if (mediaUrl && !/video/i.test(String(mediaType || ''))) return mediaUrl;
    return '';
}

// products.images is an array of URL strings today; tolerate {url} objects too.
function productImage(p) {
    if (!p) return '';
    if (p.image_url) return p.image_url;
    const imgs = Array.isArray(p.images) ? p.images : [];
    for (const i of imgs) {
        const url = typeof i === 'string' ? i : (i && i.url);
        if (url) return url;
    }
    return '';
}

async function sbFetch(path, init) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(SUPABASE_URL + path, {
            ...init,
            signal: ctl.signal,
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
                'Content-Type': 'application/json',
                ...(init && init.headers),
            },
        });
        if (!res.ok) throw new Error(path.split('?')[0] + ' -> ' + res.status);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

const rpc = (name, body) => sbFetch('/rest/v1/rpc/' + name, { method: 'POST', body: JSON.stringify(body) });

async function metaFor(kind, slug) {
    if (kind === 'post') {
        const p = await rpc('public_post', { p_id: slug });
        if (!p || !p.id) return null;
        const name = p.display_name || ('@' + (p.username || 'artist'));
        return {
            title: name + ' on AIAD',
            // Plenty of posts are an image with no caption, so fall back rather than
            // emit an empty description.
            description: clamp(p.content) || (name + ' on AIAD.'),
            image: absUrl(mediaImage(p.media, p.media_type, p.media_url) || p.avatar_url) || FALLBACK_IMAGE,
            type: 'article',
            url: SITE + '/post/' + encodeURIComponent(slug),
        };
    }

    const prof = await rpc('public_artist_profile', { p_username: slug });
    if (!prof || !prof.id) return null;
    const handle = prof.username || slug;
    const name = prof.display_name || ('@' + handle);

    if (kind === 'artist') {
        return {
            title: name + ' — AIAD',
            // The profile's one-liner is `tagline` on this RPC; `bio` is accepted in
            // case the column is ever surfaced under that name.
            description: clamp(prof.bio || prof.tagline) || (name + ' on AIAD.'),
            image: absUrl(prof.avatar_url) || FALLBACK_IMAGE,
            type: 'website',
            url: SITE + '/artist/' + encodeURIComponent(handle),
        };
    }

    // store: the newest live product is the shop's cover.
    let product = null;
    try {
        const rows = await sbFetch('/rest/v1/products?artist_id=eq.' + encodeURIComponent(prof.id)
            + '&is_active=eq.true&select=image_url,images,name&order=created_at.desc&limit=1');
        product = Array.isArray(rows) ? rows[0] : null;
    } catch (err) {
        // No products is not a reason to serve no preview — the avatar still works.
        console.error('[og] products fetch failed for', slug, err && err.message);
    }
    return {
        title: (prof.store_title || prof.display_name || ('@' + handle)) + ' — Store',
        description: 'Shop official merch and releases from ' + name + ' on AIAD.',
        image: absUrl(productImage(product) || prof.avatar_url) || FALLBACK_IMAGE,
        type: 'website',
        url: SITE + '/store/' + encodeURIComponent(handle),
    };
}

// Replace, never append: a second og:title is a coin toss for whichever crawler reads it.
function inject(html, m) {
    let out = html;
    const head = out.indexOf('</head>');
    if (head === -1) return html;

    // Strip every og:/twitter: meta already in the head (post.html ships four).
    const headPart = out.slice(0, head).replace(
        /[ \t]*<meta\b[^>]*\b(?:property|name)\s*=\s*["'](?:og:|twitter:)[^"']*["'][^>]*>[ \t]*\r?\n?/gi, '');
    out = headPart + out.slice(head);

    out = out.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, '<title>' + esc(m.title) + '</title>');

    const descTag = '<meta name="description" content="' + esc(m.description) + '" />';
    const descRe = /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*>/i;
    const hadDesc = descRe.test(out);
    if (hadDesc) out = out.replace(descRe, descTag);

    const tags = [
        hadDesc ? '' : descTag,
        '<meta property="og:title" content="' + esc(m.title) + '" />',
        '<meta property="og:description" content="' + esc(m.description) + '" />',
        '<meta property="og:image" content="' + esc(m.image) + '" />',
        '<meta property="og:image:width" content="1200" />',
        '<meta property="og:image:height" content="630" />',
        '<meta property="og:url" content="' + esc(m.url) + '" />',
        '<meta property="og:type" content="' + esc(m.type) + '" />',
        '<meta property="og:site_name" content="AIAD" />',
        '<meta name="twitter:card" content="summary_large_image" />',
        '<meta name="twitter:title" content="' + esc(m.title) + '" />',
        '<meta name="twitter:description" content="' + esc(m.description) + '" />',
        '<meta name="twitter:image" content="' + esc(m.image) + '" />',
    ].filter(Boolean).map((t) => '    ' + t).join('\n');

    return out.replace(/<\/head>/i, tags + '\n</head>');
}

export default async function handler(req, res) {
    const q = (req && req.query) || {};
    const kind = String(q.kind || '');
    const slug = String(q.slug || '');

    const html = pageHtml(kind);
    if (!html) {
        console.error('[og] no page file for kind=' + kind);
        res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end('<!doctype html><title>Not found</title>');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');

    if (!slug) return res.status(200).end(html);

    let meta = null;
    try {
        meta = await metaFor(kind, slug);
        if (!meta) console.error('[og] no data for', kind, slug);
    } catch (err) {
        console.error('[og] lookup failed for', kind, slug, err && err.message);
    }

    // The page itself is what matters; a generic preview is the acceptable loss.
    if (!meta) return res.status(200).end(html);

    let injected = html;
    try {
        injected = inject(html, meta);
    } catch (err) {
        console.error('[og] inject failed for', kind, slug, err && err.message);
        injected = html;
    }
    return res.status(200).end(injected);
}
