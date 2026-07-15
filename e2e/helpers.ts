import { expect, type Page } from "@playwright/test";

/**
 * Resolve a current draw persisted by an earlier serial spec (issue #25).
 * Since #88 the draw is a commitment — there is no "Draw again", and a
 * restored card blocks the idle front face. Resolution mirrors the product's
 * escape hatch: blocking ("Not now") takes the card out of the deck and
 * eagerly clears the persisted pointer (ADR-17); the immediate wake keeps the
 * task itself drawable, because some specs re-draw the very task their
 * leftover card shows (their goal-scoped pool holds exactly that one card).
 */
export async function resolveCurrentDraw(page: Page) {
  const current = await (await page.request.get("/api/draw/current")).json();
  if (current?.task) {
    await page.request.patch(`/api/tasks/${current.task.id}`, { data: { blocked: true } });
    await page.request.patch(`/api/tasks/${current.task.id}`, { data: { blocked: false } });
  }
}

/**
 * Select the goal filter and draw — deterministic for specs that seed exactly
 * one drawable task under their own goal. A leftover persisted draw is
 * resolved first so the idle front face is clickable. Ends on the flipped
 * card; callers assert the title themselves.
 */
export async function drawFromGoal(page: Page, goalTitle: string) {
  await resolveCurrentDraw(page);
  await page.goto("/");
  await page.locator(".draw-filters select").selectOption({ label: `🎯 ${goalTitle}` });
  await page.locator(".draw-face.front").click();
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
}
