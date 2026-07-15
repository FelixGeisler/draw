import { expect, test, type Page } from "@playwright/test";

// Issue #87: manage a goal's tasks on the GoalCard — list open root tasks
// with badges, unlink per row (server resets impact to neutral, ADR-4),
// link existing goal-less root tasks via the picker, collapsed done count.
// Runs serially against the suite's shared database; every title is unique
// to this spec so earlier journeys can't interfere.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "Ship the e2e conference talk";
const LOOSE_TASK = "Draft the e2e talk outline";
const PARENT_TASK = "Build the e2e slide deck";
const SUBTASK_1 = "Sketch e2e slides part one";
const SUBTASK_2 = "Sketch e2e slides part two";

function card(page: Page, title: string) {
  return page.locator(".panel").filter({ hasText: title });
}

async function apiGoalId(page: Page): Promise<number> {
  const goals: { id: number; title: string }[] = await (
    await page.request.get("/api/goals")
  ).json();
  return goals.find((g) => g.title === GOAL_TITLE)!.id;
}

interface ApiTask {
  id: number;
  title: string;
  goalId: number | null;
  impact: number;
  status: string;
  subtasks?: ApiTask[];
}

async function apiTask(page: Page, title: string): Promise<ApiTask> {
  const roots: ApiTask[] = await (await page.request.get("/api/tasks?status=all")).json();
  for (const t of roots) {
    if (t.title === title) return t;
    const sub = t.subtasks?.find((s) => s.title === title);
    if (sub) return sub;
  }
  throw new Error(`task not found: ${title}`);
}

test("an existing goal-less task can be linked from the goal card", async ({ page }) => {
  // Seed through the API — this spec is about the GoalCard section, not the
  // capture form.
  const categories: { id: number }[] = await (await page.request.get("/api/categories")).json();
  await page.request.post("/api/goals", { data: { title: GOAL_TITLE } });
  await page.request.post("/api/tasks", {
    data: { title: LOOSE_TASK, categoryId: categories[0].id, effortMinutes: 15 },
  });

  await page.goto("/goals");
  const goalCard = card(page, GOAL_TITLE);

  // The progress count doubles as the section toggle.
  await goalCard.getByRole("button", { name: "0/0 tasks" }).click();
  await expect(goalCard.getByText("📋 Tasks toward this goal")).toBeVisible();
  await expect(goalCard.getByText(/No open tasks yet/)).toBeVisible();

  await goalCard.getByRole("button", { name: "🔗 Link existing" }).click();
  await goalCard.getByTitle(`Attach "${LOOSE_TASK}" to this goal`).click();

  // The task moves from the picker into the section list with its badges;
  // the linked task starts at neutral impact (stars only exist goal-linked).
  // The picker is closed first — leftover goal-less tasks from earlier
  // journeys may wear identical effort chips in it.
  await expect(goalCard.getByTitle(`Attach "${LOOSE_TASK}" to this goal`)).not.toBeVisible();
  await goalCard.getByTitle("Close the picker").click();
  await expect(goalCard.getByText(LOOSE_TASK, { exact: true })).toBeVisible();
  await expect(goalCard.getByText("15 min")).toBeVisible();
  await expect(goalCard.getByTitle("Impact 3/5")).toBeVisible();
  // Goal progress updates without a reload.
  await expect(goalCard.getByRole("button", { name: "0/1 tasks" })).toBeVisible();

  const goalId = await apiGoalId(page);
  expect((await apiTask(page, LOOSE_TASK)).goalId).toBe(goalId);

  // The Tasks page row reflects the link: impact stars appear on goal-linked
  // rows only. Same row idiom as task-row-edit.spec.ts — the row div is the
  // parent of the exact-title span.
  await page.goto("/tasks");
  const row = page.getByText(LOOSE_TASK, { exact: true }).locator("..");
  await expect(row.getByTitle("Impact 3/5")).toBeVisible();
});

