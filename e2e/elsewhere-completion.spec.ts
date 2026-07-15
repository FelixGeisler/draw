import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { drawFromGoal } from "./helpers.js";

// Issue #110: the standing revealed card DERIVES from the server-persisted
// current draw (extending ADR-29's derived-view principle) — completing the
// drawn task on another surface must dismiss the card without a second
// ✓ Done on the DrawPage. Runs after core-journey.spec.ts against the same
// database (core-journey asserts the pristine 0-XP header, so no spec that
// completes tasks may sort before it). Serial like the other draw journeys:
// each test seeds one task under the shared goal, so every draw is a
// deterministic pool of one; tests only touch their own uniquely-named data.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "E2E complete-elsewhere goal";
const TIMER_TASK = "Elsewhere e2e timer-bar task";
const TASKS_PAGE_TASK = "Elsewhere e2e tasks-page task";

async function seed(request: APIRequestContext, title: string) {
  const goals: { id: number; title: string }[] = await (await request.get("/api/goals")).json();
  let goal = goals.find((g) => g.title === GOAL_TITLE);
  if (!goal) {
    goal = await (await request.post("/api/goals", { data: { title: GOAL_TITLE } })).json();
  }
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  const task = await (
    await request.post("/api/tasks", {
      data: { title, categoryId: categories[0].id, goalId: goal!.id, effortMinutes: 10 },
    })
  ).json();
  return task as { id: number };
}

/**
 * Shared-DB hygiene: deleting the task cascades to its completion, so this
 * file leaves no extra cards in today's trophy pile (a reopen would instead
 * put the task back into the shared goal's pool and break the next test's
 * deterministic single-card draw). The pile is a centered non-wrapping flex
 * row — every leftover completion shrinks ALL cards, and below ~60px each
 * card's hover center falls under its right neighbor, flaking the trophy
 * specs' hover asserts.
 */
async function cleanup(request: APIRequestContext, taskId: number) {
  await request.delete(`/api/tasks/${taskId}`);
}

test("completing the drawn card from the TimerBar dismisses it — no second ✓ Done", async ({
  page,
}) => {
  const task = await seed(page.request, TIMER_TASK);
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TIMER_TASK);

  // Start the timer from the card, then Escape the focus overlay: the
  // TimerBar now shows the running timer NEXT TO the still-revealed card.
  await page.locator(".draw-actions").getByRole("button", { name: "▶ Start now" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);

  await page.locator(".timer-bar").getByRole("button", { name: "✓ Done" }).click();

  // The card leaves on its own: the completion cleared the persisted pointer,
  // the invalidated current-draw query refetched, and the derived view
  // returned to the idle deck — no reload, no click on the card.
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
  await expect(page.getByText("click to draw")).toBeVisible();
  // The focus overlay derives from the same facts — it must not resurrect.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The acting surface was the TimerBar, but the drawn bonus still derives
  // from the server-persisted pointer (ADR-13): 10 × (3/3) × 1.5 = 15.
  const g = await (await page.request.get("/api/gamification")).json();
  const completion = g.todayCompletions.find((c: { title: string }) => c.title === TIMER_TASK);
  expect(completion).toBeTruthy();
  expect(completion.wasDrawn).toBe(1);
  expect(completion.xpAwarded).toBe(15);
  expect(await (await page.request.get("/api/draw/current")).json()).toBeNull();

  await cleanup(page.request, task.id);
});

test("completing the drawn card from the Tasks page dismisses it on return — SPA nav, no reload", async ({
  page,
}) => {
  const task = await seed(page.request, TASKS_PAGE_TASK);
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASKS_PAGE_TASK);

  // In-app navigation keeps the query cache alive: this is NOT the reload
  // restore path (#25) but the derived dismissal (#110). Plain click on the
  // controlled checkbox — the row leaves the "open" filter instead of
  // turning checked (same pattern as timer-completion.spec.ts).
  await page.getByRole("link", { name: "Tasks" }).click();
  await page
    .getByText(TASKS_PAGE_TASK, { exact: true })
    .locator("..")
    .getByRole("checkbox")
    .click();
  await expect(page.getByText(TASKS_PAGE_TASK)).toHaveCount(0);

  await page.getByRole("link", { name: "Draw", exact: true }).click();
  await expect(page.getByText("click to draw")).toBeVisible();
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);

  await cleanup(page.request, task.id);
});
