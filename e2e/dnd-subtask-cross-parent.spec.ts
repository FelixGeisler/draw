import { expect, test, type Locator, type Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { openRowMenu, taskTree } from "./helpers.js";

// Issue #167: a CHILDLESS subtask can be dragged (or menu-moved) straight under
// a DIFFERENT open root — no promote-then-nest two-step. The server always
// accepted the move (the reparent matrix only requires a root target and a
// childless mover); #167 is the client enablement, so these journeys drive the
// REAL drag path and confirm the result on the server (GET /api/tasks). They
// also pin the coexistence with #157 reorder: the same subtask still reorders
// within its own breakdown via the gap zones, and dropping on its own parent
// stays blocked-with-reason. Runs serial against the shared E2E database with
// titles unique to this spec. The filename deliberately sorts AFTER the sibling
// dnd-reorder / dnd-reorganize specs: those measure gap geometry near the page
// fold, so this spec's seeded rows must not exist yet while they run and push
// their targets down (the same shared-DB ordering discipline reparent-tasks
// relies on).
test.describe.configure({ mode: "serial" });

const CATEGORY = "XParent e2e";
const ORIGIN = "XParent e2e origin";
const DEST = "XParent e2e destination";
const STEP_ONE = "xparent step one";
const STEP_TWO = "xparent step two";
const STEP_THREE = "xparent step three";

let originId: number;
let destId: number;
const subId: Record<string, number> = {};

async function seed(request: APIRequestContext) {
  const cat = await (
    await request.post("/api/categories", { data: { name: CATEGORY, color: "#f59e0b" } })
  ).json();
  const origin = await (
    await request.post("/api/tasks", { data: { title: ORIGIN, categoryId: cat.id, effortMinutes: 30 } })
  ).json();
  originId = origin.id;
  const dest = await (
    await request.post("/api/tasks", { data: { title: DEST, categoryId: cat.id, effortMinutes: 20 } })
  ).json();
  destId = dest.id;
  const subs = await (
    await request.post(`/api/tasks/${origin.id}/subtasks`, {
      data: {
        subtasks: [
          { title: STEP_ONE, effortMinutes: 5 },
          { title: STEP_TWO, effortMinutes: 5 },
          { title: STEP_THREE, effortMinutes: 5 },
        ],
      },
    })
  ).json();
  for (const s of subs as { id: number; title: string }[]) subId[s.title] = s.id;
}

// Tree-scoped: an unestimated seed would also list in the triage strip, which
// is not a drop surface — scope every lookup to the tree to stay unambiguous.
function row(page: Page, title: string): Locator {
  return taskTree(page).getByText(title, { exact: true }).locator("..");
}
function handle(page: Page, title: string): Locator {
  return row(page, title).locator(".dnd-handle");
}
/** The gap that drops a subtask before `beforeTitle` inside the origin. */
function gap(page: Page, beforeTitle: string | null): Locator {
  const before = beforeTitle == null ? "end" : String(subId[beforeTitle]);
  return page.locator(`[data-dnd-gap="${originId}:${before}"]`);
}

async function tasks(page: Page) {
  const list: {
    id: number;
    title: string;
    parentId: number | null;
    subtasks?: { id: number; title: string }[];
  }[] = await (await page.request.get("/api/tasks")).json();
  return list;
}
async function childTitles(page: Page, parentId: number): Promise<string[]> {
  const list = await tasks(page);
  return (list.find((t) => t.id === parentId)?.subtasks ?? []).map((s) => s.title);
}

/**
 * Press on `from`'s handle, cross the 5px activation threshold so the overlay
 * mounts, then travel to `to`'s center WITHOUT releasing — the caller asserts
 * the mid-drag feedback and then drops or bails.
 */
async function dragWithoutRelease(page: Page, from: Locator, to: Locator) {
  await to.scrollIntoViewIfNeeded();
  await from.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 3 });
  await expect(page.locator(".dnd-ghost")).toBeVisible();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  // Corrective hop (#244, mirrors dnd-reorganize): mid-drag reason strips
  // shift the rows, so re-target the LIVE box; the drop commits from the
  // last pointermove's overKey, so the stationary pointer stays right.
  const live = (await to.boundingBox())!;
  await page.mouse.move(live.x + live.width / 2, live.y + live.height / 2, { steps: 1 });
}

/**
 * The reorder gap zones only exist MID-DRAG, so — unlike a row target — the gap
 * cannot be measured before the press. Cross the activation threshold first so
 * the gaps mount, THEN travel to the target gap and release (mirrors
 * dnd-reorder's helper).
 */
