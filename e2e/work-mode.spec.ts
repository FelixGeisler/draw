import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { resolveCurrentDraw, taskTree } from "./helpers.js";

// Issue #214: the Draw page's category chips became the app-wide, per-device
// deck scope — "work mode". They used to be bare page state: reset on reload,
// and invisible to the Tasks page.
//
// The two rules worth pinning are the ones a filter could plausibly break: a
// face-up card must survive a scope switch (the commitment invariant outranks
// the filter — a card that vanished would be a re-roll), and an empty scoped
// page must say WHY it is empty rather than reading as "you're done".
test.describe.configure({ mode: "serial" });

const WORK_TASK = "Draft the e2e quarterly memo";
const HOUSE_TASK = "Descale the e2e kettle";

// Categories are addressed by POSITION, never by name. The suite shares one
// database and the categories spec renames the seeded defaults, so a
// find(name === "Work") resolves to undefined depending on spec order — which
// is exactly how this spec failed the first time it ran in the full suite.
let scoped: { id: number; name: string };
let other: { id: number; name: string };

// The empty-scope test makes its own category and removes it again.
const EMPTY_CATEGORY = "E2E empty scope";
let emptyCategoryId: number | undefined;

async function seed(request: APIRequestContext) {
  const categories: { id: number; name: string }[] = await (
    await request.get("/api/categories")
  ).json();
  if (categories.length < 2) throw new Error("work-mode spec needs at least 2 categories");
  [scoped, other] = categories;
  await request.post("/api/tasks", {
    data: { title: WORK_TASK, categoryId: scoped.id, effortMinutes: 20 },
  });
  await request.post("/api/tasks", {
    data: { title: HOUSE_TASK, categoryId: other.id, effortMinutes: 20 },
  });
}

const chip = (page: Page, name: string) =>
  page.locator(".draw-filters .chip", { hasText: name });
const scopeBar = (page: Page) => page.getByTestId("deck-scope-bar");

test("picking a category sticks across a reload and narrows the Tasks page", async ({ page }) => {
  await seed(page.request);
  await resolveCurrentDraw(page);

  await page.goto("/");
  // Unscoped: no strip at all — the default app gains no chrome.
  await expect(scopeBar(page)).toHaveCount(0);

  await chip(page, scoped.name).click();
  await expect(scopeBar(page)).toContainText(scoped.name);

  // The scope survives a full reload, which is the whole point — the chips
  // already worked within a session.
  await page.reload();
  await expect(scopeBar(page)).toContainText(scoped.name);
  await expect(chip(page, scoped.name)).toHaveClass(/active/);

  // …and it reaches the Tasks page, which the chips never did.
  await page.goto("/tasks");
  await expect(scopeBar(page)).toContainText(scoped.name);
  await expect(taskTree(page).getByText(WORK_TASK, { exact: true })).toBeVisible();
  await expect(taskTree(page).getByText(HOUSE_TASK, { exact: true })).toHaveCount(0);

  // Quick capture defaults into the scoped category, so a captured task cannot
  // vanish from the page that captured it.
  await page.getByTestId("capture-form").getByPlaceholder("What needs doing?").fill("E2E scoped capture");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(taskTree(page).getByText("E2E scoped capture", { exact: true })).toBeVisible();
});

test("the scope bar clears from any page, and the rest of the tasks come back", async ({ page }) => {
  // Each test gets a fresh browser context, so the scope set by the previous
  // one is gone with its localStorage — set it here rather than leaning on
  // serial ordering for state the browser does not actually carry.
  await page.goto("/");
  await chip(page, scoped.name).click();

  await page.goto("/tasks");
  await expect(taskTree(page).getByText(HOUSE_TASK, { exact: true })).toHaveCount(0);

  await scopeBar(page).getByRole("button").click();
  await expect(scopeBar(page)).toHaveCount(0);
  await expect(taskTree(page).getByText(HOUSE_TASK, { exact: true })).toBeVisible();
  await expect(taskTree(page).getByText(WORK_TASK, { exact: true })).toBeVisible();

  // Cleared means cleared — not just for this render.
  await page.reload();
  await expect(scopeBar(page)).toHaveCount(0);
});

test("a face-up card survives a scope switch — the filter never retracts a commitment", async ({
  page,
}) => {
  await resolveCurrentDraw(page);
  await page.goto("/");
  await chip(page, other.name).click();
  await page.locator(".draw-face.front").click();
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
  await expect(page.locator(".draw-face.back h2")).toHaveText(HOUSE_TASK);

  // Switch to a scope the standing card does NOT belong to. The card stays:
  // #88's commitment invariant outranks the filter, and a card that vanished
  // here would be a re-roll with extra steps. The scope applies to the NEXT
  // draw.
  await chip(page, scoped.name).click();
  await expect(scopeBar(page)).toContainText(scoped.name);
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
  await expect(page.locator(".draw-face.back h2")).toHaveText(HOUSE_TASK);

  // It is still resolvable from here, which is the only way it should leave.
  await page.getByRole("button", { name: "💤 Not now" }).click();
  await page.getByRole("button", { name: /Tomorrow/ }).click();
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
});

test("an empty scoped page names its cause instead of claiming you are done", async ({ page }) => {
  // Its OWN category, created here: the assertion needs a genuinely empty one,
  // and any pre-existing category may hold another spec's leftovers.
  const created = await (
    await page.request.post("/api/categories", { data: { name: EMPTY_CATEGORY, color: "#8a2be2" } })
  ).json();
  emptyCategoryId = created.id;

  await page.goto("/");
  await chip(page, EMPTY_CATEGORY).click();
  await page.goto("/tasks");
  // "Nothing here" in front of a full task list is the one way work mode can
  // actively mislead — an empty scope must name itself.
  await expect(page.getByText(/clear work mode to see the rest/)).toBeVisible();

  await scopeBar(page).getByRole("button").click();
  await expect(page.getByText(/clear work mode to see the rest/)).toHaveCount(0);
});

test.afterAll(async ({ request }) => {
  // The suite shares one database — leaked drawable tasks would change what
  // later specs draw.
  const tasks: { id: number; title: string }[] = await (
    await request.get("/api/tasks?status=all")
  ).json();
  const mine = new Set([WORK_TASK, HOUSE_TASK, "E2E scoped capture"]);
  for (const t of tasks.filter((t) => mine.has(t.title))) {
    const res = await request.delete(`/api/tasks/${t.id}`);
    if (!res.ok()) throw new Error(`cleanup: delete task ${t.id} failed (${res.status()})`);
  }
  // The extra category would otherwise show up as a stray chip and a stray
  // group heading in every spec that runs after this one.
  if (emptyCategoryId != null) {
    const res = await request.delete(`/api/categories/${emptyCategoryId}`);
    if (!res.ok()) throw new Error(`cleanup: delete category failed (${res.status()})`);
  }
});
