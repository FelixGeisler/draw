import { request as apiRequest, expect, test, type Page, type Route } from "@playwright/test";

/**
 * OTA update (#247, #272): authenticated Settings is the only client
 * consumer of the server's build identity. All replacement-specific cases
 * use local route fixtures and sessionStorage; they never contact a release
 * service or invoke a real update trigger.
 */
test.describe.configure({ mode: "serial" });

const OLD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_SHA = "0123456789abcdef0123456789abcdef01234567";
const CHANNEL_LABELS = {
  stable: "Release",
  edge: "Edge (deployment opt-in)",
  local: "Local build",
} as const;

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
    latest: null,
    updateAvailable: false,
    releaseUrl: null,
    checkedAt: null,
    checkEnabled: true,
    applyConfigured: false,
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

test.afterAll(async ({}, testInfo) => {
  const ctx = await apiRequest.newContext({ baseURL: testInfo.project.use.baseURL });
  await ctx.delete("/api/update/trigger");
  await ctx.dispose();
});

test("Settings shows the exact running version and server build identity", async ({ page }) => {
  await page.goto("/settings");

  const status = await (await page.request.get("/api/update")).json();
  await expect(page.getByTestId("update-current-version")).toHaveText(`Draw ${status.current}`);
  await expect(page.getByTestId("update-build-identity")).toHaveText(
    status.buildSha
      ? `${CHANNEL_LABELS[status.buildChannel as keyof typeof CHANNEL_LABELS]} · ${status.buildSha}`
      : `${CHANNEL_LABELS[status.buildChannel as keyof typeof CHANNEL_LABELS]} · package ${status.current} (SHA unavailable)`,
  );

  await expect(page.getByTestId("update-check-toggle")).toBeChecked();
  await page.getByTestId("update-check-now").click();
  await expect(page.getByTestId("update-check-result")).toBeVisible();
  await expect(page.getByTestId("update-banner")).toHaveCount(0);
});

test("Build row renders full SHA and exact package fallback fixture values", async ({ page }) => {
  let fixture = updateStatus();
  await routeUpdateApi(page, async (route, pathname) => {
    expect(pathname).toBe("/api/update");
    await route.fulfill({ json: fixture });
  });

  await page.goto("/settings");
  await expect(page.getByTestId("update-current-version")).toHaveText("Draw 1.1.0");
  await expect(page.getByTestId("update-build-identity")).toHaveText(
    `Edge (deployment opt-in) · ${OLD_SHA}`,
  );

  fixture = updateStatus({
    current: "2.3.4-rc.1",
    buildChannel: "local",
    buildSha: null,
    buildIdentity: "local:version-2.3.4-rc.1",
  });
  await page.reload();
  await expect(page.getByTestId("update-current-version")).toHaveText("Draw 2.3.4-rc.1");
  await expect(page.getByTestId("update-build-identity")).toHaveText(
    "Local build · package 2.3.4-rc.1 (SHA unavailable)",
  );

  fixture = updateStatus({ buildChannel: "stable", buildIdentity: `stable:${OLD_SHA}` });
  await page.reload();
  await expect(page.getByTestId("update-build-identity")).toHaveText(`Release · ${OLD_SHA}`);

  await expect(page.getByTestId("update-edge-guide")).toHaveAttribute(
    "href",
    "https://felixgeisler.github.io/draw/docs/07_deployment_view.html#edge-deployment-opt-in",
  );
  await expect(page.getByText("Draw does not change deployment channels.")).toBeVisible();
});

test("changed buildIdentity reloads once at the same package version", async ({ page }) => {
  let applied = false;
  let applyPosts = 0;
  let updateGets = 0;
  const original = updateStatus({ applyConfigured: true });
  const replacement = updateStatus({
    applyConfigured: true,
    buildSha: NEW_SHA,
    buildIdentity: `edge:${NEW_SHA}`,
  });

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
  await expect(page.getByTestId("update-current-version")).toHaveText("Draw 1.1.0");
  await expect(page.getByTestId("update-build-identity")).toHaveText(
    `Edge (deployment opt-in) · ${NEW_SHA}`,
  );
  expect(documentLoads).toBe(loadsBeforeApply + 1);
  expect(applyPosts).toBe(1);
  expect(updateGets).toBe(3); // initial status, changed poll, post-reload status

  await page.waitForTimeout(3_500);
  expect(documentLoads).toBe(loadsBeforeApply + 1);
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("draw.updateNotice")))
    .toBeNull();

  await page.reload();
  await expect(page.getByTestId("update-updated-notice")).toHaveCount(0);
  expect(documentLoads).toBe(loadsBeforeApply + 2);
});