async function dragToGap(page: Page, subtaskTitle: string, gapLocator: Locator) {
  const h = handle(page, subtaskTitle);
  await h.scrollIntoViewIfNeeded();
  const a = (await h.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 3 });
  await expect(page.locator(".dnd-ghost")).toBeVisible();
  // Bring the target gap into view and clamp the pointer inside the viewport: a
  // gap's zero-net-height box straddles a row boundary, so near the bottom of a
  // tall shared-DB page its exact center can fall a sub-pixel past the fold
  // where elementFromPoint returns null (see dnd-reorder for the same guard).
  await gapLocator.scrollIntoViewIfNeeded();
  const g = (await gapLocator.boundingBox())!;
  const vh = page.viewportSize()!.height;
  const ty = Math.max(3, Math.min(g.y + g.height / 2, vh - 3));
  await page.mouse.move(g.x + g.width / 2, ty, { steps: 10 });
  await expect(gapLocator).toHaveClass(/dnd-over/);
  await page.mouse.up();
}

test("drags a childless subtask straight under a different root (#167)", async ({ page }) => {
  await seed(page.request);
  await page.goto("/tasks");

  // Baseline: all three steps live under the origin, the destination is empty.
  expect(await childTitles(page, originId)).toEqual([STEP_ONE, STEP_TWO, STEP_THREE]);
  expect(await childTitles(page, destId)).toEqual([]);

  await dragWithoutRelease(page, handle(page, STEP_THREE), row(page, DEST));
  // Mid-drag: the different root highlights as an eligible nest target.
  await expect(row(page, DEST)).toHaveClass(/dnd-eligible/);
  await expect(row(page, DEST)).toHaveClass(/dnd-over/);
  await page.mouse.up();

  // The server confirms the cross-parent move: step three now lives under the
  // destination and no longer under the origin — in one gesture, no promote.
  await expect(async () => {
    expect(await childTitles(page, destId)).toContain(STEP_THREE);
  }).toPass();
  expect(await childTitles(page, originId)).toEqual([STEP_ONE, STEP_TWO]);
  const list = await tasks(page);
  expect(list.some((t) => t.title === STEP_THREE && t.parentId == null)).toBe(false);
});

test("dropping a subtask on its OWN parent is blocked-with-reason, no move", async ({ page }) => {
  await page.goto("/tasks");

  await dragWithoutRelease(page, handle(page, STEP_ONE), row(page, ORIGIN));
  // The own-parent row names the shared rule instead of accepting the drop.
  await expect(row(page, ORIGIN)).toHaveClass(/dnd-blocked/);
  await expect(row(page, ORIGIN)).not.toHaveClass(/dnd-eligible/);
  const reason = page.locator(".dnd-reason");
  await expect(reason).toContainText("already a subtask of this target");

  // Drifting onto the reason strip itself must not flicker it away: it carries
  // the row's data-dnd-row, so the pointer resting on it keeps ORIGIN hovered.
  const r = (await reason.boundingBox())!;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2, { steps: 4 });
  await expect(reason).toBeVisible();
  await expect(row(page, ORIGIN)).toHaveClass(/dnd-blocked/);
  await page.mouse.up();

  // Dropping on a blocked target is a cancel: the breakdown is unchanged.
  expect(await childTitles(page, originId)).toEqual([STEP_ONE, STEP_TWO]);
});

test("reorder-within-parent (#157) still works alongside the cross-parent nest", async ({
  page,
}) => {
  await page.goto("/tasks");
  expect(await childTitles(page, originId)).toEqual([STEP_ONE, STEP_TWO]);

  // Drag step two into the gap before step one → the order flips. Gaps and
  // rows are distinct drop spots, so the reorder gesture is intact.
  await dragToGap(page, STEP_TWO, gap(page, STEP_ONE));

  await expect(async () => {
    expect(await childTitles(page, originId)).toEqual([STEP_TWO, STEP_ONE]);
  }).toPass();
});

test("the cross-parent nest works identically under reduced motion", async ({ page }) => {
  // The acceptance criterion is that motion is decorative: with animations off,
  // the new gesture must still move the subtask across parents.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tasks");

  // Current origin order is [STEP_TWO, STEP_ONE]; move step one under the dest.
  await dragWithoutRelease(page, handle(page, STEP_ONE), row(page, DEST));
  await expect(row(page, DEST)).toHaveClass(/dnd-eligible/);
  await page.mouse.up();

  await expect(async () => {
    expect(await childTitles(page, destId)).toContain(STEP_ONE);
  }).toPass();
  expect(await childTitles(page, originId)).toEqual([STEP_TWO]);
});

test("the menu offers cross-parent Move under… for a childless subtask", async ({ page }) => {
  // Keyboard/menu parity with the drag (#167): the "Move under…" action now
  // appears on a childless subtask row (in the kebab menu since #244) and
  // lists other open roots. Origin now holds only STEP_TWO; move it under
  // the destination via the menu.
  await page.goto("/tasks");

  const subtaskRow = row(page, STEP_TWO);
  const menu = await openRowMenu(subtaskRow);
  await menu.getByRole("button", { name: "Move under…" }).click();
  await page.getByLabel(/Move under/).selectOption({ label: DEST });
  await page.getByRole("button", { name: "Move", exact: true }).click();

  await expect(async () => {
    expect(await childTitles(page, destId)).toContain(STEP_TWO);
  }).toPass();
  expect(await childTitles(page, originId)).toEqual([]);
});
