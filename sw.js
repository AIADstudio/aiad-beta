// AIAD Service Worker — network-first for HTML/JS/CSS, cache-first for assets.
// Bump CACHE_VERSION on every deploy to force old caches out.
const CACHE_VERSION = 'aiad-v' + (self.AIAD_BUILD || Date.now());
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;

// File extensions treated as long-lived assets (cache-first).
const ASSET_EXT = /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|mp3|mp4|webm|ogg)$/i;

// Take control of clients ASAP on install/activate.
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // Delete any caches that don't match the current version.
        const keys = await caches.keys();
        await Promise.all(
            keys
                .filter((k) => !k.startsWith(CACHE_VERSION))
                .map((k) => caches.delete(k))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Only handle same-origin GETs. Let everything else pass through to the network.
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    // Never intercept Supabase, Stripe, or other API calls (they may sneak in same-origin via proxies).
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/functions')) return;

    // Assets: cache-first (fast, offline-safe, rarely change).
    if (ASSET_EXT.test(url.pathname)) {
        event.respondWith(cacheFirst(req));
        return;
    }

    // Everything else (HTML, JS, CSS, JSON): network-first so deploys take effect immediately.
    event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
    const cache = await caches.open(RUNTIME_CACHE);
    try {
        const fresh = await fetch(req, { cache: 'no-store' });
        // Only cache successful basic responses.
        if (fresh && fresh.ok && fresh.type === 'basic') {
            cache.put(req, fresh.clone());
        }
        return fresh;
    } catch (err) {
        const cached = await cache.match(req);
        if (cached) return cached;
        // Last-ditch fallback for navigations when offline.
        if (req.mode === 'navigate') {
            const indexFallback = await cache.match('/index.html') || await cache.match('/');
            if (indexFallback) return indexFallback;
        }
        throw err;
    }
}

async function cacheFirst(req) {
    const cache = await caches.open(ASSET_CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    const fresh = await fetch(req);
    if (fresh && fresh.ok && fresh.type === 'basic') {
        cache.put(req, fresh.clone());
    }
    return fresh;
}

// Allow the page to ask us to skip waiting (used when an update is detected).
self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
