/* Minimal app-shell service worker (#193, ADR-54).
 *
 * Exists to make the app installable on Android Chrome (manifest + SW +
 * secure context) — NOT to make it offline-first. Scope discipline:
 *
 *   - Precache: the app shell only — "/", the manifest, the two regular
 *     icons. The content-hashed bundles under /assets/ are deliberately NOT
 *     precached: the HTTP layer already serves them immutable (server/src/
 *     app.ts), and a SW copy would be a second cache to invalidate.
 *   - /api: never intercepted. Requests go straight to the network, so API
 *     data can never be served stale by this worker (the issue's hard rule).
 *   - Navigations: network-first, cached shell as OFFLINE fallback only —
 *     online users always get the server's index.html (which the server
 *     already sends no-cache), so a deploy is picked up on the next load.
 *
 * Update strategy: this file is served no-cache (it sits outside /assets/),
 * so the browser re-fetches it on navigation; any byte change installs the
 * new worker, skipWaiting()+clients.claim() activate it immediately, and the
 * activate handler drops the previous version's cache. Bump CACHE when the
 * precached shell list changes shape.
 */
const CACHE = "draw-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Cross-origin and /api requests are not this worker's business — falling
  // through means the browser handles them exactly as without a SW.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Every SPA navigation answers with index.html (the server's SPA
          // fallback), so refreshing the "/" cache entry from ANY route keeps
          // the offline shell current without a second request.
          if (response.ok) {
            const copy = response.clone();
            caches
              .open(CACHE)
              .then((cache) => cache.put("/", copy))
              .catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  // Everything else: network, with the precache as fallback — only the shell
  // files above can ever match, nothing is cached at runtime here.
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
