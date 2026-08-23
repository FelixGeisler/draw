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

test("the header and ShopPanel render independent server snapshots", async ({ page }) => {
  const gamification = await (await page.request.get("/api/gamification")).json();
  const shop = await (await page.request.get("/api/shop")).json();
  const independentShopGold = gamification.totalGold + 999;
  await page.route("**/api/shop", (route) =>
    route.fulfill({ json: { ...shop, gold: independentShopGold } }),
  );

  await page.goto("/stats");
  await expect(
    page.getByText(`${gamification.xp} XP · ${gamification.totalGold} Gold`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("shop")).toContainText(`— ${independentShopGold} Gold`);
});

test("the header renders a negative server-derived Gold total without clamping", async ({ page }) => {
  const gamification = await (await page.request.get("/api/gamification")).json();
  await page.route("**/api/gamification", (route) =>
    route.fulfill({ json: { ...gamification, totalGold: -7 } }),
  );
  await page.goto("/");
  await expect(page.getByText(`${gamification.xp} XP · -7 Gold`, { exact: true })).toBeVisible();
});
