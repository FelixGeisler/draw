import { expect, test, type Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

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

async function drawFromGoal(page: Page) {
  // Earlier specs can leave a persisted current draw behind (issue #25),
  // which restores as a revealed card on load — the idle front face is then
  // unclickable, so replace the card via "Draw again" instead.
  const current = await (await page.request.get("/api/draw/current")).json();
  await page.goto("/");
  await page.locator(".draw-filters select").selectOption({ label: `🎯 ${GOAL_TITLE}` });
  if (current?.task) {
    await page.getByRole("button", { name: "Draw again" }).click();
  } else {
    await page.locator(".draw-face.front").click();
  }
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
}

test("edit: saving updates the card in place, drawn state preserved", async ({ page }) => {
  await seed(page.request);
  await drawFromGoal(page);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);
  await expect(page.locator(".draw-chance")).toBeVisible();

  // Cancel leaves the card untouched.
  await page.getByRole("button", { name: "✎ Edit" }).click();
  const title = page.getByPlaceholder("What needs doing?");
  await expect(title).toHaveValue(TASK_TITLE);
  await expect(page.getByTitle("Effort estimate in minutes")).toHaveValue("10");
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
  await expect(page.locator(".draw-face.back").getByText("15 min")).toBeVisible();
  // Still drawable: no out-of-the-deck hint. The original draw odds are
  // stale after an edit, so they are hidden rather than shown wrong.
  await expect(page.locator(".draw-hint")).not.toBeVisible();
  await expect(page.locator(".draw-chance")).not.toBeVisible();

  // The tasks queries were invalidated — the Tasks page shows the edit.
  await page.goto("/tasks");
  await expect(page.getByText(EDITED_TITLE)).toBeVisible();
});

test("edit above max_draw_effort: card stays with hint and draw-again offer", async ({
  page,
}) => {
  await drawFromGoal(page);
  await expect(page.locator(".draw-face.back h2")).toHaveText(EDITED_TITLE);

  await page.getByRole("button", { name: "✎ Edit" }).click();
  await page.getByTitle("Effort estimate in minutes").fill("90");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  // Card stays revealed with the updated data plus a non-drawable hint.
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
  await expect(page.locator(".draw-face.back h2")).toHaveText(EDITED_TITLE);
  await expect(page.locator(".draw-face.back").getByText("90 min")).toBeVisible();
  await expect(page.locator(".draw-hint")).toContainText("out of the deck");
  await expect(page.getByRole("button", { name: "Draw again" })).toBeVisible();
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

  await drawFromGoal(page);
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