test("the accessible indeterminate status moves Waiting → Reconnecting → Waiting", async ({
  page,
}) => {
  let applied = false;
  let poll = 0;
  const original = updateStatus({ applyConfigured: true });

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

  let documentLoads = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) documentLoads += 1;
  });
  await page.goto("/settings");
  const loadsBeforeApply = documentLoads;
  await page.getByTestId("update-apply").click();

  const verification = page.getByTestId("update-verification-status");
  await expect(verification).toHaveAttribute("role", "status");
  await expect(verification).toHaveAttribute("aria-label", "Update verification status");
  await expect(verification).toContainText("Waiting");
  await expect(verification).toContainText(/Elapsed wait: \d+(?:m \d+)?s/);
  const progress = page.getByTestId("update-progress");
  await expect(progress).toHaveAttribute("aria-label", "Update verification in progress");
  await expect(progress).not.toHaveAttribute("value");
  await expect(verification).not.toContainText(/%|remaining|complete by/i);

  await expect(verification).toContainText("Reconnecting", { timeout: 8_000 });
  await expect(verification).toContainText("Waiting", { timeout: 5_000 });
  expect(poll).toBeGreaterThanOrEqual(3);
  expect(documentLoads).toBe(loadsBeforeApply);
  await expect(page.getByTestId("update-updated-notice")).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("draw.updateNotice"))).toBeNull();
});

test("an answered trigger failure stops checking and stays actionable", async ({ page }) => {
  let applied = false;
  let poll = 0;
  const original = updateStatus({ applyConfigured: true });

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
  await expect(page.getByTestId("update-apply-error")).toContainText(
    "check the trigger URL and token, then try again",
    { timeout: 5_000 },
  );
  expect(poll).toBe(1);
  await page.waitForTimeout(3_500);
  expect(poll).toBe(1);
  await expect(page.getByTestId("update-apply")).toBeEnabled();
});

test("valid SHA and package notices show exact messages and are consumed once", async ({ page }) => {
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

  await page.evaluate(() =>
    sessionStorage.setItem(
      "draw.updateNotice",
      JSON.stringify({
        v: 1,
        kind: "package",
        buildChannel: "local",
        current: "2.3.4-rc.1",
      }),
    ),
  );
  await page.reload();
  await expect(page.getByTestId("update-updated-notice")).toHaveText(
    "Updated to Draw 2.3.4-rc.1 (local build)",
  );
  expect(await page.evaluate(() => sessionStorage.getItem("draw.updateNotice"))).toBeNull();
  await page.reload();
  await expect(page.getByTestId("update-updated-notice")).toHaveCount(0);
});

test("absent and invalid notice values are silent and every present value is removed", async ({
  page,
}) => {
  await routeUpdateApi(page, async (route) => route.fulfill({ json: updateStatus() }));
  await page.goto("/settings");
  await expect(page.getByTestId("update-updated-notice")).toHaveCount(0);

  const invalidValues = [
    "1.2.3", // legacy bare version
    "{", // malformed JSON
    JSON.stringify({ v: 1, kind: "sha", buildChannel: "edge", buildSha: NEW_SHA, extra: true }),
    JSON.stringify({ v: "1", kind: "sha", buildChannel: "edge", buildSha: NEW_SHA }),
    JSON.stringify({ v: 1, kind: "sha", buildChannel: "Edge", buildSha: NEW_SHA }),
    JSON.stringify({ v: 1, kind: "sha", buildChannel: "edge", buildSha: "ABC" }),
    JSON.stringify({ v: 1, kind: "package", buildChannel: "stable", current: "v1.2.3" }),
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

test("the unconfigured apply state guides instead of offering a button", async ({ page }) => {
  await page.goto("/settings");

  await expect(page.getByTestId("update-apply")).toHaveCount(0);
  const trigger = page.getByTestId("update-trigger-status");
  await expect(trigger).toContainText("No update trigger configured");

  await page.getByTestId("update-trigger-url-input").fill("http://127.0.0.1:9/draw-e2e-trigger");
  await page.getByTestId("update-trigger-save").click();
  await expect(trigger).toContainText("Update trigger configured");
  await expect(page.getByTestId("update-trigger-url-input")).toHaveValue("");
  await expect(page.getByTestId("update-apply")).toBeVisible();

  const settings = await (await page.request.get("/api/settings")).json();
  expect(JSON.stringify(settings)).not.toContain("draw-e2e-trigger");

  await page.getByTestId("update-trigger-remove").click();
  await expect(trigger).toContainText("No update trigger configured");
  await expect(page.getByTestId("update-apply")).toHaveCount(0);
});
