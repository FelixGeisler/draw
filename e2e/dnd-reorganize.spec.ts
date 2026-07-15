import { expect, test, type Locator, type Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

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

function row(page: Page, title: string): Locator {
  return page.getByText(title, { exact: true }).locator("..");
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

  // The list updates without a reload: the row re-renders as a subtask —
  // the promote affordance replaces the move menu.
  await expect(row(page, NEST_MOVER).getByTitle("Promote to top-level")).toBeVisible();
  await expect(
    row(page, NEST_MOVER).getByTitle("Move under another task (it becomes a subtask)"),
  ).not.toBeVisible();

  const tasks = await tasksByTitle(page);
  expect(tasks.some((t) => t.title === NEST_MOVER)).toBe(false); // no longer a root
  expect(tasks.find((t) => t.title === NEST_TARGET)?.subtasks?.map((s) => s.title)).toContain(
    NEST_MOVER,
  );
});

test("an invalid target names its rule mid-drag and the drop leaves the tree unchanged", async ({
  page,
}) => {
  await page.goto("/tasks");

  // PARENT_WITH_CHILD has a subtask — nesting it anywhere violates ADR-16.
  await dragWithoutRelease(page, handle(page, PARENT_WITH_CHILD), row(page, NEST_TARGET));
  await expect(row(page, NEST_TARGET)).toHaveClass(/dnd-blocked/);
  await expect(row(page, NEST_TARGET)).not.toHaveClass(/dnd-eligible/);
  // The reason comes from the shared eligibility helper (#100), not a copy.
  await expect(
    page.getByText(/a task with subtasks cannot become a subtask itself/),
  ).toBeVisible();
  await page.mouse.up();

  // Dropping on a blocked target is a cancel: tree unchanged on the server.
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
  // A dragged subtask has exactly one gesture (menu parity): root rows stay
  // inert — no eligible highlight — and only the zone is a live target.
  await expect(row(page, NEST_TARGET)).not.toHaveClass(/dnd-eligible/);
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
