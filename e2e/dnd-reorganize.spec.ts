import { expect, test, type Locator, type Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { taskTree } from "./helpers.js";

// Issue #101: pointer drag-and-drop on the Tasks page as an alternative input
// for the #100 reparent controls — same PATCH, same eligibility rules. Every
// test drives the REAL drag path (mouse down → stepped moves → up), asserting
// the mid-drag feedback before releasing. Runs against the shared E2E
// database; the seeded category and titles are unique to this spec so the
// section stays compact enough for source and target to share the viewport.
test.describe.configure({ mode: "serial" });

const CATEGORY = "DnD e2e";
const NEST_TARGET = "Assemble e2e bookshelf";
const NEST_MOVER = "Sort e2e paperbacks";
const PARENT_WITH_CHILD = "Restore e2e typewriter";
const CHILD = "Buy e2e ink ribbon";

async function seed(request: APIRequestContext) {
  const cat = await (
    await request.post("/api/categories", { data: { name: CATEGORY, color: "#8b5cf6" } })
  ).json();
  for (const title of [NEST_TARGET, NEST_MOVER, PARENT_WITH_CHILD]) {
    await request.post("/api/tasks", { data: { title, categoryId: cat.id } });
  }
  const tasks: { id: number; title: string }[] = await (await request.get("/api/tasks")).json();
  const parent = tasks.find((t) => t.title === PARENT_WITH_CHILD)!;
  await request.post(`/api/tasks/${parent.id}/subtasks`, {
    data: { subtasks: [{ title: CHILD }] },
  });
}

// Tree-scoped (#151): the seeds are unestimated, so the triage strip lists
// them too — but the strip is not a drop surface (its rows render without
// data-dnd-row), and an unscoped title lookup would go ambiguous.
function row(page: Page, title: string): Locator {
  return taskTree(page).getByText(title, { exact: true }).locator("..");
}

function handle(page: Page, title: string): Locator {
  return row(page, title).locator(".dnd-handle");
}

async function tasksByTitle(page: Page) {
  const tasks: {
    title: string;
    parentId: number | null;
    subtasks?: { title: string }[];
  }[] = await (await page.request.get("/api/tasks")).json();
  return tasks;
}

/**
 * Press on `from`'s center and travel to `to`'s center in steps WITHOUT
 * releasing — mid-drag assertions (highlights, reasons) happen at the call
 * site, then the caller decides to drop (mouse.up) or bail. The first short
 * hop crosses the 5px activation threshold so the overlay (ghost + root
 * zone) exists before `to` is measured — the zone only mounts mid-drag.
 */
async function dragWithoutRelease(page: Page, from: Locator, to: Locator) {
  // Both endpoints must be fully inside the viewport BEFORE the press: the
  // page cannot scroll mid-drag, and a coordinate below the fold hits
  // nothing (elementFromPoint sees only the viewport).
  await to.scrollIntoViewIfNeeded();
  await from.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 3 });
  await expect(page.locator(".dnd-ghost")).toBeVisible();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
}

test("drag a childless root onto another root to nest it as a subtask", async ({ page }) => {
  await seed(page.request);
  await page.goto("/tasks");

  await dragWithoutRelease(page, handle(page, NEST_MOVER), row(page, NEST_TARGET));
  // Mid-drag: the hovered eligible target is highlighted.
  await expect(row(page, NEST_TARGET)).toHaveClass(/dnd-eligible/);
  await expect(row(page, NEST_TARGET)).toHaveClass(/dnd-over/);
  await page.mouse.up();

  // The list updates without a reload: the row re-renders as a subtask, so it
  // gains the promote (⤴) affordance — and since #167 a childless subtask also
  // keeps its "Move under…" menu (it can move under a different parent too), so
  // both reorganize controls are present.
  await expect(row(page, NEST_MOVER).getByTitle("Promote to top-level")).toBeVisible();
  await expect(
    row(page, NEST_MOVER).getByTitle("Move under another task (it becomes a subtask)"),
  ).toBeVisible();

  const tasks = await tasksByTitle(page);
  expect(tasks.some((t) => t.title === NEST_MOVER)).toBe(false); // no longer a root
  expect(tasks.find((t) => t.title === NEST_TARGET)?.subtasks?.map((s) => s.title)).toContain(
    NEST_MOVER,
  );
});

