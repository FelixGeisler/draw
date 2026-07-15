import { expect, test, type Page } from "@playwright/test";

// Category self-service in Settings: rename, recolor, create + delete,
// deleting defaults. Runs before core-journey.spec.ts against the same
// database, so it must only touch categories — never tasks or completions.
test.describe.configure({ mode: "serial" });

function categoriesSection(page: Page) {
  return page.locator("section").filter({ hasText: "Categories" });
}

test("rename: click-to-edit updates the row and the TaskForm select", async ({ page }) => {
  await page.goto("/settings");

  await categoriesSection(page).getByText("Study", { exact: true }).click();
  const edit = page.getByLabel("Rename category");
  await edit.fill("Uni Study");
  await edit.press("Enter");

  await expect(categoriesSection(page).getByText("Uni Study", { exact: true })).toBeVisible();
  // The row shows the new name while the PATCH is still in flight, so anchor
  // on the color input's title — it only changes once the refreshed categories
  // land — before navigating away.
  await expect(page.getByTitle("Change color of Uni Study")).toBeVisible();

  // Client-side navigation (no reload): the select only shows the new name
  // because the mutation invalidated the ["categories"] query.
  await page.getByRole("link", { name: "Capture" }).click();
  const select = page.locator("select").first();
  await expect(select.locator("option", { hasText: "Uni Study" })).toHaveCount(1);
  await expect(select.locator("option", { hasText: /^Study$/ })).toHaveCount(0);
});

test("duplicate rename: 409 error shown inline, original name preserved", async ({ page }) => {
  await page.goto("/settings");

  await categoriesSection(page).getByText("Work", { exact: true }).click();
  const edit = page.getByLabel("Rename category");
  await edit.fill("Uni Study");
  await edit.press("Enter");

  await expect(page.getByText("a category with that name already exists")).toBeVisible();
  await expect(categoriesSection(page).getByText("Work", { exact: true })).toBeVisible();
});

test("recolor: the picked color survives a reload", async ({ page }) => {
  await page.goto("/settings");

  const color = page.getByTitle("Change color of Uni Study");
  await color.fill("#ff0000");
  await color.blur();

  await page.reload();
  await expect(page.getByTitle("Change color of Uni Study")).toHaveValue("#ff0000");
});

test("create and delete a category", async ({ page }) => {
  await page.goto("/settings");

  await page.getByPlaceholder("New category").fill("Temp");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(categoriesSection(page).getByText("Temp", { exact: true })).toBeVisible();

  await page.getByTitle("Delete Temp").click();
  await expect(categoriesSection(page).getByText("Temp", { exact: true })).not.toBeVisible();
});

test("a slow rename PATCH shows the new name immediately, not a silently lost edit", async ({ page }) => {
  // Regression for a load-dependent flake: with the rename PATCH + refetch
  // round-trip slower than the assertion window, the row used to fall back to
  // the stale name with no pending indicator — indistinguishable from a lost
  // keystroke. The row must show the committed name while the PATCH is in
  // flight. Uses its own category so the stall can't disturb the others.
  await page.goto("/settings");
  await page.getByPlaceholder("New category").fill("Slowpoke");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(categoriesSection(page).getByText("Slowpoke", { exact: true })).toBeVisible();

  await page.route("**/api/categories/*", async (route) => {
    if (route.request().method() === "PATCH") {
      await new Promise((r) => setTimeout(r, 6500)); // > expect()'s 5s default
    }
    await route.fallback();
  });

  await categoriesSection(page).getByText("Slowpoke", { exact: true }).click();
  const edit = page.getByLabel("Rename category");
  await edit.fill("Slowpoke Jr");
  await edit.press("Enter");

  // Mid-stall: the editor is closed and the row already reads Slowpoke Jr.
  await expect(edit).not.toBeVisible();
  await expect(categoriesSection(page).getByText("Slowpoke Jr", { exact: true })).toBeVisible({
    timeout: 3000,
  });

  // Once the round-trip completes the rename is persisted; clean up.
  await expect(page.getByTitle("Delete Slowpoke Jr")).toBeVisible({ timeout: 15_000 });
  await page.getByTitle("Delete Slowpoke Jr").click();
  await expect(categoriesSection(page).getByText("Slowpoke Jr", { exact: true })).not.toBeVisible();
});

test("default categories can be deleted when task-free", async ({ page }) => {
  await page.goto("/settings");

  await page.getByTitle("Delete Household").click();
  await expect(
    categoriesSection(page).getByText("Household", { exact: true }),
  ).not.toBeVisible();

  // The other defaults are still there for the core journey.
  await expect(categoriesSection(page).getByText("Work", { exact: true })).toBeVisible();
  await expect(categoriesSection(page).getByText("Uni Study", { exact: true })).toBeVisible();
});
