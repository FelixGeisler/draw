import { expect, test, type APIRequestContext } from "@playwright/test";
import { drawFromGoal } from "./helpers.js";

test.describe.configure({ mode: "serial" });

const PREFIX = "Forest client e2e";

type Task = { id: number; title: string };
type Tree = { id: number; startedAt: string; endedAt: string; endReason: "done" | "stop" };

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
  const current = await (await request.get("/api/timer/current")).json();
  expect(current).not.toBeNull();
  return current.entry;
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

  // Make the authoritative current response older than the one-minute estimate.
  // The server entry remains open; this is a browser-clock-independent proof
  // that estimate expiry changes only elapsed presentation, never outcome.
  await page.route("**/api/timer/current", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body?.entry?.id === first.id) {
      body.entry.startedAt = new Date(Date.parse(body.entry.startedAt) - 120_000).toISOString();
    }
    await route.fulfill({ response, json: body });
  });

  await page.goto("/stats");
  const growing = page.locator(`[data-session-id="${first.id}"]`);
  await expect(growing).toContainText("Growing");
  await expect(growing.locator(".forest-leaves")).toBeVisible();
  await expect(growing).toContainText(/2m/);
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
  await page.goto("/stats");
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
  // Remove the still-running archived child before another Start can classify it.
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

  await page.goto("/stats");
  await expect(page.locator(`[data-tree-id="${archiveParentEntry}"]`)).toContainText("Living");
  await expect(page.locator(`[data-tree-id="${deleteParentEntry}"]`)).toContainText("Living");
  await expect(page.locator(`[data-tree-id="${archivedChildEntry}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-tree-id="${deletedChildEntry}"]`)).toHaveCount(0);
});

test("Older replaces the one 100-tree window, exhaustion disables it, and Newest restores page one", async ({ page }) => {
  const timestamp = "2026-01-02T03:04:05.006Z";
  const trees = (first: number, count: number) => Array.from({ length: count }, (_, index) => ({
    id: first - index,
    startedAt: timestamp,
    endedAt: timestamp,
    endReason: index % 2 === 0 ? "done" : "stop",
  }));
  await page.route("**/api/timer/current", (route) => route.fulfill({ json: null }));
  await page.route("**/api/forest*", (route) => {
    const older = new URL(route.request().url()).searchParams.get("beforeId") === "101";
    return route.fulfill({
      json: older
        ? { trees: trees(100, 99), nextBeforeId: null }
        : { trees: trees(200, 100), nextBeforeId: 101 },
    });
  });

  await page.goto("/stats");
  await expect(page.locator(".forest-tree")).toHaveCount(100);
  await expect(page.locator('[data-tree-id="200"]')).toBeVisible();
  await page.getByRole("button", { name: "Older", exact: true }).click();
  await expect(page.locator(".forest-tree")).toHaveCount(99);
  await expect(page.locator('[data-tree-id="200"]')).toHaveCount(0);
  await expect(page.locator('[data-tree-id="100"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Older", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Newest", exact: true }).click();
  await expect(page.locator(".forest-tree")).toHaveCount(100);
  await expect(page.locator('[data-tree-id="200"]')).toBeVisible();
});
