import { expect, test } from "@playwright/test";

// PWA delivery (#193, ADR-54). Installability is a property of the PRODUCTION
// server: the manifest, the icons and sw.js live in client/public/ and reach
// the browser only once vite has copied them into client/dist and Express
// serves it. So this spec runs against the prod webServer entry, not the Vite
// dev server the rest of the suite uses (main.tsx registers the worker in
// PROD builds only). Port resolution mirrors playwright.config.ts, and
// 127.0.0.1 is a secure context, which service workers require.
const PROD = `http://127.0.0.1:${process.env.E2E_PROD_PORT || "3102"}`;

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
    const purposes = manifest.icons.map((i: { purpose?: string }) => i.purpose ?? "any");
    expect(purposes).toContain("maskable");
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");

    // Every declared icon must actually resolve — a 404 here silently breaks
    // the install prompt.
    for (const icon of manifest.icons as { src: string }[]) {
      const iconRes = await request.get(`${PROD}${icon.src}`);
      expect(iconRes.ok(), `${icon.src} should be served`).toBeTruthy();
      expect(iconRes.headers()["content-type"]).toContain("image");
    }
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

    const registration = await page.evaluate(async () => {
      // `ready` waits forever when nothing registers, so race a deadline.
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("no service worker became ready")), 20_000),
        ),
      ]);
      return { scope: reg.scope, hasActive: reg.active !== null };
    });
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
});
