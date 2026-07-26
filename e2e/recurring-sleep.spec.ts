import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { drawFromGoal } from "./helpers.js";

// Issue #205 (ADR-6 amended): a recurring chore that was just completed must
// not come straight back out of the deck. Its due date IS its next
// occurrence, so the card sleeps until that day — visibly, as a "next <date>"
// chip on the Tasks page, and NOT as a snooze (the user did not send it
// away). Runs serially against the shared database like snooze-block.spec.ts,
// seeding one task under its own goal so the goal-filtered pool is exactly
// one card.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "E2E recurrence goal";
const TASK_TITLE = "Empty the office bin";
const INTERVAL_DAYS = 4;

/** The user's LOCAL calendar day + n — the clock the schedule is written and
 *  read in (PR #206 review): the browser and the server must agree, and both
 *  of them ask the machine's own calendar. */
function day(n: number): string {
  const now = new Date();
  const pad = (v: number) => String(v).padStart(2, "0");
  const localToday = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const d = new Date(`${localToday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

let taskId: number;
let categoryName: string;

async function seed(request: APIRequestContext) {
  const goal = await (await request.post("/api/goals", { data: { title: GOAL_TITLE } })).json();
  const categories: { id: number; name: string }[] = await (
    await request.get("/api/categories")
  ).json();
  categoryName = categories[0].name;
  const task = await (
    await request.post("/api/tasks", {
      data: {
        title: TASK_TITLE,
        categoryId: categories[0].id,
        goalId: goal.id,
        effortMinutes: 10,
        // No due date yet: an unscheduled recurring chore is drawable today,
        // and completing it is what schedules the first next occurrence.
        recurEveryDays: INTERVAL_DAYS,
      },
    })
  ).json();
  taskId = task.id;
}

function categorySection(page: import("@playwright/test").Page) {
  return page.locator("section").filter({ hasText: categoryName });
}

test("completing a recurring card puts it to sleep until its next occurrence", async ({ page }) => {
  await seed(page.request);
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);

  await page.getByRole("button", { name: "✓ Done" }).click();
  // It went to the trophy pile like any completion…
  await expect(page.locator(".trophy-card", { hasText: TASK_TITLE })).toBeVisible();

  // …and the very next draw from the same one-card pool comes up empty, with
  // the honest reason: nothing to break down, the card returns on its own.
  await page.locator(".draw-face.front").click();
  await expect(page.getByText("Everything left is waiting for its next occurrence")).toBeVisible();
  await expect(page.locator(".draw-face.back h2")).toHaveCount(0);

  // A reload cannot resurrect it either (ADR-13 restore validation).
  await page.reload();
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
});

test("the Tasks page shows it waiting for its next occurrence, not snoozed", async ({ page }) => {
  await page.goto("/tasks");

  // Still in its category group — a scheduled card is not parked away like a
  // snoozed one; it wears its state as a chip.
  const row = categorySection(page).getByText(TASK_TITLE).locator("..");
  await expect(row).toBeVisible();
  await expect(row.locator(".chip", { hasText: `next ${day(INTERVAL_DAYS)}` })).toBeVisible();
  await expect(row.locator(".chip", { hasText: `↻ ${INTERVAL_DAYS}d` })).toBeVisible();

  // Explicitly NOT the snooze wording — the user never sent this card away.
  await expect(row.locator(".chip", { hasText: "💤" })).toHaveCount(0);
  await expect(page.locator("details").filter({ hasText: "💤 Snoozed" })).not.toBeVisible();
});

test("the occurrence arriving puts the card back in the deck with no user action", async ({
  page,
}) => {
  // The next occurrence, seeded rather than waited for — the same thing the
  // calendar does four days later.
  const patched = await page.request.patch(`/api/tasks/${taskId}`, {
    data: { dueDate: day(0) },
  });
  expect(patched.ok()).toBe(true);

  await page.goto("/tasks");
  const row = categorySection(page).getByText(TASK_TITLE).locator("..");
  // The chip stops saying "next" the moment the day arrives — it is a due
  // date again, and the card is drawable.
  await expect(row.locator(".chip", { hasText: `due ${day(0)}` })).toBeVisible();

  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);
});
