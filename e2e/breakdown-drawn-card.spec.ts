import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { drawFromGoal, subtaskEditor, taskTree } from "./helpers.js";

// Issue #209: the drawn card can be broken down where you meet it. Realising
// a card is too coarse the moment it flips is the likeliest time to want a
// breakdown, and the only route used to be leaving the page to hunt the row
// down in the tree.
//
// The interesting part is not that subtasks get created — it is that the card
// must NOT be replaced. A parent with children is a container and containers
// are never drawable, so the breakdown pushes the card out of the deck; it
// therefore takes the same #88 hold as an out-of-deck edit and stands there
// with the resolve hint. A breakdown that dealt a fresh card would be a
// re-roll through the back door.
//
// Seeds its own goal so the pool is exactly one card, like the other
// drawn-card specs, and removes everything it made.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "E2E breakdown-card goal";
const TASK_TITLE = "Overhaul the e2e greenhouse";
const STEP_ONE = "Clear the old e2e benches";
const STEP_TWO = "Reglaze the e2e roof panels";

async function seed(request: APIRequestContext) {
  const goal = await (await request.post("/api/goals", { data: { title: GOAL_TITLE } })).json();
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  await request.post("/api/tasks", {
    data: { title: TASK_TITLE, categoryId: categories[0].id, goalId: goal.id, effortMinutes: 25 },
  });
  return goal.id as number;
}

test("breaking the drawn card down holds it out of the deck instead of dealing a new one", async ({
  page,
}) => {
  await seed(page.request);
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);
  // Drawable to start with: no hint yet.
  await expect(page.locator(".draw-hint")).not.toBeVisible();

  // Cancel leaves the card exactly as it was — the affordance is not a trap.
  await page.getByRole("button", { name: "🔨 Break down" }).click();
  await expect(subtaskEditor(page)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(subtaskEditor(page)).not.toBeVisible();
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);
  await expect(page.locator(".draw-hint")).not.toBeVisible();

  await page.getByRole("button", { name: "🔨 Break down" }).click();
  const titles = subtaskEditor(page).getByPlaceholder("Small, concrete step…");
  const minutes = subtaskEditor(page).getByPlaceholder("min");
  await titles.nth(0).fill(STEP_ONE);
  await minutes.nth(0).fill("10");
  await titles.nth(1).fill(STEP_TWO);
  await minutes.nth(1).fill("15");
  await page.getByRole("button", { name: /Add 2 subtasks/ }).click();

  // The card STANDS — same task, still flipped — and now names why it is out
  // of the deck. This is the assertion the whole spec exists for: a redraw
  // here would show a different title, and an unheld card would vanish.
  await expect(subtaskEditor(page)).not.toBeVisible();
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);
  await expect(page.locator(".draw-hint")).toBeVisible();
  // The original odds are stale once the card changed shape.
  await expect(page.locator(".draw-chance")).not.toBeVisible();

  // The affordance stays, and now means "add more steps" — the #67
  // re-breakdown, exactly as it reads on a TaskRow parent that already has
  // subtasks. Adding a third step must not deal a new card either.
  await page.getByRole("button", { name: "🔨 Break down" }).click();
  await titles.nth(0).fill("Order the e2e replacement glass");
  await minutes.nth(0).fill("5");
  await page.getByRole("button", { name: /Add 1 subtask/ }).click();
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);
  await expect(page.locator(".draw-hint")).toBeVisible();

  // The steps really landed, nested under the parent (ADR-16: two levels).
  await page.goto("/tasks");
  await expect(taskTree(page).getByText(STEP_ONE, { exact: true })).toBeVisible();
  await expect(taskTree(page).getByText(STEP_TWO, { exact: true })).toBeVisible();
  // Each step is a subtask, so each offers Split rather than Break down.
  const stepRow = taskTree(page).getByText(STEP_ONE, { exact: true }).locator("..");
  await expect(stepRow.getByRole("button", { name: "Split" })).toBeVisible();
  await expect(stepRow.getByRole("button", { name: "Break down" })).toHaveCount(0);
});

test("the breakdown forfeited the draw pointer — the deck is idle again", async ({ page }) => {
  // The hold is session-local (#88): it keeps the card on the screen that
  // made it, but the server-side pointer is already gone, so a fresh load
  // finds an idle deck rather than a restored container.
  const current = await (await page.request.get("/api/draw/current")).json();
  expect(current?.task ?? null).toBeNull();

  await page.goto("/");
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
});

test.afterAll(async ({ request }) => {
  // The suite shares one database and a leaked drawable step would change
  // what later specs draw. Deleting the parent cascades to its children.
  const tasks: { id: number; title: string }[] = await (
    await request.get("/api/tasks?status=all")
  ).json();
  for (const t of tasks.filter((t) => t.title === TASK_TITLE)) {
    const res = await request.delete(`/api/tasks/${t.id}`);
    if (!res.ok()) throw new Error(`cleanup: delete task ${t.id} failed (${res.status()})`);
  }
  const goals: { id: number; title: string }[] = await (await request.get("/api/goals")).json();
  for (const g of goals.filter((g) => g.title === GOAL_TITLE)) {
    const res = await request.delete(`/api/goals/${g.id}`);
    if (!res.ok()) throw new Error(`cleanup: delete goal ${g.id} failed (${res.status()})`);
  }
});
