import { expect, test } from "@playwright/test";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

// Issue #40: the trophy pile is browsable — hovering, focusing, or tapping a
// pile card lifts it above its siblings and reveals the full details (title,
// category, completion time, XP). Runs last against the shared serial E2E
// database; earlier specs may have left their own completions in the pile, so
// every assertion scopes to this file's uniquely-titled cards (never counts).
test.describe.configure({ mode: "serial" });

const TITLES = [
  "Trophy pile alpha card",
  "Trophy pile beta card with a much longer title that the collapsed card clamps away",
  "Trophy pile gamma card",
];

let categoryName: string;

// Completions must flow through the real completion path (PATCH status done),
// like a user would produce them — no direct DB seeding.
async function seedCompletions(request: APIRequestContext) {
  const categories: { id: number; name: string }[] = await (
    await request.get("/api/categories")
  ).json();
  for (const title of TITLES) {
    const task = await (
      await request.post("/api/tasks", {
        data: { title, categoryId: categories[0].id, effortMinutes: 10 },
      })
    ).json();
    await request.patch(`/api/tasks/${task.id}`, { data: { status: "done" } });
  }
  return categories[0].name;
}

function card(page: Page, title: string) {
  return page.locator(".trophy-card", { hasText: title });
}

test("hover lifts a middle pile card and reveals its full details", async ({ page }) => {
  categoryName = await seedCompletions(page.request);
  await page.goto("/");

  const middle = card(page, TITLES[1]);
  const details = middle.locator(".trophy-details");
  const title = middle.locator(".trophy-card-title");

  // Collapsed: details hidden, long title clamped.
  await expect(details).toBeHidden();
  await expect(title).toHaveCSS("-webkit-line-clamp", "4");

  // The lift must not reflow the pile: a sibling's box stays put. Scroll the
  // pile into view FIRST — boundingBox() is viewport-relative, and hover()'s
  // auto-scroll would otherwise shift every box between the two snapshots.
  await middle.scrollIntoViewIfNeeded();
  const sibling = card(page, TITLES[2]);
  const before = await sibling.boundingBox();

  await middle.hover();
  await expect(details).toBeVisible();
  await expect(details).toContainText(categoryName);
  await expect(details).toContainText(/\d{1,2}:\d{2}/); // completion time
  await expect(middle).toContainText("+10"); // 10 min × impact 3/3, not drawn
  await expect(title).toHaveCSS("-webkit-line-clamp", "none"); // full title

  // The lift itself: raised above siblings (explicit z-index — each card's
  // rotation makes it a stacking context) and scaled up, rotation zeroed.
  // toHaveCSS retries, so the 0.18s transition settles before this passes.
  await expect(middle).toHaveCSS("z-index", "30");
  await expect(middle).toHaveCSS("transform", "matrix(1.5, 0, 0, 1.5, 0, -26)");

  expect(await sibling.boundingBox()).toEqual(before);
});

test("keyboard: tabbing to a card lifts it, Escape lowers it", async ({ page }) => {
  await page.goto("/");

  // A real Tab keypress from the neighboring card guarantees the
  // :focus-visible heuristic treats the focus as keyboard-driven.
  await card(page, TITLES[0]).focus();
  await page.keyboard.press("Tab");

  const focused = card(page, TITLES[1]);
  await expect(focused).toBeFocused();
  await expect(focused.locator(".trophy-details")).toBeVisible();
  await expect(focused.locator(".trophy-details")).toContainText(categoryName);

  await page.keyboard.press("Escape");
  await expect(focused.locator(".trophy-details")).toBeHidden();
});

test("click toggles the lift; clicking elsewhere lowers it", async ({ page }) => {
  await page.goto("/");
  const gamma = card(page, TITLES[2]);
  const details = gamma.locator(".trophy-details");

  // Lift sticks without hover — park the mouse away after each click.
  await gamma.click();
  await page.mouse.move(0, 0);
  await expect(details).toBeVisible();

  // Second click on the same card toggles it back down.
  await gamma.click();
  await page.mouse.move(0, 0);
  await expect(details).toBeHidden();

  // Lifted again, a click outside the pile lowers it.
  await gamma.click();
  await page.mouse.move(0, 0);
  await expect(details).toBeVisible();
  await page.locator("h1").click();
  await expect(details).toBeHidden();
});

test("a lifted card paints above its overlap neighbor at both pile ends", async ({ page }) => {
  await page.goto("/");
  const cards = page.locator(".trophy-card");
  const count = await cards.count();
  expect(count).toBeGreaterThanOrEqual(2);

  // Each card rotates, so each is its own stacking context — this is exactly
  // the case where a missing z-index would leave the first card painted UNDER
  // its neighbor even while lifted. Probe real paint order via elementFromPoint
  // in the region where the two cards' boxes overlap.
  async function assertPaintsAbove(lifted: Locator, neighbor: Locator) {
    await lifted.click(); // sticky lift, independent of the mouse position
    await page.mouse.move(0, 0);
    const lb = (await lifted.boundingBox())!;
    const nb = (await neighbor.boundingBox())!;
    const x = (Math.max(lb.x, nb.x) + Math.min(lb.x + lb.width, nb.x + nb.width)) / 2;
    const y = (Math.max(lb.y, nb.y) + Math.min(lb.y + lb.height, nb.y + nb.height)) / 2;
    const isTop = await lifted.evaluate((el, pt) => {
      const hit = document.elementFromPoint(pt.x, pt.y);
      return hit !== null && (el === hit || el.contains(hit));
    }, { x, y });
    expect(isTop).toBe(true);
  }

  await assertPaintsAbove(cards.first(), cards.nth(1));
  await assertPaintsAbove(cards.last(), cards.nth(count - 2));
});

test("prefers-reduced-motion keeps the lift but drops the transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const alpha = card(page, TITLES[0]);
  await expect(alpha).toHaveCSS("transition-duration", "0s");
  await alpha.hover();
  await expect(alpha.locator(".trophy-details")).toBeVisible();
});
