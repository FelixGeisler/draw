import { devices, expect, test, type Page } from "@playwright/test";
import { captureForm, resolveCurrentDraw, taskTree } from "./helpers.js";

// Phone-readiness journey (#193): the core loop — capture → draw → reveal →
// complete — on an emulated Android phone, plus the layout invariants the
// responsive pass promises (no horizontal page scroll, thumb-reachable bottom
// nav) and touch-input drag-and-drop. Desktop specs stay untouched; this file
// only ADDS the mobile variant of the core loop.
test.use({ ...devices["Pixel 7"] });

test.describe.configure({ mode: "serial" });

/** The page itself must never scroll sideways — inner scroll boxes (the
 *  History calendar) are fine, the document is not. */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("bottom nav is thumb-reachable and no main page scrolls sideways", async ({ page }) => {
  await page.goto("/");
  const viewport = page.viewportSize()!;

  // The sidenav renders as a fixed bar hugging the bottom edge; the brand
  // header hides to keep it a pure tab bar.
  const nav = page.locator(".sidenav");
  const navBox = (await nav.boundingBox())!;
  expect(navBox.y + navBox.height).toBeGreaterThanOrEqual(viewport.height - 1);
  await expect(page.locator(".sidenav .brand")).toBeHidden();

  // Every entry is a ≥44px touch target.
  for (const link of await nav.getByRole("link").all()) {
    const box = (await link.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }

  // Walk the main pages through the bar itself — tap, not click.
  const pages: [string, string][] = [
    ["Tasks", "Tasks"],
    ["Goals", "Goals"],
    ["Stats", "Stats"],
    ["Settings", "Settings"],
    ["Draw", "Draw a card"],
  ];
  await expectNoHorizontalScroll(page);
  for (const [label, heading] of pages) {
    await nav.getByRole("link", { name: label }).tap();
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
});

test("core loop on a phone: capture, draw, reveal, complete", async ({ page }) => {
  await resolveCurrentDraw(page);
  // A private goal makes the draw deterministic (the shared E2E database
  // holds other specs' tasks): the goal filter scopes the pool to one card.
  const goal = await (
    await page.request.post("/api/goals", { data: { title: "Mobile journey goal" } })
  ).json();

  await page.goto("/tasks");
  const form = captureForm(page);
  await form.getByPlaceholder("What needs doing?").tap();
  await form.getByPlaceholder("What needs doing?").fill("Reply to the plumber");
  await form.getByTitle("Link to a goal (enables impact rating)").selectOption({
    label: "🎯 Mobile journey goal",
  });
  await form.getByTitle("Effort estimate in minutes").fill("5");
  await form.getByRole("button", { name: "Add", exact: true }).tap();
  await expect(form.getByPlaceholder("What needs doing?")).toHaveValue("");
  await expect(taskTree(page).getByText("Reply to the plumber")).toBeVisible();

  // Draw from the goal-scoped deck: tap the card back, watch it flip.
  await page.goto("/");
  await page.locator(".draw-filters select").selectOption({ label: "🎯 Mobile journey goal" });
  await page.locator(".draw-face.front").tap();
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
  await expect(page.locator(".draw-face.back h2")).toHaveText("Reply to the plumber");

  // The revealed card and its actions stay inside the viewport.
  await expectNoHorizontalScroll(page);
  const scene = (await page.locator(".draw-scene").boundingBox())!;
  expect(scene.x).toBeGreaterThanOrEqual(0);
  expect(scene.x + scene.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  await page.getByRole("button", { name: "✓ Done" }).tap();
  await expect(page.getByText(/Today's pile — \d+ done/)).toBeVisible();

  await page.request.delete(`/api/goals/${goal.id}`);
});

test("touch drag-and-drop: a childless root nests under another root", async ({ page }) => {
  // Seed two fresh roots over the API; estimates keep them OUT of the triage
  // strip, so each renders exactly once (in the tree, where the handles are).
  const mk = async (title: string) =>
    (
      await page.request.post("/api/tasks", {
        data: { title, categoryId: 1, effortMinutes: 10 },
      })
    ).json();
  const child = await mk("Mobile dnd child");
  const parent = await mk("Mobile dnd parent");

  await page.goto("/tasks");
  await expect(taskTree(page).getByText("Mobile dnd parent")).toBeVisible();

  // The handle owns the touch gesture: touch-action none, so dragging it can
  // never turn into a page scroll.
  const handle = taskTree(page).locator(`[data-dnd-row="${child.id}"] .dnd-handle`);
  expect(
    await handle.evaluate((el) => getComputedStyle(el).touchAction),
  ).toBe("none");

  // Playwright's touchscreen has no drag primitive, so drive the exact
  // pointer-event sequence a touch drag produces (pointerdown on the handle,
  // pointermoves past the 5px threshold, pointerup over the target row) with
  // pointerType "touch" — the same code path a finger takes on Android.
  await page.evaluate(
    ([childId, parentId]) => {
      const handleEl = document.querySelector<HTMLElement>(
        `[data-dnd-row="${childId}"] .dnd-handle`,
      )!;
      const targetEl = document.querySelector<HTMLElement>(`[data-dnd-row="${parentId}"]`)!;
      const from = handleEl.getBoundingClientRect();
      const to = targetEl.getBoundingClientRect();
      const base = {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 11,
        pointerType: "touch",
        isPrimary: true,
      };
      const at = (x: number, y: number) => ({ clientX: x, clientY: y });
      const fx = from.x + from.width / 2;
      const fy = from.y + from.height / 2;
      const tx = to.x + to.width / 2;
      const ty = to.y + to.height / 2;
      handleEl.dispatchEvent(
        new PointerEvent("pointerdown", { ...base, button: 0, buttons: 1, ...at(fx, fy) }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { ...base, buttons: 1, ...at(fx + 8, fy + 8) }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { ...base, buttons: 1, ...at(tx, ty) }),
      );
      window.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0, ...at(tx, ty) }));
    },
    [child.id, parent.id] as const,
  );

  // The drop issues the same PATCH parentId as the Move under… menu.
  await expect
    .poll(async () => {
      const tasks = await (await page.request.get("/api/tasks?status=open")).json();
      const p = tasks.find((t: { id: number }) => t.id === parent.id);
      return p?.subtasks?.some((s: { id: number }) => s.id === child.id) ?? false;
    })
    .toBe(true);

  // Leave the shared database as found — later specs draw from this pool.
  await page.request.delete(`/api/tasks/${parent.id}`);
});
