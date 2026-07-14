import { expect, test } from "@playwright/test";

// Issue #12: completing a task stops its own running timer — the top-bar
// timer must disappear without a reload (query invalidation, not refetch
// interval). Runs after core-journey.spec.ts against the same database; it
// only creates and completes its own uniquely-named task.

test("completing a task from the tasks page removes the timer bar without reload", async ({
  page,
}) => {
  // Capture a fresh task so the test doesn't depend on core-journey's tasks.
  await page.goto("/capture");
  await page.getByPlaceholder("What needs doing?").fill("Fold the laundry");
  await page.getByTitle("Effort estimate in minutes").fill("10");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByPlaceholder("What needs doing?")).toHaveValue("");

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
  await page
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
});
