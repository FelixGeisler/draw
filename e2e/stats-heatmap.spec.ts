import { expect, test } from "@playwright/test";

// Issue #54: the Stats page shows a contribution-style daily activity
// heatmap — 26 week columns, Monday-first weekday rows, one cell per local
// day, shaded by tracked minutes. Each cell carries the full day summary
// (date, minutes, completions, XP) in its aria-label and native title, and
// writes the same text into a visible readout line on hover/focus/tap.
// Runs against the shared serial E2E database; assertions never rely on
// exact counts of activity other specs may add to today. The file is named
// stats-heatmap (not activity-heatmap) so it sorts AFTER core-journey.spec.ts:
// the journey opens on a pristine header ("0 XP" exact) and this spec's
// seeded completion awards XP.
test.describe.configure({ mode: "serial" });

const TITLE = "Heatmap seeded errand";

test("a day seeded through the real API renders a cell whose accessible label carries minutes, completions and XP", async ({
  page,
}) => {
  // Real user flows only: task via POST, work via the timer routes,
  // completion via PATCH status done — no direct DB seeding.
  const request = page.request;
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  const task = await (
    await request.post("/api/tasks", {
      data: { title: TITLE, categoryId: categories[0].id, effortMinutes: 10 },
    })
  ).json();
  await request.post(`/api/tasks/${task.id}/timer/start`);
  await request.post("/api/timer/stop");
  await request.patch(`/api/tasks/${task.id}`, { data: { status: "done" } });

  await page.goto("/stats");

  // Today's cell, found by its formatted local date — built with the same
  // toLocaleDateString options in the same browser so the locale matches.
  const todayLabel = await page.evaluate(() =>
    new Date().toLocaleDateString([], {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
  );
  const cell = page.locator(`.hm-cell[aria-label^="${todayLabel}"]`);

  // The label carries all three metrics; at least the completion above must
  // be in it (other specs may add more — never assert exact counts).
  const escaped = todayLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await expect(cell).toHaveAttribute(
    "aria-label",
    new RegExp(`^${escaped}: \\d+ min tracked, [1-9]\\d* completed, \\+[1-9]\\d* XP$`),
  );
  // Hover reveal rides the native title — same text, so never hover-only.
  const label = await cell.getAttribute("aria-label");
  await expect(cell).toHaveAttribute("title", label!);

  // Keyboard reachable: focusing the cell writes its summary into the
  // visible readout line.
  await cell.focus();
  await expect(cell).toBeFocused();
  await expect(page.locator(".hm-readout")).toHaveText(label!);
});

test("the grid spans 26 Monday-first week columns with a 5-step legend", async ({ page }) => {
  await page.goto("/stats");

  // Layout facts, not data facts: the default range is fixed at 26 weeks.
  await expect(page.locator(".hm-week")).toHaveCount(26);

  // Monday-first weekday rows (TaskForm chip order) — Mon is the top label.
  await expect(page.locator(".hm-weekdays span").first()).toHaveText("Mon");

  // Legend: five swatches from level-0 (no activity) to level-4, and the
  // zero level is visually distinct — it carries a border, not a fill hue.
  for (let level = 0; level < 5; level++) {
    await expect(page.locator(`.hm-legend .hm-cell.level-${level}`)).toBeAttached();
  }
  const zero = page.locator(".hm-legend .hm-cell.level-0");
  const one = page.locator(".hm-legend .hm-cell.level-1");
  const bg = async (loc: typeof zero) =>
    loc.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg(zero)).not.toBe(await bg(one));

  // Hovering a mid-range cell updates the readout to that day.
  const someCell = page.locator(".hm-week .hm-cell:not(.placeholder)").first();
  await someCell.hover();
  const hovered = await someCell.getAttribute("aria-label");
  await expect(page.locator(".hm-readout")).toHaveText(hovered!);
});
