// AIAD Service Worker — network-first for HTML/JS/CSS, cache-first for static assets.
// Goal: every deploy reaches users immediately; the PWA still works offline by falling back to cache.

const VERSION       = "aiad-" + (self.AIAD_BUILD || "20260619");
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
        if (fresh && fresh.ok && fresh.type === "basic") cache.put(req, fresh.clone());
        return fresh;
    } catch (err) {
        const cached = await cache.match(req);
        if (cached) return cached;
        if (req.mode === "navigate") {
            const fallback = await cache.match("/index.html") || await cache.match("/");
            if (fallback) return fallback;
        }
        throw err;
    }
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
