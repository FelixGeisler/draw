/* Minimal app-shell service worker (#193, ADR-54).
 *
 * Exists to make the app installable on Android Chrome (manifest + SW +
 * secure context) — NOT to make it offline-first. Scope discipline:
 *
 *   - Precache: the app shell only — "/", the manifest, the two regular
 *     icons and the notification badge. The content-hashed bundles under
 *     /assets/ are deliberately NOT
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
// v5 (#351): fixed app-owned Push branding adds the monochrome badge to the
// shell. The upgrade retires v4 while Push data remains outside Cache Storage.
const CACHE = "draw-shell-v5";
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/notification-badge-96.png",
];
const NOTIFICATION_ICON = "/icons/icon-192.png";
const NOTIFICATION_BADGE = "/icons/notification-badge-96.png";

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

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function canonicalEventId(value) {
  if (typeof value !== "string" || value.length !== 22 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "==";
    const binary = atob(base64);
    if (binary.length !== 16) return false;
    const roundTrip = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return roundTrip === value;
  } catch {
    return false;
  }
}

function countsLine(payload) {
  return payload.todayCount === 0 && payload.tomorrowCount === 0 && payload.overdueCount === 0
    ? "Nothing due today or tomorrow · Overdue: 0"
    : `Today: ${payload.todayCount} · Tomorrow: ${payload.tomorrowCount} · Overdue: ${payload.overdueCount}`;
}

function notificationFromPayload(payload) {
  if (exactKeys(payload, ["v", "kind"]) && payload.v === 2 && payload.kind === "test") {
    return {
      title: "Draw",
      options: {
        body: "Notifications are enabled",
        tag: "draw-push-test",
        data: { v: 2, route: "/settings" },
      },
    };
  }
  const shared = payload && payload.v === 2 && payload.kind === "digest" &&
    canonicalEventId(payload.eventId) &&
    nonNegativeSafeInteger(payload.todayCount) && nonNegativeSafeInteger(payload.tomorrowCount) &&
    nonNegativeSafeInteger(payload.overdueCount) &&
    Number.isSafeInteger(payload.todayCount + payload.tomorrowCount + payload.overdueCount);
  if (!shared) return null;
  const options = {
    tag: `draw-digest-${payload.eventId}`,
    data: { v: 2, route: "/today" },
  };
  if (payload.detail === "generic" && exactKeys(payload, [
    "v", "kind", "detail", "eventId", "todayCount", "tomorrowCount", "overdueCount",
  ])) {
    return { title: "Good morning", options: { ...options, body: countsLine(payload) } };
  }
  if (payload.detail === "detailed" && exactKeys(payload, [
    "v", "kind", "detail", "eventId", "todayCount", "tomorrowCount", "overdueCount", "titles", "remainingCount",
  ]) && Array.isArray(payload.titles) && payload.titles.length <= 5 &&
    payload.titles.every((title) => typeof title === "string") &&
    nonNegativeSafeInteger(payload.remainingCount) &&
    payload.remainingCount === payload.todayCount + payload.tomorrowCount + payload.overdueCount - payload.titles.length) {
    const lines = [...payload.titles];
    if (payload.remainingCount > 0) lines.push(`…and ${payload.remainingCount} more`);
    lines.push(countsLine(payload));
    return { title: "Good morning", options: { ...options, body: lines.join("\n") } };
  }
  return null;
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    if (!event.data) return;
    try {
      const blob = event.data.blob();
      if (blob.size > 3072) return;
      const bytes = await blob.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const notification = notificationFromPayload(JSON.parse(text));
      if (!notification) return;
      await self.registration.showNotification(notification.title, {
        ...notification.options,
        icon: NOTIFICATION_ICON,
        badge: NOTIFICATION_BADGE,
      });
    } catch {
      // Closed protocol: malformed, oversized, unknown, or non-UTF-8 input
      // produces no notification and exposes no payload/provider detail.
    }
  })());
});

function canonicalClickRoute(value) {
  return value === "/settings" || value === "/today" ? value : null;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  if (!exactKeys(data, ["v", "route"]) || data.v !== 2 || typeof data.route !== "string") return;
  const route = canonicalClickRoute(data.route);
  if (!route) return;
  event.waitUntil((async () => {
    const target = new URL(route, self.location.origin);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find((candidate) => {
      try { return new URL(candidate.url).origin === self.location.origin; } catch { return false; }
    });
    if (client) {
      await client.navigate(target.href);
      await client.focus();
    } else {
      await self.clients.openWindow(target.href);
    }
  })());
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