test("a container offers no nest gesture — its drag stays inert and changes nothing (#167)", async ({
  page,
}) => {
  await page.goto("/tasks");

  // PARENT_WITH_CHILD has a subtask, so it is a container: it cannot itself
  // become a subtask (ADR-16). Since #167 the move-under gesture is gated on
  // CHILDLESSNESS, so a container's drag is inert over every row — no eligible
  // glow, no blocked reason (the gesture is hidden, not shown-disabled).
  await dragWithoutRelease(page, handle(page, PARENT_WITH_CHILD), row(page, NEST_TARGET));
  await expect(row(page, NEST_TARGET)).not.toHaveClass(/dnd-eligible/);
  await expect(row(page, NEST_TARGET)).not.toHaveClass(/dnd-blocked/);
  await expect(page.locator(".dnd-reason")).toHaveCount(0);
  await page.mouse.up();

  // An inert drop is a no-op: the tree is unchanged on the server.
  const tasks = await tasksByTitle(page);
  const parent = tasks.find((t) => t.title === PARENT_WITH_CHILD);
  expect(parent?.parentId).toBeNull();
  expect(parent?.subtasks?.map((s) => s.title)).toEqual([CHILD]);
  expect(tasks.find((t) => t.title === NEST_TARGET)?.subtasks?.map((s) => s.title)).toEqual([
    NEST_MOVER,
  ]);
});

test("drag a subtask to the root drop zone to promote it — under reduced motion", async ({
  page,
}) => {
  // The acceptance criterion is that motion is decorative: with animations
  // off, the drag path must work identically.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tasks");

  const zone = page.locator(".dnd-root-zone");
  await dragWithoutRelease(page, handle(page, CHILD), row(page, NEST_TARGET));
  // Since #167 a childless subtask also nests under a DIFFERENT root, so
  // NEST_TARGET now highlights as an eligible nest target — but the promote
  // zone stays a live target in parallel, and dropping ON the zone (below) is
  // what this test exercises. The two reorganize gestures coexist.
  await expect(row(page, NEST_TARGET)).toHaveClass(/dnd-eligible/);
  await expect(zone).toContainText("Drop here to promote");

  const z = (await zone.boundingBox())!;
  await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2, { steps: 12 });
  await expect(zone).toHaveClass(/dnd-over/);
  await page.mouse.up();

  // A root row again: the move menu returns.
  await expect(
    row(page, CHILD).getByTitle("Move under another task (it becomes a subtask)"),
  ).toBeVisible();
  const tasks = await tasksByTitle(page);
  expect(tasks.find((t) => t.title === CHILD)?.parentId).toBeNull();
  expect(tasks.find((t) => t.title === PARENT_WITH_CHILD)?.subtasks).toEqual([]);
});

test("the session ignores foreign pointers and retires itself when its release was lost", async ({
  page,
}) => {
  // The two accidental-drop vectors from review: (a) a second touch must
  // neither steer nor commit someone else's drag; (b) a session whose
  // release was never delivered (mouse let go outside the window) must not
  // survive to turn the next in-page click into a drop. Playwright cannot
  // move a real pointer out of the window, so after a REAL drag is live the
  // stray pointers are injected as synthetic events on window — exactly
  // where the session's listeners live.
  await page.goto("/tasks");
  await page.evaluate(() => {
    window.addEventListener(
      "pointerdown",
      (e) => ((window as unknown as { __pid: number }).__pid = e.pointerId),
      { once: true, capture: true },
    );
  });

  // After the promote test, CHILD is a childless root again: dropping it on
  // the (now childless) PARENT_WITH_CHILD would be a perfectly eligible nest
  // — which is what makes a phantom commit detectable below.
  await dragWithoutRelease(page, handle(page, CHILD), row(page, PARENT_WITH_CHILD));
  await expect(row(page, PARENT_WITH_CHILD)).toHaveClass(/dnd-over/);
  const pid = await page.evaluate(() => (window as unknown as { __pid: number }).__pid);

  // (a) A different pointerId lifting (the second finger) is not our
  // release: the drag survives it, uncommitted.
  await page.evaluate((foreign) => {
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: foreign }));
  }, pid + 1);
  await expect(page.locator(".dnd-ghost")).toBeVisible();

  // (b) Our own pointer moving with no button held means the release
  // happened where it could not be delivered — the session retires on the
  // spot instead of waiting to hijack the next click…
  await page.evaluate((own) => {
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: own, buttons: 0 }));
  }, pid);
  await expect(page.locator(".dnd-ghost")).not.toBeVisible();

  // …so this release over an ELIGIBLE row commits nothing.
  await page.mouse.up();
  // Give a wrongly-issued PATCH time to land before asserting it did not.
  await page.waitForTimeout(300);
  const tasks = await tasksByTitle(page);
  expect(tasks.find((t) => t.title === CHILD)?.parentId).toBeNull();
  expect(tasks.find((t) => t.title === PARENT_WITH_CHILD)?.subtasks).toEqual([]);
});
