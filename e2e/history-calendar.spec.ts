import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

// Issue #174: the History contribution calendar — one tile per LOCAL day laid
// out in Monday-first week columns and shaded by activity intensity, the
// GitHub-heatmap successor to the house-of-cards skyline (#53). A day's tasks
// (completed with XP, worked-but-unfinished labelled) reveal on hover, keyboard
// focus and tap. Since #182 the detail is a FLOATING overlay anchored to the
// active tile — out of normal flow, so hovering across days reflows nothing
// below it (the Achievements grid stays put), and mounted outside the scroll box
// so it can't clip. Since #155 the view lives on the merged Stats page and
// /history is a redirect. Runs against the shared serial E2E database; every
// assertion scopes to this file's uniquely-titled cards or to today's single
// tile (never counts).
test.describe.configure({ mode: "serial" });

const DONE_TITLE = "Calendar card finished essay";
const OPEN_TITLE = "Calendar card abandoned chores";

// Cards must arise from the real user flows: timers via the timer routes,
// completions via PATCH status done — no direct DB seeding.
async function seedActivity(request: APIRequestContext) {
  const categories: { id: number; name: string }[] = await (
    await request.get("/api/categories")
  ).json();
  const done = await (
    await request.post("/api/tasks", {
      data: { title: DONE_TITLE, categoryId: categories[0].id, effortMinutes: 10 },
    })
  ).json();
  await request.post(`/api/tasks/${done.id}/timer/start`);
  await request.post("/api/timer/stop");
  await request.patch(`/api/tasks/${done.id}`, { data: { status: "done" } });

  const open = await (
    await request.post("/api/tasks", {
      data: { title: OPEN_TITLE, categoryId: categories[0].id, effortMinutes: 10 },
    })
  ).json();
  await request.post(`/api/tasks/${open.id}/timer/start`);
  await request.post("/api/timer/stop");
  return categories[0].name;
}

/** Today's tile — where every seeded card lands. Interactive once it has activity. */
function todayCell(page: Page) {
  return page.locator(".cal-cell.today");
}
function detail(page: Page) {
  return page.locator(".cal-detail");
}
/** The always-present footer hint — a constant-height stand-in for the floating detail. */
function hint(page: Page) {
  return page.locator(".cal-hint");
}
/** The Achievements section heading — the thing that used to jump when the detail reflowed. */
function achievementsHeading(page: Page) {
  return page.getByRole("heading", { name: /^Achievements/ });
}

test("/history redirects to the merged Stats page; the nav entry is gone", async ({ page }) => {
  await page.goto("/history");
  await page.waitForURL("**/stats");
  // The calendar section is really there — heading plus its Load earlier
  // control — and History no longer exists as a nav destination.
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await expect(page.getByRole("button", { name: "← Load earlier" })).toBeVisible();
  await expect(page.locator(".sidenav a", { hasText: "History" })).toHaveCount(0);
});

test("today's tile reveals its tasks — completed with XP, unfinished labelled — on hover, without reflow", async ({
  page,
}) => {
  const categoryName = await seedActivity(page.request);
  await page.goto("/");
  await page.getByRole("link", { name: "Stats" }).click();

  const cell = todayCell(page);
  // Today has activity, so its tile is an interactive button.
  await expect(cell).toBeVisible();
  await expect(cell).toHaveAttribute("role", "button");

  // Collapsed: the floating detail is not mounted; only the static footer hint.
  await expect(detail(page)).toHaveCount(0);
  await expect(hint(page)).toBeVisible();

  // Revealing the detail must reflow NOTHING below the calendar — the detail
  // floats out of flow (#182). Scroll the calendar into view first so
  // boundingBox() (viewport-relative) is comparable across the hover, then pin
  // the Achievements heading's box as the reflow witness.
  await cell.scrollIntoViewIfNeeded();
  const grid = page.locator(".cal-grid");
  await expect(achievementsHeading(page)).toBeVisible();
  const gridBefore = await grid.boundingBox();
  const achBefore = await achievementsHeading(page).boundingBox();

  await cell.hover();
  await expect(detail(page)).toBeVisible();
  // The live region is preserved for keyboard / screen-reader users.
  await expect(detail(page)).toHaveAttribute("role", "status");
  await expect(detail(page)).toContainText(DONE_TITLE);
  await expect(detail(page)).toContainText(categoryName);
  await expect(detail(page)).toContainText("+10 XP"); // 10 min × impact 3/3, not drawn
  // The worked-but-unfinished card is named and marked, without XP on its line.
  await expect(detail(page)).toContainText(OPEN_TITLE);
  const openLine = detail(page).locator(".cal-detail-card", { hasText: OPEN_TITLE });
  await expect(openLine).toContainText("not completed");
  await expect(openLine).not.toContainText("XP");

  // The active tile lifts via transform + z-index only (retries settle the
  // transition); NOTHING moves: the grid AND the Achievements grid below keep
  // their exact boxes across the hover.
  await expect(cell).toHaveCSS("z-index", "2");
  expect(await grid.boundingBox()).toEqual(gridBefore);
  expect(await achievementsHeading(page).boundingBox()).toEqual(achBefore);

  // The detail floats free of the horizontally-scrolling grid (so the scroll box
  // can never clip it) and stays inside the viewport.
  const clippedByScroll = await detail(page).evaluate((el) => el.closest(".cal-scroll") !== null);
  expect(clippedByScroll).toBe(false);
  await expect(detail(page)).toBeInViewport();
});

