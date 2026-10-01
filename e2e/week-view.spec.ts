import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { WeekRecord } from "../shared/weekContract.js";

test.use({ timezoneId: "UTC" });

const WEEK = "2026-10-26";
const REQUEST_NOW = "2026-10-29T12:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function pushStatus(timezone: unknown = "UTC") {
  return {
    available: false,
    reason: "not-production",
    mutationAllowed: false,
    mutationReason: "secure-transport-required",
    vapidPublicKey: null,
    maxDevices: 16,
    preferences: { hideDetails: false, sendTime: "09:00", timezone, quietStart: null, quietEnd: null },
    devices: [],
  };
}

function envelope(weekStart: string, timezone: string, records: WeekRecord[], nextCursor: string | null = null) {
  return { weekStart, timezone, requestNow: REQUEST_NOW, records, nextCursor };
}

function taskRecord(
  id: number,
  title: string,
  options: { status?: "open" | "done"; fixed?: [string, string] | null; deadline?: string | null; truncated?: boolean } = {},
): WeekRecord {
  const fixed = options.fixed === null ? null : options.fixed
    ? { startsAt: options.fixed[0], endsAt: options.fixed[1], contextDate: options.fixed[0].slice(0, 10) }
    : null;
  return {
    kind: "task",
    id,
    title,
    titleTruncated: options.truncated ?? false,
    status: options.status ?? "open",
    fixed,
    deadline: options.status === "done" || options.deadline === null ? null : options.deadline ? { date: options.deadline } : null,
  };
}

function cursor(weekStart: string, timezone: string, anchor: string, kindRank: 0 | 1 | 2, id: number) {
  const payload = Buffer.from(JSON.stringify({ v: 2, w: weekStart, z: timezone, n: REQUEST_NOW, a: anchor, k: kindRank, i: id })).toString("base64url");
  return `${payload}.${Buffer.alloc(32, 7).toString("base64url")}`;
}

async function mockPush(page: Page, status: unknown = pushStatus()) {
  await page.route("**/api/push/status", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(status) }));
}

async function fulfillWeek(route: Route, records: WeekRecord[] = []) {
  const url = new URL(route.request().url());
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(envelope(url.searchParams.get("weekStart")!, url.searchParams.get("timezone")!, records)),
  });
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(child.exitCode !== null || child.signalCode !== null);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function closeFixtureAndRemove(child: ChildProcess | null, root: string): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    let acknowledged = false;
    child.on("message", (message) => {
      if (message && typeof message === "object" && "type" in message && message.type === "shutdown-complete") {
        acknowledged = true;
      }
    });
    if (!child.connected) {
      throw new Error(`fixture IPC disconnected before graceful shutdown; retained ${root}`);
    }
    child.send({ type: "shutdown" });
    let exited = await waitForChildExit(child, 5_000);
    if (!exited) {
      child.kill("SIGKILL");
      exited = await waitForChildExit(child, 5_000);
    }
    if (!exited) {
      throw new Error(`fixture termination is unconfirmed; retained ${root}`);
    }
    if (child.exitCode === 0 && !acknowledged) {
      throw new Error(`fixture exited without confirming server/worker/database closure; retained ${root}`);
    }
  }

  if (child && child.exitCode === null && child.signalCode === null) {
    throw new Error(`fixture child is still live; retained ${root}`);
  }
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    throw new Error(`fixture Temp removal failed; retained ${root}: ${(error as Error).message}`);
  }
  if (fs.existsSync(root)) throw new Error(`fixture Temp path still exists after removal: ${root}`);
}

