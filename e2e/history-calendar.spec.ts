import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

// Issue #174: the History contribution calendar — one tile per LOCAL day laid
// out in Monday-first week columns and shaded by activity intensity, the
// GitHub-heatmap successor to the house-of-cards skyline (#53). A day's tasks
// (completed with XP, worked-but-unfinished labelled) reveal in a docked detail
// panel on hover, keyboard focus and tap. Since #155 the view lives on the
// merged Stats page and /history is a redirect. Runs against the shared serial
// E2E database; every assertion scopes to this file's uniquely-titled cards or
// to today's single tile (never counts).
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

  // Collapsed: the docked detail shows its idle hint, not a day.
  await expect(detail(page)).toHaveClass(/idle/);

  // Revealing the detail must not reflow the grid — it docks BELOW it. Scroll
  // first so boundingBox() (viewport-relative) is comparable across the hover.
  await cell.scrollIntoViewIfNeeded();
  const grid = page.locator(".cal-grid");
  const before = await grid.boundingBox();

  await cell.hover();
  await expect(detail(page)).not.toHaveClass(/idle/);
  await expect(detail(page)).toContainText(DONE_TITLE);
  await expect(detail(page)).toContainText(categoryName);
  await expect(detail(page)).toContainText("+10 XP"); // 10 min × impact 3/3, not drawn
  // The worked-but-unfinished card is named and marked, without XP on its line.
  await expect(detail(page)).toContainText(OPEN_TITLE);
  const openLine = detail(page).locator(".cal-detail-card", { hasText: OPEN_TITLE });
  await expect(openLine).toContainText("not completed");
  await expect(openLine).not.toContainText("XP");

  // The active tile lifts via transform + z-index only (retries settle the
  // transition), and the grid's own box is unmoved.
  await expect(cell).toHaveCSS("z-index", "2");
  expect(await grid.boundingBox()).toEqual(before);
});

test("keyboard focus reveals and Escape lowers; tap toggles; outside tap lowers", async ({
  page,
}) => {
  await page.goto("/stats");

  const cell = todayCell(page);
  // Keyboard focus reveals the day, Escape lowers it (and drops focus).
  await cell.focus();
  await expect(detail(page)).not.toHaveClass(/idle/);
  await expect(detail(page)).toContainText(DONE_TITLE);
  await page.keyboard.press("Escape");
  await expect(detail(page)).toHaveClass(/idle/);

  // Tap toggles a sticky pin — park the mouse after each click so no hover
  // keeps the panel open on its own.
  await cell.click();
  await page.mouse.move(0, 0);
  await expect(detail(page)).not.toHaveClass(/idle/);
  await expect(cell).toHaveAttribute("aria-pressed", "true");

  await cell.click();
  await page.mouse.move(0, 0);
  await expect(detail(page)).toHaveClass(/idle/);
  await expect(cell).toHaveAttribute("aria-pressed", "false");

  // Pinned again, a tap outside any tile lowers it.
  await cell.click();
  await page.mouse.move(0, 0);
  await expect(detail(page)).not.toHaveClass(/idle/);
  await page.locator("h1").click();
  await expect(detail(page)).toHaveClass(/idle/);
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
  await expect(detail(page)).not.toHaveClass(/idle/);
  await expect(cell).toBeInViewport();
});
