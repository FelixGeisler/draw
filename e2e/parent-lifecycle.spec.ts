import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

// Issue #111 (ADR-32): the happy parent lifecycle on the Tasks page — break a
// task down, complete every subtask from the UI, watch the parent flip to
// done WITHOUT manual action, add a new subtask, watch the parent reopen,
// complete it, watch it flip done again. Shares the serial E2E database, so
// every assertion scopes by this file's unique titles.
test.describe.configure({ mode: "serial" });

const PARENT_TITLE = "Publish the lifecycle zine";
const STEP_ONE = "Write the lifecycle articles";
const STEP_TWO = "Lay out the lifecycle pages";
const STEP_THREE = "Print the lifecycle copies";

async function seed(request: APIRequestContext) {
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  await request.post("/api/tasks", {
    data: { title: PARENT_TITLE, categoryId: categories[0].id, effortMinutes: 60 },
  });
}

function taskRow(page: Page, title: string) {
  return page.getByText(title, { exact: true }).locator("..");
}

// Plain click, not .check(): the controlled checkbox only turns checked after
// the mutation round-trip (same pattern as sequential-subtasks.spec.ts).
async function completeFromRow(page: Page, title: string) {
  const row = taskRow(page, title);
  await row.getByRole("checkbox").click();
  await expect(row.getByRole("checkbox")).toBeChecked();
}

test("completing the last subtask flips the parent to done without manual action", async ({
  page,
}) => {
  await seed(page.request);
  await page.goto("/tasks");

  // Break the parent down into two steps from the UI.
  await taskRow(page, PARENT_TITLE).getByRole("button", { name: "Break down" }).click();
  const rows = page.getByPlaceholder("Small, concrete step…");
  const minutes = page.getByPlaceholder("min");
  await rows.nth(0).fill(STEP_ONE);
  await minutes.nth(0).fill("15");
  await rows.nth(1).fill(STEP_TWO);
  await minutes.nth(1).fill("15");
  await page.getByRole("button", { name: /Add 2 subtasks/ }).click();
  await expect(taskRow(page, STEP_ONE)).toBeVisible();

  // Keep done rows visible — the auto-completed parent must stay assertable.
  await page.getByLabel("show done").check();

  await completeFromRow(page, STEP_ONE);
  // One open step left: the parent is still open.
  await expect(taskRow(page, PARENT_TITLE).getByRole("checkbox")).not.toBeChecked();

  await completeFromRow(page, STEP_TWO);
  // The last subtask completed the parent server-side; the invalidated tasks
  // query repaints the row as done with no click on the parent itself.
  await expect(taskRow(page, PARENT_TITLE).getByRole("checkbox")).toBeChecked();

  // The auto-completion is a genuine completion row: it lands in today's
  // trophy pile as a plain mini-frame (wasDrawn 0 → ✅ glyph, no rarity) with
  // the symbolic +1 XP — the frame's degraded states render it sanely.
  await page.goto("/");
  const trophy = page.locator(".trophy-card", { hasText: PARENT_TITLE });
  await expect(trophy).toBeVisible();
  await expect(trophy.locator(".trophy-card-xp")).toHaveText("+1");
  await expect(trophy.locator(".trophy-card-glyph")).toHaveText("✅");
});

test("adding a new subtask reopens the done parent; completing it closes the loop", async ({
  page,
}) => {
  await page.goto("/tasks");
  await page.getByLabel("show done").check();
  await expect(taskRow(page, PARENT_TITLE).getByRole("checkbox")).toBeChecked();

  // A done root offers no Break down button — reopening is the lifecycle's
  // job: add the new step through the API (MCP create_subtasks path) and
  // watch the page reflect the reopen.
  const tasks: { id: number; title: string }[] = await (
    await page.request.get("/api/tasks?status=all")
  ).json();
  const parent = tasks.find((t) => t.title === PARENT_TITLE)!;
  await page.request.post(`/api/tasks/${parent.id}/subtasks`, {
    data: { subtasks: [{ title: STEP_THREE, effortMinutes: 10 }] },
  });

  await page.goto("/tasks");
  await page.getByLabel("show done").check();
  // The parent reopened server-side: unchecked again, new step underneath.
  await expect(taskRow(page, PARENT_TITLE).getByRole("checkbox")).not.toBeChecked();
  await expect(taskRow(page, STEP_THREE)).toBeVisible();

  // Completing the late arrival flips the parent to done once more.
  await completeFromRow(page, STEP_THREE);
  await expect(taskRow(page, PARENT_TITLE).getByRole("checkbox")).toBeChecked();
});
