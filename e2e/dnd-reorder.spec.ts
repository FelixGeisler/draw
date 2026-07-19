import { expect, test, type Locator, type Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { taskTree } from "./helpers.js";

// Issue #157 (ADR-43): drag-and-drop reorder of a breakdown's subtasks via the
// gap drop-zones between sibling rows. The whole point is the sequential queue
// (ADR-18) — the front step is what the draw exposes — so the acceptance check
// drives a real drag and then reads the goal-scoped draw pool to prove the
// exposed card changed. Runs against the shared E2E database with titles unique
// to this spec. The gap zones only exist mid-drag, so the drag helper crosses
// the activation threshold first, then measures the gap.
test.describe.configure({ mode: "serial" });

const CATEGORY = "Reorder e2e";
const GOAL = "Reorder e2e goal";
const PARENT = "Reorder e2e outline";
const STEP_A = "reorder step alpha";
const STEP_B = "reorder step bravo";
const STEP_C = "reorder step charlie";

let goalId: number;
let parentId: number;
const subId: Record<string, number> = {};

async function seed(request: APIRequestContext) {
  const cat = await (
    await request.post("/api/categories", { data: { name: CATEGORY, color: "#0ea5e9" } })
  ).json();
  goalId = (await (await request.post("/api/goals", { data: { title: GOAL } })).json()).id;
  const parent = await (
    await request.post("/api/tasks", { data: { title: PARENT, categoryId: cat.id, goalId } })
  ).json();
  parentId = parent.id;
  // Sequential so the draw exposes only the front step — the reorder's payoff.
  const subs = await (
    await request.post(`/api/tasks/${parent.id}/subtasks`, {
      data: {
        subtasks: [
          { title: STEP_A, effortMinutes: 5 },
          { title: STEP_B, effortMinutes: 5 },
          { title: STEP_C, effortMinutes: 5 },
        ],
        orderMode: "sequential",
      },
    })
  ).json();
  for (const s of subs as { id: number; title: string }[]) subId[s.title] = s.id;
}

function row(page: Page, title: string): Locator {
  return taskTree(page).getByText(title, { exact: true }).locator("..");
}
function handle(page: Page, title: string): Locator {
  return row(page, title).locator(".dnd-handle");
}
/** The gap that drops a subtask before `beforeTitle` (or the end when null). */
function gap(page: Page, beforeTitle: string | null): Locator {
  const before = beforeTitle == null ? "end" : String(subId[beforeTitle]);
  return page.locator(`[data-dnd-gap="${parentId}:${before}"]`);
}

async function poolIds(page: Page): Promise<number[]> {
  const pool = await (await page.request.get(`/api/draw/pool?goalId=${goalId}`)).json();
  return (pool.candidates as { id: number }[]).map((c) => c.id);
}

async function childTitles(page: Page): Promise<string[]> {
  const tasks: { id: number; subtasks?: { title: string }[] }[] = await (
    await page.request.get("/api/tasks")
  ).json();
  return tasks.find((t) => t.id === parentId)!.subtasks!.map((s) => s.title);
}

/**
 * Press on `subtaskTitle`'s handle, cross the 5px activation threshold so the
 * gap zones mount, then travel to `gapLocator` and release. Mid-drag the gap
 * must report dnd-over before the drop, mirroring dnd-reorganize's assertions.
 */
async function dragToGap(page: Page, subtaskTitle: string, gapLocator: Locator) {
  const h = handle(page, subtaskTitle);
  await h.scrollIntoViewIfNeeded();
  const a = (await h.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 3 });
  await expect(page.locator(".dnd-ghost")).toBeVisible();
  // The gaps only exist now — measure and travel to the target one.
  const g = (await gapLocator.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2, { steps: 10 });
  await expect(gapLocator).toHaveClass(/dnd-over/);
  await page.mouse.up();
}

test("dragging a middle subtask to first place makes the sequential queue expose it", async ({
  page,
}) => {
  await seed(page.request);
  await page.goto("/tasks");

  // Baseline: the front step is the only exposed card of the sequential parent.
  await expect(row(page, STEP_A)).toBeVisible();
  expect(await poolIds(page)).toEqual([subId[STEP_A]]);

  // Drag the middle step (B) to the gap before A → B is the new front.
  await dragToGap(page, STEP_B, gap(page, STEP_A));

  // The list re-renders without a reload, and the draw pool now exposes B.
  await expect(async () => {
    expect(await childTitles(page)).toEqual([STEP_B, STEP_A, STEP_C]);
  }).toPass();
  expect(await poolIds(page)).toEqual([subId[STEP_B]]);
});

test("the new order persists across a reload", async ({ page }) => {
  await page.goto("/tasks");
  // Order set by the previous test survives a full reload (stored sort_order).
  expect(await childTitles(page)).toEqual([STEP_B, STEP_A, STEP_C]);

  // Move C to the end-gap (a no-op position) then A before C, ending B, C, A.
  await dragToGap(page, STEP_A, gap(page, null));
  await expect(async () => {
    expect(await childTitles(page)).toEqual([STEP_B, STEP_C, STEP_A]);
  }).toPass();

  await page.reload();
  const domOrder = await taskTree(page)
    .locator(`[data-dnd-row]`)
    .filter({ hasText: /reorder step/ })
    .allInnerTexts();
  // The three steps render in the persisted order in the DOM after reload.
  const seen = domOrder.join(" | ");
  expect(seen.indexOf("bravo")).toBeLessThan(seen.indexOf("charlie"));
  expect(seen.indexOf("charlie")).toBeLessThan(seen.indexOf("alpha"));
  expect(await poolIds(page)).toEqual([subId[STEP_B]]);
});

test("the reorder drag works identically under reduced motion", async ({ page }) => {
  // The acceptance criterion is that gap motion is decorative: with animations
  // off, the drag path must still reorder.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tasks");

  // Current order is B, C, A. Drag A back to the front.
  await dragToGap(page, STEP_A, gap(page, STEP_B));
  await expect(async () => {
    expect(await childTitles(page)).toEqual([STEP_A, STEP_B, STEP_C]);
  }).toPass();
  expect(await poolIds(page)).toEqual([subId[STEP_A]]);
});
