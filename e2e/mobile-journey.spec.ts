import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import { captureForm, resolveCurrentDraw, taskTree } from "./helpers.js";

// Phone-readiness journey (#193): the core loop — capture → draw → reveal →
// complete — on an emulated Android phone, plus the layout invariants the
// responsive pass promises (no horizontal page scroll, a pinned thumb-reachable
// bottom nav, 44px touch targets) and touch-input drag-and-drop in both
// directions (reparent and same-parent reorder). Desktop specs stay untouched;
// this file only ADDS the mobile variant of the core loop.
test.use({ ...devices["Pixel 7"] });

test.describe.configure({ mode: "serial" });

type Point = { x: number; y: number };

// Every row this file seeds is registered here and removed in afterEach. The
// suite shares ONE database and these rows are DRAWABLE, so a leak changes what
// the specs running after this file draw. afterEach fires even when a test fails
// or times out halfway through — a cleanup at the end of the test body does not.
const created: { tasks: number[]; goals: number[] } = { tasks: [], goals: [] };

/** POST that fails loudly: an unchecked seed makes every later assertion a lie. */
async function seed<T>(page: Page, path: string, data: object): Promise<T> {
  const res = await page.request.post(path, { data });
  expect(res.ok(), `POST ${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

async function seedTask(page: Page, data: object): Promise<{ id: number }> {
  const task = await seed<{ id: number }>(page, "/api/tasks", data);
  created.tasks.push(task.id);
  return task;
}

async function seedGoal(page: Page, title: string): Promise<{ id: number }> {
  const goal = await seed<{ id: number }>(page, "/api/goals", { title });
  created.goals.push(goal.id);
  return goal;
}

test.afterEach(async ({ page }) => {
  const failed: string[] = [];
  const remove = async (path: string) => {
    const res = await page.request.delete(path);
    // 404 is fine: a subtask goes away with the parent that adopted it.
    if (!res.ok() && res.status() !== 404) failed.push(`DELETE ${path} → ${res.status()}`);
  };
  for (const id of created.tasks.splice(0)) await remove(`/api/tasks/${id}`);
  for (const id of created.goals.splice(0)) await remove(`/api/goals/${id}`);
  expect(failed, "seeded rows must leave the shared database clean").toEqual([]);
});

/** The page itself must never scroll sideways — inner scroll boxes (the
 *  History calendar) are fine, the document is not. */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * Real browser touch input through CDP. Playwright's touchscreen exposes only
 * tap, and synthesising PointerEvents with dispatchEvent does NOT work here:
 * those never establish pointer capture, so the drag session never commits and
 * such a test fails while real touch dragging works. Input.dispatchTouchEvent
 * injects input the engine turns into genuine pointer events (pointerType
 * "touch", working capture) — the path a finger takes on Android. Chromium-only,
 * which is the browser this suite runs.
 */
async function touchDriver(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: "touchStart" | "touchMove" | "touchEnd", at?: Point) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: at ? [{ x: at.x, y: at.y, id: 1 }] : [],
    });
  return {
    start: (at: Point) => send("touchStart", at),
    move: (at: Point) => send("touchMove", at),
    end: () => send("touchEnd"),
  };
}

/** Viewport coordinates, which is what CDP touch input speaks. */
async function centre(locator: Locator): Promise<Point> {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Both ends of a drag must be on screen: the drop is hit-tested with
 *  elementFromPoint, so an off-screen target fails for that reason rather than
 *  as a mystifying "no reparent" timeout. */
async function expectOnScreen(page: Page, name: string, p: Point) {
  const height = page.viewportSize()!.height;
  expect(p.y, `${name} must be within the viewport to drag`).toBeGreaterThan(0);
  expect(p.y, `${name} must be within the viewport to drag`).toBeLessThan(height);
}

test("bottom nav is thumb-reachable, stays pinned when the page scrolls, and no main page scrolls sideways", async ({
  page,
}) => {
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

  // The Assistant is one of #193's main pages too, but its nav entry is AI-gated
  // (App.tsx) and this suite runs AI-degraded, so there is no tab to tap: reach
  // it by URL. Without this the "no main page scrolls sideways" claim would
  // simply not cover it.
  await page.goto("/assistant");
  await expect(page.getByRole("heading", { name: /Assistant/ })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Pinned, not merely bottom-of-page: measuring at scroll offset 0 passes for a
  // static footer too. Settings is long at phone width whatever the database
  // holds, so this cannot go vacuous.
  await page.goto("/settings");
  const scrollable = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  expect(scrollable, "the settings page must be taller than the viewport here").toBeGreaterThan(200);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect
    .poll(() => page.evaluate(() => Math.round(window.scrollY)))
    .toBeGreaterThan(100);
  const scrolledBox = (await nav.boundingBox())!;
  expect(scrolledBox.y + scrolledBox.height).toBeGreaterThanOrEqual(viewport.height - 1);
  expect(await nav.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
});

test("the controls the phone rules target are ≥44px touch targets", async ({ page }) => {
  // The nav links were already 48px by their own CSS — these are the controls
  // the 640px block actually changes: the capture form's inputs, selects and
  // buttons, and the drag handle that IS the touch drag surface.
  const seeded = await seedTask(page, { title: "Mobile target probe", categoryId: 1, effortMinutes: 10 });
  await page.goto("/tasks");
  const form = captureForm(page);
  await expect(form.getByPlaceholder("What needs doing?")).toBeVisible();

  // Checkbox/radio/color keep their compact boxes by design, so they are out of
  // the measured set exactly as they are out of the CSS rule; textareas are not
  // targeted either (they are multi-line and tall anyway).
  const controls = form.locator(
    'button, select, input:not([type="checkbox"]):not([type="radio"]):not([type="color"])',
  );
  const count = await controls.count();
  expect(count, "the capture form must expose controls to measure").toBeGreaterThan(3);
  for (let i = 0; i < count; i++) {
    const control = controls.nth(i);
    if (!(await control.isVisible())) continue;
    const box = (await control.boundingBox())!;
    const what = await control.evaluate(
      (el) =>
        `${el.tagName.toLowerCase()}[${(el as HTMLInputElement).type ?? ""}] ` +
        `${el.getAttribute("placeholder") ?? el.getAttribute("title") ?? el.textContent?.trim() ?? ""}`,
    );
    expect(Math.round(box.height), `${what} height`).toBeGreaterThanOrEqual(44);
  }

  // Both axes for the handle: padding alone left it ~28px wide (TaskDnd.css).
  const handle = taskTree(page).locator(`[data-dnd-row="${seeded.id}"] .dnd-handle`);
  await handle.scrollIntoViewIfNeeded();
  const handleBox = (await handle.boundingBox())!;
  expect(Math.round(handleBox.width), "drag handle width").toBeGreaterThanOrEqual(44);
  expect(Math.round(handleBox.height), "drag handle height").toBeGreaterThanOrEqual(44);

  // The row's icon buttons (#244): 28px hover-economy targets on desktop,
  // but on the phone they join the 44px rule in BOTH axes — the kebab
  // included. hover:none makes the cluster permanently visible here, so a
  // finger can actually reach what it can hit.
  const rowEl = taskTree(page).locator(`[data-dnd-row="${seeded.id}"]`);
  const actions = rowEl.locator(".row-actions button");
  const actionCount = await actions.count();
  expect(actionCount, "the row must expose icon action buttons").toBeGreaterThanOrEqual(2);
  for (let i = 0; i < actionCount; i++) {
    const btn = actions.nth(i);
    const label = await btn.getAttribute("aria-label");
    const box = (await btn.boundingBox())!;
    expect(Math.round(box.width), `row action "${label}" width`).toBeGreaterThanOrEqual(44);
    expect(Math.round(box.height), `row action "${label}" height`).toBeGreaterThanOrEqual(44);
  }
});

test("core loop on a phone: capture, draw, reveal, complete", async ({ page }) => {
  await resolveCurrentDraw(page);
  // A private goal makes the draw deterministic (the shared E2E database
  // holds other specs' tasks): the goal filter scopes the pool to one card.
  const goal = await seedGoal(page, "Mobile journey goal");

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

  // Register the row the UI just created: deleting the goal does not take its
  // tasks with it, so if a step below fails this OPEN task would stay drawable
  // for every spec that follows.
  const open = (await (await page.request.get("/api/tasks?status=open")).json()) as {
    id: number;
    title: string;
  }[];
  const captured = open.find((t) => t.title === "Reply to the plumber");
  expect(captured, "the captured task must be readable over the API").toBeTruthy();
  created.tasks.push(captured!.id);

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
});

test("touch drag-and-drop: a childless root nests under another root", async ({ page }) => {
  // Two fresh roots; estimates keep them OUT of the triage strip, so each
  // renders exactly once (in the tree, where the handles are).
  const child = await seedTask(page, { title: "Mobile dnd child", categoryId: 1, effortMinutes: 10 });
  const parent = await seedTask(page, { title: "Mobile dnd parent", categoryId: 1, effortMinutes: 10 });

  await page.goto("/tasks");
  await expect(taskTree(page).getByText("Mobile dnd parent")).toBeVisible();

  // The handle owns the touch gesture: touch-action none, so dragging it can
  // never turn into a page scroll.
  const handle = taskTree(page).locator(`[data-dnd-row="${child.id}"] .dnd-handle`);
  expect(await handle.evaluate((el) => getComputedStyle(el).touchAction)).toBe("none");

  // The suite shares one database, so by now the tree is long and these two
  // freshly-seeded roots sit near its end — off-screen on a phone. Bring the
  // pair into view first; they are adjacent (same category, created back to
  // back).
  const targetRow = taskTree(page).locator(`[data-dnd-row="${parent.id}"]`);
  await targetRow.scrollIntoViewIfNeeded();
  // "Into view" is minimal: it stops as soon as the TARGET row clears the
  // viewport edge, and depending on how long the shared tree is by now (it
  // varies with which specs ran before this file) the source handle can be
  // left sitting just below the fold. Bring it in too — the pair is two
  // adjacent ~44px rows, so both stay visible — and only then measure.
  await handle.scrollIntoViewIfNeeded();

  const from = await centre(handle);
  const targetBox = (await targetRow.boundingBox())!;
  // The row's own title strip, not its centre: a row that contains nested rows
  // would hit-test to the innermost one at the centre.
  const to = { x: targetBox.x + 40, y: targetBox.y + 16 };
  await expectOnScreen(page, "handle", from);
  await expectOnScreen(page, "target", to);

  const touch = await touchDriver(page);
  await touch.start(from);
  // Past the 5px threshold first, so the press becomes a drag, then onto the
  // target row.
  await touch.move({ x: from.x + 10, y: from.y + 10 });
  await touch.move(to);
  // The row under the finger reports itself as an eligible drop target — the
  // same hover feedback the mouse gets.
  await expect(targetRow).toHaveClass(/dnd-over/);
  await touch.end();

  // The drop issues the same PATCH parentId as the Move under… menu.
  await expect
    .poll(async () => {
      const tasks = await (await page.request.get("/api/tasks?status=open")).json();
      const p = tasks.find((t: { id: number }) => t.id === parent.id);
      return p?.subtasks?.some((s: { id: number }) => s.id === child.id) ?? false;
    })
    .toBe(true);
});

test("touch drag-and-drop: siblings reorder within their parent", async ({ page }) => {
  // The other half of the acceptance criterion (#193): reorder, not just
  // reparent. Reordering drops onto the zero-height gap zones between sibling
  // rows (#157, ADR-43), which only exist mid-drag — a different code path from
  // the row-to-row reparent above.
  const parent = await seedTask(page, { title: "Mobile reorder outline", categoryId: 1 });
  const steps = await seed<{ id: number; title: string }[]>(
    page,
    `/api/tasks/${parent.id}/subtasks`,
    {
      subtasks: [
        { title: "mobile step alpha", effortMinutes: 5 },
        { title: "mobile step bravo", effortMinutes: 5 },
      ],
      orderMode: "sequential",
    },
  );
  const [alpha, bravo] = steps;

  const childTitles = async () => {
    const tasks = await (await page.request.get("/api/tasks")).json();
    const row = (tasks as { id: number; subtasks?: { title: string }[] }[]).find(
      (t) => t.id === parent.id,
    );
    return (row?.subtasks ?? []).map((s) => s.title);
  };
  expect(await childTitles()).toEqual([alpha.title, bravo.title]);

  await page.goto("/tasks");
  const bravoRow = taskTree(page).locator(`[data-dnd-row="${bravo.id}"]`);
  await bravoRow.scrollIntoViewIfNeeded();
  const handle = bravoRow.locator(".dnd-handle");
  const from = await centre(handle);
  await expectOnScreen(page, "handle", from);

  const touch = await touchDriver(page);
  await touch.start(from);
  // Cross the 5px activation threshold: only then do the gap zones mount.
  await touch.move({ x: from.x + 10, y: from.y + 10 });
  await expect(page.locator(".dnd-ghost")).toBeVisible();

  // A gap is a net-zero 12px hit box over a row boundary and the context only
  // flips it to dnd-over when a move's elementFromPoint lands inside it — one
  // pixel off and nothing updates. So step off it and back until the highlight
  // registers, the same hardening dnd-reorder.spec.ts uses for the mouse.
  const gap = page.locator(`[data-dnd-gap="${parent.id}:${alpha.id}"]`);
  await expectOnScreen(page, "reorder gap", await centre(gap));
  await expect(async () => {
    const target = await centre(gap);
    await touch.move({ x: target.x, y: target.y + 14 });
    await touch.move(target);
    await expect(gap).toHaveClass(/dnd-over/, { timeout: 750 });
  }).toPass({ timeout: 10_000 });
  await touch.end();

  // Dropped before alpha: bravo is the new front step, which for a sequential
  // breakdown is also the card the draw exposes.
  await expect
    .poll(childTitles)
    .toEqual([bravo.title, alpha.title]);
});

test("the History day-detail stays clear of the fixed bottom nav", async ({ page }) => {
  // The floating panel (#182) is z-index 50 against the phone nav's 80, so
  // without the bar's height in its clamp the panel's tail is painted over.
  // Seed one completion so today's tile has a detail to show at all.
  const done = await seedTask(page, { title: "Mobile history probe", categoryId: 1, effortMinutes: 5 });
  const patch = await page.request.patch(`/api/tasks/${done.id}`, { data: { status: "done" } });
  expect(patch.ok(), `PATCH status=done → ${patch.status()}`).toBeTruthy();

  await page.goto("/stats");
  const today = new Date();
  const key = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");
  const tile = page.locator(`[data-cal-day="${key}"]`);
  await tile.scrollIntoViewIfNeeded();
  await tile.tap();
  const detail = page.locator(".cal-detail");
  await expect(detail).toBeVisible();

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".cal-detail")!;
    const nav = document.querySelector<HTMLElement>(".sidenav")!;
    return {
      panelBottom: panel.getBoundingClientRect().bottom,
      navTop: nav.getBoundingClientRect().top,
      navHeight: nav.getBoundingClientRect().height,
      // The measured bar height the component feeds into its clamp and its cap.
      inset: Number.parseFloat(panel.style.getPropertyValue("--cal-detail-bottom-inset")),
    };
  });
  expect(geometry.panelBottom).toBeLessThanOrEqual(geometry.navTop);
  // Fed the bar's live height (padding and safe-area included), not a constant.
  expect(Math.abs(geometry.inset - geometry.navHeight)).toBeLessThan(1);
});

test.describe("at 360px — the narrowest width the acceptance criterion names", () => {
  // Pixel 7 emulation is 412px wide, so the 360px criterion needs its own
  // viewport; touch and mobile emulation carry over from the file-level device.
  test.use({ viewport: { width: 360, height: 780 } });

  test("no main page scrolls sideways", async ({ page }) => {
    for (const path of ["/", "/tasks", "/goals", "/stats", "/settings", "/assistant"]) {
      await page.goto(path);
      // Wait for the page's own content, not just the shell — an unrendered
      // route would pass the overflow check vacuously.
      await expect(page.locator(".content")).toBeVisible();
      // Report the culprits, not just the number: this invariant depends on
      // platform font and emoji metrics (it first failed on the Linux CI while
      // passing on Windows), so a bare pixel count is not debuggable from a log.
      const { overflow, offenders } = await page.evaluate(() => {
        const root = document.documentElement;
        const vw = root.clientWidth;
        // An element painted past the edge is usually a FOLLOWER: boxes stretch
        // to the (already widened) content area. The CAUSE is an element whose
        // own content does not fit its box, so report those — widest first.
        const causes = [...root.querySelectorAll<HTMLElement>("*")]
          .map((el) => ({ el, over: el.scrollWidth - el.clientWidth }))
          .filter((c) => c.over > 1 && c.el.clientWidth > 0)
          .sort((a, b) => b.over - a.over)
          .slice(0, 6)
          .map(({ el, over }) => {
            const cs = getComputedStyle(el);
            return `CAUSE ${el.tagName}.${(el.className || "").toString().slice(0, 26)} contentOver=${over} client=${el.clientWidth} scroll=${el.scrollWidth} minW=${cs.minWidth} wrap=${cs.flexWrap} txt=${(el.textContent || "").trim().slice(0, 22)}`;
          });
        // Plus the ancestor chain of the widest right edge, for context.
        let widest: HTMLElement | null = null;
        let maxRight = 0;
        root.querySelectorAll<HTMLElement>("*").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.right > maxRight) {
            maxRight = r.right;
            widest = el;
          }
        });
        const chain: string[] = [];
        for (let n: HTMLElement | null = widest; n; n = n.parentElement) {
          const r = n.getBoundingClientRect();
          const cs = getComputedStyle(n);
          chain.push(
            `CHAIN ${n.tagName}.${(n.className || "").toString().slice(0, 22)} w=${Math.round(r.width)} x=${Math.round(r.x)} minW=${cs.minWidth} disp=${cs.display}`,
          );
        }
        return { overflow: root.scrollWidth - vw, offenders: [...causes, ...chain.slice(0, 7)] };
      });
      expect(
        overflow,
        `${path} must not scroll sideways at 360px (vw=360). Widest offenders:\n${offenders.join("\n")}`,
      ).toBeLessThanOrEqual(0);
    }
  });
});
