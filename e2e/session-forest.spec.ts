import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { drawFromGoal } from "./helpers.js";

test.describe.configure({ mode: "serial" });

const PREFIX = "Forest client e2e";
const STAMP = "2026-01-02T03:04:05.006Z";

type Task = { id: number; title: string };
type Tree = { id: number; startedAt: string; endedAt: string; endReason: "done" | "stop" };

function trees(first: number, count: number): Tree[] {
  return Array.from({ length: count }, (_, index) => ({
    id: first - index,
    startedAt: STAMP,
    endedAt: new Date(Date.parse(STAMP) + 65_000).toISOString(),
    endReason: index % 2 === 0 ? "done" : "stop",
  }));
}

function current(id = 300, startedAt = STAMP) {
  return {
    entry: { id, taskId: 700, startedAt, endedAt: null },
    task: {
      id: 700,
      title: "Synthetic fixture — never a forest label",
      categoryId: 1,
      impact: 3,
      effortMinutes: 15,
      goalId: null,
      status: "open",
    },
  };
}

async function stubForest(
  page: Page,
  pageBody: { trees: Tree[]; nextBeforeId: number | null },
  currentBody: ReturnType<typeof current> | null = null,
) {
  await page.route("**/api/forest*", (route) => route.fulfill({ json: pageBody }));
  await page.route("**/api/timer/current", (route) => route.fulfill({ json: currentBody }));
}

async function firstCategory(request: APIRequestContext): Promise<number> {
  const categories: Array<{ id: number }> = await (await request.get("/api/categories")).json();
  return categories[0].id;
}

