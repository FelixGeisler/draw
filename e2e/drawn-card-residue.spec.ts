import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { drawFromGoal, resolveCurrentDraw } from "./helpers.js";

// Issue #118: the residue #110 left behind. The derived card leaves on its own
// everywhere EXCEPT under #88's session-local hold — a card edited out of the
// deck forfeits its pointer, so the current-draw query can no longer speak for
// it and the hold stood until a reload, however the card was resolved
// elsewhere. Plus the pre-existing stuck shuffle: a rejected draw never ended
// its own animation.
//
// Runs after core-journey.spec.ts against the same database (core-journey
// asserts the pristine 0-XP header, so no spec that completes tasks may sort
// before it). Serial like the other draw journeys: each test seeds one task
// under this file's own goal, so every draw is a deterministic pool of one.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "E2E card-residue goal";
const TIMER_HELD_TASK = "Residue e2e held-then-finished card";
const DELETED_HELD_TASK = "Residue e2e held-then-deleted card";
const EDITED_HELD_TASK = "Residue e2e held-then-deleted edited card";
const REDRAW_TASK = "Residue e2e redraw card";

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
 * Shared-DB hygiene, same reasoning as elsewhere-completion.spec.ts: deleting
 * the task cascades its completion away, so this file leaves neither an extra
 * card in today's trophy pile (which shrinks every card until the trophy
 * specs' hover centers drift under their neighbours) nor an armed momentum
 * bonus (×1.25 for 30 wall-clock minutes) for later exact-XP asserts.
 */
async function cleanup(request: APIRequestContext, taskId: number) {
  await request.delete(`/api/tasks/${taskId}`);
}

/** Edit the standing card above max_draw_effort — #88's sanctioned escape. */
async function editOutOfDeck(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "✎ Edit" }).click();
  await page.getByTitle("Effort estimate in minutes").fill("90");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".draw-hint")).toContainText("out of the deck");
}

test("a held card finished from the TimerBar releases the hold — no reload", async ({ page }) => {
  const task = await seed(page.request, TIMER_HELD_TASK);
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TIMER_HELD_TASK);

  // Start the timer from the card, then Escape the focus overlay: the
  // TimerBar now runs NEXT TO the still-revealed card.
  await page.locator(".draw-actions").getByRole("button", { name: "▶ Start now" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  // Mid-work the estimate turns out to be wrong — the everyday out-of-deck
  // edit. The pointer is forfeit; the hold keeps the card with its hint.
  await editOutOfDeck(page);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TIMER_HELD_TASK);

  // …and it gets finished anyway, from the OTHER surface. The hold used to
  // ignore this entirely: the card stood there until a reload.
  await page.locator(".timer-bar").getByRole("button", { name: "✓ Done" }).click();

  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
  await expect(page.getByText("click to draw")).toBeVisible();
  // Dismissed, not celebrated: the acting surface was the TimerBar (#110).
  await expect(page.locator("canvas")).toHaveCount(0);

  await cleanup(page.request, task.id);
});

test("a held card deleted elsewhere: resolving it dismisses instead of 404ing", async ({ page }) => {
  const task = await seed(page.request, DELETED_HELD_TASK);
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(DELETED_HELD_TASK);
  await editOutOfDeck(page);

  // Deleted out of band — the MCP / second-tab surface. Nothing in THIS tab
  // invalidates, so the held card is still on screen with its resolve hint:
  // the tasks watch closes that window on its next refetch (60s or window
  // focus, ADR-29's accepted latency), but the user is looking at it now.
  await page.request.delete(`/api/tasks/${task.id}`);
  await expect(page.locator(".draw-face.back h2")).toHaveText(DELETED_HELD_TASK);

  // Every on-page resolution 404s at this point — that WAS the stuck card:
  // Done, Not now and Delete all dead-ended, leaving a reload as the only way
  // out. The 404 is now read as the dismissal arriving by the other door.
  await page.getByRole("button", { name: "✓ Done" }).click();
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
  await expect(page.getByText("click to draw")).toBeVisible();
  // A card that was never completed here pays no celebration.
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("saving an edit on a held card deleted elsewhere dismisses — never a form error", async ({ page }) => {
  const task = await seed(page.request, EDITED_HELD_TASK);
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(EDITED_HELD_TASK);
  await editOutOfDeck(page);

  // Deleted out of band while held — the same window as the spec above…
  await page.request.delete(`/api/tasks/${task.id}`);
  await expect(page.locator(".draw-face.back h2")).toHaveText(EDITED_HELD_TASK);

  // …but this time the user resolves it through the EDITOR. Before #130,
  // saveEdit was the one on-page path that still met the vanished card the
  // old way: the raw 404 landed in the form's error line and the card stood,
  // editor open, until the watch's next refetch.
  await page.getByRole("button", { name: "✎ Edit" }).click();
  await page.getByTitle("Effort estimate in minutes").fill("15");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  // The 404 is the dismissal arriving by the other door: the card leaves and
  // the editor closes with it — no error line, and no celebration for a card
  // that was never completed here.
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
  await expect(page.getByText("click to draw")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("a rejected draw hands the deck back — never a stuck shuffle", async ({ page }) => {
  const task = await seed(page.request, REDRAW_TASK);
  await resolveCurrentDraw(page);
  await page.goto("/");
  await page.locator(".draw-filters select").selectOption({ label: `🎯 ${GOAL_TITLE}` });

  let attempts = 0;
  await page.route("**/api/draw", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    attempts++;
    // Hold the request so the shuffle is genuinely observable below — the
    // idle assert must not be able to pass before the draw was attempted.
    await new Promise((r) => setTimeout(r, 500));
    await route.abort("failed");
  });

  await page.locator(".draw-face.front").click();
  await expect(page.getByText("shuffling…")).toBeVisible();
  // The animation ends with the mutation either way. Before #118 `shuffling`
  // was only cleared on the success path, so a rejected draw froze the deck
  // at "shuffling…" for the rest of the session — and since the front face
  // only draws while idle, not even a second click could revive it.
  await expect(page.getByText("click to draw")).toBeVisible();
  expect(attempts).toBe(1);

  // Live again, not merely relabelled.
  await page.unroute("**/api/draw");
  await page.locator(".draw-face.front").click();
  await expect(page.locator(".draw-face.back h2")).toHaveText(REDRAW_TASK);

  // Resolve the card so no pointer leaks into the next spec.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "🗑 Delete" }).click();
  await expect(page.getByText("click to draw")).toBeVisible();
  await cleanup(page.request, task.id);
});
