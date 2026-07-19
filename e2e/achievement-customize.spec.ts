import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Display-only achievement customization (#177, ADR-44): rename, rewrite the
// description, and hide a card — all from an inline editor on the card. The
// server overrides are DISPLAY-ONLY; unlock/claim/XP are untouched (covered by
// the integration suite), so everything here is safe on LOCKED cards and spends
// no XP.
//
// This filename sorts FIRST in the alphabetical serial run — BEFORE
// core-journey.spec.ts, which asserts a pristine "0 XP / Lv 1", and before
// earned-achievements.spec.ts, which asserts specific DEFAULT names/criteria on
// streak_30 / early_bird. So every test here operates on other keys and RESETS
// its customization to default before it ends, leaving the shared DB pristine.
test.describe.configure({ mode: "serial" });

function card(page: Page, key: string) {
  return page.locator(`.ach-card[data-key="${key}"]`);
}

/** Restore an achievement to its shipped default (clears every override). */
async function reset(page: Page, key: string) {
  const res = await page.request.patch(`/api/achievements/${key}`, {
    data: { title: null, description: null, hidden: false },
  });
  expect(res.ok()).toBe(true);
}

test("rename persists across reload, shows on the collection, and flows to the toast", async ({
  page,
}) => {
  await page.goto("/stats");

  // draw_10 is a locked chain card here (nothing drawn) — default "Warming the deck".
  const c = card(page, "draw_10");
  await expect(c.locator(".ach-name")).toHaveText("Warming the deck");

  // Open the inline editor from the ✎ button, rename, Save.
  await c.hover();
  await c.getByRole("button", { name: /Edit/ }).click();
  await c.locator(".ach-editor-name").fill("My warmup deck");
  await c.getByRole("button", { name: "Save" }).click();

  // The card face shows the new name (the query invalidated and refetched)...
  await expect(c.locator(".ach-name")).toHaveText("My warmup deck");
  // ...and it survives a full reload (it is a stored override, not local state).
  await page.reload();
  await expect(card(page, "draw_10").locator(".ach-name")).toHaveText("My warmup deck");

  // The unlock TOAST reads the same /api/gamification payload, so it resolves
  // the custom title automatically. Dispatch an unlock event for the (already
  // loaded) key rather than earning one — this spends no XP and unlocks nothing,
  // it only exercises the toast's rendering path.
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("achievements-unlocked", { detail: ["draw_10"] })),
  );
  const toast = page.locator(".ach-toast", { has: page.locator('.ach-card[data-key="draw_10"]') });
  await expect(toast.locator(".ach-card .ach-name")).toHaveText("My warmup deck");

  // Reset and confirm the default returns.
  await reset(page, "draw_10");
  await page.reload();
  await expect(card(page, "draw_10").locator(".ach-name")).toHaveText("Warming the deck");
});

test("hiding moves the card into a 'Hidden (N)' section; un-hiding returns it", async ({ page }) => {
  await page.goto("/stats");

  // No hidden section to start, and draw_100 is in the main collection.
  await expect(page.locator(".ach-hidden-section")).toHaveCount(0);
  const c = card(page, "draw_100");
  await c.hover();
  await c.getByRole("button", { name: /Edit/ }).click();
  await c.getByRole("checkbox").check();
  await c.getByRole("button", { name: "Save" }).click();

  // It left the main grid for the collapsed Hidden section — display curation,
  // not deletion: still present, still editable there.
  const hiddenSection = page.locator(".ach-hidden-section");
  await expect(hiddenSection.locator("summary")).toHaveText("Hidden (1)");
  await expect(hiddenSection.locator('.ach-card[data-key="draw_100"]')).toHaveCount(1);

  // Un-hide it from the Hidden section: expand, edit, uncheck Hide, Save.
  await hiddenSection.locator("summary").click();
  const hiddenCard = hiddenSection.locator('.ach-card[data-key="draw_100"]');
  await hiddenCard.hover();
  await hiddenCard.getByRole("button", { name: /Edit/ }).click();
  await hiddenCard.getByRole("checkbox").uncheck();
  await hiddenCard.getByRole("button", { name: "Save" }).click();

  // Back in the main collection; the Hidden section is gone.
  await expect(page.locator(".ach-hidden-section")).toHaveCount(0);
  await expect(card(page, "draw_100")).toHaveCount(1);

  await reset(page, "draw_100");
});

test("the description reveals on hover and is reachable on focus", async ({ page }) => {
  await page.goto("/stats");

  // streak_7 is a locked card here — its criteria are the reveal's content.
  const c = card(page, "streak_7");
  const desc = c.locator(".ach-desc");
  await expect(desc).toHaveText("7 completed days in one unbroken streak.");

  // Hidden by default (opacity 0), no permanent caption line on the face.
  expect(await desc.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");

  // Hover reveals it.
  await c.hover();
  await expect
    .poll(async () => desc.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("1");

  // Move the mouse away, then reach it by FOCUS (not hover-only): focusing the
  // ✎ button flips :focus-within, which the reveal keys off — so a keyboard
  // user sees the description too.
  await page.mouse.move(0, 0);
  await c.getByRole("button", { name: /Edit/ }).focus();
  await expect
    .poll(async () => desc.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("1");
});

test("Reset to default restores the shipped name and description", async ({ page }) => {
  await page.goto("/stats");

  const c = card(page, "draw_1000");
  await c.hover();
  await c.getByRole("button", { name: /Edit/ }).click();
  await c.locator(".ach-editor-name").fill("Custom deck name");
  await c.locator(".ach-editor-desc").fill("Custom criteria");
  await c.getByRole("button", { name: "Save" }).click();
  await expect(c.locator(".ach-name")).toHaveText("Custom deck name");

  await page.reload();
  const c2 = card(page, "draw_1000");
  await c2.hover();
  await c2.getByRole("button", { name: /Edit/ }).click();
  // The Reset affordance appears only because the card is customized.
  await c2.getByRole("button", { name: "Reset to default" }).click();

  // Both the name and the reveal description are back to the shipped values.
  await expect(c2.locator(".ach-name")).toHaveText("Deck devotee");
  await expect(card(page, "draw_1000").locator(".ach-desc")).toHaveText("Draw 1,000 cards.");
});

test("reduced motion keeps the reveal instant (no transition), still functional", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/stats");

  const c = card(page, "streak_100");
  const desc = c.locator(".ach-desc");

  // The reveal fade is gated behind prefers-reduced-motion: no-preference, so
  // reduced motion drops the transition entirely — the panel still toggles, it
  // just does not animate.
  expect(await desc.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");

  await c.hover();
  await expect
    .poll(async () => desc.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("1");
});
