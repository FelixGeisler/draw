import { expect, test, type Locator, type Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { openRowMenu, taskTree } from "./helpers.js";

// Issue #100 (+ #167): the Tasks page offers menu-based reparenting — "Move
// under…" on any CHILDLESS row (a root or, since #167, a subtask that can move
// to a different parent), "Promote to top-level" on subtask rows. Both are
// plain buttons/selects (keyboard-operable by construction; the promote test
// drives the keyboard path). Since #244 "Move under…" lives in the row's
// kebab menu — openRowMenu is the shared way in. Runs against the shared E2E database after the
// other specs; all seeded titles are unique to this spec.
test.describe.configure({ mode: "serial" });

const UMBRELLA_TITLE = "Plan the e2e garden bed";
const LOOSE_TITLE = "Buy e2e seed packets";

async function seed(request: APIRequestContext) {
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  await request.post("/api/tasks", {
    data: { title: UMBRELLA_TITLE, categoryId: categories[0].id, effortMinutes: 60 },
  });
  await request.post("/api/tasks", {
    data: { title: LOOSE_TITLE, categoryId: categories[0].id, effortMinutes: 10 },
  });
}

// Tree-scoped (#151): the 60-minute umbrella classifies too-big, so the
// triage strip lists it too — an unscoped title lookup would go ambiguous.
function row(page: Page, title: string): Locator {
  return taskTree(page).getByText(title, { exact: true }).locator("..");
}

async function tasksByTitle(page: Page) {
  const tasks: {
    title: string;
    parentId: number | null;
    subtasks?: { title: string }[];
  }[] = await (await page.request.get("/api/tasks")).json();
  return tasks;
}

test("move a root task under another via the Move under… menu", async ({ page }) => {
  await seed(page.request);
  await page.goto("/tasks");

  const moveMenu = await openRowMenu(row(page, LOOSE_TITLE));
  await moveMenu.getByRole("button", { name: "Move under…" }).click();
  await page.getByLabel("Move under").selectOption({ label: UMBRELLA_TITLE });
  await page.getByRole("button", { name: "Move", exact: true }).click();

  // The row re-renders as a subtask: it gains the promote (⤴) affordance, and
  // since #167 a childless subtask keeps its "Move under…" action too (it can
  // move under a different parent), so both reorganize controls are present.
  await expect(row(page, LOOSE_TITLE).getByTitle("Promote to top-level")).toBeVisible();
  const subtaskMenu = await openRowMenu(row(page, LOOSE_TITLE));
  await expect(subtaskMenu.getByRole("button", { name: "Move under…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(subtaskMenu).toHaveCount(0);

  // The server persisted the adoption — the task nests under the umbrella.
  const tasks = await tasksByTitle(page);
  expect(tasks.some((t) => t.title === LOOSE_TITLE)).toBe(false); // no longer a root
  const umbrella = tasks.find((t) => t.title === UMBRELLA_TITLE);
  expect(umbrella?.subtasks?.map((s) => s.title)).toContain(LOOSE_TITLE);
});

test("promote the subtask back to top-level — via the keyboard", async ({ page }) => {
  await page.goto("/tasks");

  // The promote control is a glyph-only button (⤴): its accessible name must
  // come from an aria-label, not the glyph, so it is announceable and reachable
  // by role+name (#104 item 3). getByRole resolves by accessible name, so this
  // would fail if the label were still the bare glyph.
  const promote = row(page, LOOSE_TITLE).getByRole("button", { name: "Promote to top-level" });
  await expect(promote).toBeVisible();
  await promote.focus();
  await page.keyboard.press("Enter");

  // A root row again: the promote button leaves, the kebab still offers the
  // move action.
  await expect(row(page, LOOSE_TITLE).getByTitle("Promote to top-level")).not.toBeVisible();
  const rootMenu = await openRowMenu(row(page, LOOSE_TITLE));
  await expect(rootMenu.getByRole("button", { name: "Move under…" })).toBeVisible();
  await page.keyboard.press("Escape");

  const tasks = await tasksByTitle(page);
  const loose = tasks.find((t) => t.title === LOOSE_TITLE);
  expect(loose?.parentId).toBeNull();
  expect(tasks.find((t) => t.title === UMBRELLA_TITLE)?.subtasks).toEqual([]);
});
