import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * OTA update (#247, #292, #299): Settings presents only version/latest/apply
 * state. Replacement cases use local route fixtures and sessionStorage; they
 * never contact a release service or invoke a real update trigger.
 */
test.describe.configure({ mode: "serial" });

const OLD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_SHA = "0123456789abcdef0123456789abcdef01234567";
const NO_UPDATE_TRIGGER_ERROR =
  "no update trigger configured — see the deployment guide (docs, Deployment View §7.5) for the Watchtower setup";

type UpdateStatusFixture = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  checkedAt: string | null;
  checkEnabled: boolean;
  applyConfigured: boolean;
  lastApplyError: string | null;
  buildChannel: "stable" | "edge" | "local";
  buildSha: string | null;
  buildIdentity: string;
};

function updateStatus(overrides: Partial<UpdateStatusFixture> = {}): UpdateStatusFixture {
  return {
    current: "1.1.0",
    latest: "1.2.0",
    updateAvailable: true,
    releaseUrl: "https://example.test/releases/1.2.0",
    checkedAt: "2026-01-01T00:00:00.000Z",
    checkEnabled: true,
    applyConfigured: true,
    lastApplyError: null,
    buildChannel: "edge",
    buildSha: OLD_SHA,
    buildIdentity: `edge:${OLD_SHA}`,
    ...overrides,
  };
}

async function routeUpdateApi(
  page: Page,
  handler: (route: Route, pathname: string) => Promise<void> | void,
) {
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/update" || pathname === "/api/update/apply") {
      await handler(route, pathname);
      return;
    }
    await route.fallback();
  });
}

async function seedNotice(page: Page, raw: string) {
  await page.goto("/");
  await page.evaluate(
    ({ key, value }) => sessionStorage.setItem(key, value),
    { key: "draw.updateNotice", value: raw },
  );
}

function updatesCard(page: Page) {
  return page.getByRole("heading", { name: "Updates", exact: true }).locator("..");
}

async function expectRemovedIdleUi(page: Page) {
  const card = updatesCard(page);
  for (const testId of [
    "update-build-identity",
    "update-check-toggle",
    "update-check-now",
    "update-check-result",
    "update-banner",
    "update-trigger-status",
    "update-edge-guide",
    "update-trigger-url-input",
    "update-trigger-token-input",
    "update-trigger-save",
    "update-trigger-remove",
    "update-progress",
    "update-verification-status",
  ]) {
    await expect(page.getByTestId(testId)).toHaveCount(0);
  }
  await expect(card.getByText("Build", { exact: true })).toHaveCount(0);
  await expect(card.getByText("Release notes", { exact: true })).toHaveCount(0);
  await expect(card.getByText(/release feed|deployment channel/i)).toHaveCount(0);
}

