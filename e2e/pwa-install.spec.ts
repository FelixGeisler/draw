import { expect, test } from "@playwright/test";

// PWA delivery (#193, ADR-54). Installability is a property of the PRODUCTION
// server: the manifest, the icons and sw.js live in client/public/ and reach
// the browser only once vite has copied them into client/dist and Express
// serves it. So this spec runs against the prod webServer entry, not the Vite
// dev server the rest of the suite uses (main.tsx registers the worker in
// PROD builds only). Port resolution mirrors playwright.config.ts, and
// 127.0.0.1 is a secure context, which service workers require.
const PROD = `http://127.0.0.1:${process.env.E2E_PROD_PORT || "3102"}`;

/** Runs in the page: `ready` waits forever when nothing registers, so race a
 *  deadline instead of letting the whole spec hang. */
async function waitForActiveWorker() {
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("no service worker became ready")), 20_000),
    ),
  ]);
  return { scope: reg.scope, hasActive: reg.active !== null };
}

test.describe("PWA delivery", () => {
  test("the manifest and its icons are served, maskable included", async ({ request }) => {
    const res = await request.get(`${PROD}/manifest.webmanifest`);
    expect(res.ok()).toBeTruthy();
    // Chrome accepts application/manifest+json (and tolerates JSON); assert we
    // are not accidentally serving index.html through the SPA fallback.
    expect(res.headers()["content-type"]).not.toContain("text/html");

    const manifest = JSON.parse(await res.text());
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();

    // Android's launcher needs a maskable icon or it applies its own mask to
    // the square one; 192 and 512 are the sizes Chrome's install prompt wants.
    // Asserted as PURPOSE+SIZE PAIRS: independent "contains maskable" and
    // "contains 512x512" sets would also pass with a single maskable 192 and a
    // plain 512, which is not what Android needs.
    const declared = new Set(
      (manifest.icons as { sizes: string; purpose?: string }[]).map(
        (i) => `${i.purpose ?? "any"} ${i.sizes}`,
      ),
    );
    for (const wanted of ["any 192x192", "any 512x512", "maskable 192x192", "maskable 512x512"]) {
      expect([...declared], `the manifest must declare a ${wanted} icon`).toContain(wanted);
    }

    // Every declared icon must actually resolve — a 404 here silently breaks
    // the install prompt.
    for (const icon of manifest.icons as { src: string }[]) {
      const iconRes = await request.get(`${PROD}${icon.src}`);
      expect(iconRes.ok(), `${icon.src} should be served`).toBeTruthy();
      expect(iconRes.headers()["content-type"]).toContain("image");
    }
  });

  test("index.html carries the head an installable phone app needs", async ({ request }) => {
    const html = await (await request.get(`${PROD}/`)).text();

    // With DRAW_PASSWORD set (#190) the gate 401s /manifest.webmanifest, and
    // browsers fetch manifests without cookies unless the link opts in — drop
    // this attribute and a password-protected instance silently stops being
    // installable, which no other assertion would catch.
    const link = html.match(/<link[^>]+rel="manifest"[^>]*>/)?.[0] ?? "";
    expect(link, "index.html must link the manifest").toBeTruthy();
    expect(link).toContain('crossorigin="use-credentials"');

    // Without width=device-width the phone renders at a ~980px desktop width and
    // scales down, which would silently undo the whole responsive pass; the
    // theme-color is what paints the standalone app's system bars.
    const viewport = html.match(/<meta[^>]+name="viewport"[^>]*>/)?.[0] ?? "";
    expect(viewport, "index.html must declare a viewport").toBeTruthy();
    expect(viewport).toContain("width=device-width");
    const themeColor = html.match(/<meta[^>]+name="theme-color"[^>]*>/)?.[0] ?? "";
    expect(themeColor, "index.html must declare a theme-color").toBeTruthy();
    expect(themeColor).toMatch(/content="#[0-9a-fA-F]{3,8}"/);
  });

  test("sw.js is served revalidating, never immutably cached", async ({ request }) => {
    // The whole update strategy rests on this: the worker sits outside
    // /assets/, so app.ts's setHeaders gives it no-cache and the browser
    // re-fetches it — an immutable sw.js would strand users on a stale shell.
    const res = await request.get(`${PROD}/sw.js`);
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["cache-control"]).toContain("no-cache");
    expect(res.headers()["cache-control"]).not.toContain("immutable");
  });

  test("the service worker registers and never caches /api", async ({ page }) => {
    await page.goto(`${PROD}/`);

    const registration = await page.evaluate(waitForActiveWorker);
    expect(registration.hasActive).toBe(true);
    // Root scope: the worker must cover every SPA route, not just "/".
    expect(new URL(registration.scope).pathname).toBe("/");

    // Exercise the app so real API traffic flows through the active worker.
    await page.goto(`${PROD}/tasks`);
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();

    const cacheState = await page.evaluate(async () => {
      const keys = await caches.keys();
      const entries: string[] = [];
      for (const key of keys) {
        const cache = await caches.open(key);
        entries.push(...(await cache.keys()).map((r) => new URL(r.url).pathname));
      }
      return { keys, entries };
    });
    // The hard rule from #193: API responses are never served stale, so the
    // worker must hold no /api entry at all.
    expect(cacheState.entries.filter((p) => p.startsWith("/api"))).toEqual([]);
    // And the shell it does hold stays a shell — no runtime asset hoarding.
    expect(cacheState.entries).toContain("/");
    expect(cacheState.entries.filter((p) => p.startsWith("/assets/"))).toEqual([]);
  });

  test("network failure returns cached shell hits or explicit 503 misses", async ({ page }) => {
    await page.goto(`${PROD}/`);
    expect((await page.evaluate(waitForActiveWorker)).hasActive).toBe(true);
    await page.reload();
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    await page.context().setOffline(true);
    try {
      const result = await page.evaluate(async () => {
        const hit = await fetch("/");
        const miss = await fetch("/not-cached-shell-probe");
        const bypassed = async (url: string) => {
          try {
            const response = await fetch(url);
            return { kind: "response", status: response.status };
          } catch {
            return { kind: "network-error", status: null };
          }
        };
        return {
          hit: { status: hit.status, type: hit.headers.get("content-type"), text: await hit.text() },
          miss: {
            status: miss.status,
            type: miss.headers.get("content-type"),
            text: await miss.text(),
          },
          api: await bypassed("/API/tasks"),
          crossOrigin: await bypassed("https://example.com/draw-pwa-probe"),
        };
      });

      expect(result.hit.status).toBe(200);
      expect(result.hit.type).toContain("text/html");
      expect(result.hit.text.toLowerCase()).toContain("<!doctype html>");
      expect(result.miss.status).toBe(503);
      expect(result.miss.type).toContain("text/plain");
      expect(result.miss.text).toContain("temporarily unavailable");
      expect(result.api).toEqual({ kind: "network-error", status: null });
      expect(result.crossOrigin).toEqual({ kind: "network-error", status: null });
    } finally {
      await page.context().setOffline(false);
    }

    const cacheEntries = await page.evaluate(async () => {
      const entries: string[] = [];
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        entries.push(...(await cache.keys()).map((request) => new URL(request.url).pathname));
      }
      return entries;
    });
    expect(cacheEntries).not.toContain("/not-cached-shell-probe");
    expect(cacheEntries.filter((path) => path.toLowerCase().startsWith("/api"))).toEqual([]);
    expect(cacheEntries.filter((path) => path.startsWith("/assets/"))).toEqual([]);
  });

  test("an offline navigation cache miss receives a human-readable 503 Response", async ({
    page,
  }) => {
    await page.goto(`${PROD}/`);
    expect((await page.evaluate(waitForActiveWorker)).hasActive).toBe(true);
    await page.reload();

    await page.evaluate(async () => {
      for (const key of await caches.keys()) await (await caches.open(key)).delete("/");
    });
    await page.context().setOffline(true);
    try {
      const response = await page.goto(`${PROD}/offline-navigation-probe`);
      expect(response).not.toBeNull();
      expect(response!.status()).toBe(503);
      expect(await page.locator("body").innerText()).toContain("temporarily unavailable");
    } finally {
      await page.context().setOffline(false);
    }
  });

  test("a non-HTML navigation cannot replace the offline shell", async ({ page }) => {
    await page.goto(`${PROD}/`);
    expect((await page.evaluate(waitForActiveWorker)).hasActive).toBe(true);

    // Express matches its mounts case-insensitively (#189), so /API/tasks IS the
    // tasks API and answers 200 application/json. Navigating there drives the
    // worker's navigation branch with a body that must never become the shell:
    // a lowercase-only /api test plus a bare response.ok check would have stored
    // this JSON as "/" and white-paged every later offline launch.
    const jsonNav = await page.goto(`${PROD}/API/tasks`);
    expect(jsonNav!.status(), "/API/tasks must reach the API, not the SPA fallback").toBe(200);
    expect(jsonNav!.headers()["content-type"]).toContain("application/json");

    // Read the cache from THAT page (same origin, so CacheStorage is the same):
    // navigating back to "/" first would legitimately re-store the HTML shell and
    // paper over the very overwrite this test is looking for.
    const shell = await page.evaluate(async () => {
      for (const key of await caches.keys()) {
        const hit = await (await caches.open(key)).match("/");
        if (hit) return { type: hit.headers.get("content-type"), head: (await hit.text()).slice(0, 200) };
      }
      return null;
    });
    expect(shell, "the worker must hold a shell entry").not.toBeNull();
    expect(shell!.type).toContain("text/html");
    expect(shell!.head.toLowerCase()).toContain("<!doctype html>");
  });
});
