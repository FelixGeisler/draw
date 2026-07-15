import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { drawFromGoal } from "./helpers.js";

// Issue #23: break a task down with "Do in order" — only the first open step
// enters the deck, later siblings wear the ⏳ queued chip, and completing the
// exposed step frees the next one. Like the other journey specs it seeds one
// parent under its own goal and draws goal-filtered for a deterministic pool.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "E2E sequential goal";
const PARENT_TITLE = "Assemble the flatpack wardrobe";
const STEP_ONE = "Unpack and sort the panels";
const STEP_TWO = "Attach the wardrobe doors";
const RECUR_PARENT_TITLE = "Keep the e2e aquarium alive";
const RECUR_STEP_TITLE = "Feed the e2e fish";

async function seed(request: APIRequestContext) {
  const goal = await (
    await request.post("/api/goals", { data: { title: GOAL_TITLE } })
  ).json();
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  await request.post("/api/tasks", {
    data: {
      title: PARENT_TITLE,
      categoryId: categories[0].id,
      goalId: goal.id,
      effortMinutes: 60,
    },
  });
}

function taskRow(page: Page, title: string) {
  return page.getByText(title).locator("..");
}

test("sequential breakdown: only the first step is drawable, the second queues up", async ({
  page,
}) => {
  await seed(page.request);

  // Break the parent down with "Do in order" checked.
  await page.goto("/tasks");
  await taskRow(page, PARENT_TITLE).getByRole("button", { name: "Break down" }).click();
  const rows = page.getByPlaceholder("Small, concrete step…");
  const minutes = page.getByPlaceholder("min");
  await rows.nth(0).fill(STEP_ONE);
  await minutes.nth(0).fill("15");
  await rows.nth(1).fill(STEP_TWO);
  await minutes.nth(1).fill("15");
  await page.getByLabel(/Do in order/).check();
  await page.getByRole("button", { name: /Add 2 subtasks/ }).click();

  // The held-back sibling wears the queued chip; the exposed first step does not.
  await expect(taskRow(page, STEP_TWO).locator(".chip", { hasText: "⏳ queued" })).toBeVisible();
  await expect(
    taskRow(page, STEP_ONE).locator(".chip", { hasText: "⏳ queued" }),
  ).not.toBeVisible();
  // The parent row announces the mode and offers the flip.
  await expect(
    taskRow(page, PARENT_TITLE).getByRole("button", { name: "→ in order" }),
  ).toBeVisible();

  // The goal-scoped deck holds exactly the first step.
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(STEP_ONE);
  await expect(page.locator(".draw-chance")).toContainText("1 card");
});

test("completing the exposed step frees the next one in line", async ({ page }) => {
  // The previous test left step one revealed as the current draw.
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(STEP_ONE);
  await page.getByRole("button", { name: "✓ Done" }).click();

  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(STEP_TWO);

  // The queue chip is gone on the Tasks page — derived, with no extra write.
  await page.goto("/tasks");
  await expect(
    taskRow(page, STEP_TWO).locator(".chip", { hasText: "⏳ queued" }),
  ).not.toBeVisible();
});

test("flipping the parent back to any order clears the queue", async ({ page }) => {
  // Give the flip something to hold back again: a third step, still in order.
  await page.goto("/tasks");
  await taskRow(page, PARENT_TITLE).getByRole("button", { name: "Break down" }).click();
  const rows = page.getByPlaceholder("Small, concrete step…");
  const minutes = page.getByPlaceholder("min");
  await rows.nth(0).fill("Mount the clothes rail");
  await minutes.nth(0).fill("10");
  // The toggle remembers the parent's sequential mode — no re-check needed.
  await expect(page.getByLabel(/Do in order/)).toBeChecked();
  await page.getByRole("button", { name: /Add 1 subtask/ }).click();
  await expect(
    taskRow(page, "Mount the clothes rail").locator(".chip", { hasText: "⏳ queued" }),
  ).toBeVisible();

  await taskRow(page, PARENT_TITLE).getByRole("button", { name: "→ in order" }).click();
  await expect(
    taskRow(page, PARENT_TITLE).getByRole("button", { name: "⇄ any order" }),
  ).toBeVisible();
  await expect(
    taskRow(page, "Mount the clothes rail").locator(".chip", { hasText: "⏳ queued" }),
  ).not.toBeVisible();
});

test("a step completed out of order never wears the queued chip", async ({ page }) => {
  // Back to in-order: the still-open, older step two holds the rail back again.
  await page.goto("/tasks");
  await taskRow(page, PARENT_TITLE).getByRole("button", { name: "⇄ any order" }).click();
  // Keep done rows on screen — the completed step must stay visible to assert on.
  await page.getByLabel("show done").check();
  const rail = taskRow(page, "Mount the clothes rail");
  await expect(rail.locator(".chip", { hasText: "⏳ queued" })).toBeVisible();

  // Tick the held-back step done directly — allowed out of order. Plain click:
  // the controlled checkbox only turns checked after the mutation round-trip,
  // so .check()'s immediate state assertion would fail.
  await rail.getByRole("checkbox").click();
  await expect(rail.getByRole("checkbox")).toBeChecked();
  // The done row must drop the derived queue chip (#67: heldBack status guard).
  await expect(rail.locator(".chip", { hasText: "⏳ queued" })).not.toBeVisible();
});

test("recurring steps cannot join an in-order breakdown (#66)", async ({ page }) => {
  // Editing a step of the (again in-order) wardrobe parent offers no
  // recurrence field — a recurring step would gate its siblings forever.
  await page.goto("/tasks");
  await taskRow(page, STEP_TWO).getByTitle("Edit", { exact: true }).click();
  await expect(page.getByPlaceholder("What needs doing?")).toHaveValue(STEP_TWO);
  await expect(page.getByTitle("Repeat every N days (optional)")).not.toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // A parallel parent's step CAN recur — but then the parent locks against
  // "do in order": the flip button and the breakdown editor's toggle disable
  // with the reason instead of failing on the server's 400.
  const categories: { id: number }[] = await (await page.request.get("/api/categories")).json();
  const parent = await (
    await page.request.post("/api/tasks", {
      data: { title: RECUR_PARENT_TITLE, categoryId: categories[0].id, effortMinutes: 30 },
    })
  ).json();
  await page.request.post(`/api/tasks/${parent.id}/subtasks`, {
    data: { subtasks: [{ title: RECUR_STEP_TITLE, effortMinutes: 10 }] },
  });

  await page.goto("/tasks");
  await taskRow(page, RECUR_STEP_TITLE).getByTitle("Edit", { exact: true }).click();
  await page.getByTitle("Repeat every N days (optional)").fill("3");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(taskRow(page, RECUR_STEP_TITLE).locator(".chip", { hasText: "↻ 3d" })).toBeVisible();

  const flip = taskRow(page, RECUR_PARENT_TITLE).getByRole("button", { name: "⇄ any order" });
  await expect(flip).toBeDisabled();
  await expect(flip).toHaveAttribute("title", /recurring/);

  await taskRow(page, RECUR_PARENT_TITLE).getByRole("button", { name: "Break down" }).click();
  await expect(page.getByLabel(/Do in order/)).toBeDisabled();
});
