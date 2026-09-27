import { expect, test, type Page, type Route } from "@playwright/test";
import { taskTree, triageStrip } from "./helpers.js";

test.use({ timezoneId: "UTC" });
test.describe.configure({ mode: "serial" });

const created = { tasks: [] as number[], goals: [] as number[] };

function pushStatus(timezone: unknown = "UTC") {
  return {
    available: false,
    reason: "not-production",
    mutationAllowed: false,
    mutationReason: "secure-transport-required",
    vapidPublicKey: null,
    maxDevices: 16,
    preferences: { hideDetails: false, leadDays: 1, sendTime: "09:00", timezone, quietStart: null, quietEnd: null },
    devices: [],
  };
}

function overview(timezone = "UTC", groups = {
  overdue: [] as Array<{ type: "task" | "goal"; id: number; title: string; date: string }>,
  today: [] as Array<{ type: "task" | "goal"; id: number; title: string; date: string }>,
  tomorrow: [] as Array<{ type: "task" | "goal"; id: number; title: string; date: string }>,
}) {
  return {
    timezone,
    localDate: "2026-09-27",
    counts: { overdue: groups.overdue.length, today: groups.today.length, tomorrow: groups.tomorrow.length },
    groups,
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function seedTask(page: Page, data: object) {
  const response = await page.request.post("/api/tasks", { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  const task = await response.json() as { id: number };
  created.tasks.push(task.id);
  return task;
}

async function seedGoal(page: Page, data: object) {
  const response = await page.request.post("/api/goals", { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  const goal = await response.json() as { id: number };
  created.goals.push(goal.id);
  return goal;
}

async function utcDates(page: Page) {
  const response = await page.request.get("/api/daily-overview?timezone=UTC");
  expect(response.ok()).toBeTruthy();
  const today = (await response.json() as { localDate: string }).localDate;
  const add = (days: number) => {
    const date = new Date(`${today}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  return { today, tomorrow: add(1), future: add(2), overdue: add(-1) };
}

function row(page: Page, title: string) {
  return page.locator(".today-row").filter({ has: page.getByRole("link", { name: title, exact: true }) });
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const failed: string[] = [];
  for (const id of created.tasks.splice(0).reverse()) {
    const response = await page.request.delete(`/api/tasks/${id}`);
    if (!response.ok() && response.status() !== 404) failed.push(`task ${id}: ${response.status()}`);
  }
  for (const id of created.goals.splice(0).reverse()) {
    const response = await page.request.delete(`/api/goals/${id}`);
    if (!response.ok() && response.status() !== 404) failed.push(`goal ${id}: ${response.status()}`);
  }
  expect(failed, "Today seeds must be removed even after a failed test").toEqual([]);
});

test("waits for saved timezone resolution before the first overview request", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let statusSeen!: () => void;
  const seen = new Promise<void>((resolve) => { statusSeen = resolve; });
  const order: string[] = [];
  let overviewRequests = 0;
  await page.route("**/api/push/status", async (route) => {
    order.push("status-start");
    statusSeen();
    await held;
    order.push("status-end");
    await fulfillJson(route, pushStatus("Europe/Berlin"));
  });
  await page.route("**/api/daily-overview?*", async (route) => {
    overviewRequests++;
    order.push("overview");
    expect(new URL(route.request().url()).searchParams.get("timezone")).toBe("Europe/Berlin");
    await fulfillJson(route, overview("Europe/Berlin"));
  });

  await page.goto("/today");
  await seen;
  await expect(page.getByText("Resolving your timezone…")).toBeVisible();
  expect(overviewRequests).toBe(0);
  release();
  await expect(page.getByText("Nothing is overdue, due today, or due tomorrow.")).toBeVisible();
  expect(order).toEqual(["status-start", "status-end", "overview"]);
  expect(overviewRequests).toBe(1);
});

for (const scenario of [
  { name: "invalid saved timezone", status: pushStatus("Not/A_Zone"), mode: "fulfill" },
  { name: "malformed status", status: { preferences: { timezone: "Europe/Berlin" } }, mode: "fulfill" },
  { name: "failed status", status: null, mode: "abort" },
] as const) {
  test(`falls back to detected timezone after ${scenario.name}`, async ({ page }) => {
    const order: string[] = [];
    await page.route("**/api/push/status", async (route) => {
      order.push("status");
      if (scenario.mode === "abort") await route.abort();
      else await fulfillJson(route, scenario.status);
    });
    await page.route("**/api/daily-overview?*", async (route) => {
      order.push("overview");
      expect(new URL(route.request().url()).searchParams.get("timezone")).toBe("UTC");
      await fulfillJson(route, overview());
    });
    await page.goto("/today");
    await expect(page.getByText("Nothing is overdue, due today, or due tomorrow.")).toBeVisible();
    expect(order).toEqual(["status", "overview"]);
  });
}

test("does not request an overview when neither timezone source is valid", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      return { ...original.call(this), timeZone: "Not/A_Zone" };
    };
  });
  let overviewRequests = 0;
  await page.route("**/api/push/status", (route) => fulfillJson(route, pushStatus("Not/A_Zone")));
  await page.route("**/api/daily-overview?*", (route) => { overviewRequests++; return fulfillJson(route, overview()); });
  await page.goto("/today");
  await expect(page.getByText(/No valid timezone is available/)).toBeVisible();
  expect(overviewRequests).toBe(0);
});

test("shows held loading, fetches on entry and refocus, and never polls", async ({ page }) => {
  await page.route("**/api/push/status", (route) => fulfillJson(route, pushStatus()));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.route("**/api/daily-overview?*", async (route) => {
    requests++;
    if (requests === 1) await held;
    await fulfillJson(route, overview());
  });
  await page.goto("/today");
  await expect(page.getByText("Loading daily overview…")).toBeVisible();
  release();
  await expect(page.getByText("Nothing is overdue, due today, or due tomorrow.")).toBeVisible();
  expect(requests).toBe(1);
  await page.waitForTimeout(1_000);
  expect(requests).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => requests).toBe(2);
});

test("keeps overview failure distinct from empty and retries successfully", async ({ page }) => {
  await page.route("**/api/push/status", (route) => fulfillJson(route, pushStatus()));
  let requests = 0;
  await page.route("**/api/daily-overview?*", async (route) => {
    requests++;
    if (requests === 1) await fulfillJson(route, { error: "synthetic" }, 500);
    else await fulfillJson(route, overview());
  });
  await page.goto("/today");
  await expect(page.getByText(/Could not load the daily overview/)).toBeVisible();
  await expect(page.getByText("Nothing is overdue, due today, or due tomorrow.")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry overview" }).click();
  await expect(page.getByText("Nothing is overdue, due today, or due tomorrow.")).toBeVisible();
  expect(requests).toBe(2);
});

test("Draw action and direct route show stable mixed sections and canonical links without nav entries", async ({ page }) => {
  await page.route("**/api/push/status", (route) => fulfillJson(route, pushStatus()));
  await page.route("**/api/daily-overview?*", (route) => fulfillJson(route, overview("UTC", {
    overdue: [{ type: "task", id: 7, title: "Late task", date: "2026-09-20" }],
    today: [{ type: "goal", id: 9, title: "Today goal", date: "2026-09-27" }],
    tomorrow: [],
  })));
  await page.goto("/");
  const action = page.getByRole("link", { name: "Today", exact: true });
  await expect(action).toBeVisible();
  await action.click();
  for (const group of ["overdue", "today", "tomorrow"]) {
    await expect(page.locator(`[data-overview-group="${group}"]`).getByRole("heading")).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Late task" })).toHaveAttribute("href", "/tasks?focus=7&showDone=1");
  await expect(page.getByRole("link", { name: "Today goal" })).toHaveAttribute("href", "/goals?focus=9");
  await expect(page.locator(".sidenav").getByRole("link", { name: "Today", exact: true })).toHaveCount(0);
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
});

test("all existing task and goal mutations refetch and honestly rebucket or remove rows", async ({ page }) => {
  const categories = await (await page.request.get("/api/categories")).json() as Array<{ id: number }>;
  const dates = await utcDates(page);
  const tasks = {
    clear: await seedTask(page, { title: "Today clear task", categoryId: categories[0].id, dueDate: dates.today }),
    move: await seedTask(page, { title: "Today move task", categoryId: categories[0].id, dueDate: dates.today }),
    future: await seedTask(page, { title: "Today future task", categoryId: categories[0].id, dueDate: dates.today }),
    complete: await seedTask(page, { title: "Today complete task", categoryId: categories[0].id, dueDate: dates.today }),
    archive: await seedTask(page, { title: "Today archive task", categoryId: categories[0].id, dueDate: dates.today }),
    delete: await seedTask(page, { title: "Today delete task", categoryId: categories[0].id, dueDate: dates.today }),
    recurring: await seedTask(page, { title: "Today recurring task", categoryId: categories[0].id, dueDate: dates.today, recurEveryDays: 1 }),
  };
  const goals = {
    clear: await seedGoal(page, { title: "Today clear goal", targetDate: dates.today }),
    achieved: await seedGoal(page, { title: "Today achieved goal", targetDate: dates.today }),
    missed: await seedGoal(page, { title: "Today missed goal", targetDate: dates.today }),
    dropped: await seedGoal(page, { title: "Today dropped goal", targetDate: dates.today }),
    delete: await seedGoal(page, { title: "Today delete goal", targetDate: dates.today }),
  };
  expect(Object.values(tasks).every(({ id }) => id > 0) && Object.values(goals).every(({ id }) => id > 0)).toBeTruthy();

  await page.goto("/today");
  await expect(row(page, "Today clear task")).toBeVisible();
  await row(page, "Today clear task").getByRole("button", { name: "Clear date" }).click();
  await expect(row(page, "Today clear task")).toHaveCount(0);

  const move = row(page, "Today move task");
  await move.getByLabel("Due date for Today move task").fill(dates.tomorrow);
  await move.getByRole("button", { name: "Save date" }).click();
  await expect(page.locator('[data-overview-group="tomorrow"]')).toContainText("Today move task");

  const future = row(page, "Today future task");
  await future.getByLabel("Due date for Today future task").fill(dates.future);
  await future.getByRole("button", { name: "Save date" }).click();
  await expect(row(page, "Today future task")).toHaveCount(0);

  for (const [title, action] of [["Today complete task", "Complete"], ["Today archive task", "Archive"]] as const) {
    await row(page, title).getByRole("button", { name: action }).click();
    await expect(row(page, title)).toHaveCount(0);
  }
  page.once("dialog", (dialog) => dialog.accept());
  await row(page, "Today delete task").getByRole("button", { name: "Delete" }).click();
  await expect(row(page, "Today delete task")).toHaveCount(0);

  await row(page, "Today recurring task").getByRole("button", { name: "Complete" }).click();
  await expect(page.locator('[data-overview-group="tomorrow"]')).toContainText("Today recurring task");

  await row(page, "Today clear goal").getByRole("button", { name: "Clear date" }).click();
  await expect(row(page, "Today clear goal")).toHaveCount(0);
  await row(page, "Today achieved goal").getByRole("button", { name: "Achieved" }).click();
  await expect(row(page, "Today achieved goal")).toHaveCount(0);
  for (const [title, action] of [["Today missed goal", "Missed"], ["Today dropped goal", "Dropped"]] as const) {
    page.once("dialog", (dialog) => dialog.accept());
    await row(page, title).getByRole("button", { name: action }).click();
    await expect(row(page, title)).toHaveCount(0);
  }
  page.once("dialog", (dialog) => dialog.accept());
  await row(page, "Today delete goal").getByRole("button", { name: "Delete" }).click();
  await expect(row(page, "Today delete goal")).toHaveCount(0);
});

test("a rejected mutation leaves the row visible with an error", async ({ page }) => {
  const categories = await (await page.request.get("/api/categories")).json() as Array<{ id: number }>;
  const { today } = await utcDates(page);
  const task = await seedTask(page, { title: "Today failed mutation", categoryId: categories[0].id, dueDate: today });
  await page.route(`**/api/tasks/${task.id}`, async (route) => {
    if (route.request().method() === "PATCH") await fulfillJson(route, { error: "synthetic mutation failure" }, 500);
    else await route.continue();
  });
  await page.goto("/today");
  await row(page, "Today failed mutation").getByRole("button", { name: "Clear date" }).click();
  await expect(row(page, "Today failed mutation")).toBeVisible();
  await expect(row(page, "Today failed mutation").getByRole("alert")).toHaveText("synthetic mutation failure");
});

test("archiving a parent keeps its qualifying child focusable in the visible ordinary all-status tree", async ({ page }) => {
  const categories = await (await page.request.get("/api/categories")).json() as Array<{ id: number }>;
  const { today } = await utcDates(page);
  const parent = await seedTask(page, { title: "Today archive parent", categoryId: categories[0].id, dueDate: today });
  const response = await page.request.post(`/api/tasks/${parent.id}/subtasks`, {
    data: { subtasks: [{ title: "Today archived-root child" }] },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const child = (await response.json() as Array<{ id: number }>)[0];
  created.tasks.push(child.id);
  expect((await page.request.patch(`/api/tasks/${child.id}`, { data: { dueDate: today } })).ok()).toBeTruthy();

  await page.goto("/today");
  await row(page, "Today archive parent").getByRole("button", { name: "Archive" }).click();
  await expect(row(page, "Today archive parent")).toHaveCount(0);
  const childLink = row(page, "Today archived-root child").getByRole("link", { name: "Today archived-root child" });
  await expect(childLink).toHaveAttribute("href", `/tasks?focus=${child.id}&showDone=1`);
  await childLink.click();
  await expect(page.getByRole("checkbox", { name: "show done" })).toBeChecked();
  const ordinary = taskTree(page).locator(`[data-task-id="${child.id}"]`);
  await expect(ordinary).toBeVisible();
  await expect(ordinary).toHaveClass(/palette-flash/);
  const triage = triageStrip(page).locator(`[data-task-id="${child.id}"]`);
  expect(await triage.count()).toBeGreaterThan(0);
  await expect(triage).toBeHidden();
});

test("focus waits when all-status tasks finish before held categories", async ({ page }) => {
  const categories = await (await page.request.get("/api/categories")).json() as Array<{ id: number }>;
  const task = await seedTask(page, { title: "Today held categories focus", categoryId: categories[0].id });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/categories", async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await page.goto(`/tasks?focus=${task.id}&showDone=1`);
  await expect(page).toHaveURL("/tasks");
  await expect(page.getByRole("checkbox", { name: "show done" })).toBeChecked();
  await expect(taskTree(page).locator(`[data-task-id="${task.id}"]`)).toHaveCount(0);
  release();
  const ordinary = taskTree(page).locator(`[data-task-id="${task.id}"]`);
  await expect(ordinary).toBeVisible();
  await expect(ordinary).toHaveClass(/palette-flash/);
});