test("Week route is durable, saved-zone-first, Monday navigating, and suppresses unpaged lists and Quick capture", async ({ page }) => {
  const unpaged: string[] = [];
  await mockPush(page, pushStatus("Europe/Berlin"));
  await page.route("**/api/tasks**", async (route) => {
    unpaged.push(route.request().url());
    await route.continue();
  });
  await page.route("**/api/goals**", async (route) => {
    unpaged.push(route.request().url());
    await route.continue();
  });
  await page.route("**/api/calendar/week**", (route) => fulfillWeek(route));

  await page.goto(`/tasks?view=week&week=${WEEK}`);
  await expect(page).toHaveURL(`/tasks?view=week&week=${WEEK}`);
  await expect(page.getByTestId("week-view")).toContainText("Europe/Berlin");
  await expect(page.getByTestId("capture-form")).toHaveCount(0);
  await expect(page.getByTestId("task-tree")).toHaveCount(0);
  expect(unpaged).toEqual([]);
  await expect(page.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Due dates", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Week", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Previous week" }).click();
  await expect(page).toHaveURL("/tasks?view=week&week=2026-10-19");
  await page.reload();
  await expect(page).toHaveURL("/tasks?view=week&week=2026-10-19");
  await page.getByRole("button", { name: "Next week" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/tasks?view=week&week=${WEEK}`);

  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page).toHaveURL("/tasks");
  await expect(page.getByTestId("capture-form")).toBeVisible();
});

test("List to Week unmounts and cancels exact list datasets, then List refetches without an old response", async ({ page, request }) => {
  const categories = await (await request.get("/api/categories")).json() as Array<{ id: number }>;
  const oldTitle = `Week transition stale ${Date.now()}`;
  const oldTask = await (await request.post("/api/tasks", { data: {
    title: oldTitle,
    categoryId: categories[0].id,
  } })).json() as { id: number };

  let openTaskRequests = 0;
  let allTaskRequests = 0;
  let goalRequests = 0;
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
  let heldTaskSeen!: () => void;
  const taskSeen = new Promise<void>((resolve) => { heldTaskSeen = resolve; });
  let abortedHeldTask = false;
  page.on("requestfailed", (failed) => {
    const url = new URL(failed.url());
    if (url.pathname === "/api/tasks" && url.searchParams.get("status") === "all") abortedHeldTask = true;
  });

  await mockPush(page);
  await page.route("**/api/calendar/week**", (route) => fulfillWeek(route));
  await page.route("**/api/tasks**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.pathname !== "/api/tasks") {
      await route.continue();
      return;
    }
    const status = url.searchParams.get("status");
    if (status === "open") {
      openTaskRequests += 1;
      await route.continue();
      return;
    }
    if (status !== "all") {
      await route.continue();
      return;
    }
    allTaskRequests += 1;
    const response = await route.fetch();
    heldTaskSeen();
    await held;
    try { await route.fulfill({ response }); } catch { /* cancellation closes the routed request */ }
  });
  await page.route("**/api/goals**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/api/goals" && url.searchParams.get("status") === "active") {
      goalRequests += 1;
    }
    await route.continue();
  });

  try {
    await page.goto("/tasks");
    await expect(page.getByText(oldTitle, { exact: true }).first()).toBeVisible();
    const openBeforeWeek = openTaskRequests;
    const goalsBeforeWeek = goalRequests;
    await page.getByLabel("show done").check();
    await taskSeen;
    await page.getByRole("button", { name: "Week", exact: true }).click();
    await expect(page.getByTestId("week-view")).toBeVisible();
    await expect(page.getByTestId("task-tree")).toHaveCount(0);
    await request.delete(`/api/tasks/${oldTask.id}`);
    releaseHeld();
    await expect.poll(() => abortedHeldTask).toBe(true);

    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(page.getByTestId("task-tree")).toHaveCount(1);
    await expect.poll(() => openTaskRequests).toBeGreaterThan(openBeforeWeek);
    await expect.poll(() => goalRequests).toBeGreaterThan(goalsBeforeWeek);
    expect(allTaskRequests).toBe(1);
    await expect(page.getByText(oldTitle, { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("capture-form")).toBeVisible();
  } finally {
    releaseHeld();
    await request.delete(`/api/tasks/${oldTask.id}`).catch(() => undefined);
  }
});

test("frozen-invalid saved aliases fall through, and unavailable candidates make no Week request", async ({ page }) => {
  let weekRequests = 0;
  await mockPush(page, pushStatus("US/Eastern"));
  await page.route("**/api/calendar/week**", async (route) => {
    weekRequests += 1;
    await fulfillWeek(route);
  });
  await page.goto(`/tasks?view=week&week=${WEEK}`);
  await expect(page.getByTestId("week-view")).toContainText("UTC");
  expect(weekRequests).toBe(1);

  await page.unroute("**/api/push/status");
  await page.route("**/api/push/status", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(pushStatus(null)) }));
  await page.addInitScript(() => {
    const original = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      return { ...original.call(this), timeZone: "US/Eastern" };
    };
  });
  await page.reload();
  await expect(page.getByText("week-timezone-unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText(/Week needs a supported calendar time zone/)).toBeVisible();
  expect(weekRequests).toBe(1);
  await page.getByRole("button", { name: "Retry Week timezone" }).click();
  await expect(page.getByText("week-timezone-unavailable", { exact: true })).toBeVisible();
  expect(weekRequests).toBe(1);
});

test("UTC, Berlin, New York, Lord Howe, Chatham, DST, and year rollover keep zoned Fixed display separate from literal deadlines", async ({ page }) => {
  const cases = [
    { zone: "UTC", week: "2026-12-28", start: "2027-01-01T12:00:00.000Z", end: "2027-01-01T13:00:00.000Z", date: "2027-01-01", deadline: "2027-01-02" },
    { zone: "Europe/Berlin", week: "2026-03-23", start: "2026-03-29T00:30:00.000Z", end: "2026-03-29T01:30:00.000Z", date: "2026-03-29", deadline: "2026-03-29" },
    { zone: "America/New_York", week: "2026-10-26", start: "2026-11-01T05:30:00.000Z", end: "2026-11-01T07:30:00.000Z", date: "2026-11-01", deadline: "2026-10-31" },
    { zone: "Australia/Lord_Howe", week: "2026-09-28", start: "2026-10-03T15:15:00.000Z", end: "2026-10-03T16:15:00.000Z", date: "2026-10-04", deadline: "2026-10-03" },
    { zone: "Pacific/Chatham", week: "2026-06-29", start: "2026-07-01T00:00:00.000Z", end: "2026-07-01T01:00:00.000Z", date: "2026-07-01", deadline: "2026-07-02" },
  ];
  let active = cases[0];
  await page.route("**/api/push/status", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(pushStatus(active.zone)) }));
  await page.route("**/api/calendar/week**", (route) => {
    const url = new URL(route.request().url());
    const record = taskRecord(1, `${active.zone} fixture`, { fixed: [active.start, active.end], deadline: active.deadline }) as Extract<WeekRecord, { kind: "task" }>;
    record.fixed!.contextDate = active.date;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope(url.searchParams.get("weekStart")!, active.zone, [record])) });
  });
  for (const fixture of cases) {
    active = fixture;
    await page.goto(`/tasks?view=week&week=${fixture.week}`);
    const row = page.locator('[data-week-identity="task:1"]');
    await expect(row).toContainText(`${fixture.zone} fixture`);
    await expect(row).toContainText(`source date ${fixture.date}`);
    await expect(row.getByText(fixture.deadline, { exact: true })).toBeVisible();
    await expect(page.getByTestId("week-view")).toContainText(fixture.zone);
  }
  active = cases[0];
  await page.goto("/tasks?view=week&week=2026-12-28");
  await page.getByRole("button", { name: "Next week" }).click();
  await expect(page).toHaveURL("/tasks?view=week&week=2027-01-04");
});

test("nullable boundary context keeps Fixed visible while omitting only source-date context", async ({ page }) => {
  await mockPush(page, pushStatus("America/New_York"));
  const record = taskRecord(1, "Boundary fixed", { fixed: ["0001-01-01T00:00:00.000Z", "0001-01-01T10:00:00.000Z"] }) as Extract<WeekRecord, { kind: "task" }>;
  record.fixed!.contextDate = null;
  await page.route("**/api/calendar/week**", (route) => fulfillWeek(route, [record]));
  await page.goto("/tasks?view=week&week=0001-01-01");
  const row = page.locator('[data-week-identity="task:1"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText("Fixed");
  await expect(row).not.toContainText("source date");
  await expect(page.locator(".week-block-fixed")).toBeVisible();
});

test("page-one 400, busy, unavailable, and projection failure remain distinct explicit Retry states", async ({ page }) => {
  await mockPush(page);
  let status = 400;
  let code = "invalid-week-request";
  await page.route("**/api/calendar/week**", (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: code }) }));
  await page.goto(`/tasks?view=week&week=${WEEK}`);
  await expect(page.getByRole("heading", { name: "Week request rejected" })).toBeVisible();
  for (const fixture of [
    [503, "week-projection-busy", "Week is busy"],
    [503, "week-index-unavailable", "Week index unavailable"],
    [500, "week-projection-failed", "Week projection failed"],
  ] as const) {
    [status, code] = fixture;
    await page.getByRole("button", { name: "Retry Week page" }).click();
    await expect(page.getByRole("heading", { name: fixture[2] })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry Week page" })).toBeVisible();
  }
});

test("desktop and narrow layouts preserve the closed action matrix, labels, hostile text, clipping, and links", async ({ page }) => {
  await mockPush(page);
  const records: WeekRecord[] = [
    taskRecord(1, "<img src=x onerror=alert(1)>", { fixed: ["2026-10-25T23:30:00.000Z", "2026-10-26T01:00:00.000Z"], deadline: "2026-10-30" }),
    taskRecord(2, "Done fixed", { status: "done", fixed: ["2026-10-26T10:00:00.000Z", "2026-10-26T11:00:00.000Z"] }),
    { kind: "goal", id: 3, title: "Goal deadline", titleTruncated: false, status: "active", deadline: { date: "2026-10-27" } },
    { kind: "tracked", id: 4, taskId: 40, taskStatus: "open", title: "Open tracked", titleTruncated: false, startedAt: "2026-10-28T08:00:00.000Z", effectiveEndAt: "2026-10-28T09:00:00.000Z", running: false },
    { kind: "tracked", id: 5, taskId: 50, taskStatus: "done", title: "Done tracked", titleTruncated: false, startedAt: "2026-10-28T10:00:00.000Z", effectiveEndAt: "2026-10-28T11:00:00.000Z", running: false },
    { kind: "tracked", id: 6, taskId: 60, taskStatus: "archived", title: "Archived tracked", titleTruncated: false, startedAt: "2026-10-29T10:00:00.000Z", effectiveEndAt: REQUEST_NOW, running: true },
  ];
  await page.route("**/api/calendar/week**", (route) => fulfillWeek(route, records));
  await page.goto(`/tasks?view=week&week=${WEEK}`);

  await expect(page.locator(".week-deadline-rail")).toBeVisible();
  await expect(page.locator(".week-timeline")).toBeVisible();
  await expect(page.locator(".week-block-fixed").first()).toContainText("Fixed");
  await expect(page.locator(".week-block-tracked").first()).toContainText("Tracked");
  await expect(page.locator("img")).toHaveCount(0);
  await expect(page.getByText("<img src=x onerror=alert(1)>", { exact: true })).toBeVisible();
  await expect(page.locator("[data-week-identity]")).toHaveCount(6);

  const openTask = page.locator('[data-week-identity="task:1"]');
  await expect(openTask.getByRole("link", { name: "<img src=x onerror=alert(1)>" })).toHaveAttribute("href", "/tasks?focus=1&showDone=1");
  await expect(openTask.getByRole("button", { name: "Complete" })).toBeVisible();
  await expect(openTask.getByRole("button", { name: "Start now" })).toBeVisible();
  await expect(openTask.getByRole("link", { name: "Edit fixed" })).toHaveAttribute("href", "/tasks?focus=1&showDone=1");
  await expect(openTask.getByRole("button", { name: "Remove fixed" })).toBeVisible();
  await expect(openTask.getByText("source date 2026-10-25")).toBeVisible();

  const doneTask = page.locator('[data-week-identity="task:2"]');
  await expect(doneTask.getByRole("button", { name: "Reopen" })).toBeVisible();
  await expect(doneTask.getByRole("button", { name: "Start now" })).toHaveCount(0);
  await expect(doneTask.getByRole("link", { name: "Edit fixed" })).toHaveAttribute("href", "/tasks?focus=2&showDone=1");
  const goal = page.locator('[data-week-identity="goal:3"]');
  await expect(goal.getByRole("link", { name: "Goal deadline" })).toHaveAttribute("href", "/goals?focus=3");
  await expect(goal.locator("button")).toHaveCount(0);
  const openTracked = page.locator('[data-week-identity="tracked:4"]');
  await expect(openTracked.getByRole("button", { name: "Complete" })).toBeVisible();
  await expect(openTracked.getByRole("button", { name: "Start now" })).toBeVisible();
  await expect(openTracked.getByRole("button", { name: "Stop" })).toHaveCount(0);
  const doneTracked = page.locator('[data-week-identity="tracked:5"]');
  await expect(doneTracked.getByRole("button", { name: "Reopen" })).toBeVisible();
  await expect(doneTracked.getByRole("button", { name: "Start now" })).toHaveCount(0);
  const archived = page.locator('[data-week-identity="tracked:6"]');
  await expect(archived.getByRole("link")).toHaveCount(0);
  await expect(archived.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(archived.getByRole("button", { name: /Complete|Reopen|Start now/ })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".week-deadline-rail")).toBeHidden();
  await expect(page.locator(".week-timeline")).toBeHidden();
  await expect(page.locator(".week-agenda")).toBeVisible();
  expect(await page.locator("[data-week-identity]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-week-identity"))))
    .toEqual(["task:1", "task:2", "goal:3", "tracked:4", "tracked:5", "tracked:6"]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("Week fixed edit navigates to the authoritative retained-zone editor for unchanged and partial saves", async ({ page, request }) => {
  const categories = await (await request.get("/api/categories")).json() as Array<{ id: number }>;
  const title = `Week retained zone ${Date.now()}`;
  const createdResponse = await request.post("/api/tasks", { data: {
    title,
    categoryId: categories[0].id,
    fixedSlot: {
      startLocal: "2026-10-27T10:00",
      endLocal: "2026-10-27T11:00",
      entryTimezone: "Europe/Berlin",
    },
  } });
  expect(createdResponse.ok()).toBe(true);
  const created = await createdResponse.json() as {
    id: number;
    fixedSlot: { startsAt: string; endsAt: string; startLocal: string; endLocal: string; entryTimezone: string };
  };
  const original = { ...created.fixedSlot };

  try {
    await mockPush(page, pushStatus("America/New_York"));
    const record = taskRecord(created.id, title, {
      fixed: [created.fixedSlot.startsAt, created.fixedSlot.endsAt],
    }) as Extract<WeekRecord, { kind: "task" }>;
    record.fixed!.contextDate = "2026-10-27";
    await page.route("**/api/calendar/week**", (route) => fulfillWeek(route, [record]));
    await page.goto(`/tasks?view=week&week=${WEEK}`);
    await expect(page.getByTestId("week-view")).toContainText("America/New_York");

    await page.locator(`[data-week-identity="task:${created.id}"]`).getByRole("link", { name: "Edit fixed" }).click();
    await expect(page).toHaveURL(`/tasks`);
    const tree = page.getByTestId("task-tree");
    await expect(tree.getByLabel("Entry timezone")).toHaveValue("Europe/Berlin");
    await expect(tree.getByLabel("Fixed start")).toHaveValue("2026-10-27T10:00");
    await expect(tree.getByLabel("Fixed end")).toHaveValue("2026-10-27T11:00");

    await tree.getByRole("button", { name: "Save", exact: true }).click();
    await expect(tree.getByLabel("Fixed start")).toHaveCount(0);
    let stored = (await (await request.get("/api/tasks?status=all")).json()).find(
      (candidate: { id: number }) => candidate.id === created.id,
    );
    expect(stored.fixedSlot).toEqual(original);

    const taskRow = tree.getByText(title, { exact: true }).first().locator("..");
    await taskRow.getByTitle("Edit", { exact: true }).click();
    await expect(tree.getByLabel("Entry timezone")).toHaveValue("Europe/Berlin");
    await tree.getByLabel("Fixed end").fill("2026-10-27T11:30");
    await tree.getByRole("button", { name: "Save", exact: true }).click();
    await expect(tree.getByLabel("Fixed end")).toHaveCount(0);
    stored = (await (await request.get("/api/tasks?status=all")).json()).find(
      (candidate: { id: number }) => candidate.id === created.id,
    );
    expect(stored.fixedSlot).toMatchObject({
      entryTimezone: "Europe/Berlin",
      startLocal: "2026-10-27T10:00",
      endLocal: "2026-10-27T11:30",
      startsAt: original.startsAt,
      endsAt: "2026-10-27T10:30:00.000Z",
    });
  } finally {
    await request.delete(`/api/tasks/${created.id}`);
  }
});

test("Load more completes 100 plus one records without a quantity promise or API cache", async ({ page }) => {
  await mockPush(page);
  const first = Array.from({ length: 100 }, (_, index) => taskRecord(index + 1, `Paged ${index + 1}`, { deadline: WEEK }));
  const next = cursor(WEEK, "UTC", "2026-10-26T00:00:00.000Z", 0, 100);
  let continuation = 0;
  await page.route("**/api/calendar/week**", async (route) => {
    const url = new URL(route.request().url());
    expect(route.request().headerValue("cache-control")).not.toBe("only-if-cached");
    if (url.searchParams.has("cursor")) {
      continuation += 1;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope(WEEK, "UTC", [{ kind: "goal", id: 1, title: "Page 101", titleTruncated: false, status: "active", deadline: { date: WEEK } }])) });
    } else {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope(WEEK, "UTC", first, next)) });
    }
  });
  await page.goto(`/tasks?view=week&week=${WEEK}`);
  await expect(page.locator("[data-week-identity]")).toHaveCount(100);
  const loadMore = page.getByRole("button", { name: "Load more", exact: true });
  await expect(loadMore).toBeVisible();
  await expect(loadMore).not.toContainText(/100|1/);
  await loadMore.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("[data-week-identity]")).toHaveCount(101);
  await expect(page.getByText("Page 101", { exact: true })).toBeVisible();
  await expect(loadMore).toHaveCount(0);
  expect(continuation).toBe(1);
});

test("one continuation 400 discards the generation and restarts page one exactly once", async ({ page }) => {
  await mockPush(page);
  const next = cursor(WEEK, "UTC", "2026-10-26T08:00:00.000Z", 0, 1);
  const freshNext = cursor(WEEK, "UTC", "2026-10-26T09:00:00.000Z", 0, 2);
  let pageOne = 0;
  let continuation = 0;
  await page.route("**/api/calendar/week**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("cursor")) {
      continuation += 1;
      await route.fulfill({ status: 400, contentType: "application/json", body: '{"error":"invalid-week-request"}' });
      return;
    }
    pageOne += 1;
    const records = pageOne === 1
      ? [taskRecord(1, "Old generation", { fixed: ["2026-10-26T08:00:00.000Z", "2026-10-26T09:00:00.000Z"] })]
      : [taskRecord(2, "Fresh generation", { fixed: ["2026-10-26T09:00:00.000Z", "2026-10-26T10:00:00.000Z"] })];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope(WEEK, "UTC", records, pageOne === 1 ? next : freshNext)) });
  });
  await page.goto(`/tasks?view=week&week=${WEEK}`);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("Fresh generation", { exact: true })).toBeVisible();
  await expect(page.getByText("Old generation", { exact: true })).toHaveCount(0);
  expect({ pageOne, continuation }).toEqual({ pageOne: 2, continuation: 1 });
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("heading", { name: "Week request rejected" })).toBeVisible();
  await expect(page.getByText("Fresh generation", { exact: true })).toBeVisible();
  expect({ pageOne, continuation }).toEqual({ pageOne: 2, continuation: 2 });
});

test("stale responses cannot overwrite navigation and invalid pages/errors stay explicit", async ({ page }) => {
  await mockPush(page);
  await page.route("**/api/calendar/week**", async (route) => {
    const url = new URL(route.request().url());
    const week = url.searchParams.get("weekStart")!;
    if (week === WEEK) await new Promise((resolve) => setTimeout(resolve, 350));
    const records = [taskRecord(week === WEEK ? 1 : 2, week === WEEK ? "Stale Week" : "Active Week", { deadline: week })];
    try { await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope(week, "UTC", records)) }); } catch { /* aborted request */ }
  });
  await page.goto(`/tasks?view=week&week=${WEEK}`);
  await page.getByRole("button", { name: "Next week" }).click();
  await expect(page.getByText("Active Week", { exact: true })).toBeVisible();
  await page.waitForTimeout(450);
  await expect(page.getByText("Stale Week", { exact: true })).toHaveCount(0);

  await page.unroute("**/api/calendar/week**");
  await page.route("**/api/calendar/week**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...envelope("2026-11-02", "UTC", []), extra: true }) }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Invalid Week response" })).toBeVisible();
  await expect(page.getByText(/no records from it were accepted/)).toBeVisible();

  await page.unroute("**/api/calendar/week**");
  await page.route("**/api/calendar/week**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"week-index-unavailable"}' }));
  await page.getByRole("button", { name: "Retry Week page" }).click();
  await expect(page.getByRole("heading", { name: "Week index unavailable" })).toBeVisible();
  await expect(page.getByText(/Nothing has been treated as an empty Week/)).toBeVisible();
});

test("delayed action success and failure cannot cross Week navigation, zone reload, or unmount", async ({ page }) => {
  let savedZone = "UTC";
  const weekRequests: string[] = [];
  const outcomes = [deferred<"success" | "failure">(), deferred<"success" | "failure">(), deferred<"success" | "failure">()];
  const starts = [deferred<void>(), deferred<void>(), deferred<void>()];
  let actionIndex = 0;

  await page.route("**/api/push/status", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(pushStatus(savedZone)),
  }));
  await page.route("**/api/calendar/week**", async (route) => {
    const url = new URL(route.request().url());
    const week = url.searchParams.get("weekStart")!;
    const zone = url.searchParams.get("timezone")!;
    weekRequests.push(`${zone}:${week}`);
    await fulfillWeek(route, [taskRecord(1, `Action ${zone} ${week}`, { deadline: week })]);
  });
  await page.route("**/api/tasks/*", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    const index = actionIndex++;
    starts[index].resolve(undefined);
    const outcome = await outcomes[index].promise;
    try {
      await route.fulfill(outcome === "success"
        ? { status: 200, contentType: "application/json", body: '{"newAchievements":[]}' }
        : { status: 500, contentType: "application/json", body: '{"error":"delayed-old-action"}' });
    } catch { /* a document unmount can close the old request */ }
  });

  await page.goto(`/tasks?view=week&week=${WEEK}`);
  await page.locator('[data-week-identity="task:1"]').getByRole("button", { name: "Complete" }).click();
  await starts[0].promise;
  await page.getByRole("button", { name: "Next week" }).click();
  await expect(page.getByText("Action UTC 2026-11-02", { exact: true })).toBeVisible();
  outcomes[0].resolve("failure");
  await page.waitForTimeout(100);
  await expect(page.getByText("delayed-old-action", { exact: true })).toHaveCount(0);
  expect(weekRequests.filter((entry) => entry === "UTC:2026-11-02")).toHaveLength(1);

  await page.locator('[data-week-identity="task:1"]').getByRole("button", { name: "Complete" }).click();
  await starts[1].promise;
  savedZone = "Europe/Berlin";
  await page.reload();
  await expect(page.getByText("Action Europe/Berlin 2026-11-02", { exact: true })).toBeVisible();
  const utcRequestsBeforeLateSuccess = weekRequests.filter((entry) => entry === "UTC:2026-11-02").length;
  outcomes[1].resolve("success");
  await page.waitForTimeout(100);
  expect(weekRequests.filter((entry) => entry === "UTC:2026-11-02")).toHaveLength(utcRequestsBeforeLateSuccess);
  await expect(page.getByText("delayed-old-action", { exact: true })).toHaveCount(0);

  await page.locator('[data-week-identity="task:1"]').getByRole("button", { name: "Complete" }).click();
  await starts[2].promise;
  const weekRequestCountBeforeUnmount = weekRequests.length;
  await page.getByRole("button", { name: "List", exact: true }).click();
  outcomes[2].resolve("failure");
  await page.waitForTimeout(100);
  expect(weekRequests).toHaveLength(weekRequestCountBeforeUnmount);
  await expect(page.getByText("delayed-old-action", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("task-tree")).toHaveCount(1);
});

test("Title truncated indicator is exact and present only when the protocol says so", async ({ page }) => {
  await mockPush(page);
  await page.route("**/api/calendar/week**", (route) => fulfillWeek(route, [taskRecord(1, "Bounded title", { deadline: WEEK, truncated: true })]));
  await page.goto(`/tasks?view=week&week=${WEEK}`);
  const row = page.locator('[data-week-identity="task:1"]');
  await expect(row.getByText("Title truncated", { exact: true })).toBeVisible();
  await expect(row.getByLabel("Title truncated", { exact: true })).toHaveCount(1);
});

test("public Start now and bodyless Stop create/finalize a distinct Tracked row without changing Fixed or deadline", async ({ page, request }) => {
  await mockPush(page, pushStatus(null));
  const categories = await (await request.get("/api/categories")).json() as Array<{ id: number }>;
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const local = (value: Date) => `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`;
  const monday = new Date(now);
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const week = local(monday).slice(0, 10);
  const fixedStart = new Date(now.getTime() - 30 * 60_000);
  const fixedEnd = new Date(now.getTime() + 30 * 60_000);
  const title = `Week public timer ${Date.now()}`;
  const created = await request.post("/api/tasks", { data: {
    title,
    categoryId: categories[0].id,
    dueDate: week,
    fixedSlot: { startLocal: local(fixedStart), endLocal: local(fixedEnd), entryTimezone: "UTC" },
  } });
  expect(created.ok()).toBeTruthy();
  const task = await created.json() as { id: number; fixedSlot: unknown; dueDate: string };
  try {
    await page.goto(`/tasks?view=week&week=${week}`);
    const planning = page.locator(`[data-week-identity="task:${task.id}"]`);
    await expect(planning).toContainText(title);
    const before = Date.now();
    await planning.getByRole("button", { name: "Start now" }).click();
    const after = Date.now();
    const runningRow = page.locator('[data-week-identity^="tracked:"]', { hasText: title });
    await expect(runningRow).toBeVisible();
    await expect(runningRow.getByRole("button", { name: "Stop" })).toBeVisible();
    const runningApi = await (await request.get(`/api/calendar/week?weekStart=${week}&timezone=UTC`)).json();
    const running = runningApi.records.find((record: any) => record.kind === "tracked" && record.taskId === task.id && record.running);
    expect(Date.parse(running.startedAt)).toBeGreaterThanOrEqual(before - 1_000);
    expect(Date.parse(running.startedAt)).toBeLessThanOrEqual(after + 1_000);
    expect(running.effectiveEndAt).toBe(runningApi.requestNow);

    let stopBody: string | null | undefined;
    page.on("request", (outgoing) => {
      if (outgoing.url().endsWith("/api/timer/stop") && outgoing.method() === "POST") stopBody = outgoing.postData();
    });
    await runningRow.getByRole("button", { name: "Stop" }).click();
    await expect(page.locator('[data-week-identity^="tracked:"]', { hasText: title }).getByRole("button", { name: "Stop" })).toHaveCount(0);
    expect(stopBody ?? null).toBeNull();
    // The UI's refresh owns the sole Week worker briefly after Stop. Poll the
    // public read until that admitted request releases it; never interpret its
    // exact busy response as an empty Week.
    let finalizedApi: any = null;
    await expect.poll(async () => {
      const response = await request.get(`/api/calendar/week?weekStart=${week}&timezone=UTC`);
      if (!response.ok()) return response.status();
      finalizedApi = await response.json();
      return 200;
    }).toBe(200);
    const finalized = finalizedApi.records.find((record: any) => record.kind === "tracked" && record.id === running.id);
    expect(finalized.running).toBe(false);
    expect(Date.parse(finalized.effectiveEndAt)).toBeGreaterThanOrEqual(Date.parse(running.startedAt));
    const allTasks = await (await request.get("/api/tasks?status=all")).json();
    const source = allTasks.find((record: any) => record.id === task.id);
    expect(source.dueDate).toBe(task.dueDate);
    expect(source.fixedSlot).toEqual(task.fixedSlot);
  } finally {
    await request.post("/api/timer/stop").catch(() => undefined);
    await request.delete(`/api/tasks/${task.id}`);
  }
});

test("direct Temp-DB historical fixture drives real paging, deterministic lanes, archive policy, hostile text, overnight clipping, and byte truncation", async ({ page }) => {
  test.setTimeout(60_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "draw-week-client-fixture-"));
  const requireFromRepository = createRequire(path.join(process.cwd(), "package.json"));
  let fixture: ChildProcess | null = null;
  try {
    fixture = spawn(
      process.execPath,
      [requireFromRepository.resolve("tsx/cli"), path.resolve("e2e/week-fixture-server.ts")],
      { cwd: process.cwd(), env: { ...process.env, DATA_DIR: root }, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    let stderr = "";
    fixture.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    const port = await new Promise<number>((resolve, reject) => {
      let stdout = "";
      const timeout = setTimeout(() => reject(new Error(`fixture server timeout: ${stderr}`)), 15_000);
      fixture!.once("error", reject);
      fixture!.once("exit", (code) => reject(new Error(`fixture server exited ${code}: ${stderr}`)));
      fixture!.stdout!.on("data", (chunk) => {
        stdout += String(chunk);
        const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith('{"port":'));
        if (!line) return;
        clearTimeout(timeout);
        resolve((JSON.parse(line) as { port: number }).port);
      });
    });
    const origin = `http://127.0.0.1:${port}`;

    await mockPush(page, pushStatus("UTC"));
    await page.route("**/api/calendar/week**", async (route) => {
      const source = new URL(route.request().url());
      const target = `${origin}${source.pathname}${source.search}`;
      const response = await route.fetch({ url: target });
      await route.fulfill({ response });
    });
    await page.goto(`/tasks?view=week&week=${WEEK}`);

    for (const title of [
      "Crossing fixed", "Equal fixed alpha", "Equal fixed beta", "Dual deadline",
      "Tracked source", "Archived source", "Overnight source", "<script>hostile()</script>",
      "Historical goal",
    ]) await expect(page.getByText(title, { exact: true }).last()).toBeVisible();
    await expect(page.locator("script", { hasText: "hostile" })).toHaveCount(0);
    await expect(page.locator('[data-week-identity="tracked:303"] a')).toHaveCount(0);
    await expect(page.locator('[data-week-identity="tracked:303"]')).toContainText("Archived source");
    await expect(page.locator(".week-block-fixed")).toHaveCount(4);
    await expect(page.locator(".week-block-tracked")).toHaveCount(5); // overnight is split over two days

    const equalLanes = await page.locator(".week-block-fixed", { hasText: /Equal fixed/ }).evaluateAll((blocks) =>
      blocks.map((block) => ({ left: (block as HTMLElement).style.left, width: (block as HTMLElement).style.width })),
    );
    expect(new Set(equalLanes.map((lane) => lane.left)).size).toBe(2);
    expect(new Set(equalLanes.map((lane) => lane.width)).size).toBe(1);
    expect(equalLanes.every((lane) => lane.width !== "100%")).toBe(true);
    await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.getByText("Title truncated", { exact: true })).toBeVisible();
    await expect(page.locator('[data-week-identity="task:109"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  } finally {
    await closeFixtureAndRemove(fixture, root);
  }
});