async function createTask(request: APIRequestContext, title: string, extra: Record<string, unknown> = {}): Promise<Task> {
  const response = await request.post("/api/tasks", {
    data: { title, categoryId: await firstCategory(request), effortMinutes: 1, ...extra },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function createChildren(request: APIRequestContext, parentId: number, names: string[]): Promise<Task[]> {
  const response = await request.post(`/api/tasks/${parentId}/subtasks`, {
    data: { subtasks: names.map((title) => ({ title, effortMinutes: 1 })) },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function currentEntry(request: APIRequestContext): Promise<{ id: number; startedAt: string }> {
  const response = await (await request.get("/api/timer/current")).json();
  expect(response).not.toBeNull();
  return response.entry;
}

async function forest(request: APIRequestContext): Promise<Tree[]> {
  return (await (await request.get("/api/forest")).json()).trees;
}

async function expectOutcome(request: APIRequestContext, id: number, reason: "done" | "stop") {
  await expect.poll(async () => (await forest(request)).find((tree) => tree.id === id)?.endReason).toBe(reason);
}

async function expectNoOutcome(request: APIRequestContext, id: number) {
  expect((await forest(request)).some((tree) => tree.id === id)).toBe(false);
}

test("/forest is the active six-link destination and Stats has no forest subtree", async ({ page }) => {
  await stubForest(page, { trees: [], nextBeforeId: null });
  await page.goto("/forest");

  await expect(page.getByRole("heading", { level: 1, name: "Forest", exact: true })).toBeVisible();
  const nav = page.locator("nav.sidenav");
  await expect(nav.getByRole("link")).toHaveText(["Draw", "Tasks", "Goals", "Forest", "Stats", "Settings"]);
  const forestLink = nav.getByRole("link", { name: "Forest", exact: true });
  await expect(forestLink).toHaveClass(/active/);
  await expect(forestLink).toHaveAttribute("aria-current", "page");
  const icon = forestLink.locator("svg");
  await expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
  await expect(icon).toHaveAttribute("stroke", "currentColor");
  await expect(icon).toHaveAttribute("stroke-width", "2");
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByText("Start a working session to grow the first tree.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Selected tree details" })).toHaveCount(0);

  await page.goto("/stats");
  await expect(page.getByRole("heading", { level: 1, name: "Stats", exact: true })).toBeVisible();
  await expect(page.locator(".session-forest")).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Forest", exact: true })).toBeVisible();
});

test("initial loading and unavailable Retry publish no half-response and retain route chrome", async ({ page }) => {
  let releaseForest!: () => void;
  let releaseCurrent!: () => void;
  const forestGate = new Promise<void>((resolve) => { releaseForest = resolve; });
  const currentGate = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  let forestAttempts = 0;
  let currentAttempts = 0;
  let unavailable = true;
  let currentReleased = false;

  await page.route("**/api/forest*", async (route) => {
    forestAttempts += 1;
    if (unavailable) {
      await forestGate;
      return route.fulfill({ status: 503, json: { error: "fixture unavailable" } });
    }
    return route.fulfill({ json: { trees: [], nextBeforeId: null } });
  });
  await page.route("**/api/timer/current", async (route) => {
    currentAttempts += 1;
    if (!currentReleased) await currentGate;
    return route.fulfill({ json: null });
  });

  await page.goto("/forest");
  await expect(page.getByRole("status")).toHaveText("Loading the forest…");
  await expect(page.getByTestId("forest-scene")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Forest", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Forest", exact: true })).toBeVisible();

  releaseForest();
  currentReleased = true;
  releaseCurrent();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("The forest is unavailable.");
  await expect(alert).not.toContainText("Stats");
  await expect(page.getByTestId("forest-scene")).toHaveCount(0);
  unavailable = false;
  await alert.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Start a working session to grow the first tree.", { exact: true })).toBeVisible();
  expect(forestAttempts).toBeGreaterThanOrEqual(2);
  expect(currentAttempts).toBeGreaterThanOrEqual(2);
});

test("native radio arrows, pointer selection and one details region share checked state without task text", async ({ page }) => {
  await page.clock.install({ time: new Date(STAMP) });
  await stubForest(page, { trees: [
    { ...trees(2, 1)[0], id: 2, endReason: "done" },
    { ...trees(1, 1)[0], id: 1, endReason: "stop" },
  ], nextBeforeId: null }, current(3));
  await page.goto("/forest");

  const growing = page.getByRole("radio", { name: /^Growing\./ });
  const living = page.getByRole("radio", { name: /^Living\./ });
  const dead = page.getByRole("radio", { name: /^Dead\./ });
  const details = page.getByRole("region", { name: "Selected tree details" });
  await expect(page.getByRole("group", { name: "Forest trees" })).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(3);
  await expect(growing).toBeChecked();
  await expect(details).toHaveCount(1);
  await expect(details).toContainText("Growing");
  await expect(details).toContainText("Started");
  await expect(details).toContainText("0s");
  await expect(page.locator(".forest-tree.growing .forest-tree-art")).toBeVisible();

  await growing.focus();
  await page.keyboard.press("ArrowRight");
  await expect(living).toBeChecked();
  await expect(living).toBeFocused();
  await expect(details).toContainText("Living");
  await expect(details).toContainText("Ended");

  await page.keyboard.press("ArrowRight");
  await expect(dead).toBeChecked();
  await expect(dead).toBeFocused();
  await expect(details).toContainText("Dead");

  await page.locator('[data-session-id="3"]').click();
  await expect(growing).toBeChecked();
  await expect(details).toContainText("Growing");
  await expect(page.locator(".session-forest")).not.toContainText("Synthetic fixture — never a forest label");

  const controlsBeforeGroup = await page.evaluate(() => {
    const controls = document.querySelector('[aria-label="Forest history"]')!;
    const group = document.querySelector(".forest-world")!;
    return Boolean(controls.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(controlsBeforeGroup).toBe(true);
});

test("one scene owns continuous terrain; transparent cells are not cards and variants keep equal envelopes", async ({ page }) => {
  await stubForest(page, { trees: [
    { ...trees(2, 1)[0], id: 2, endReason: "done" },
    { ...trees(1, 1)[0], id: 1, endReason: "stop" },
  ], nextBeforeId: null }, current(3));
  await page.goto("/forest");

  await expect(page.getByTestId("forest-scene")).toHaveCount(1);
  await expect(page.locator(".forest-world")).toHaveCount(1);
  await expect(page.locator(".forest-tree")).toHaveCount(3);
  await expect(page.locator(".forest-tree .panel")).toHaveCount(0);
  await expect(page.locator(".forest-ground")).toHaveCount(0);

  const geometry = await page.locator(".forest-tree").evaluateAll((cells) => cells.map((cell) => {
    const style = getComputedStyle(cell);
    const rect = cell.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      background: style.backgroundColor,
      border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
      radius: style.borderRadius,
      shadow: style.boxShadow,
    };
  }));
  for (const cell of geometry) {
    expect(cell.background).toBe("rgba(0, 0, 0, 0)");
    expect(cell.border).toEqual(["0px", "0px", "0px", "0px"]);
    expect(cell.radius).toBe("0px");
    expect(cell.shadow).toBe("none");
  }
  expect(Math.abs(geometry[1].width - geometry[2].width)).toBeLessThan(1);
  expect(geometry[1].height).toBe(geometry[2].height);
  expect(await page.locator(".forest-world").evaluate((el) => getComputedStyle(el).backgroundImage)).not.toBe("none");
  await expect(page.locator(".forest-tree-art").first()).toHaveCSS("pointer-events", "none");
});

test("failed Older retains publication/details and Retry repeats its cursor; Newest restores page one", async ({ page }) => {
  let olderAttempts = 0;
  let releaseOlder!: () => void;
  const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
  await page.route("**/api/timer/current", (route) => route.fulfill({ json: current(300) }));
  await page.route("**/api/forest*", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("beforeId");
    if (cursor === "101") {
      olderAttempts += 1;
      if (olderAttempts === 1) {
        await olderGate;
        return route.fulfill({ status: 503, json: { error: "older unavailable" } });
      }
      return route.fulfill({ json: { trees: trees(100, 99), nextBeforeId: null } });
    }
    return route.fulfill({ json: { trees: trees(200, 100), nextBeforeId: 101 } });
  });

  await page.goto("/forest");
  await expect(page.locator(".forest-tree")).toHaveCount(101);
  await page.locator('[data-tree-id="200"]').click();
  await expect(page.getByRole("region", { name: "Selected tree details" })).toContainText("Living");
  const older = page.getByRole("button", { name: "Older", exact: true });
  await older.click();
  await expect(page.getByTestId("forest-scene")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator('[data-tree-id="200"]')).toBeVisible();
  await expect(page.getByRole("region", { name: "Selected tree details" })).toContainText("Living");
  releaseOlder();

  const error = page.getByRole("alert");
  await expect(error).toContainText("The forest could not be refreshed.");
  await expect(page.locator('[data-tree-id="200"]')).toBeVisible();
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator('[data-tree-id="100"]')).toBeVisible();
  await expect(page.locator('[data-tree-id="200"]')).toHaveCount(0);
  expect(olderAttempts).toBe(2);
  await expect(page.getByRole("radio", { name: /^Growing\./ })).toBeChecked();
  await expect(page.getByRole("button", { name: "Older", exact: true })).toBeDisabled();
  await expect(page.locator("input:focus")).toHaveCount(0);

  const newest = page.getByRole("button", { name: "Newest", exact: true });
  await newest.click();
  await expect(page.locator('[data-tree-id="200"]')).toBeVisible();
  await expect(newest).toBeDisabled();
  await expect(page.locator(".forest-tree")).toHaveCount(101);
});

test("Start grows, focus Exit/estimate expiry do not finish, Stop is dead, restart Done is a distinct living tree, reload is continuous, and deletion removes both", async ({ page }) => {
  const goalResponse = await page.request.post("/api/goals", {
    data: { title: `${PREFIX} goal`, outcome: "Prove the forest", targetDate: null },
  });
  expect(goalResponse.ok()).toBe(true);
  const goal = await goalResponse.json();
  const task = await createTask(page.request, `${PREFIX} same task`, { goalId: goal.id });

  await drawFromGoal(page, goal.title);
  await page.locator(".draw-actions").getByRole("button", { name: "▶ Start now" }).click();
  const first = await currentEntry(page.request);
  await page.getByRole("dialog").getByRole("button", { name: "Exit focus", exact: true }).click();
  await expectNoOutcome(page.request, first.id);

  await page.route("**/api/timer/current", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body?.entry?.id === first.id) {
      body.entry.startedAt = new Date(Date.parse(body.entry.startedAt) - 120_000).toISOString();
    }
    await route.fulfill({ response, json: body });
  });

  await page.goto("/forest");
  const growing = page.locator(`[data-session-id="${first.id}"]`);
  await expect(growing).toContainText("Growing");
  await expect(growing.locator(".forest-leaves")).toBeVisible();
  await expect(page.getByRole("region", { name: "Selected tree details" })).toContainText(/2m/);
  await expectNoOutcome(page.request, first.id);

  await page.reload();
  await expect(page.locator(`[data-session-id="${first.id}"]`)).toContainText("Growing");

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  const dead = page.locator(`[data-tree-id="${first.id}"]`);
  await expect(dead).toContainText("Dead");
  await expect(dead.locator(".forest-branches")).toBeVisible();
  await expectOutcome(page.request, first.id, "stop");

  await page.goto("/");
  await page.locator(".draw-actions").getByRole("button", { name: "▶ Start now" }).click();
  const second = await currentEntry(page.request);
  expect(second.id).not.toBe(first.id);
  await page.getByRole("dialog").getByRole("button", { name: "Exit focus", exact: true }).click();
  await page.goto("/forest");
  await expect(page.locator(`[data-session-id="${second.id}"]`)).toContainText("Growing");

  await page.getByRole("button", { name: "✓ Done", exact: true }).click();
  const living = page.locator(`[data-tree-id="${second.id}"]`);
  await expect(living).toContainText("Living");
  await expect(living.locator(".forest-leaves")).toBeVisible();
  await expectOutcome(page.request, second.id, "done");

  const remove = await page.request.delete(`/api/tasks/${task.id}`);
  expect(remove.ok()).toBe(true);
  await page.reload();
  await expect(page.locator(`[data-tree-id="${first.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-tree-id="${second.id}"]`)).toHaveCount(0);
  await expectNoOutcome(page.request, first.id);
  await expectNoOutcome(page.request, second.id);
});