test("idle card has only conditional version rows and action with exact identity labels", async ({
  page,
}) => {
  let fixture = updateStatus({
    current: "1.1.0",
    latest: "1.1.0",
    updateAvailable: false,
    buildChannel: "stable",
    buildSha: OLD_SHA,
    buildIdentity: `stable:${OLD_SHA}`,
  });
  await routeUpdateApi(page, async (route, pathname) => {
    expect(pathname).toBe("/api/update");
    await route.fulfill({ json: fixture });
  });

  await page.goto("/settings");
  const card = updatesCard(page);
  await expect(card.getByText("Current Version", { exact: true })).toBeVisible();
  await expect(page.getByTestId("update-current-version")).toHaveText("Draw 1.1.0");
  await expect(card.getByText("Latest Version", { exact: true })).toBeVisible();
  await expect(page.getByTestId("update-latest-version")).toHaveText("1.1.0");
  await expect(page.getByTestId("update-apply")).toHaveCount(0);
  await expectRemovedIdleUi(page);

  fixture = updateStatus({ applyConfigured: false });
  await page.reload();
  await expect(page.getByTestId("update-current-version")).toHaveText(
    "Draw 1.1.0 · Edge aaaaaaaaaaaa",
  );
  await expect(page.getByTestId("update-latest-version")).toHaveText("1.2.0");
  await expect(page.getByTestId("update-apply")).toHaveText("Update");
  await expectRemovedIdleUi(page);

  fixture = updateStatus({
    current: "2.3.4-rc.1",
    latest: null,
    updateAvailable: false,
    buildChannel: "local",
    buildSha: null,
    buildIdentity: "local:version-2.3.4-rc.1",
  });
  await page.reload();
  await expect(page.getByTestId("update-current-version")).toHaveText("Draw 2.3.4-rc.1");
  await expect(page.getByTestId("update-latest-version")).toHaveCount(0);
  await expect(card.getByText("Latest Version", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("update-apply")).toHaveCount(0);
  await expectRemovedIdleUi(page);

  fixture = updateStatus({ buildChannel: "local", buildIdentity: `local:${OLD_SHA}` });
  await page.reload();
  await expect(page.getByTestId("update-current-version")).toHaveText(
    "Draw 1.1.0 · Local aaaaaaaaaaaa",
  );
});

test("unconfigured updates still POST once and show the concise 409 error", async ({ page }) => {
  let applyPosts = 0;
  const fixture = updateStatus({ applyConfigured: false });
  await routeUpdateApi(page, async (route, pathname) => {
    if (pathname === "/api/update/apply") {
      applyPosts += 1;
      await route.fulfill({ status: 409, json: { error: NO_UPDATE_TRIGGER_ERROR } });
      return;
    }
    await route.fulfill({ json: fixture });
  });

  await page.goto("/settings");
  await page.getByTestId("update-apply").click();
  const renderedError = page.getByTestId("update-apply-error");
  await expect(renderedError).toHaveCount(1);
  await expect(renderedError).toHaveText(`Update failed: ${NO_UPDATE_TRIGGER_ERROR}`);
  await expect(page.getByTestId("update-apply")).toBeEnabled();
  await expect(page.getByTestId("update-apply")).toHaveText("Update");
  expect(applyPosts).toBe(1);
  await expectRemovedIdleUi(page);
});

test("changed buildIdentity reloads once at the same package version", async ({ page }) => {
  let applied = false;
  let applyPosts = 0;
  let updateGets = 0;
  const original = updateStatus();
  const replacement = updateStatus({ buildSha: NEW_SHA, buildIdentity: `edge:${NEW_SHA}` });

  await routeUpdateApi(page, async (route, pathname) => {
    if (pathname === "/api/update/apply") {
      applyPosts += 1;
      applied = true;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    updateGets += 1;
    await route.fulfill({ json: applied ? replacement : original });
  });

  let documentLoads = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) documentLoads += 1;
  });
  await page.goto("/settings");
  const loadsBeforeApply = documentLoads;
  await page.getByTestId("update-apply").click();

  await expect(page.getByTestId("update-updated-notice")).toHaveText(
    "Updated to edge build 0123456789ab",
    { timeout: 10_000 },
  );
  await expect(page.getByTestId("update-current-version")).toHaveText(
    "Draw 1.1.0 · Edge 0123456789ab",
  );
  expect(documentLoads).toBe(loadsBeforeApply + 1);
  expect(applyPosts).toBe(1);
  expect(updateGets).toBe(3);

  await page.waitForTimeout(3_500);
  expect(documentLoads).toBe(loadsBeforeApply + 1);
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("draw.updateNotice")))
    .toBeNull();

  await page.reload();
  await expect(page.getByTestId("update-updated-notice")).toHaveCount(0);
  expect(documentLoads).toBe(loadsBeforeApply + 2);
});

