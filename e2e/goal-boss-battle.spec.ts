import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { taskTree } from "./helpers.js";

// Boss battles (#229): a goal with estimated leaves renders its remaining
// work as an opponent's HP bar; completions deal damage. Derived end to end —
// max HP and remaining both come from the goals payload, the client only
// combines them — so the pins here are the caption arithmetic, the live drop
// through the SPA's own invalidation (no reload), the enrage tie to the
// feasibility verdict, and the count-bar fallback for unestimated goals.

// FILENAME CONTRACT: "goal-" sorts AFTER core-journey and earned-achievements
// on purpose — this spec completes a task, and running it first would steal
// the first_completion unlock whose fresh toast core-journey pins (the same
// alphabetical-neighbour rule earned-achievements.spec.ts documents).
test.describe.configure({ mode: "serial" });

const GOAL = "Fell the e2e boss goal";
const PLAIN_GOAL = "Unestimated e2e goal";
const BIG = "Boss task thirty";
const SMALL = "Boss task twenty";

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
  // A second goal with an UNESTIMATED task: no HP without numbers, so this
  // panel must keep the count-based progress bar.
  const plain = await (await request.post("/api/goals", { data: { title: PLAIN_GOAL } })).json();
  await request.post("/api/tasks", {
    data: { title: "Unestimated task", categoryId: categories[0].id, goalId: plain.id },
  });
}

function panel(page: import("@playwright/test").Page, title: string) {
  return page.locator(".panel").filter({ hasText: title });
}

test("an estimated goal renders full boss HP; completing a task deals damage without a reload", async ({
  page,
}) => {
  await seed(page.request);
  await page.goto("/goals");

  const bar = panel(page, GOAL).getByTestId("boss-bar");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("♥ 50/50");
  await expect(bar.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");

  // The unestimated goal keeps the plain count bar — no HP without numbers.
  await expect(panel(page, PLAIN_GOAL).getByTestId("boss-bar")).toHaveCount(0);

  // Deal 20 damage from the Tasks page, then return by SPA navigation — the
  // task mutation invalidates ['goals'], so the bar has dropped with NO page
  // reload anywhere in between.
  await page.getByRole("link", { name: "Tasks" }).click();
  // Keep done rows mounted (the split-subtask.spec pattern): completing from
  // the open-only list unmounts the row before toBeChecked can see it.
  await page.getByLabel("show done").check();
  const row = taskTree(page).getByText(SMALL, { exact: true }).locator("..");
  await row.getByRole("checkbox").click();
  await expect(row.getByRole("checkbox")).toBeChecked();
  await page.getByRole("link", { name: "Goals" }).click();

  await expect(bar).toContainText("♥ 30/50");
  await expect(bar).toContainText("20 dmg");
});

test("enrage is the feasibility verdict wearing war paint", async ({ page }) => {
  // Overdue target with estimated open work → infeasible regardless of pace
  // (the #60 decision table) → the bar enrages.
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
  const day = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(
    yesterday.getDate(),
  ).padStart(2, "0")}`;
  const res = await page.request.patch(`/api/goals/${goalId}`, { data: { targetDate: day } });
  expect(res.ok()).toBe(true);

  await page.goto("/goals");
  const bar = panel(page, GOAL).getByTestId("boss-bar");
  await expect(bar).toHaveClass(/enraged/);
  await expect(bar).toContainText("enraged");
  await expect(bar.getByRole("progressbar")).toHaveAccessibleName("Boss HP — enraged");
});

test.afterAll(async ({ request }) => {
  // Shared suite DB: drawable leftovers change later draws; the completion on
  // SMALL also fed today's trophy pile, so the task is removed entirely
  // (delete cascades its completions — restoring the pile size).
  const tasks: { id: number; title: string }[] = await (
    await request.get("/api/tasks?status=all")
  ).json();
  for (const t of tasks.filter((t) => [BIG, SMALL, "Unestimated task"].includes(t.title))) {
    await request.delete(`/api/tasks/${t.id}`);
  }
  const goals: { id: number; title: string }[] = await (await request.get("/api/goals")).json();
  for (const g of goals.filter((g) => [GOAL, PLAIN_GOAL].includes(g.title))) {
    await request.delete(`/api/goals/${g.id}`);
  }
});