test("child archive/delete can complete a timed parent, while a timed child archive/delete creates no own outcome", async ({ page }) => {
  async function parentCompletion(kind: "archive" | "delete") {
    const parent = await createTask(page.request, `${PREFIX} ${kind} parent`);
    await page.request.post(`/api/tasks/${parent.id}/timer/start`);
    const entry = await currentEntry(page.request);
    const [doneChild, lastOpen] = await createChildren(page.request, parent.id, [
      `${PREFIX} ${kind} done child`,
      `${PREFIX} ${kind} last child`,
    ]);
    expect((await page.request.patch(`/api/tasks/${doneChild.id}`, { data: { status: "done" } })).ok()).toBe(true);
    const result = kind === "archive"
      ? await page.request.patch(`/api/tasks/${lastOpen.id}`, { data: { status: "archived" } })
      : await page.request.delete(`/api/tasks/${lastOpen.id}`);
    expect(result.ok()).toBe(true);
    await expectOutcome(page.request, entry.id, "done");
    return entry.id;
  }

  const archiveParentEntry = await parentCompletion("archive");
  const deleteParentEntry = await parentCompletion("delete");

  const archiveParent = await createTask(page.request, `${PREFIX} timed child archive parent`);
  const [archivedTimedChild] = await createChildren(page.request, archiveParent.id, [
    `${PREFIX} timed archived child`,
    `${PREFIX} archive sibling remains open`,
  ]);
  await page.request.post(`/api/tasks/${archivedTimedChild.id}/timer/start`);
  const archivedChildEntry = await currentEntry(page.request);
  expect((await page.request.patch(`/api/tasks/${archivedTimedChild.id}`, { data: { status: "archived" } })).ok()).toBe(true);
  await expectNoOutcome(page.request, archivedChildEntry.id);
  expect((await page.request.delete(`/api/tasks/${archivedTimedChild.id}`)).ok()).toBe(true);
  await expectNoOutcome(page.request, archivedChildEntry.id);

  const deleteParent = await createTask(page.request, `${PREFIX} timed child delete parent`);
  const [deletedTimedChild] = await createChildren(page.request, deleteParent.id, [
    `${PREFIX} timed deleted child`,
    `${PREFIX} delete sibling remains open`,
  ]);
  await page.request.post(`/api/tasks/${deletedTimedChild.id}/timer/start`);
  const deletedChildEntry = await currentEntry(page.request);
  expect((await page.request.delete(`/api/tasks/${deletedTimedChild.id}`)).ok()).toBe(true);
  await expectNoOutcome(page.request, deletedChildEntry.id);

  await page.goto("/forest");
  await expect(page.locator(`[data-tree-id="${archiveParentEntry}"]`)).toContainText("Living");
  await expect(page.locator(`[data-tree-id="${deleteParentEntry}"]`)).toContainText("Living");
  await expect(page.locator(`[data-tree-id="${archivedChildEntry}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-tree-id="${deletedChildEntry}"]`)).toHaveCount(0);
});

