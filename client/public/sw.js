/* Minimal app-shell service worker (#193, ADR-54).
 *
 * Exists to make the app installable on Android Chrome (manifest + SW +
 * secure context) — NOT to make it offline-first. Scope discipline:
 *
 *   - Precache: the app shell only — "/", the manifest, the two regular
 *     icons. The content-hashed bundles under /assets/ are deliberately NOT
 *     precached: the HTTP layer already serves them immutable (server/src/
 *     app.ts), and a SW copy would be a second cache to invalidate.
 *   - /api: never intercepted, case-insensitively. Requests go straight to the
 *     network, so API data can never be served stale by this worker (the
 *     issue's hard rule).
 *   - Navigations: network-first, cached shell as OFFLINE fallback only —
 *     online users always get the server's index.html (which the server
 *     already sends no-cache), so a deploy is picked up on the next load.
 *
 * What this does NOT promise: a working offline app. The precached "/" is
 * index.html, which references content-hashed /assets/* bundles this worker
 * deliberately never caches — so an offline launch renders only if the browser
 * still holds those bundles in its own (evictable) HTTP cache. Treat offline as
 * best-effort; installability is the goal.
 *
 * Update strategy: this file is served no-cache (it sits outside /assets/),
 * so the browser re-fetches it on navigation; any byte change installs the
 * new worker, skipWaiting()+clients.claim() activate it immediately, and the
 * activate handler drops the previous version's cache. Bump CACHE when the
 * precached shell list changes shape or what may become the shell changes.
 */
// v3 (#255): the icon rasters and the manifest's felt theme/background were
// retuned to the card-table identity — refresh the precached copies.
const CACHE = "draw-shell-v3";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

function temporaryUnavailable() {
  return new Response("Draw is temporarily unavailable. Please try again shortly.", {
    status: 503,
    statusText: "Service Unavailable",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function cachedOrUnavailable(request) {
  return (await caches.match(request)) || temporaryUnavailable();
}

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
  // through means the browser handles them exactly as without a SW. The path
  // test is case-insensitive because Express mounts match that way (#189,
  // server/src/app.ts): /API/tasks IS api traffic, and must not be treated as
  // a navigation whose JSON body could land in the shell cache.
  if (url.origin !== self.location.origin || url.pathname.toLowerCase().startsWith("/api")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Every SPA navigation answers with index.html (the server's SPA
          // fallback), so refreshing the "/" cache entry from ANY route keeps
          // the offline shell current without a second request. Only an HTML
          // body qualifies: response.ok alone would let one non-HTML same-origin
          // navigation (a download, a JSON error page) permanently replace the
          // offline shell. waitUntil keeps the write alive past the response —
          // a detached promise dies with the worker.
          if (response.ok && (response.headers.get("content-type") || "").includes("text/html")) {
            const copy = response.clone();
            event.waitUntil(
              caches
                .open(CACHE)
                .then((cache) => cache.put("/", copy))
                .catch(() => {}),
            );
          }
          return response;
        })
        .catch(() => cachedOrUnavailable("/")),
    );
    return;
  }

  // Everything else: network, with the precache as fallback — only the shell
  // files above can ever match, nothing is cached at runtime here.
  event.respondWith(fetch(request).catch(() => cachedOrUnavailable(request)));
});
