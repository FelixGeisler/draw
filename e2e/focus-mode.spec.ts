import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { drawFromGoal } from "./helpers.js";

// Issue #56: fullscreen focus mode on the drawn card. The view is DERIVED
// from the persisted current draw + the running timer (ADR-29), so this
// journey exercises exactly the restore/degrade matrix: enter → Escape
// (timer survives) → reload (focus restores) → ■ Stop (revealed card, draw
// survives) → ✓ Done in-face (completes with the drawn bonus). Overtime
// rendering stays unit-level (client/src/lib/time.test.ts) — waiting out a
// real estimate is not worth the E2E budget.
// Serial like restore-drawn-card.spec.ts: one goal-scoped task makes the
// draw deterministic; tests continue from the previous test's state.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "E2E focus goal";
const TASK_TITLE = "Focus-mode e2e task";
const OTHER_TITLE = "Focus-mode other running task";

async function seed(request: APIRequestContext) {
  const goal = await (await request.post("/api/goals", { data: { title: GOAL_TITLE } })).json();
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  await request.post("/api/tasks", {
    data: { title: TASK_TITLE, categoryId: categories[0].id, goalId: goal.id, effortMinutes: 10 },
  });
  // A second task OUTSIDE the goal whose timer runs when focus starts — the
  // start-B-closes-A invariant must leave exactly the drawn task running.
  const other = await (
    await request.post("/api/tasks", {
      data: { title: OTHER_TITLE, categoryId: categories[0].id, effortMinutes: 5 },
    })
  ).json();
  await request.post(`/api/tasks/${other.id}/timer/start`);
}

const overlay = (page: Page) => page.getByRole("dialog");

test("Start now flips the drawn card into fullscreen focus with an effort countdown", async ({
  page,
}) => {
  await seed(page.request);
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);

  await page.locator(".draw-actions").getByRole("button", { name: "▶ Start now" }).click();

  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page).locator(".focus-title")).toHaveText(TASK_TITLE);
  // Countdown initialized from the 10 min estimate — counting DOWN (a plain
  // count-up would read 0:0x here), display only.
  await expect(overlay(page).locator(".focus-clock.countdown")).toHaveText(/^(10:00|9:5\d)$/);

  // Starting focus closed the other task's entry — exactly one running
  // timer, and it is the drawn card's (existing invariant, no new semantics).
  const timer = await (await page.request.get("/api/timer/current")).json();
  expect(timer.task.title).toBe(TASK_TITLE);
});

test("reloading while focused restores straight into the focus view", async ({ page }) => {
  // Fresh navigation = the reload: timer still runs on the persisted drawn
  // card, so the page derives its way back into the overlay — no click.
  await page.goto("/");
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page).locator(".focus-title")).toHaveText(TASK_TITLE);
  await expect(overlay(page).locator(".focus-clock.countdown")).toHaveText(/^9:[0-5]\d$/);
});

test("the dialog takes focus, Tab never reaches the covered page, Escape hands focus back", async ({
  page,
}) => {
  // Timer still runs on the drawn card, so the overlay derives on load.
  await page.goto("/");
  await expect(overlay(page)).toBeVisible();
  // Focus moves INTO the dialog on mount (PR #105 review) — a keyboard or
  // screen-reader user lands in the modal, not on a covered control.
  await expect(overlay(page)).toBeFocused();

  // The app root is inert while the overlay is open: Tab cycles the dialog's
  // own controls only. The covered ▶ Start button, 💤/🗑 card actions and the
  // sidenav must be unreachable — no blind operation of invisible controls.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    const escaped = await page.evaluate(() => {
      const el = document.activeElement;
      return el !== document.body && !document.querySelector(".focus-overlay")?.contains(el);
    });
    expect(escaped, `Tab press ${i + 1} left the dialog`).toBe(false);
  }

  // Exit, then re-enter via the trigger so the restore target is a real
  // element: Escape must hand focus back to exactly that trigger.
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toBeHidden();
  const trigger = page.locator(".draw-actions").getByRole("button", { name: "▶ Start now" });
  // Timer already points at the drawn card — re-entry must not restart it
  // (the startFocus guard), so the countdown below keeps its history.
  await trigger.click();
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("Escape exits the view but never the timer", async ({ page }) => {
  await page.goto("/");
  await expect(overlay(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(overlay(page)).toBeHidden();

  // The TimerBar shows the still-running timer (its estimate hint is unique
  // to it), and the classic drawn-card actions are back.
  await expect(page.getByText("est. 10 min")).toBeVisible();
  const actions = page.locator(".draw-actions");
  for (const name of ["▶ Start now", "✓ Done", "💤 Not now", "✎ Edit", "🗑 Delete"]) {
    await expect(actions.getByRole("button", { name })).toBeVisible();
  }
  const timer = await (await page.request.get("/api/timer/current")).json();
  expect(timer.task.title).toBe(TASK_TITLE);
  expect(timer.entry.endedAt).toBeNull();
});

test("Stop in-face returns to the revealed card and the draw survives", async ({ page }) => {
  // Escape was session-local: a fresh page derives back into focus (ADR-29).
  await page.goto("/");
  await expect(overlay(page)).toBeVisible();

  await overlay(page).getByRole("button", { name: "■ Stop" }).click();
  await expect(overlay(page)).toBeHidden();

  // Back on the revealed card; the persisted draw is untouched.
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);
  expect(await (await page.request.get("/api/timer/current")).json()).toBeNull();

  // Reload with a STOPPED timer degrades gracefully: plain revealed card,
  // no dead overlay counting down for nobody.
  await page.reload();
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);
  await expect(overlay(page)).toHaveCount(0);
});

test("Done in-face completes with the drawn bonus and exits to the idle deck", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);
  await page.locator(".draw-actions").getByRole("button", { name: "▶ Start now" }).click();
  await expect(overlay(page)).toBeVisible();

  await overlay(page).getByRole("button", { name: "✓ Done" }).click();
  await expect(overlay(page)).toBeHidden();
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);

  // Same effects as the drawn card's Done: drawn bonus 10 × (3/3) × 1.5 = 15,
  // and the running entry was closed server-side by the completion (ADR-12).
  const g = await (await page.request.get("/api/gamification")).json();
  const completion = g.todayCompletions.find((c: { title: string }) => c.title === TASK_TITLE);
  expect(completion).toBeTruthy();
  expect(completion.wasDrawn).toBe(1);
  expect(completion.xpAwarded).toBe(15);
  expect(await (await page.request.get("/api/timer/current")).json()).toBeNull();

  // Completion cleared the persisted draw — a reload lands on the idle deck.
  await page.reload();
  await expect(page.getByText("click to draw")).toBeVisible();
  await expect(overlay(page)).toHaveCount(0);
});
