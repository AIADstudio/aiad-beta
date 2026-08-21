// AIAD Service Worker — network-first for HTML/JS/CSS, cache-first for static assets.
// Goal: every deploy reaches users immediately; the PWA still works offline by falling back to cache.

const VERSION       = "aiad-" + (self.AIAD_BUILD || "20260821b");
const RUNTIME_CACHE = `${VERSION}-runtime`;
const ASSET_CACHE   = `${VERSION}-assets`;

const ASSET_EXT = /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|mp3|mp4|webm|ogg)$/i;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    // Never intercept API / Supabase function calls.
    if (url.pathname.startsWith("/api") || url.pathname.startsWith("/functions")) return;

    if (ASSET_EXT.test(url.pathname)) {
        event.respondWith(cacheFirst(req));
    } else {
        event.respondWith(networkFirst(req));
    }
});

async function networkFirst(req) {
    const cache = await caches.open(RUNTIME_CACHE);
    try {
        const fresh = await fetch(req, { cache: "no-store" });
        if (fresh && fresh.ok && fresh.type === "basic") {
            cache.put(req, fresh.clone());
            return fresh;
        }
        // A non-ok response is not content — it's an error page. Previously this
        // returned it anyway, declining only to cache it, which meant Vercel's
        // Security Checkpoint (HTTP 403, x-vercel-mitigated: challenge) replaced a
        // perfectly good cached app with a spinner that reloads. Blocked, broken and
        // timed-out responses now fall back to cache the same way a network failure
        // does — but 404 and 410 mean the resource is genuinely gone, so they are
        // passed through rather than answered from a stale copy.
        if (fresh && (fresh.status === 404 || fresh.status === 410)) {
            cache.delete(req);   // drop any stale copy so it can't resurface later
            return fresh;
        }
        return (await cacheFallback(cache, req)) || fresh;
    } catch (err) {
        const fallback = await cacheFallback(cache, req);
        if (fallback) return fallback;
        throw err;
    }
}

// Best cached answer for a request: the exact entry, or the app shell for a
// navigation. Returns null when we have nothing, so callers can decide.
async function cacheFallback(cache, req) {
    const cached = await cache.match(req);
    if (cached) return cached;
    if (req.mode === "navigate") {
        return (await cache.match("/index.html")) || (await cache.match("/")) || null;
    }
    return null;
}

async function cacheFirst(req) {
    const cache = await caches.open(ASSET_CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    const fresh = await fetch(req);
    if (fresh && fresh.ok && fresh.type === "basic") cache.put(req, fresh.clone());
    return fresh;
}

self.addEventListener("message", (event) => {
    if (event.data === "SKIP_WAITING") self.skipWaiting();
});
