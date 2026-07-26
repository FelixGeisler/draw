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

  // Playwright's touchscreen exposes only tap, so the drag is driven through
  // CDP's Input.dispatchTouchEvent: that injects REAL browser input, which the
  // engine turns into genuine pointer events (pointerType "touch", working
  // pointer capture) — the same path a finger takes on Android. Synthesising
  // PointerEvents with dispatchEvent instead does NOT work here: those never
  // establish pointer capture, and the drag session never commits, so such a
  // test would fail while real touch dragging works. Chromium-only, which is
  // the browser this suite runs.
  const points = await page.evaluate(
    ([childId, parentId]) => {
      const handle = document
        .querySelector<HTMLElement>(`[data-dnd-row="${childId}"] .dnd-handle`)!
        .getBoundingClientRect();
      const target = document
        .querySelector<HTMLElement>(`[data-dnd-row="${parentId}"]`)!
        .getBoundingClientRect();
      return {
        from: { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 },
        // The row's own title strip, not its centre: a row that contains
        // nested rows would hit-test to the innermost one at the centre.
        to: { x: target.x + 40, y: target.y + 16 },
      };
    },
    [child.id, parent.id] as const,
  );

  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", at?: { x: number; y: number }) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: at ? [{ x: at.x, y: at.y, id: 1 }] : [],
    });

  await touch("touchStart", points.from);
  // Past the 5px threshold first, so the press becomes a drag, then onto the
  // target row.
  await touch("touchMove", { x: points.from.x + 10, y: points.from.y + 10 });
  await touch("touchMove", points.to);
  // The row under the finger reports itself as an eligible drop target — the
  // same hover feedback the mouse gets.
  await expect(taskTree(page).locator(`[data-dnd-row="${parent.id}"]`)).toHaveClass(/dnd-over/);
  await touch("touchEnd");

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
