import { expect, test } from "@playwright/test";
import { captureForm, taskTree } from "./helpers.js";

// Issue #12: completing a task stops its own running timer — the top-bar
// timer must disappear without a reload (query invalidation, not refetch
// interval). Runs after core-journey.spec.ts against the same database; it
// only creates and completes its own uniquely-named task.

test("completing a task from the tasks page removes the timer bar without reload", async ({
  page,
}) => {
  // A category OF THIS SPEC'S OWN: the estimation assertions below must be
  // attributable to exactly this task's minutes — earlier serial specs
  // (history-skyline sorts first) also complete tracked tasks in the default
  // category, so a shared-category row could pass without this spec's entry
  // ever arriving. A unique category makes the row discriminating again.
  const SPEC_CATEGORY = "Timer spec laundry room";
  await page.request.post("/api/categories", {
    data: { name: SPEC_CATEGORY, color: "#8888ff" },
  });

  // Capture a fresh task so the test doesn't depend on core-journey's tasks.
  await page.goto("/tasks");
  const form = captureForm(page);
  await form.getByPlaceholder("What needs doing?").fill("Fold the laundry");
  await form.locator("select").first().selectOption({ label: SPEC_CATEGORY });
  await form.getByTitle("Effort estimate in minutes").fill("10");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form.getByPlaceholder("What needs doing?")).toHaveValue("");

  // Start its timer deterministically via the API (the draw page picks a
  // random card, and the tasks page has no per-task start button).
  const tasks: { id: number; title: string }[] = await (
    await page.request.get("/api/tasks")
  ).json();
  const task = tasks.find((t) => t.title === "Fold the laundry")!;
  expect(task).toBeTruthy();
  await page.request.post(`/api/tasks/${task.id}/timer/start`);

  await page.goto("/tasks");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();

  // Complete the task via its row checkbox — no reload afterwards. Plain
  // click: the controlled checkbox never turns checked, the row disappears
  // from the "open" filter instead, so .check()'s state assertion would fail.
  await taskTree(page)
    .getByText("Fold the laundry", { exact: true })
    .locator("..")
    .getByRole("checkbox")
    .click();

  // The timer bar disappears through invalidation of the timer query; the
  // 60s refetch interval could not explain this within the assertion timeout.
  await expect(stop).not.toBeVisible();
  await expect(page.getByText("Fold the laundry")).toHaveCount(0);

  // The server really closed the entry — not just a hidden bar.
  expect(await (await page.request.get("/api/timer/current")).json()).toBeNull();

  // #22: this task is now completed WITH an estimate and a time entry, so it
  // qualifies for "Estimates vs. reality". The per-task table is gone (#155):
  // the minutes surface through the summary ratio and the task's category
  // row instead — and the title must not appear anywhere in the section.
  await page.goto("/stats");
  const estimation = page.locator("section").filter({ hasText: "Estimates vs. reality" });
  // The summary panel is populated (no empty state): count + totals line.
  await expect(
    estimation.getByText(/\d+ tasks? · \d+ min estimated · \d+ min tracked/),
  ).toBeVisible();
  // The spec's own category carries a row: only THIS task lives in it, so
  // the row existing proves this task's estimate+minutes reached the block.
  await expect(estimation.getByText(SPEC_CATEGORY, { exact: true })).toBeVisible();
  await expect(estimation.getByText("Fold the laundry")).toHaveCount(0);
});
