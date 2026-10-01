import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { WeekRecord } from "../shared/weekContract.js";
import { seedHistoricalWeek } from "./week-fixtures.js";

test.use({ timezoneId: "UTC" });

const WEEK = "2026-10-26";
const REQUEST_NOW = "2026-10-29T12:00:00.000Z";

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
  await expect(openTask.getByRole("button", { name: "Edit fixed" })).toBeVisible();
  await expect(openTask.getByRole("button", { name: "Remove fixed" })).toBeVisible();
  await openTask.getByRole("button", { name: "Edit fixed" }).click();
  await expect(openTask.getByRole("form", { name: /Edit fixed time/ })).toBeVisible();
  await expect(openTask.getByText("source date 2026-10-25")).toBeVisible();

  const doneTask = page.locator('[data-week-identity="task:2"]');
  await expect(doneTask.getByRole("button", { name: "Reopen" })).toBeVisible();
  await expect(doneTask.getByRole("button", { name: "Start now" })).toHaveCount(0);
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
    const finalizedApi = await (await request.get(`/api/calendar/week?weekStart=${week}&timezone=UTC`)).json();
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
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = root;
  let server: Server | null = null;
  const dbModule = await import("../server/src/db.js");
  try {
    seedHistoricalWeek({
      db: dbModule.db,
      maintainFixedIntervalWrite: dbModule.maintainFixedIntervalWrite,
      beginWeekIntervalMutation: dbModule.beginWeekIntervalMutation,
      reprojectTrackedIntervals: (token, ids) => dbModule.reprojectTrackedIntervals(token as never, ids),
      finalizeWeekIntervalMutation: (token) => dbModule.finalizeWeekIntervalMutation(token as never),
    });
    const { createApp } = await import("../server/src/app.js");
    server = createApp().listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.listening ? resolve() : server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture listener");
    const origin = `http://127.0.0.1:${address.port}`;

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
    if (server?.listening) {
      const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    await dbModule.shutdownWeekProjection();
    dbModule.checkpointAndCloseLiveDatabaseForSwap();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
