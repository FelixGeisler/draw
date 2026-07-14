import { expect, type Page } from "@playwright/test";

/**
 * Select the goal filter and draw — deterministic for specs that seed exactly
 * one drawable task under their own goal. Earlier serial specs can leave a
 * persisted current draw behind (issue #25), which restores as a revealed
 * card on load — the idle front face is then unclickable, so the card is
 * replaced via "Draw again" instead. Ends on the flipped card; callers assert
 * the title themselves.
 */
export async function drawFromGoal(page: Page, goalTitle: string) {
  const current = await (await page.request.get("/api/draw/current")).json();
  await page.goto("/");
  await page.locator(".draw-filters select").selectOption({ label: `🎯 ${goalTitle}` });
  if (current?.task) {
    await page.getByRole("button", { name: "Draw again" }).click();
  } else {
    await page.locator(".draw-face.front").click();
  }
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
}
