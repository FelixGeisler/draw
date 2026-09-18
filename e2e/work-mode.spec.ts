import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { resolveCurrentDraw, taskTree } from "./helpers.js";

// ADR-57 / issue #305: the per-device category-backed scope is presented as
// one shared-header project picker. These journeys pin persistence, shared
// scope behavior, keyboard/search accessibility and the face-up commitment.
test.describe.configure({ mode: "serial" });

const WORK_TASK = "Draft the e2e quarterly memo";
const HOUSE_TASK = "Descale the e2e kettle";
const EMPTY_CATEGORY = "E2E empty scope";

let scoped: { id: number; name: string };
let other: { id: number; name: string };
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

const picker = (page: Page) => page.getByTestId("project-picker");
const trigger = (page: Page) => picker(page).getByRole("button");
const projectList = (page: Page) => page.getByRole("listbox", { name: "Projects" });

async function chooseProject(page: Page, name: string) {
  await trigger(page).click();
  await projectList(page).getByRole("option", { name, exact: true }).click();
}

async function expectPickerOnEveryMainRoute(page: Page, label: string) {
  for (const route of ["/", "/tasks", "/goals", "/stats", "/settings"]) {
    await page.goto(route);
    await expect(picker(page)).toHaveCount(1);
    await expect(trigger(page)).toHaveAccessibleName(`Project: ${label}`);
  }
}

test("picking a project sticks across reloads, stays singular on every route, and narrows Tasks", async ({
  page,
}) => {
  await seed(page.request);
  await resolveCurrentDraw(page);

  await page.goto("/");
  await expect(trigger(page)).toHaveText("Project: All projects");
  await expect(page.locator(".draw-filters .chip")).toHaveCount(0);

  await chooseProject(page, scoped.name);
  await expect(trigger(page)).toHaveText(`Project: ${scoped.name}`);
  await expect(trigger(page)).toHaveAttribute("title", `Project: ${scoped.name}`);
  await expect(picker(page).locator(".project-picker-dot")).toHaveCount(1);

  await page.reload();
  await expect(trigger(page)).toHaveAccessibleName(`Project: ${scoped.name}`);
  await expectPickerOnEveryMainRoute(page, scoped.name);

  await page.goto("/tasks");
  await expect(taskTree(page).getByText(WORK_TASK, { exact: true })).toBeVisible();
  await expect(taskTree(page).getByText(HOUSE_TASK, { exact: true })).toHaveCount(0);

  await page.getByTestId("capture-form").getByPlaceholder("What needs doing?").fill("E2E scoped capture");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(taskTree(page).getByText("E2E scoped capture", { exact: true })).toBeVisible();
});

test("search, list order, keyboard selection and close focus behavior are accessible", async ({ page }) => {
  await page.goto("/stats");
  await trigger(page).click();

  const search = page.getByRole("searchbox", { name: "Search projects" });
  await expect(search).toBeFocused();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
  await expect(projectList(page)).toBeVisible();
  await expect(projectList(page).getByRole("option").first()).toHaveAccessibleName("All projects");
  await expect(projectList(page).getByRole("option", { selected: true })).toHaveAccessibleName(
    "All projects",
  );

  await search.fill(`  ${scoped.name.toUpperCase().slice(0, 5)}  `);
  await expect(projectList(page).locator(".project-picker-option-name")).toHaveText([
    "All projects",
    scoped.name,
  ]);
  await search.fill("no project can match this e2e phrase");
  await expect(projectList(page).getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("status")).toHaveText("No matching projects");

  await search.fill("");
  await search.press("End");
  const lastId = await search.getAttribute("aria-activedescendant");
  expect(lastId).toBeTruthy();
  await search.press("Home");
  await expect(search).toHaveAttribute("aria-activedescendant", /all-projects$/);
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(trigger(page)).toBeFocused();
  await expect(trigger(page)).toHaveAccessibleName(`Project: ${scoped.name}`);

  await trigger(page).click();
  await search.fill("temporary query");
  await search.press("Escape");
  await expect(trigger(page)).toBeFocused();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  await trigger(page).click();
  await expect(search).toHaveValue("");

  await search.press("Tab");
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("body")).not.toBeFocused();

  await trigger(page).click();
  await page.getByRole("heading", { name: "Stats" }).click();
  await expect(trigger(page)).toBeFocused();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
});

