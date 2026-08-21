import { expect, test } from "@playwright/test";

// Transitional shop (#263): the collection remains visible and Draw keeps the
// equipped weave, but no pack/direct-freeze purchase action is exposed.
test("shop is read-only until Gold purchases launch", async ({ page }) => {
  await page.goto("/stats");
  const shop = page.getByTestId("shop");
  await shop.scrollIntoViewIfNeeded();

  await expect(shop.getByText(/Gold/)).toBeVisible();
  await expect(shop.getByRole("button", { name: /Classic weave/ })).toBeVisible();
  await expect(shop.getByRole("button", { name: /Open pack|Buy freeze/ })).toHaveCount(0);
  await expect(shop).not.toContainText(/XP to spend/);

  await page.goto("/");
  await expect(page.locator(".draw-face.front").first()).not.toHaveAttribute("data-back");
});
