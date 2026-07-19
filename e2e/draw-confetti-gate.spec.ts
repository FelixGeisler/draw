import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { drawFromGoal } from "./helpers.js";

// The Draw page's confetti gate (#148): the page's own ✓ Done celebrates
// through lib/celebrate.ts, which skips canvas-confetti entirely under
// prefers-reduced-motion — mirroring goal-victory-shelf.spec.ts's gate pair
// for the victory overlay. Both directions are pinned: the canvas must
// appear for a real completion and must NOT appear under reduced motion
// (without the positive control, the count-0 assert could pass vacuously if
// the celebration ever stopped rendering a <canvas> at all). Serial like the
// other draw journeys, against the shared suite database; each test seeds
// one task under its own goal, so every draw is a deterministic pool of one.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "E2E confetti-gate goal";
const LOUD_TASK = "Confetti e2e celebrated task";
const QUIET_TASK = "Confetti e2e reduced-motion task";

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
 * Shared-DB hygiene (the elsewhere-completion.spec.ts pattern): deleting the
 * task cascades to its completion, which keeps today's trophy pile clean for
 * the trophy specs' hover asserts AND disarms the momentum bonus the
 * completion armed — later specs assert exact XP.
 */
async function cleanup(request: APIRequestContext, taskId: number) {
  await request.delete(`/api/tasks/${taskId}`);
}

test("the page's own ✓ Done fires confetti when motion is allowed", async ({ page }) => {
  // No reduced-motion emulation: this test pins that the celebration
  // actually happens. Presence of the confetti canvas only — no pixels.
  const task = await seed(page.request, LOUD_TASK);
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(LOUD_TASK);

  await page.locator(".draw-actions").getByRole("button", { name: "✓ Done" }).click();
  // body > canvas, the sibling goal-victory-shelf idiom (#152): canvas-confetti
  // mounts its canvas directly under body, and the scope keeps the assert
  // honest if a page-level <canvas> ever appears.
  await expect(page.locator("body > canvas")).toHaveCount(1);
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);

  await cleanup(page.request, task.id);
});

test("reduced motion suppresses the ✓ Done confetti entirely", async ({ page }) => {
  const task = await seed(page.request, QUIET_TASK);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(QUIET_TASK);

  await page.locator(".draw-actions").getByRole("button", { name: "✓ Done" }).click();
  // The completion itself is untouched by the gate: the card leaves for the
  // idle deck exactly as ever. completeDrawn fires the (gated) burst before
  // dismissing the card, so once the card is gone the canvas would already
  // exist if it were going to — the count below cannot pass by racing it.
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
  await expect(page.getByText("click to draw")).toBeVisible();
  // The matchMedia gate skipped the burst: no canvas was ever created.
  await expect(page.locator("body > canvas")).toHaveCount(0);

  await cleanup(page.request, task.id);
});
