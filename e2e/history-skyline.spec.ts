import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

// Issue #53: the house-of-cards skyline — one tower per local day, upright
// cards for completions, face-down cards for tasks worked on but not
// finished. Hover, keyboard focus, and tap lift a card and reveal its
// details (trophy-pile interaction, PR #47). Since #155 the skyline lives on
// the merged Stats page and /history is a redirect — same assertions, new
// address. Runs against the shared serial E2E database; every assertion
// scopes to this file's uniquely-titled cards (never counts).
test.describe.configure({ mode: "serial" });

const DONE_TITLE = "Skyline card finished essay";
const OPEN_TITLE = "Skyline card abandoned chores";

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

function card(page: Page, title: string) {
  // The resting card face carries no text — the title lives in the
  // aria-label (and the hidden details panel), so scope by the label.
  return page.locator(`.hoc-card[aria-label*="${title}"]`);
}

test("/history redirects to the merged Stats page; the nav entry is gone", async ({ page }) => {
  await page.goto("/history");
  await page.waitForURL("**/stats");
  // The skyline section is really there — heading plus its Load earlier
  // control — and History no longer exists as a nav destination.
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await expect(page.getByRole("button", { name: "← Load earlier" })).toBeVisible();
  await expect(page.locator(".sidenav a", { hasText: "History" })).toHaveCount(0);
});

test("today's tower: upright for completed, face-down for started-only; hover reveals details without reflow", async ({
  page,
}) => {
  const categoryName = await seedActivity(page.request);
  await page.goto("/");
  await page.getByRole("link", { name: "Stats" }).click();

  const done = card(page, DONE_TITLE);
  const open = card(page, OPEN_TITLE);

  // Upright vs face-down derivation, straight from the classes that style
  // the card face (category color vs neutral card back).
  await expect(done).toHaveClass(/completed/);
  await expect(open).toHaveClass(/face-down/);

  // Collapsed: the details panel is hidden.
  const details = done.locator(".hoc-details");
  await expect(details).toBeHidden();

  // The lift must not reflow the tower: the sibling card's box stays put.
  // Scroll first — boundingBox() is viewport-relative and hover()'s
  // auto-scroll would otherwise shift every box between the two snapshots.
  await done.scrollIntoViewIfNeeded();
  const before = await open.boundingBox();

  await done.hover();
  await expect(details).toBeVisible();
  await expect(details).toContainText(DONE_TITLE);
  await expect(details).toContainText(categoryName);
  await expect(details).toContainText(/\d+ min tracked/);
  await expect(details).toContainText("+10 XP"); // 10 min × impact 3/3, not drawn

  // The lift itself: transform + explicit z-index only. toHaveCSS retries,
  // so the 0.18s transition settles before this passes.
  await expect(done).toHaveCSS("z-index", "30");
  await expect(done).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, -6)");

  expect(await open.boundingBox()).toEqual(before);

  // The face-down card says so instead of showing XP.
  await open.hover();
  await expect(open.locator(".hoc-details")).toContainText("not completed this day");
  await expect(open.locator(".hoc-details")).not.toContainText("XP");
});

test("keyboard focus lifts with Escape lowering; tap toggles; outside tap lowers", async ({
  page,
}) => {
  await page.goto("/stats");

  // A real Tab keypress from the neighboring card guarantees the
  // :focus-visible heuristic treats the focus as keyboard-driven. Today's
  // tower stacks in start order: DONE_TITLE was started first.
  await card(page, DONE_TITLE).focus();
  await page.keyboard.press("Tab");

  const focused = card(page, OPEN_TITLE);
  await expect(focused).toBeFocused();
  await expect(focused.locator(".hoc-details")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(focused.locator(".hoc-details")).toBeHidden();

  // Tap/click toggle — sticky without hover, so park the mouse after clicks.
  const done = card(page, DONE_TITLE);
  const details = done.locator(".hoc-details");
  await done.click();
  await page.mouse.move(0, 0);
  await expect(details).toBeVisible();
  await expect(done).toHaveAttribute("aria-pressed", "true");

  await done.click();
  await page.mouse.move(0, 0);
  await expect(details).toBeHidden();

  // Lifted again, a tap outside the skyline lowers it.
  await done.click();
  await page.mouse.move(0, 0);
  await expect(details).toBeVisible();
  await page.locator("h1").click();
  await expect(details).toBeHidden();
});

test("axis marks today, and prefers-reduced-motion drops the lift transition", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/stats");

  const open = card(page, OPEN_TITLE);
  await expect(open).toHaveCSS("transition-duration", "0s");
  await open.hover();
  await expect(open.locator(".hoc-details")).toBeVisible();

  // The skyline opens scrolled to its right end: today's labelled axis tick.
  await expect(page.locator(".hoc-day.today .hoc-axis")).toBeInViewport();
  await expect(page.locator(".hoc-day.today .hoc-axis")).toHaveText("today");
});