test("All projects clears scope from any page and survives reload", async ({ page }) => {
  await page.goto("/");
  await chooseProject(page, scoped.name);

  await page.goto("/tasks");
  await expect(taskTree(page).getByText(HOUSE_TASK, { exact: true })).toHaveCount(0);
  await chooseProject(page, "All projects");
  await expect(trigger(page)).toHaveAccessibleName("Project: All projects");
  await expect(taskTree(page).getByText(HOUSE_TASK, { exact: true })).toBeVisible();

  await page.reload();
  await expect(trigger(page)).toHaveAccessibleName("Project: All projects");
});

test("a face-up card survives a project switch and the new scope applies next", async ({ page }) => {
  await resolveCurrentDraw(page);
  await page.goto("/");
  await chooseProject(page, other.name);
  await page.locator(".draw-face.front").click();
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
  await expect(page.locator(".draw-face.back h2")).toHaveText(HOUSE_TASK);

  await chooseProject(page, scoped.name);
  await expect(trigger(page)).toHaveAccessibleName(`Project: ${scoped.name}`);
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
  await expect(page.locator(".draw-face.back h2")).toHaveText(HOUSE_TASK);

  await page.getByRole("button", { name: "💤 Not now" }).click();
  await page.getByRole("button", { name: /Tomorrow/ }).click();
  await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
});

test("an empty scoped page names its cause instead of claiming completion", async ({ page }) => {
  const created = await (
    await page.request.post("/api/categories", { data: { name: EMPTY_CATEGORY, color: "#8a2be2" } })
  ).json();
  emptyCategoryId = created.id;

  await page.goto("/");
  await chooseProject(page, EMPTY_CATEGORY);
  await page.goto("/tasks");
  await expect(page.getByText(/clear work mode to see the rest/)).toBeVisible();

  await chooseProject(page, "All projects");
  await expect(page.getByText(/clear work mode to see the rest/)).toHaveCount(0);
});

test("loading and unavailable states remain truthful and disabled", async ({ page }) => {
  let releaseCategories!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseCategories = resolve;
  });
  await page.route("**/api/categories", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/");
  await expect(trigger(page)).toBeDisabled();
  await expect(trigger(page)).toHaveAccessibleName("Project: Loading…");
  releaseCategories();
  await expect(trigger(page)).toBeEnabled();
  await expect(trigger(page)).toHaveAccessibleName("Project: All projects");

  await page.unroute("**/api/categories");
  await page.evaluate(() => localStorage.setItem("draw.deckScope", "999999"));
  await page.route("**/api/categories", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"offline"}' }),
  );
  await page.reload();
  await expect(trigger(page)).toBeDisabled({ timeout: 15_000 });
  await expect(trigger(page)).toHaveAccessibleName("Project: Unavailable");
  expect(await page.evaluate(() => localStorage.getItem("draw.deckScope"))).toBe("999999");
});

test.afterAll(async ({ request }) => {
  const tasks: { id: number; title: string }[] = await (
    await request.get("/api/tasks?status=all")
  ).json();
  const mine = new Set([WORK_TASK, HOUSE_TASK, "E2E scoped capture"]);
  for (const task of tasks.filter((candidate) => mine.has(candidate.title))) {
    const response = await request.delete(`/api/tasks/${task.id}`);
    if (!response.ok()) throw new Error(`cleanup: delete task ${task.id} failed (${response.status()})`);
  }
  if (emptyCategoryId != null) {
    const response = await request.delete(`/api/categories/${emptyCategoryId}`);
    if (!response.ok()) throw new Error(`cleanup: delete category failed (${response.status()})`);
  }
});
