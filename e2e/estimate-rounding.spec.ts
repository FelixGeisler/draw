import { expect, test, type Page } from "@playwright/test";

// #84 (PR #85 review): decimal minutes typed into the flows that bypass the
// browser's form `step` validation — the capture page's Enter-keydown
// estimate input and the subtask editor's plain-button accept — used to go
// out as floats. The API's integer contract answered 400 and the failure
// vanished (neither path had error handling), leaving the task silently
// stuck. The client now rounds at the send boundary; this spec pins both
// flows end to end against the real server.

function section(page: Page, heading: string) {
  return page.locator("section").filter({ hasText: heading });
}

test("decimal estimates round at the send boundary instead of silently failing", async ({
  page,
}) => {
  await page.goto("/capture");

  // Captured without an estimate: the task waits in "Needs an estimate".
  await page.getByPlaceholder("What needs doing?").fill("Rounding probe task");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const needsRow = section(page, "Needs an estimate")
    .getByText("Rounding probe task")
    .locator("..");
  await expect(needsRow).toBeVisible();

  // The estimate input saves on Enter keydown — no form submit, no `step`
  // check. 90.7 must round to 91 (oversized on purpose: the probe must not
  // enter the deck that later spec files draw from).
  await needsRow.getByPlaceholder("min").fill("90.7");
  await needsRow.getByPlaceholder("min").press("Enter");
  const probeRow = section(page, "Too big").getByText("Rounding probe task").locator("..");
  await expect(probeRow.locator(".chip", { hasText: "min" })).toHaveText("91 min");

  // The subtask editor's accept is a plain button — same bypass: 20.4 → 20,
  // 10.6 → 11. The parent's remaining-effort chip proves what was stored.
  await page.goto("/tasks");
  const parentRow = page.getByText("Rounding probe task").locator("..");
  await parentRow.getByRole("button", { name: "Break down" }).click();
  const steps = page.getByPlaceholder("Small, concrete step…");
  const minutes = page.getByPlaceholder("min");
  await steps.nth(0).fill("First rounded step");
  await minutes.nth(0).fill("20.4");
  await steps.nth(1).fill("Second rounded step");
  await minutes.nth(1).fill("10.6");
  await page.getByRole("button", { name: /Add 2 subtasks/ }).click();
  await expect(page.getByText("First rounded step")).toBeVisible();
  await expect(parentRow.locator(".chip", { hasText: "min" })).toHaveText("31 min");

  // Leave no residue: the probe's steps are open 20/11-minute cards that
  // would otherwise join the deck later spec files draw from.
  const tasks = (await (await page.request.get("/api/tasks")).json()) as {
    id: number;
    title: string;
  }[];
  const probe = tasks.find((t) => t.title === "Rounding probe task")!;
  await page.request.delete(`/api/tasks/${probe.id}`);
});
