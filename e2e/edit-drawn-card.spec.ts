import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { drawFromGoal } from "./helpers.js";

// Issue #13: the drawn card offers Edit (reusing TaskForm) and Delete.
// Runs after core-journey.spec.ts against the same database. To keep the
// draw deterministic despite leftover drawable tasks from earlier specs,
// this spec seeds one task linked to its own goal and draws with the goal
// filter — a pool of exactly one card. It only touches its own data.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "E2E edit-card goal";
const TASK_TITLE = "Water the e2e ficus";
const EDITED_TITLE = "Water the e2e ficus properly";

async function seed(request: APIRequestContext) {
  const goal = await (
    await request.post("/api/goals", { data: { title: GOAL_TITLE } })
  ).json();
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  await request.post("/api/tasks", {
    data: {
      title: TASK_TITLE,
      categoryId: categories[0].id,
      goalId: goal.id,
      effortMinutes: 10,
    },
  });
}

test("edit: saving updates the card in place, drawn state preserved", async ({ page }) => {
  await seed(page.request);
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);
  await expect(page.locator(".draw-chance")).toBeVisible();

  // Cancel leaves the card untouched.
  await page.getByRole("button", { name: "✎ Edit" }).click();
  const title = page.getByPlaceholder("What needs doing?");
  await expect(title).toHaveValue(TASK_TITLE);
  await expect(page.getByTitle("Effort estimate in minutes")).toHaveValue("10");
  // No goal select mid-draw (#88): the page's goal filter covers that axis,
  // and goal (re)linking lives on the Tasks page rows. The task IS
  // goal-linked, so the impact stars still render.
  await expect(page.getByTitle("Link to a goal (enables impact rating)")).toHaveCount(0);
  await expect(page.getByTitle("Impact toward the goal (1–5)")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(title).not.toBeVisible();
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);

  // Save writes the PATCH response back into the card — still flipped,
  // no redraw, new title and effort badge visible immediately.
  await page.getByRole("button", { name: "✎ Edit" }).click();
  await title.fill(EDITED_TITLE);
  await page.getByTitle("Effort estimate in minutes").fill("15");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
  await expect(page.locator(".draw-face.back h2")).toHaveText(EDITED_TITLE);
  // The estimate renders as the effort chip again (#123 — the ATK stat died
  // with the TCG frame).
  await expect(
    page.locator(".draw-face.back .chip", { hasText: "15 min" }),
  ).toBeVisible();
  // Still drawable: no out-of-the-deck hint. The original draw odds are
  // stale after an edit, so they are hidden rather than shown wrong.
  await expect(page.locator(".draw-hint")).not.toBeVisible();
  await expect(page.locator(".draw-chance")).not.toBeVisible();

  // The tasks queries were invalidated — the Tasks page shows the edit.
  await page.goto("/tasks");
  await expect(page.getByText(EDITED_TITLE)).toBeVisible();

  // The hidden goal select resent the stored link unchanged (#88) — the
  // edit must not silently detach the task from its goal.
  const tasks: { title: string; goalId: number | null }[] = await (
    await page.request.get("/api/tasks")
  ).json();
  expect(tasks.find((t) => t.title === EDITED_TITLE)?.goalId).not.toBeNull();
});

test("edit above max_draw_effort: card stays with the resolve hint, no draw-again", async ({
  page,
}) => {
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(EDITED_TITLE);

  await page.getByRole("button", { name: "✎ Edit" }).click();
  await page.getByTitle("Effort estimate in minutes").fill("90");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  // Card stays revealed with the updated data plus a non-drawable hint.
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
  await expect(page.locator(".draw-face.back h2")).toHaveText(EDITED_TITLE);
  await expect(
    page.locator(".draw-face.back .chip", { hasText: "90 min" }),
  ).toBeVisible();
  await expect(page.locator(".draw-hint")).toContainText("out of the deck");
  // The draw is a commitment (#88): no "Draw again" even for a card that was
  // edited out of the deck — the way forward is resolving it ("Not now").
  await expect(page.getByRole("button", { name: "Draw again" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "💤 Not now" })).toBeVisible();
});

test("reload after the out-of-deck edit: the lazily cleared pointer stays cleared", async ({
  page,
}) => {
  // The SESSION held the 90-minute card above (#88's sanctioned escape), but
  // the pointer was forfeited: GET /api/draw/current cleared it lazily when
  // the edit's invalidation refetched. A fresh mount derives from that
  // cleared pointer (#110) — the idle deck, never a resurrected card.
  expect(await (await page.request.get("/api/draw/current")).json()).toBeNull();
  await page.goto("/");
  await expect(page.getByText("click to draw")).toBeVisible();
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
});

test("delete from the card dismisses it and returns to the idle draw", async ({ page }) => {
  // The previous test left the task at 90 min — out of the deck. Make it
  // drawable again via the API so the goal-filtered draw finds it.
  const all: { id: number; title: string }[] = await (
    await page.request.get("/api/tasks")
  ).json();
  const task = all.find((t) => t.title === EDITED_TITLE)!;
  expect(task).toBeTruthy();
  await page.request.patch(`/api/tasks/${task.id}`, { data: { effortMinutes: 10 } });

  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(EDITED_TITLE);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "🗑 Delete" }).click();

  // Card flips back to the idle front face; the draw is available again.
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
  await expect(page.getByText("click to draw")).toBeVisible();
  await expect(page.getByRole("button", { name: "🗑 Delete" })).not.toBeVisible();

  // Really deleted server-side (tasks queries invalidated for the list too).
  const tasks: { title: string }[] = await (await page.request.get("/api/tasks")).json();
  expect(tasks.some((t) => t.title === EDITED_TITLE)).toBe(false);
});