test("unlinking returns the task to the goal-less pool and resets impact", async ({ page }) => {
  // A non-neutral rating proves the server-owned reset is real (ADR-4).
  const task = await apiTask(page, LOOSE_TASK);
  await page.request.patch(`/api/tasks/${task.id}`, { data: { impact: 5 } });

  await page.goto("/goals");
  const goalCard = card(page, GOAL_TITLE);
  await goalCard.getByRole("button", { name: "0/1 tasks" }).click();
  await expect(goalCard.getByTitle("Impact 5/5")).toBeVisible();

  // No confirm dialog — unlink is fully reversible via the picker.
  await goalCard.getByTitle(/^Unlink from this goal/).click();

  // The row announces what happened even though it left the list.
  await expect(goalCard.getByRole("status")).toHaveText(
    `"${LOOSE_TASK}" moved to no goal — impact reset to neutral.`,
  );
  await expect(goalCard.getByText(LOOSE_TASK, { exact: true })).not.toBeVisible();
  await expect(goalCard.getByRole("button", { name: "0/0 tasks" })).toBeVisible();

  const after = await apiTask(page, LOOSE_TASK);
  expect(after.goalId).toBeNull();
  expect(after.impact).toBe(3);

  // Back in the picker's candidate pool immediately.
  await goalCard.getByRole("button", { name: "🔗 Link existing" }).click();
  await expect(goalCard.getByTitle(`Attach "${LOOSE_TASK}" to this goal`)).toBeVisible();
});

test("linking a broken-down parent cascades to subtasks; the picker never offers them", async ({
  page,
}) => {
  const categories: { id: number }[] = await (await page.request.get("/api/categories")).json();
  const parent = await (
    await page.request.post("/api/tasks", {
      data: { title: PARENT_TASK, categoryId: categories[0].id },
    })
  ).json();
  await page.request.post(`/api/tasks/${parent.id}/subtasks`, {
    data: { subtasks: [{ title: SUBTASK_1 }, { title: SUBTASK_2 }] },
  });

  await page.goto("/goals");
  const goalCard = card(page, GOAL_TITLE);
  await goalCard.getByRole("button", { name: "0/0 tasks" }).click();
  await goalCard.getByRole("button", { name: "🔗 Link existing" }).click();

  // Only the root is offered — subtasks follow their parent.
  await expect(goalCard.getByTitle(`Attach "${PARENT_TASK}" to this goal`)).toBeVisible();
  await expect(goalCard.getByText(SUBTASK_1)).not.toBeVisible();
  await goalCard.getByTitle(`Attach "${PARENT_TASK}" to this goal`).click();

  // Wait for the queries to settle (the linked task leaves the candidate
  // pool), then close the picker — while both refetches are in flight the
  // title briefly exists twice (picker + section list).
  await expect(goalCard.getByTitle(`Attach "${PARENT_TASK}" to this goal`)).not.toBeVisible();
  await goalCard.getByTitle("Close the picker").click();

  // The section lists the root only; the goal cascaded to both open subtasks,
  // so the header counts all three linked tasks.
  await expect(goalCard.getByText(PARENT_TASK, { exact: true })).toBeVisible();
  await expect(goalCard.getByText(SUBTASK_1)).not.toBeVisible();
  await expect(goalCard.getByRole("button", { name: "0/3 tasks" })).toBeVisible();

  const goalId = await apiGoalId(page);
  expect((await apiTask(page, SUBTASK_1)).goalId).toBe(goalId);
  expect((await apiTask(page, SUBTASK_2)).goalId).toBe(goalId);
});

test("done root tasks collapse into a count line", async ({ page }) => {
  // Complete the breakdown bottom-up (the parent 409s while children are open).
  for (const title of [SUBTASK_1, SUBTASK_2, PARENT_TASK]) {
    const t = await apiTask(page, title);
    await page.request.patch(`/api/tasks/${t.id}`, { data: { status: "done" } });
  }

  await page.goto("/goals");
  const goalCard = card(page, GOAL_TITLE);
  await goalCard.getByRole("button", { name: "3/3 tasks" }).click();

  // One done ROOT — the completed subtasks stay folded into their parent.
  await expect(goalCard.getByText("✓ 1 done")).toBeVisible();
  await expect(goalCard.getByText(PARENT_TASK, { exact: true })).not.toBeVisible();
  await expect(goalCard.getByText(/No open tasks yet/)).toBeVisible();
});
