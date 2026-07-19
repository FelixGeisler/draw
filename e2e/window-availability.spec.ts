import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { captureForm, resolveCurrentDraw, taskTree, triageStrip } from "./helpers.js";

// Issue #33: availability windows. One cheap journey, built RELATIVE to the
// real current time (no clock-faking infrastructure exists in e2e/): a task
// windowed to a DIFFERENT weekday is out of its window no matter when the
// suite runs. It is captured through the Tasks page's quick-capture form
// (#151), stays OUT of the triage strip (scheduled is passive — the card
// returns on its own, nothing to do), wears the 🕒 chip in its category
// group, and empties the goal-filtered deck with the "scheduled for later"
// message instead of the misleading break-something-down hint.
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
  await page.goto("/tasks");
  const form = captureForm(page);
  await form.getByPlaceholder("What needs doing?").fill(TASK_TITLE);
  await form.locator("select").nth(1).selectOption({ label: `🎯 ${GOAL_TITLE}` });
  await form.getByPlaceholder("min").fill("10");
  await form.getByRole("button", { name: "🕒 availability" }).click();

  const tomorrow = DAY_LABELS[(new Date().getDay() + 1) % 7];
  for (const label of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
    // Deselect the Mon–Fri default…
    await form.getByRole("checkbox", { name: label, exact: true }).click();
  }
  // …and select only tomorrow (re-selecting if it was a weekday default).
  await form.getByRole("checkbox", { name: tomorrow, exact: true }).click();
  await form.getByRole("button", { name: "Add" }).click();

  // Scheduled is a badge, not a triage verdict (#151): the row sits in its
  // category group wearing the warn-styled 🕒 chip naming the window, and
  // the strip must NOT list it — there is nothing to do, the card returns
  // on its own.
  const row = taskTree(page).getByText(TASK_TITLE).locator("..");
  await expect(row).toBeVisible();
  await expect(row.locator(".chip").filter({ hasText: "🕒" })).toContainText(tomorrow);
  await expect(triageStrip(page).getByText(TASK_TITLE)).toHaveCount(0);
});

test("drawing from an all-outside-window pool says scheduled for later", async ({ page }) => {
  // Goal-filtered draw over a pool of exactly one out-of-window card. Earlier
  // serial specs can leave a persisted current draw behind (issue #25) — the
  // revealed card blocks the idle front face, and since #88 there is no
  // "Draw again", so the leftover card is resolved before drawing.
  await resolveCurrentDraw(page);
  await page.goto("/");
  await page.locator(".draw-filters select").selectOption({ label: `🎯 ${GOAL_TITLE}` });
  await page.locator(".draw-face.front").click();

  await expect(page.getByText(/scheduled for later/)).toBeVisible();
  // Never the break-something-down hint — these cards return on their own.
  await expect(page.getByText(/Break something down/)).toHaveCount(0);
});

test("a rejected night window surfaces the server's message instead of failing silently", async ({
  page,
}) => {
  // Overnight windows (end <= start) are rejected by design — the exact
  // attempt the issue predicts. The 400 must reach the user: before the fix
  // the form swallowed it and Add just did nothing.
  const NIGHT_TITLE = "Read before bed";
  await page.goto("/tasks");
  const form = captureForm(page);
  await form.getByPlaceholder("What needs doing?").fill(NIGHT_TITLE);
  await form.getByRole("button", { name: "🕒 availability" }).click();
  await form.getByLabel("Window start").fill("20:00");
  await form.getByLabel("Window end").fill("08:00");
  await form.getByRole("button", { name: "Add" }).click();

  // The server's message is shown, the task is NOT created, and the form
  // keeps its fields for correction instead of resetting.
  await expect(form.getByRole("alert")).toContainText("overnight windows are not supported");
  await expect(taskTree(page).getByText(NIGHT_TITLE)).toHaveCount(0);
  await expect(form.getByPlaceholder("What needs doing?")).toHaveValue(NIGHT_TITLE);

  // Correcting the window clears the error and the capture goes through.
  // Unestimated on purpose (it must never enter the deck). Its triage state
  // depends on the wall clock — inside the 20:00–22:00 window it would need
  // an estimate, outside it classifies scheduled (passive, not in the strip)
  // — so only the always-true category-tree row is pinned.
  await form.getByLabel("Window end").fill("22:00");
  await form.getByRole("button", { name: "Add" }).click();
  await expect(taskTree(page).getByText(NIGHT_TITLE)).toBeVisible();
  await expect(form.getByRole("alert")).toHaveCount(0);

  // Clean up like the sibling specs: the corrected task's triage state
  // depends on the wall clock (needs-estimate inside its 20:00–22:00
  // weekday window, scheduled otherwise) — left behind, it would make later
  // spec files' strip assertions time-of-day dependent.
  const created: { id: number; title: string }[] = await (
    await page.request.get("/api/tasks")
  ).json();
  const night = created.find((t) => t.title === NIGHT_TITLE)!;
  await page.request.delete(`/api/tasks/${night.id}`);
});
