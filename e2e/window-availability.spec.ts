import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

// Issue #33: availability windows. One cheap journey, built RELATIVE to the
// real current time (no clock-faking infrastructure exists in e2e/): a task
// windowed to a DIFFERENT weekday is out of its window no matter when the
// suite runs. It is captured through the TaskForm's availability editor,
// parks under Capture's "Scheduled" group with the 🕒 chip, and empties the
// goal-filtered deck with the "scheduled for later" message instead of the
// misleading break-something-down hint.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "E2E window goal";
const TASK_TITLE = "Water the office plants";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function seedGoal(request: APIRequestContext) {
  await request.post("/api/goals", { data: { title: GOAL_TITLE } });
}

test("a task windowed to another weekday is scheduled, not drawable", async ({ page }) => {
  await seedGoal(page.request);

  // Capture through the form: title, goal, estimate, then open the
  // availability editor and move the window to tomorrow's weekday.
  await page.goto("/capture");
  await page.getByPlaceholder("What needs doing?").fill(TASK_TITLE);
  await page.locator("form select").nth(1).selectOption({ label: `🎯 ${GOAL_TITLE}` });
  await page.getByPlaceholder("min").first().fill("10");
  await page.getByRole("button", { name: "🕒 availability" }).click();

  const tomorrow = DAY_LABELS[(new Date().getDay() + 1) % 7];
  for (const label of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
    // Deselect the Mon–Fri default…
    await page.getByRole("checkbox", { name: label, exact: true }).click();
  }
  // …and select only tomorrow (re-selecting if it was a weekday default).
  await page.getByRole("checkbox", { name: tomorrow, exact: true }).click();
  await page.getByRole("button", { name: "Add" }).click();

  // The card parks under "Scheduled" — outside its window right now — and
  // carries the warn-styled 🕒 chip naming the window.
  const scheduled = page.locator("section").filter({ hasText: "🕒 Scheduled" });
  await expect(scheduled.getByText(TASK_TITLE)).toBeVisible();
  await expect(scheduled.locator(".chip").filter({ hasText: "🕒" })).toContainText(tomorrow);

  // It must not sit in the deck section at the same time.
  const ready = page.locator("section").filter({ hasText: "✅ Ready to draw" });
  await expect(ready.getByText(TASK_TITLE)).toHaveCount(0);
});

test("drawing from an all-outside-window pool says scheduled for later", async ({ page }) => {
  // Goal-filtered draw over a pool of exactly one out-of-window card. Earlier
  // serial specs can leave a persisted current draw behind (issue #25) — the
  // revealed card blocks the idle front face, so replace it via "Draw again".
  const current = await (await page.request.get("/api/draw/current")).json();
  await page.goto("/");
  await page.locator(".draw-filters select").selectOption({ label: `🎯 ${GOAL_TITLE}` });
  if (current?.task) {
    await page.getByRole("button", { name: "Draw again" }).click();
  } else {
    await page.locator(".draw-face.front").click();
  }

  await expect(page.getByText(/scheduled for later/)).toBeVisible();
  // Never the break-something-down hint — these cards return on their own.
  await expect(page.getByText(/Break something down/)).toHaveCount(0);
});
