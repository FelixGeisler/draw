import { expect, test } from "@playwright/test";

// The weekly run report (#233, ADR-65): a recap card at the top of Stats,
// folded client-side from the same activity payload the History calendar
// reads. The fold's arithmetic is unit-tested against fixed dates; this pins
// the surface — the card renders for a week with activity and its numbers
// come from the payload, not from anywhere new.
test.describe.configure({ mode: "serial" });

const TASK = "Weekly report probe";

test("a week with activity renders the recap with payload-backed numbers", async ({ page }) => {
  const categories: { id: number }[] = await (await page.request.get("/api/categories")).json();
  const task = await (
    await page.request.post("/api/tasks", {
      data: { title: TASK, categoryId: categories[0].id, effortMinutes: 10 },
    })
  ).json();
  await page.request.patch(`/api/tasks/${task.id}`, { data: { status: "done" } });

  await page.goto("/stats");
  const report = page.getByTestId("weekly-report");
  await expect(report).toBeVisible();
  await expect(report.getByText("This week")).toBeVisible();

  // The "cards done" stat equals the activity payload's own fold for this
  // week — derived, never a second counter. At minimum the probe counts.
  const cardsDone = Number(
    await report.locator(".week-report-stat", { hasText: "cards done" }).locator(".week-report-num").innerText(),
  );
  expect(cardsDone).toBeGreaterThanOrEqual(1);

  // Cleanup: the probe leaves with its completion (trophy-pile geometry).
  await page.request.delete(`/api/tasks/${task.id}`);
});