test.describe("Forest at 360×780 touch", () => {
  test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });

  test("101 trees wrap on shared terrain with 44px targets, selected details and no document overflow", async ({ page }) => {
    await stubForest(page, { trees: trees(200, 100), nextBeforeId: 101 }, current(300));
    await page.goto("/forest");
    await expect(page.locator(".forest-tree")).toHaveCount(101);
    const tapped = page.locator('[data-tree-id="199"]');
    await tapped.tap();
    await expect(tapped.getByRole("radio", { name: /^Dead\./ })).toBeChecked();
    await expect(page.getByRole("region", { name: "Selected tree details" })).toContainText("Dead");
    await expect(page.getByRole("link", { name: "Forest", exact: true })).toHaveClass(/active/);

    await page.locator(".forest-details time").evaluate((time) => {
      time.textContent = "A very long localized date and time representation that must wrap inside the selected details region";
    });
    const measurements = await page.evaluate(() => {
      const targets = [
        ...document.querySelectorAll<HTMLElement>(".forest-tree"),
        document.querySelector<HTMLElement>('nav a[href="/forest"]')!,
      ].map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      const cells = [...document.querySelectorAll<HTMLElement>(".forest-tree")];
      return {
        targets,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        firstTop: cells[0].getBoundingClientRect().top,
        lastTop: cells[cells.length - 1].getBoundingClientRect().top,
      };
    });
    expect(measurements.targets.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
    expect(measurements.overflow).toBeLessThanOrEqual(0);
    expect(measurements.lastTop).toBeGreaterThan(measurements.firstTop);
  });
});
