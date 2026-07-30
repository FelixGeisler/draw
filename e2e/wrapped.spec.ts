import { expect, test } from "@playwright/test";

// Draw Wrapped (#234, ADR-66): the year panel at the bottom of Stats. The
// fold's arithmetic is unit-tested against fixed dates; this pins the
// surface — teaser → unwrap → payload-backed numbers → a real PNG download.
test.describe.configure({ mode: "serial" });

const TASK = "Wrapped probe";

test("the year panel unwraps with payload-backed numbers and downloads a PNG", async ({ page }) => {
  const categories: { id: number }[] = await (await page.request.get("/api/categories")).json();
  const task = await (
    await page.request.post("/api/tasks", {
      data: { title: TASK, categoryId: categories[0].id, effortMinutes: 10 },
    })
  ).json();
  await page.request.patch(`/api/tasks/${task.id}`, { data: { status: "done" } });

  await page.goto("/stats");
  const wrapped = page.getByTestId("wrapped");
  await expect(wrapped).toBeVisible();
  await expect(wrapped.getByText("Your year")).toBeVisible();

  // Teaser first — the mountain stays hidden until asked for.
  await wrapped.getByTestId("wrapped-open").click();
  const cardsLine = wrapped.locator("li", { hasText: "cards completed" });
  await expect(cardsLine).toBeVisible();
  const cards = Number(await cardsLine.locator("strong").innerText());
  expect(cards).toBeGreaterThanOrEqual(1);

  // The PNG is a real local download named for the year.
  const year = new Date().getFullYear();
  const downloadPromise = page.waitForEvent("download");
  await wrapped.getByTestId("wrapped-download").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`draw-wrapped-${year}.png`);

  // Cleanup: the probe leaves with its completion (trophy-pile geometry).
  await page.request.delete(`/api/tasks/${task.id}`);
});