test("apply captures the pre-POST identity and triggers only once", async ({ page }) => {
  let statusChanged = false;
  let applyPosts = 0;
  let heldApply: Route | null = null;
  let markApplyReceived!: () => void;
  const applyReceived = new Promise<void>((resolve) => {
    markApplyReceived = resolve;
  });
  const original = updateStatus();
  const intervening = updateStatus({ buildSha: NEW_SHA, buildIdentity: `edge:${NEW_SHA}` });

  await routeUpdateApi(page, async (route, pathname) => {
    if (pathname === "/api/update/apply") {
      applyPosts += 1;
      heldApply = route;
      markApplyReceived();
      return;
    }
    await route.fulfill({ json: statusChanged ? intervening : original });
  });

  await page.goto("/settings");
  await expect(page.getByTestId("update-current-version")).toContainText("aaaaaaaaaaaa");
  await page.getByTestId("update-apply").click();
  await applyReceived;
  await expect(page.getByTestId("update-apply")).toBeDisabled();
  await expect(page.getByTestId("update-apply")).toHaveText("Updating…");

  statusChanged = true;
  if (heldApply === null) throw new Error("apply route was not captured");
  await heldApply.fulfill({ json: { ok: true } });

  await expect(page.getByTestId("update-updated-notice")).toHaveText(
    "Updated to edge build 0123456789ab",
    { timeout: 10_000 },
  );
  expect(applyPosts).toBe(1);
});

test("active apply remains one concise indeterminate action across reconnects", async ({ page }) => {
  let applied = false;
  let poll = 0;
  const original = updateStatus();

  await routeUpdateApi(page, async (route, pathname) => {
    if (pathname === "/api/update/apply") {
      applied = true;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (!applied) {
      await route.fulfill({ json: original });
      return;
    }
    poll += 1;
    if (poll === 2) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({ json: original });
  });

  await page.goto("/settings");
  await page.getByTestId("update-apply").click();
  const action = page.getByTestId("update-apply");
  await expect(action).toBeDisabled();
  await expect(action).toHaveText("Updating…");
  await expect(action).toHaveAttribute("aria-busy", "true");
  await expect.poll(() => poll, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  await expect(action).toHaveText("Updating…");
  await expect(updatesCard(page)).not.toContainText(/Waiting|Reconnecting|Elapsed|%|remaining|ETA/i);
  await expect(page.getByTestId("update-progress")).toHaveCount(0);
});

test("an answered trigger failure stops checking and stays concise and actionable", async ({
  page,
}) => {
  let applied = false;
  let poll = 0;
  const original = updateStatus();

  await routeUpdateApi(page, async (route, pathname) => {
    if (pathname === "/api/update/apply") {
      applied = true;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (!applied) {
      await route.fulfill({ json: original });
      return;
    }
    poll += 1;
    await route.fulfill({ json: { ...original, lastApplyError: "HTTP 401" } });
  });

  await page.goto("/settings");
  await page.getByTestId("update-apply").click();
  await expect(page.getByTestId("update-apply-error")).toHaveText("Update failed: HTTP 401", {
    timeout: 5_000,
  });
  expect(poll).toBe(1);
  await page.waitForTimeout(3_500);
  expect(poll).toBe(1);
  await expect(page.getByTestId("update-apply")).toBeEnabled();
  await expect(updatesCard(page)).not.toContainText(/trigger URL|token|try again/i);
});

test("valid notices are exact, consumed once, and malformed values stay silent", async ({ page }) => {
  await routeUpdateApi(page, async (route) => route.fulfill({ json: updateStatus() }));
  await seedNotice(
    page,
    JSON.stringify({ v: 1, kind: "sha", buildChannel: "edge", buildSha: NEW_SHA }),
  );
  await page.goto("/settings");
  await expect(page.getByTestId("update-updated-notice")).toHaveText(
    "Updated to edge build 0123456789ab",
  );
  expect(await page.evaluate(() => sessionStorage.getItem("draw.updateNotice"))).toBeNull();
  await page.reload();
  await expect(page.getByTestId("update-updated-notice")).toHaveCount(0);

  const invalidValues = [
    "1.2.3",
    "{",
    JSON.stringify({ v: 1, kind: "sha", buildChannel: "edge", buildSha: NEW_SHA, extra: true }),
  ];
  for (const raw of invalidValues) {
    await page.evaluate(
      ({ key, value }) => sessionStorage.setItem(key, value),
      { key: "draw.updateNotice", value: raw },
    );
    await page.reload();
    await expect(page.getByTestId("update-updated-notice")).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("draw.updateNotice"))).toBeNull();
  }
});
