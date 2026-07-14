import { expect, test, type Page } from "@playwright/test";

// One connected journey through the core product loop:
// capture → breakdown rule → draw → complete → gamification feedback.
// Runs serially against one fresh database (see playwright.config.ts).
test.describe.configure({ mode: "serial" });

function section(page: Page, heading: string) {
  return page.locator("section").filter({ hasText: heading });
}

async function captureTask(page: Page, title: string, minutes: string) {
  await page.getByPlaceholder("What needs doing?").fill(title);
  await page.getByTitle("Effort estimate in minutes").fill(minutes);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  // The form clears once the mutation went through.
  await expect(page.getByPlaceholder("What needs doing?")).toHaveValue("");
}

test("capture: an oversized task lands in 'too big', a small one is ready", async ({ page }) => {
  await page.goto("/capture");

  await captureTask(page, "Prepare exam statistics", "90");
  await expect(
    section(page, "Too big — break these down").getByText("Prepare exam statistics"),
  ).toBeVisible();

  await captureTask(page, "Solve one past exam question", "20");
  await expect(
    section(page, "Ready to draw").getByText("Solve one past exam question"),
  ).toBeVisible();
});

test("breakdown: subtasks make the parent drawable ready work", async ({ page }) => {
  await page.goto("/tasks");
  // Scope to the oversized task's row — .first() would hit the newest task
  // (rows are ordered created_at DESC), not the one that needs breaking down.
  const parentRow = page.getByText("Prepare exam statistics").locator("..");
  await parentRow.getByRole("button", { name: "Break down" }).click();

  const rows = page.getByPlaceholder("Small, concrete step…");
  const minutes = page.getByPlaceholder("min");
  await rows.nth(0).fill("Open past paper, list topics");
  await minutes.nth(0).fill("15");
  await rows.nth(1).fill("Solve first two exercises");
  await minutes.nth(1).fill("25");
  await page.getByRole("button", { name: /Add 2 subtasks/ }).click();

  await expect(page.getByText("Open past paper, list topics")).toBeVisible();

  // The parent's minutes chip now shows the remaining work of its open
  // subtasks (15 + 25), not the stale stored 90-minute estimate.
  await expect(parentRow.locator(".chip", { hasText: "min" })).toHaveText("40 min");

  // Subtasks are now in the deck; the container parent is not.
  await page.goto("/capture");
  const ready = section(page, "Ready to draw");
  await expect(ready.getByText("Open past paper, list topics")).toBeVisible();
  await expect(ready.getByText("Prepare exam statistics")).not.toBeVisible();
});

test("draw and complete: card flips, XP and trophy deck react", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Lv 1")).toBeVisible();
  await expect(page.getByText("0 XP")).toBeVisible();

  await page.locator(".draw-face.front").click();
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
  await expect(page.locator(".draw-chance")).toContainText("in the deck");

  await page.getByRole("button", { name: "✓ Done" }).click();

  // Trophy deck appears with the completed card; XP is no longer 0
  await expect(page.getByText(/Today's pile — 1 done/)).toBeVisible();
  await expect(page.getByText("0 XP")).not.toBeVisible();

  // Achievement toasts for first draw + first completion
  await expect(page.getByText("🏆 Achievement unlocked").first()).toBeVisible();
});

test("timer: start now shows the timer bar across pages and reloads", async ({ page }) => {
  await page.goto("/");
  await page.locator(".draw-face.front").click();
  await page.getByRole("button", { name: "▶ Start now" }).click();

  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

  // Timer persists across navigation and reload
  await page.goto("/stats");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).not.toBeVisible();
});

test("stats: the leverage view renders with tracked data", async ({ page }) => {
  await page.goto("/stats");
  await expect(page.getByText("minutes tracked")).toBeVisible();
  await expect(page.getByText("tasks completed")).toBeVisible();
  await expect(page.getByText("Where your time went — by impact")).toBeVisible();
});
