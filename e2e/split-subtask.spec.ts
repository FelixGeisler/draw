import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { subtaskEditor, taskTree } from "./helpers.js";

// Issue #108: a subtask above max_draw_effort used to dead-end — Break down
// only exists on root rows and nesting is banned (ADR-16). Split-in-place
// replaces the too-big step with its parts as siblings at the same level:
// break a root down into steps where one is too big, split that step, then
// complete the parts and watch the parent auto-complete (#111, ADR-32) —
// the archived original never blocks it.
test.describe.configure({ mode: "serial" });

const PARENT_TITLE = "Publish the woodworking course";
const BIG_STEP = "Record all lecture videos";
const SMALL_STEP = "Upload the course assets";
const PART_ONE = `${BIG_STEP} (part 1/2)`;
const PART_TWO = `${BIG_STEP} (part 2/2)`;

async function seed(request: APIRequestContext) {
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  await request.post("/api/tasks", {
    data: { title: PARENT_TITLE, categoryId: categories[0].id, effortMinutes: 60 },
  });
}

function taskRow(page: Page, title: string) {
  // exact: part titles contain the original title as a prefix. Tree-scoped
  // (#151): the too-big root and its too-big step also sit in the triage
  // strip — an unscoped title lookup would go ambiguous.
  return taskTree(page).getByText(title, { exact: true }).locator("..");
}

test("a too-big subtask offers Split with the even-split pre-fill; accepting replaces it in place", async ({
  page,
}) => {
  await seed(page.request);

  // Break the root down: one step over the default 30-minute draw limit.
  await page.goto("/tasks");
  await taskRow(page, PARENT_TITLE).getByRole("button", { name: "Break down" }).click();
  const titles = subtaskEditor(page).getByPlaceholder("Small, concrete step…");
  const minutes = subtaskEditor(page).getByPlaceholder("min");
  await titles.nth(0).fill(BIG_STEP);
  await minutes.nth(0).fill("45");
  await titles.nth(1).fill(SMALL_STEP);
  await minutes.nth(1).fill("15");
  await page.getByRole("button", { name: /Add 2 subtasks/ }).click();

  // Only the too-big subtask row offers Split; the root keeps Break down,
  // the drawable-sized sibling gets neither.
  await expect(taskRow(page, BIG_STEP).getByRole("button", { name: "Split" })).toBeVisible();
  await expect(
    taskRow(page, PARENT_TITLE).getByRole("button", { name: "Break down" }),
  ).toBeVisible();
  await expect(taskRow(page, SMALL_STEP).getByRole("button", { name: "Split" })).not.toBeVisible();

  // The editor opens pre-filled with the deterministic even split (45 → 23+22)
  // and no "Do in order" toggle — parts join the parent's existing mode.
  await taskRow(page, BIG_STEP).getByRole("button", { name: "Split" }).click();
  await expect(titles.nth(0)).toHaveValue(PART_ONE);
  await expect(minutes.nth(0)).toHaveValue("23");
  await expect(titles.nth(1)).toHaveValue(PART_TWO);
  await expect(minutes.nth(1)).toHaveValue("22");
  await expect(page.getByLabel(/Do in order/)).not.toBeVisible();
  await page.getByRole("button", { name: "Split into 2 parts" }).click();

  // The row disappears and its parts render in place as siblings. Count, not
  // visibility (#151): the too-big step rendered in BOTH the strip and the
  // tree, so a not-visible check would trip strict mode mid-refetch instead
  // of waiting for both copies to go.
  await expect(page.getByText(BIG_STEP, { exact: true })).toHaveCount(0);
  await expect(taskRow(page, PART_ONE)).toBeVisible();
  await expect(taskRow(page, PART_TWO)).toBeVisible();
  await expect(taskRow(page, SMALL_STEP)).toBeVisible();
});

test("completing the parts auto-completes the parent — the archived original never blocks it", async ({
  page,
}) => {
  await page.goto("/tasks");
  // Keep done rows on screen: the last completion cascades to the parent
  // (#111, ADR-32) and would otherwise unmount the whole tree from the
  // open-only list mid-assertion.
  await page.getByLabel("show done").check();

  // Plain click, not check(): the controlled checkbox only turns checked
  // after the mutation round-trip (same pattern as the other journey specs).
  for (const title of [PART_ONE, PART_TWO]) {
    await taskRow(page, title).getByRole("checkbox").click();
    await expect(taskRow(page, title).getByRole("checkbox")).toBeChecked();
  }
  // One open child left — the parent is still open.
  await expect(taskRow(page, PARENT_TITLE).getByRole("checkbox")).not.toBeChecked();

  // The last open child closes the breakdown: the parent completes on its
  // own (#111, ADR-32) — the archived original neither blocks the cascade
  // nor counts toward it.
  await taskRow(page, SMALL_STEP).getByRole("checkbox").click();
  await expect(taskRow(page, SMALL_STEP).getByRole("checkbox")).toBeChecked();
  await expect(taskRow(page, PARENT_TITLE).getByRole("checkbox")).toBeChecked();

  // The finished tree leaves the open-only list (the archived original does
  // not hold it hostage there either).
  await page.getByLabel("show done").uncheck();
  await expect(page.getByText(PARENT_TITLE, { exact: true })).not.toBeVisible();
});
