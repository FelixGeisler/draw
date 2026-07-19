import { expect, test, type Page } from "@playwright/test";
import { captureForm, subtaskEditor, taskTree, triageStrip } from "./helpers.js";

// One connected journey through the core product loop, all on the merged
// Tasks page (#151): capture → triage (breakdown rule) → draw → complete →
// gamification feedback. Runs serially against one fresh database (see
// playwright.config.ts).
test.describe.configure({ mode: "serial" });

function stripSection(page: Page, heading: string) {
  return triageStrip(page).locator("section").filter({ hasText: heading });
}

async function captureTask(page: Page, title: string, minutes: string) {
  const form = captureForm(page);
  await form.getByPlaceholder("What needs doing?").fill(title);
  await form.getByTitle("Effort estimate in minutes").fill(minutes);
  await form.getByRole("button", { name: "Add", exact: true }).click();
  // The form clears once the mutation went through.
  await expect(form.getByPlaceholder("What needs doing?")).toHaveValue("");
}

test("capture: an oversized task lands in the too-big strip, a small one goes straight to its category", async ({
  page,
}) => {
  await page.goto("/tasks");

  await captureTask(page, "Prepare exam statistics", "90");
  await expect(
    stripSection(page, "Too big — break these down").getByText("Prepare exam statistics"),
  ).toBeVisible();

  // A drawable-sized capture needs no triage: no strip row, only the
  // category group below — ready is the badge-less default, not a section.
  await captureTask(page, "Solve one past exam question", "20");
  await expect(taskTree(page).getByText("Solve one past exam question")).toBeVisible();
  await expect(triageStrip(page).getByText("Solve one past exam question")).toHaveCount(0);
});

test("breakdown from the strip: subtasks make the parent drawable ready work", async ({ page }) => {
  await page.goto("/tasks");
  // The too-big strip row carries Break down in place — the seam the merge
  // closed (#151): the triage verdict and the prescribed action share a row.
  const stripRow = stripSection(page, "Too big — break these down")
    .getByText("Prepare exam statistics")
    .locator("..");
  await stripRow.getByRole("button", { name: "Break down" }).click();

  const editor = subtaskEditor(page);
  const rows = editor.getByPlaceholder("Small, concrete step…");
  const minutes = editor.getByPlaceholder("min");
  await rows.nth(0).fill("Open past paper, list topics");
  await minutes.nth(0).fill("15");
  await rows.nth(1).fill("Solve first two exercises");
  await minutes.nth(1).fill("25");
  await editor.getByRole("button", { name: /Add 2 subtasks/ }).click();

  // The parent became a container: it leaves the triage strip entirely, and
  // its tree row shows the remaining work of its open subtasks (15 + 25),
  // not the stale stored 90-minute estimate.
  await expect(triageStrip(page).getByText("Prepare exam statistics")).toHaveCount(0);
  const parentRow = taskTree(page).getByText("Prepare exam statistics").locator("..");
  await expect(parentRow.locator(".chip", { hasText: "min" })).toHaveText("40 min");

  // The drawable subtasks nest under their parent in the category tree.
  await expect(taskTree(page).getByText("Open past paper, list topics")).toBeVisible();
  await expect(taskTree(page).getByText("Solve first two exercises")).toBeVisible();
});

test("draw and complete: card flips, XP and trophy deck react", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Lv 1")).toBeVisible();
  // exact: substring matching would collide with awards ending in 0 — a
  // 20-min impact-3 drawn card pays 30 XP, and "0 XP" is inside "30 XP".
  await expect(page.getByText("0 XP", { exact: true })).toBeVisible();

  await page.locator(".draw-face.front").click();
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
  await expect(page.locator(".draw-chance")).toContainText("in the deck");

  await page.getByRole("button", { name: "✓ Done" }).click();

  // Trophy deck appears with the completed card; XP is no longer 0
  await expect(page.getByText(/Today's pile — 1 done/)).toBeVisible();
  await expect(page.getByText("0 XP", { exact: true })).not.toBeVisible();

  // Achievement toasts for first draw + first completion
  await expect(page.getByText("🏆 Achievement unlocked").first()).toBeVisible();
});

test("timer: start now shows the timer bar across pages and reloads", async ({ page }) => {
  await page.goto("/");
  await page.locator(".draw-face.front").click();
  await page.getByRole("button", { name: "▶ Start now" }).click();

  // #56: Start now drops into fullscreen focus. Escape exits the VIEW only —
  // the timer keeps running, which is exactly what this journey asserts.
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");

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

  // #22: the estimation section renders; the journey's only completed task
  // was never timed, so it must show the empty state, not a fake 0× ratio.
  await expect(page.getByText("Estimates vs. reality")).toBeVisible();
  await expect(page.getByText(/No completed task in this range/)).toBeVisible();

  // #155: the skyline is the merged page's activity view — the journey's
  // completion and the timed-but-unfinished card both stand in today's tower.
  await expect(page.locator(".hoc-day.today .hoc-card").first()).toBeVisible();
});