test("keyboard focus reveals and Escape lowers; tap toggles; outside tap lowers", async ({
  page,
}) => {
  await page.goto("/stats");

  const cell = todayCell(page);
  // Keyboard focus reveals the day, Escape lowers it (and drops focus). The
  // floating detail mounts on reveal and unmounts on lower.
  await cell.focus();
  await expect(detail(page)).toBeVisible();
  await expect(detail(page)).toContainText(DONE_TITLE);
  await page.keyboard.press("Escape");
  await expect(detail(page)).toHaveCount(0);

  // Tap toggles a sticky pin — park the mouse after each click so no hover
  // keeps the panel open on its own.
  await cell.click();
  await page.mouse.move(0, 0);
  await expect(detail(page)).toBeVisible();
  await expect(cell).toHaveAttribute("aria-pressed", "true");

  await cell.click();
  await page.mouse.move(0, 0);
  await expect(detail(page)).toHaveCount(0);
  await expect(cell).toHaveAttribute("aria-pressed", "false");

  // Pinned again, a tap outside any tile lowers it.
  await cell.click();
  await page.mouse.move(0, 0);
  await expect(detail(page)).toBeVisible();
  await page.locator("h1").click();
  await expect(detail(page)).toHaveCount(0);
});

test("today's tile is in view, and prefers-reduced-motion drops the tile transition", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/stats");

  const cell = todayCell(page);
  // The tile transition lives behind no-preference, so reduced motion stills it.
  await expect(cell).toHaveCSS("transition-duration", "0s");

  // The calendar opens at its most-recent end: today's tile is reachable.
  await cell.hover();
  await expect(detail(page)).toBeVisible();
  await expect(cell).toBeInViewport();
  // The detail's fade also lives behind no-preference, so it is stilled too.
  await expect(detail(page)).toHaveCSS("animation-duration", "0s");
});

// Seed enough completed cards on today that, in a short viewport, the detail
// list would overflow the viewport if its height were uncapped (#182 review:
// "never clipped by the viewport edge"). Each completed task is one list line.
async function seedManyDone(request: APIRequestContext, n: number) {
  const categories: { id: number; name: string }[] = await (
    await request.get("/api/categories")
  ).json();
  for (let i = 0; i < n; i++) {
    const t = await (
      await request.post("/api/tasks", {
        data: { title: `Calendar busy day card ${i}`, categoryId: categories[0].id, effortMinutes: 5 },
      })
    ).json();
    await request.patch(`/api/tasks/${t.id}`, { data: { status: "done" } });
  }
}

test("a busy day's detail stays inside the viewport — the height is capped, not clipped off the bottom", async ({
  page,
}) => {
  // A short viewport so the capped max-height (min(70vh, 420px)) actually bites;
  // with ~20 completed cards the uncapped panel would be far taller than 70vh.
  await page.setViewportSize({ width: 960, height: 400 });
  await seedManyDone(page.request, 20);
  await page.goto("/stats");

  const cell = todayCell(page);
  await cell.hover();
  const panel = detail(page);
  await expect(panel).toBeVisible();

  const box = await panel.boundingBox();
  const vh = page.viewportSize()!.height;
  // The whole panel is on-screen: top not above the fold, bottom not past it.
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vh + 1);
  // And the cap is what keeps it there — never taller than the viewport allows.
  expect(box!.height).toBeLessThanOrEqual(Math.min(vh * 0.7, 420) + 2);
  await expect(panel).toBeInViewport();
});
