import { request as apiRequest, expect, test } from "@playwright/test";

/**
 * OTA update (#247): the Settings About/Update surface.
 *
 * SPEC-FIRST: written before the implementation — both tests are
 * `test.fixme(...)` so the suite stays green until #247 lands. WHEN
 * IMPLEMENTING: flip each `test.fixme(` back to `test(`.
 *
 * Determinism: playwright.config.ts pins UPDATE_CHECK_URL to a closed
 * loopback port (the notify-settings.spec.ts trick), so "Check now" fails
 * fast without any network and the update-available banner can never light
 * up mid-suite. The banner + apply/poll/reload flow therefore need a
 * reachable release fixture this repo does not ship (nothing in
 * client/public per the #247 contract) — that path is carried by
 * server/test/integration/update.test.ts and client/src/lib/updateNotice.test.ts
 * instead. This spec pins what IS visible on a stock install: the running
 * version, the default-on toggle, the calm degraded check, and the
 * unconfigured apply state (guidance, no button).
 *
 * Shared serial DB: the second test configures a trigger URL (privileged —
 * posting to it restarts the app) and removes it again; the afterAll is the
 * backstop so later specs never inherit a configured trigger.
 */
test.describe.configure({ mode: "serial" });

test.afterAll(async ({}, testInfo) => {
  const ctx = await apiRequest.newContext({ baseURL: testInfo.project.use.baseURL });
  await ctx.delete("/api/update/trigger");
  await ctx.dispose();
});

test.fixme("Settings shows the running version and the check controls", async ({ page }) => {
  await page.goto("/settings");

  // The version on screen is the one the server reports — not a hardcoded
  // string the client could let drift.
  const status = await (await page.request.get("/api/update")).json();
  await expect(page.getByTestId("update-current-version")).toContainText(status.current);

  // The daily check is default-ON, visibly.
  await expect(page.getByTestId("update-check-toggle")).toBeChecked();

  // "Check now" against the closed-port UPDATE_CHECK_URL: a calm result
  // line, no error spam, and definitely no banner from a failed check.
  await page.getByTestId("update-check-now").click();
  await expect(page.getByTestId("update-check-result")).toBeVisible();
  await expect(page.getByTestId("update-banner")).toHaveCount(0);
});

test.fixme("the unconfigured apply state guides instead of offering a button", async ({ page }) => {
  await page.goto("/settings");

  // No trigger configured: no "Update now" anywhere, guidance instead.
  await expect(page.getByTestId("update-apply")).toHaveCount(0);
  const trigger = page.getByTestId("update-trigger-status");
  await expect(trigger).toContainText("No update trigger configured");

  // Configure write-only, exactly like the ntfy URL block (#235): the field
  // clears, only a presence flag comes back, and the button appears.
  await page.getByTestId("update-trigger-url-input").fill("http://127.0.0.1:9/draw-e2e-trigger");
  await page.getByTestId("update-trigger-save").click();
  await expect(trigger).toContainText("Update trigger configured");
  await expect(page.getByTestId("update-trigger-url-input")).toHaveValue("");
  await expect(page.getByTestId("update-apply")).toBeVisible();

  // The privileged URL never leaks through the public settings payload.
  const settings = await (await page.request.get("/api/settings")).json();
  expect(JSON.stringify(settings)).not.toContain("draw-e2e-trigger");

  // Remove turns it off — later specs must see the stock unconfigured state.
  await page.getByTestId("update-trigger-remove").click();
  await expect(trigger).toContainText("No update trigger configured");
  await expect(page.getByTestId("update-apply")).toHaveCount(0);
});
