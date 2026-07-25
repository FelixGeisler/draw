import { expect, test } from "@playwright/test";

// Production smoke (#189, ADR-49): its own webServer entry runs the
// documented path verbatim — `npm run build && npm start` — so this spec
// exercises the real vite bundle served by Express on a single port, not the
// Vite dev server the rest of the suite uses. Absolute URLs throughout: the
// suite-wide baseURL points at the dev client. Port resolution mirrors
// playwright.config.ts (importing the config here would re-run its mkdtemp
// side effects in the worker).
const PROD = `http://127.0.0.1:${process.env.E2E_PROD_PORT || "3102"}`;

test.describe("production serve mode", () => {
  test("API and client share the port", async ({ page, request }) => {
    const health = await request.get(`${PROD}/api/health`);
    expect(health.ok()).toBeTruthy();

    await page.goto(`${PROD}/`);
    await expect(page.locator(".sidenav .brand")).toHaveText("🃏 Draw");
  });

  test("a deep link survives a full page load", async ({ page }) => {
    // Straight to /stats with no client-side navigation — only the SPA
    // fallback can answer this, and the page must then boot the real app.
    await page.goto(`${PROD}/stats`);
    await expect(page.getByRole("heading", { name: "Stats" })).toBeVisible();
  });

  test("unknown API paths still 404 as JSON-surface errors, not index.html", async ({
    request,
  }) => {
    const res = await request.get(`${PROD}/api/definitely-not-a-route`);
    expect(res.status()).toBe(404);
    expect(await res.text()).not.toContain('<div id="root">');
  });
});
