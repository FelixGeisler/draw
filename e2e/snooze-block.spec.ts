import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { drawFromGoal } from "./helpers.js";

// Issue #19: "Not now" on the drawn card snoozes or blocks the task — it
// leaves the deck, parks in the Tasks page's collapsed Snoozed group, and a
// Wake click puts it back. Runs after the other specs against the shared
// serial database; like edit-drawn-card.spec.ts it seeds one task under its
// own goal and draws goal-filtered for a deterministic pool of one.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "E2E snooze goal";
const TASK_TITLE = "Water the snoozable cactus";

async function seed(request: APIRequestContext) {
  const goal = await (
    await request.post("/api/goals", { data: { title: GOAL_TITLE } })
  ).json();
  const categories: { id: number; name: string }[] = await (
    await request.get("/api/categories")
  ).json();
  await request.post("/api/tasks", {
    data: {
      title: TASK_TITLE,
      categoryId: categories[0].id,
      goalId: goal.id,
      effortMinutes: 10,
    },
  });
  return categories[0].name;
}

function snoozedGroup(page: import("@playwright/test").Page) {
  return page.locator("details").filter({ hasText: "💤 Snoozed" });
}

test("snooze from the drawn card: dismissed, parked under Snoozed, woken again", async ({
  page,
}) => {
  const categoryName = await seed(page.request);
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);

  await page.getByRole("button", { name: "💤 Not now" }).click();
  await page.getByRole("button", { name: "Tomorrow", exact: true }).click();

  // Card dismissed back to the idle deck…
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
  await expect(page.getByText("click to draw")).toBeVisible();

  // …and a reload does not resurrect it (the persisted draw was invalidated).
  await page.reload();
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
  await expect(page.getByText("click to draw")).toBeVisible();

  // Capture no longer lists it under Ready — it moved to the Snoozed group.
  await page.goto("/capture");
  const ready = page.locator("section").filter({ hasText: "Ready to draw" });
  await expect(ready.getByText(TASK_TITLE)).not.toBeVisible();
  await expect(
    page.locator("section").filter({ hasText: "Snoozed" }).getByText(TASK_TITLE),
  ).toBeVisible();

  // On the Tasks page it left the category section into the collapsed group,
  // wearing the derived 💤 badge with its wake time.
  await page.goto("/tasks");
  await expect(
    page.locator("section").filter({ hasText: categoryName }).getByText(TASK_TITLE),
  ).not.toBeVisible();
  await snoozedGroup(page).locator("summary").click();
  const row = snoozedGroup(page).getByText(TASK_TITLE).locator("..");
  await expect(row.locator(".chip", { hasText: "💤 until" })).toBeVisible();

  // Wake puts it straight back into its category section…
  await row.getByRole("button", { name: "Wake" }).click();
  await expect(
    page.locator("section").filter({ hasText: categoryName }).getByText(TASK_TITLE),
  ).toBeVisible();
  await expect(snoozedGroup(page)).not.toBeVisible();

  // …and back into the deck.
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);
});

test("block from the drawn card: out of the draw until woken", async ({ page }) => {
  // The previous test left the card revealed; drawFromGoal redraws it.
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);

  await page.getByRole("button", { name: "💤 Not now" }).click();
  await page.getByRole("button", { name: "⛔ Block indefinitely" }).click();
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);

  // Drawing from this goal now comes up empty — and honestly so: the deck is
  // empty, not "too big" (a blocked card must not suggest breaking down).
  await page.locator(".draw-face.front").click();
  await expect(page.getByText("The deck is empty.")).toBeVisible();

  // Blocked badge in the Snoozed group; Wake makes it drawable again.
  await page.goto("/tasks");
  await snoozedGroup(page).locator("summary").click();
  const row = snoozedGroup(page).getByText(TASK_TITLE).locator("..");
  await expect(row.locator(".chip", { hasText: "⛔ blocked" })).toBeVisible();
  await row.getByRole("button", { name: "Wake" }).click();
  await expect(snoozedGroup(page)).not.toBeVisible();

  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);
});
