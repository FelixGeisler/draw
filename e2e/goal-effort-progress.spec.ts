import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { taskTree } from "./helpers.js";

// Neutral goal effort progress (#372), derived end to end from the existing
// totals. These cases pin the completed direction, live invalidation, completed
// endpoint, refetch-skew clamp, accessibility contract, and count fallback.

// FILENAME CONTRACT: "goal-" sorts AFTER core-journey and earned-achievements
// on purpose — this spec completes a task, and running it first would steal
// the first_completion unlock whose fresh toast core-journey pins (the same
// alphabetical-neighbour rule earned-achievements.spec.ts documents).
test.describe.configure({ mode: "serial" });

const GOAL = "Estimated effort progress goal";
const PLAIN_GOAL = "Unestimated effort progress goal";
const BIG = "Estimated task thirty";
const SMALL = "Estimated task twenty";

let goalId: number;

async function seed(request: APIRequestContext) {
  const goal = await (await request.post("/api/goals", { data: { title: GOAL } })).json();
  goalId = goal.id;
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  for (const [title, effortMinutes] of [
    [BIG, 30],
    [SMALL, 20],
  ] as const) {
    await request.post("/api/tasks", {
      data: { title, categoryId: categories[0].id, goalId: goal.id, effortMinutes },
    });
  }
  const plain = await (await request.post("/api/goals", { data: { title: PLAIN_GOAL } })).json();
  await request.post("/api/tasks", {
    data: { title: "Unestimated progress task", categoryId: categories[0].id, goalId: plain.id },
  });
}

function panel(page: import("@playwright/test").Page, title: string) {
  return page.locator(".panel").filter({ hasText: title });
}

function progress(page: import("@playwright/test").Page) {
  return panel(page, GOAL).getByTestId("effort-progress");
}

test("estimated and unestimated goals use their approved progress presentations", async ({ page }) => {
  await seed(page.request);
  await page.goto("/goals");

  const bar = progress(page);
  await expect(bar).toContainText("0/50 min complete");
  const accessibleBar = bar.getByRole("progressbar");
  await expect(accessibleBar).toHaveAccessibleName("Effort progress");
  await expect(accessibleBar).toHaveAttribute("aria-valuemin", "0");
  await expect(accessibleBar).toHaveAttribute("aria-valuemax", "50");
  await expect(accessibleBar).toHaveAttribute("aria-valuenow", "0");
  await expect(bar.getByTestId("effort-progress-fill")).toHaveAttribute("style", /width: 0%/);

  const plain = panel(page, PLAIN_GOAL);
  await expect(plain.getByTestId("effort-progress")).toHaveCount(0);
  await expect(plain.getByRole("button", { name: "0/1 tasks" })).toBeVisible();

  await page.getByRole("link", { name: "Tasks" }).click();
  // Keep done rows mounted: completing from the open-only list unmounts the row
  // before toBeChecked can observe the mutation.
  await page.getByLabel("show done").check();
  const row = taskTree(page).getByText(SMALL, { exact: true }).locator("..");
  await row.getByRole("checkbox").click();
  await expect(row.getByRole("checkbox")).toBeChecked();
  await page.getByRole("link", { name: "Goals" }).click();

  await expect(bar).toContainText("20/50 min complete");
  await expect(accessibleBar).toHaveAttribute("aria-valuenow", "20");
  await expect(bar.getByTestId("effort-progress-fill")).toHaveAttribute("style", /width: 40%/);
});

test("a goal with all estimated leaves complete reaches the total", async ({ page }) => {
  await page.goto("/tasks");
  await page.getByLabel("show done").check();
  const row = taskTree(page).getByText(BIG, { exact: true }).locator("..");
  await row.getByRole("checkbox").click();
  await expect(row.getByRole("checkbox")).toBeChecked();
  await page.getByRole("link", { name: "Goals" }).click();

  const bar = progress(page);
  await expect(bar).toContainText("50/50 min complete");
  await expect(bar.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  await expect(bar.getByTestId("effort-progress-fill")).toHaveAttribute("style", /width: 100%/);
});

test("refetch skew is clamped before visible and accessible progress is published", async ({ page }) => {
  await page.route("**/api/goals*", async (route) => {
    const response = await route.fetch();
    const goals = (await response.json()) as Array<{
      id: number;
      remainingOpenEffortMinutes: number | null;
      totalEffortMinutes: number | null;
    }>;
    const skewed = goals.map((goal) =>
      goal.id === goalId ? { ...goal, remainingOpenEffortMinutes: 70, totalEffortMinutes: 50 } : goal,
    );
    await route.fulfill({ response, json: skewed });
  });

  await page.goto("/goals");
  const bar = progress(page);
  await expect(bar).toContainText("0/50 min complete");
  await expect(bar.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  await expect(bar.getByTestId("effort-progress-fill")).toHaveAttribute("style", /width: 0%/);
});

test.afterAll(async ({ request }) => {
  // Shared suite DB: remove seeded records and their completion effects so
  // later draw and trophy assertions keep their isolated baseline.
  const tasks: { id: number; title: string }[] = await (
    await request.get("/api/tasks?status=all")
  ).json();
  for (const task of tasks.filter((task) =>
    [BIG, SMALL, "Unestimated progress task"].includes(task.title),
  )) {
    await request.delete(`/api/tasks/${task.id}`);
  }
  const goals: { id: number; title: string }[] = await (await request.get("/api/goals")).json();
  for (const goal of goals.filter((goal) => [GOAL, PLAIN_GOAL].includes(goal.title))) {
    await request.delete(`/api/goals/${goal.id}`);
  }
});
