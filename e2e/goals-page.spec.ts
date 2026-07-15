import { expect, test, type Page } from "@playwright/test";

// Issue #16: manual task creation from a GoalCard and inline editing of the
// goal's title, outcome and target date. Runs after the earlier specs against
// the same database; it only touches its own uniquely-named goal and task.
// E2E always runs AI-degraded, so this proves the flow needs no API key.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "Pass the e2e statistics exam";
const EDITED_TITLE = "Ace the e2e statistics exam";
const TASK_TITLE = "Skim the e2e lecture notes";
const OUTCOME = "Written exam, 60% to pass";
const EDITED_OUTCOME = "Oral exam, 50% to pass";

// Fixed per suite run so re-resolving across tests can't drift over midnight.
const INITIAL_DATE = isoDatePlus(10);
const EDITED_DATE = isoDatePlus(3);

function isoDatePlus(days: number): string {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

// Mirrors daysUntil() in GoalsPage.tsx so the chip assertion holds whenever
// the suite runs (the chip rounds up to the end of the target day).
function daysLeftChip(dateStr: string): string {
  const target = new Date(`${dateStr}T23:59:59`);
  return `${Math.ceil((target.getTime() - Date.now()) / (24 * 3600 * 1000))}d left`;
}

function card(page: Page, title: string) {
  return page.locator(".panel").filter({ hasText: title });
}

test("a task can be added from the goal card without an AI key", async ({ page }) => {
  await page.goto("/goals");

  await page.getByPlaceholder(/^Goal — e\.g\./).fill(GOAL_TITLE);
  await page.getByTitle("Target date").fill(INITIAL_DATE);
  await page.getByPlaceholder(/How is success measured/).fill(OUTCOME);
  await page.getByRole("button", { name: "Add goal" }).click();

  const goalCard = card(page, GOAL_TITLE);
  await expect(goalCard.getByText(daysLeftChip(INITIAL_DATE))).toBeVisible();
  await expect(goalCard.getByText(OUTCOME)).toBeVisible();
  await expect(goalCard.getByText("0/0 tasks")).toBeVisible();
  // Target date but no tasks yet: nothing to burn down, no feasibility chip (#60).
  await expect(goalCard.getByText(/min\/day/)).not.toBeVisible();
  // No AI configured, yet the card offers manual task creation.
  await expect(goalCard.getByRole("button", { name: "✨ Plan backward" })).not.toBeVisible();

  // Pick a category explicitly to prove the choice is respected.
  const categories: { id: number; name: string }[] = await (
    await page.request.get("/api/categories")
  ).json();
  const chosen = categories[categories.length - 1];

  await goalCard.getByRole("button", { name: "+ Add task" }).click();
  await goalCard.getByPlaceholder("What needs doing?").fill(TASK_TITLE);
  await goalCard.locator("select").first().selectOption({ label: chosen.name });
  await goalCard.getByTitle("Effort estimate in minutes").fill("20");
  await goalCard.getByRole("button", { name: "Add", exact: true }).click();

  // The count updates without reload; the form closes after submit.
  await expect(goalCard.getByText("0/1 tasks")).toBeVisible();
  await expect(goalCard.getByPlaceholder("What needs doing?")).not.toBeVisible();

  // Estimated open task + target date but zero tracked history: the burn-down
  // chip shows the required pace only — no verdict wording without an actual
  // pace to compare against (#60).
  await expect(goalCard.getByText(/Need ~\d+ min\/day/)).toBeVisible();
  await expect(goalCard.getByText(/On track|Tight|Infeasible/)).not.toBeVisible();

  // The task is really linked to the goal with the chosen category/effort.
  const goals: { id: number; title: string }[] = await (
    await page.request.get("/api/goals")
  ).json();
  const goal = goals.find((g) => g.title === GOAL_TITLE)!;
  const tasks: { title: string; goalId: number; categoryId: number; effortMinutes: number }[] =
    await (await page.request.get("/api/tasks")).json();
  const task = tasks.find((t) => t.title === TASK_TITLE)!;
  expect(task).toBeTruthy();
  expect(task.goalId).toBe(goal.id);
  expect(task.categoryId).toBe(chosen.id);
  expect(task.effortMinutes).toBe(20);
});

test("title, outcome and target date are editable in place and persist", async ({ page }) => {
  await page.goto("/goals");
  await card(page, GOAL_TITLE).getByTitle("Edit goal").click();

  // The editor is prefilled with the stored values.
  await expect(page.getByTitle("Goal title")).toHaveValue(GOAL_TITLE);
  await expect(page.getByTitle("Goal outcome")).toHaveValue(OUTCOME);
  await expect(page.getByTitle("Goal target date")).toHaveValue(INITIAL_DATE);

  await page.getByTitle("Goal title").fill(EDITED_TITLE);
  await page.getByTitle("Goal outcome").fill(EDITED_OUTCOME);
  await page.getByTitle("Goal target date").fill(EDITED_DATE);
  await page.getByRole("button", { name: "Save", exact: true }).click();

  const goalCard = card(page, EDITED_TITLE);
  await expect(goalCard.getByRole("heading", { name: `🎯 ${EDITED_TITLE}` })).toBeVisible();
  await expect(goalCard.getByText(EDITED_OUTCOME)).toBeVisible();
  await expect(goalCard.getByText(daysLeftChip(EDITED_DATE))).toBeVisible();
  // The task link survives the edit.
  await expect(goalCard.getByText("0/1 tasks")).toBeVisible();

  // Persisted server-side, not just local component state.
  await page.reload();
  await expect(page.getByRole("heading", { name: `🎯 ${EDITED_TITLE}` })).toBeVisible();
  await expect(page.getByText(EDITED_OUTCOME)).toBeVisible();
});

test("the target date can be cleared", async ({ page }) => {
  await page.goto("/goals");
  const goalCard = card(page, EDITED_TITLE);
  await expect(goalCard.getByText(/\d+d left/)).toBeVisible();

  await goalCard.getByTitle("Edit goal").click();
  await page.getByTitle("Goal target date").fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  // The days-left chip is gone, the rest of the card is intact — and without
  // a target date the feasibility chip disappears with it (#60).
  await expect(goalCard.getByRole("heading", { name: `🎯 ${EDITED_TITLE}` })).toBeVisible();
  await expect(goalCard.getByText(/\d+d left/)).not.toBeVisible();
  await expect(goalCard.getByText(/min\/day/)).not.toBeVisible();

  const goals: { title: string; targetDate: string | null }[] = await (
    await page.request.get("/api/goals")
  ).json();
  expect(goals.find((g) => g.title === EDITED_TITLE)!.targetDate).toBeNull();
});

test("cancelling an edit leaves the goal unchanged", async ({ page }) => {
  await page.goto("/goals");
  const goalCard = card(page, EDITED_TITLE);
  await goalCard.getByTitle("Edit goal").click();

  await page.getByTitle("Goal title").fill("Scrapped rename");
  await page.getByTitle("Goal outcome").fill("Scrapped outcome");
  await page.getByTitle("Goal target date").fill(INITIAL_DATE);
  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(goalCard.getByRole("heading", { name: `🎯 ${EDITED_TITLE}` })).toBeVisible();
  await expect(goalCard.getByText(EDITED_OUTCOME)).toBeVisible();
  await expect(page.getByText("Scrapped rename")).not.toBeVisible();
  await expect(goalCard.getByText(/\d+d left/)).not.toBeVisible();

  // Reopening the editor shows the stored values, not the scrapped draft.
  await goalCard.getByTitle("Edit goal").click();
  await expect(page.getByTitle("Goal title")).toHaveValue(EDITED_TITLE);
  await expect(page.getByTitle("Goal outcome")).toHaveValue(EDITED_OUTCOME);
  await expect(page.getByTitle("Goal target date")).toHaveValue("");
});
