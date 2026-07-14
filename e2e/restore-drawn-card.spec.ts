import { expect, test, type Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

// Issue #25: the drawn card survives a page reload — the DrawPage restores it
// from the server-persisted current draw, revealed and fully actionable.
// Runs against the shared serial E2E database; like edit-drawn-card.spec.ts
// it seeds one task under its own goal and draws with the goal filter for a
// deterministic pool of one. 10 min × impact 3 → 10 XP, ×1.5 drawn = 15.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "E2E restore goal";
const TASK_TITLE = "Reload-proof e2e task";

async function seed(request: APIRequestContext) {
  const goal = await (await request.post("/api/goals", { data: { title: GOAL_TITLE } })).json();
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  await request.post("/api/tasks", {
    data: { title: TASK_TITLE, categoryId: categories[0].id, goalId: goal.id, effortMinutes: 10 },
  });
}

// Earlier specs can leave a persisted draw behind, which now restores on
// load — branch on the server state so the draw stays deterministic.
async function drawFromGoal(page: Page) {
  const current = await (await page.request.get("/api/draw/current")).json();
  await page.goto("/");
  await page.locator(".draw-filters select").selectOption({ label: `🎯 ${GOAL_TITLE}` });
  if (current?.task) {
    await page.getByRole("button", { name: "Draw again" }).click();
  } else {
    await page.locator(".draw-face.front").click();
  }
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);
}

test("draw → reload: the same card comes back revealed, no redraw needed", async ({ page }) => {
  await seed(page.request);
  await drawFromGoal(page);
  await expect(page.locator(".draw-chance")).toBeVisible();

  await page.reload();

  // Restored straight to the revealed card — no click, no shuffle.
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);
  // The odds belonged to the original draw and are not restored.
  await expect(page.locator(".draw-chance")).not.toBeVisible();
  // Every card action is available on the restored card.
  for (const name of ["▶ Start now", "✓ Done", "✎ Edit", "🗑 Delete", "Draw again"]) {
    await expect(page.getByRole("button", { name })).toBeVisible();
  }
});

test("completing the restored card pays the drawn bonus and clears the draw", async ({
  page,
}) => {
  // A fresh navigation restores the card again (previous test ended revealed).
  await page.goto("/");
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);

  await page.getByRole("button", { name: "✓ Done" }).click();
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);

  // The drawn-card XP bonus came from the server-persisted draw, not a
  // client flag: 10 × (3/3) × 1.5 = 15.
  const g = await (await page.request.get("/api/gamification")).json();
  const completion = g.todayCompletions.find((c: { title: string }) => c.title === TASK_TITLE);
  expect(completion).toBeTruthy();
  expect(completion.wasDrawn).toBe(1);
  expect(completion.xpAwarded).toBe(15);

  // Completion cleared the persisted draw — a reload lands on the idle deck.
  await page.reload();
  await expect(page.getByText("click to draw")).toBeVisible();
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
});
