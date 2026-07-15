import { expect, test, type Locator, type Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

// Issue #17: every open task row on the Tasks page offers Edit, reusing
// TaskForm — including the goal link, which is how an existing task gets
// attached to a goal. Runs against the shared E2E database after the other
// specs; all seeded titles are unique to this spec and goal-count
// assertions are scoped to this spec's own goal card.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "E2E row-edit goal";
const SECOND_GOAL_TITLE = "E2E row-edit target goal";
const TASK_TITLE = "Sort the e2e sock drawer";
const EDITED_TITLE = "Sort the e2e sock drawer by colour";
const DONE_TITLE = "Fold the e2e towels";
const PARENT_TITLE = "Repaint the e2e fence";
const SUBTASK_TITLE = "Buy e2e fence paint";

let goalId: number;

async function seed(request: APIRequestContext) {
  const goal = await (
    await request.post("/api/goals", { data: { title: GOAL_TITLE } })
  ).json();
  goalId = goal.id;
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  await request.post("/api/tasks", {
    data: { title: TASK_TITLE, categoryId: categories[0].id, effortMinutes: 10 },
  });
  const doneTask = await (
    await request.post("/api/tasks", {
      data: { title: DONE_TITLE, categoryId: categories[0].id, effortMinutes: 5 },
    })
  ).json();
  await request.patch(`/api/tasks/${doneTask.id}`, { data: { status: "done" } });
  const parent = await (
    await request.post("/api/tasks", {
      data: { title: PARENT_TITLE, categoryId: categories[0].id, effortMinutes: 60 },
    })
  ).json();
  // Rated subtask under a goal-less parent: the documented ADR-4 breakdown
  // exception (#76) — the cascade test below watches this rating through
  // attach, move and detach.
  await request.post(`/api/tasks/${parent.id}/subtasks`, {
    data: { subtasks: [{ title: SUBTASK_TITLE, effortMinutes: 15, impact: 5 }] },
  });
}

function row(page: Page, title: string): Locator {
  return page.getByText(title, { exact: true }).locator("..");
}

function goalCard(page: Page, title: string = GOAL_TITLE): Locator {
  return page.locator(".panel").filter({ hasText: title });
}

test("edit from the row: prefilled form, cancel discards, save persists", async ({ page }) => {
  await seed(page.request);
  await page.goto("/tasks");

  // The form opens prefilled with the task's current values.
  await row(page, TASK_TITLE).getByTitle("Edit").click();
  const title = page.getByPlaceholder("What needs doing?");
  await expect(title).toHaveValue(TASK_TITLE);
  await expect(page.getByTitle("Effort estimate in minutes")).toHaveValue("10");

  // Cancel closes the form without changes.
  await title.fill("Discarded rename");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(title).not.toBeVisible();
  await expect(page.getByText(TASK_TITLE, { exact: true })).toBeVisible();

  // Save PATCHes and the row re-renders from the invalidated query.
  await row(page, TASK_TITLE).getByTitle("Edit").click();
  await title.fill(EDITED_TITLE);
  await page.getByTitle("Effort estimate in minutes").fill("25");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(title).not.toBeVisible();
  await expect(row(page, EDITED_TITLE).getByText("25 min")).toBeVisible();
  await expect(page.getByText(TASK_TITLE, { exact: true })).not.toBeVisible();
});

test("goal link: attach via edit, goal count reflects it, detach again", async ({ page }) => {
  await page.goto("/tasks");

  await row(page, EDITED_TITLE).getByTitle("Edit").click();
  const goalSelect = page.getByTitle("Link to a goal (enables impact rating)");
  await goalSelect.selectOption({ label: `🎯 ${GOAL_TITLE}` });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(goalSelect).not.toBeVisible();

  await page.goto("/goals");
  await expect(goalCard(page).getByText("0/1 tasks")).toBeVisible();

  // Detach: back to "no goal"; the count drops again.
  await page.goto("/tasks");
  await row(page, EDITED_TITLE).getByTitle("Edit").click();
  await goalSelect.selectOption({ label: "no goal" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(goalSelect).not.toBeVisible();

  await page.goto("/goals");
  await expect(goalCard(page).getByText("0/0 tasks")).toBeVisible();

  // The server really persisted the detach, not just the UI.
  const tasks: { title: string; goalId: number | null }[] = await (
    await page.request.get("/api/tasks")
  ).json();
  expect(tasks.find((t) => t.title === EDITED_TITLE)?.goalId).toBeNull();
});

test("subtask rows offer edit without the goal select; done rows offer none", async ({
  page,
}) => {
  await page.goto("/tasks");

  // Subtasks follow their parent's goal — the form opens without the select.
  await row(page, SUBTASK_TITLE).getByTitle("Edit").click();
  await expect(page.getByPlaceholder("What needs doing?")).toHaveValue(SUBTASK_TITLE);
  await expect(page.getByTitle("Link to a goal (enables impact rating)")).not.toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // Done rows show no Edit action (reopen first).
  await page.getByLabel("show done").check();
  const doneRow = row(page, DONE_TITLE);
  await expect(doneRow.getByRole("checkbox")).toBeChecked();
  await expect(doneRow.getByTitle("Edit")).not.toBeVisible();
});

test("goal link on a broken-down task cascades to its subtasks", async ({ page }) => {
  // Subtasks follow their parent's goal (their rows hide the select), so
  // attach/move/detach on the parent must carry them along — goal counts
  // and the goal-filtered draw key off each row's own goal link.
  await page.request.post("/api/goals", { data: { title: SECOND_GOAL_TITLE } });

  const goalSelect = page.getByTitle("Link to a goal (enables impact rating)");
  async function setParentGoal(label: string) {
    await page.goto("/tasks");
    await row(page, PARENT_TITLE).getByTitle("Edit").click();
    await goalSelect.selectOption({ label });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(goalSelect).not.toBeVisible();
    await page.goto("/goals");
  }

  // Attach: the goal counts the parent AND its subtask.
  await setParentGoal(`🎯 ${GOAL_TITLE}`);
  await expect(goalCard(page).getByText("0/2 tasks")).toBeVisible();

  // Move: both rows follow; nothing stays stranded on the old goal.
  await setParentGoal(`🎯 ${SECOND_GOAL_TITLE}`);
  await expect(goalCard(page).getByText("0/0 tasks")).toBeVisible();
  await expect(goalCard(page, SECOND_GOAL_TITLE).getByText("0/2 tasks")).toBeVisible();

  // The subtask's seeded rating survives attach and move…
  const readParent = async () => {
    const tasks: {
      title: string;
      goalId: number | null;
      subtasks: { goalId: number | null; impact: number }[];
    }[] = await (await page.request.get("/api/tasks")).json();
    return tasks.find((t) => t.title === PARENT_TITLE);
  };
  expect((await readParent())?.subtasks.map((s) => s.impact)).toEqual([5]);

  // Detach: the subtask's link is cleared too.
  await setParentGoal("no goal");
  await expect(goalCard(page, SECOND_GOAL_TITLE).getByText("0/0 tasks")).toBeVisible();

  const parent = await readParent();
  expect(parent?.goalId).toBeNull();
  expect(parent?.subtasks.map((s) => s.goalId)).toEqual([null]);
  // …and only the deliberate unlink resets it to neutral (#76): the rating
  // described leverage toward the goal that was just removed.
  expect(parent?.subtasks.map((s) => s.impact)).toEqual([3]);
});
