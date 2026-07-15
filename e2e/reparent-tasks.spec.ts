import { expect, test, type Locator, type Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

// Issue #100: the Tasks page offers menu-based reparenting — "Move under…" on
// root rows without subtasks, "Promote to top-level" on subtask rows. Both
// are plain buttons/selects (keyboard-operable by construction; the promote
// test drives the keyboard path). Runs against the shared E2E database after
// the other specs; all seeded titles are unique to this spec.
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

function row(page: Page, title: string): Locator {
  return page.getByText(title, { exact: true }).locator("..");
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

  await row(page, LOOSE_TITLE)
    .getByTitle("Move under another task (it becomes a subtask)")
    .click();
  await page.getByLabel("Move under").selectOption({ label: UMBRELLA_TITLE });
  await page.getByRole("button", { name: "Move", exact: true }).click();

  // The row re-renders as a subtask: the promote affordance replaces the
  // move menu, and the umbrella now expands over it.
  await expect(row(page, LOOSE_TITLE).getByTitle("Promote to top-level")).toBeVisible();
  await expect(
    row(page, LOOSE_TITLE).getByTitle("Move under another task (it becomes a subtask)"),
  ).not.toBeVisible();

  // The server persisted the adoption — the task nests under the umbrella.
  const tasks = await tasksByTitle(page);
  expect(tasks.some((t) => t.title === LOOSE_TITLE)).toBe(false); // no longer a root
  const umbrella = tasks.find((t) => t.title === UMBRELLA_TITLE);
  expect(umbrella?.subtasks?.map((s) => s.title)).toContain(LOOSE_TITLE);
});

test("promote the subtask back to top-level — via the keyboard", async ({ page }) => {
  await page.goto("/tasks");

  const promote = row(page, LOOSE_TITLE).getByTitle("Promote to top-level");
  await promote.focus();
  await page.keyboard.press("Enter");

  // A root row again: the move menu returns, the promote button leaves.
  await expect(
    row(page, LOOSE_TITLE).getByTitle("Move under another task (it becomes a subtask)"),
  ).toBeVisible();
  await expect(row(page, LOOSE_TITLE).getByTitle("Promote to top-level")).not.toBeVisible();

  const tasks = await tasksByTitle(page);
  const loose = tasks.find((t) => t.title === LOOSE_TITLE);
  expect(loose?.parentId).toBeNull();
  expect(tasks.find((t) => t.title === UMBRELLA_TITLE)?.subtasks).toEqual([]);
});
