import { expect, test, type Locator, type Page } from "@playwright/test";
import { subtaskEditor, taskTree } from "./helpers.js";

/**
 * Design foundation (#244) — the behavioural floor the restructure must land on.
 *
 * These specs were written BEFORE the implementation (test-first); their
 * `test.fail()` markers came off as each behaviour landed. The DOM contract
 * they pin:
 *
 *   - `.task-row` keeps its class and stays the container hover/focus-within
 *     key on (the #243 palette flash and the DnD hit-testing already require
 *     this element to be stable).
 *   - The secondary actions live in a `.row-actions` cluster inside the row.
 *     Reveal is opacity/transform ONLY — never display/visibility/
 *     pointer-events — so the buttons stay tabbable and clickable while
 *     visually hidden (Playwright's click hovers first; keyboard users get
 *     them via :focus-within).
 *   - Icon buttons keep their old accessible names: "Snooze" (the old 💤),
 *     "Break down", "Edit". The kebab trigger is named "More actions"; its
 *     popover is `.row-menu` and holds buttons "Move under…" and "Delete".
 *   - On touch devices (`@media (hover: none)`) the cluster is always visible.
 *   - The nav renders inline SVG icons; no emoji anywhere in `.sidenav`
 *     (including the brand), and icons must not leak into the links'
 *     accessible names.
 */
test.describe.configure({ mode: "serial" });

// Long enough that it CANNOT fit one line at 1080px next to chips and the
// action cluster on any platform's fonts — the promise is ellipsis, not luck.
const TASK_TITLE =
  "DF244 Draft the quarterly design-foundation review with every stakeholder from the platform, mobile and infrastructure teams before the Friday deadline";
const GOAL_TITLE =
  "DF244 Ship the complete design foundation with tokens, icons and motion across every surface";
// A second open root so the seeded row offers "Move under…" in its kebab.
const ANCHOR_TITLE = "DF244 Move-target anchor";
// A parent WITH subtasks: only such a row renders the order-mode flip, whose
// accessible name the pictograph gate must cover (#249).
const STEPPED_TITLE = "DF244 Stepped parent";

test.beforeAll(async ({ request }) => {
  const goalRes = await request.post("/api/goals", { data: { title: GOAL_TITLE } });
  expect(goalRes.ok(), `POST /api/goals → ${goalRes.status()}`).toBeTruthy();
  const goal = await goalRes.json();
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  for (const data of [
    // The issue's exact worst case: 5-star, goal-linked, effort chip, long title.
    {
      title: TASK_TITLE,
      categoryId: categories[0].id,
      goalId: goal.id,
      effortMinutes: 25,
      impact: 5,
    },
    { title: ANCHOR_TITLE, categoryId: categories[0].id, effortMinutes: 15 },
    { title: STEPPED_TITLE, categoryId: categories[0].id },
  ]) {
    const res = await request.post("/api/tasks", { data });
    expect(res.ok(), `POST /api/tasks → ${res.status()}`).toBeTruthy();
    const task = await res.json();
    if (data.title === STEPPED_TITLE) {
      const subRes = await request.post(`/api/tasks/${task.id}/subtasks`, {
        data: {
          subtasks: [
            { title: "DF244 Step one", effortMinutes: 5 },
            { title: "DF244 Step two", effortMinutes: 5 },
          ],
        },
      });
      expect(subRes.ok(), `POST subtasks → ${subRes.status()}`).toBeTruthy();
    }
  }
});

test.afterAll(async ({ request }) => {
  // Shared suite database: both rows are drawable — a leak changes later draws.
  const tasks: { id: number; title: string }[] = await (
    await request.get("/api/tasks?status=all")
  ).json();
  for (const t of tasks.filter((t) => t.title.startsWith("DF244 "))) {
    await request.delete(`/api/tasks/${t.id}`);
  }
  const goals: { id: number; title: string }[] = await (await request.get("/api/goals")).json();
  for (const g of goals.filter((g) => g.title.startsWith("DF244 "))) {
    await request.delete(`/api/goals/${g.id}`);
  }
});

function row(page: Page): Locator {
  // Deliberately NOT the getByText(...).locator("..") idiom of the older
  // specs: this file must survive the restructure it specifies, so it keys on
  // the stable `.task-row` class instead of the title span's DOM parent.
  return taskTree(page).locator(".task-row").filter({ hasText: TASK_TITLE });
}

const opacityOf = (cluster: Locator) =>
  cluster.evaluate((el) => getComputedStyle(el).opacity);

// Accessible names of every button in an action cluster: aria-label when set
// (all icon buttons), text content otherwise — the #249 pictograph gate's input.
const clusterNames = (cluster: Locator) =>
  cluster
    .locator("button")
    .evaluateAll((els) =>
      els.map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim()),
    );

// Anything pictographic is emoji chrome. Covers 🎴📋🎯📊⚙️✨🃏 as well as the
// dingbat range (✎ ✕ ⚙ live outside Extended_Pictographic's BMP heart).
const EMOJI = /[\p{Extended_Pictographic}←-⯿️]/u;

test.describe("desktop, 1080px", () => {
  test.use({ viewport: { width: 1080, height: 800 } });

  test("a 5-star goal-linked row keeps its long title to exactly one line", async ({ page }) => {
    await page.goto("/tasks");
    const r = row(page);
    await expect(r).toBeVisible();

    // The goal chip's #213 clamp survives the restructure.
    const chip = r.locator(".chip-clip");
    await expect(chip).toBeVisible();
    expect(Math.round((await chip.boundingBox())!.width)).toBeLessThanOrEqual(152);

    // ONE rendered line. The title element is a flex item (blockified), so
    // its own getClientRects() is always a single box — count the LINE boxes
    // of its text contents via a Range instead, and back it with the height
    // bound the contract names (≤ 1.6em: one line even at a generous
    // line-height; a second line puts it past 2em).
    //
    // AMENDED during implementation (#244): Chromium fragments an ellipsised
    // nowrap text node into MULTIPLE horizontal rects on the same visual
    // line (observed: [942px, 262px] fragments for one 21px-tall line), and
    // the inline-block category dot adds its own rect too — a raw rect count
    // can never be 1 here. A "line" is therefore a group of vertically
    // OVERLAPPING rects: fragments and the dot merge into their line box,
    // while a genuine second line starts below the first one's bottom.
    const title = r.getByText(TASK_TITLE, { exact: true });
    const m = await title.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0)
        .sort((a, b) => a.top - b.top);
      let lines = 0;
      let bottom = -Infinity;
      for (const rect of rects) {
        // 2px tolerance for subpixel rounding between fragments.
        if (rect.top >= bottom - 2) {
          lines++;
          bottom = rect.bottom;
        } else {
          bottom = Math.max(bottom, rect.bottom);
        }
      }
      const s = getComputedStyle(el);
      return {
        lines,
        height: el.getBoundingClientRect().height,
        fontSize: parseFloat(s.fontSize),
        elided: el.scrollWidth > el.clientWidth,
      };
    });
    expect(m.lines).toBe(1);
    expect(m.height).toBeLessThanOrEqual(m.fontSize * 1.6);
    // This title genuinely does not fit — one line must mean ellipsis, not a
    // vacuous pass on a row that happened to be wide enough.
    expect(m.elided).toBe(true);
    // …and an elided title stays readable IN PLACE: the native tooltip
    // (title attribute) replaced the wrapping the one-line rule removed.
    await expect(title).toHaveAttribute("title", TASK_TITLE);
  });

  test("actions reveal on hover and focus-within, and every action is keyboard-reachable", async ({
    page,
  }) => {
    await page.goto("/tasks");
    const r = row(page);
    await expect(r).toBeVisible();
    const cluster = r.locator(".row-actions");
    await expect(cluster).toHaveCount(1, { timeout: 2000 });

    // At rest on a hover-capable device the cluster is hidden — but hidden by
    // OPACITY only. display/visibility/pointer-events hiding would take the
    // buttons out of the tab order and out of Playwright's reach.
    await page.mouse.move(0, 0);
    const rest = await cluster.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        opacity: parseFloat(s.opacity),
        display: s.display,
        visibility: s.visibility,
        pointerEvents: s.pointerEvents,
      };
    });
    expect(rest.opacity).toBe(0);
    expect(rest.display).not.toBe("none");
    expect(rest.visibility).toBe("visible");
    expect(rest.pointerEvents).not.toBe("none");

    // Hover reveals…
    await r.hover();
    await expect.poll(() => opacityOf(cluster)).toBe("1");
    await page.mouse.move(0, 0);
    await expect.poll(() => opacityOf(cluster)).toBe("0");

    // …and so does focus anywhere in the row (focus-within): the keyboard
    // path must not depend on a pointer.
    await r.getByRole("checkbox").focus();
    await expect.poll(() => opacityOf(cluster)).toBe("1");

    // Every action — snooze, break down, edit, kebab — is focusable while
    // visually revealed, is an SVG icon button (no emoji chrome), and keeps
    // the cluster revealed while it holds focus.
    for (const name of ["Snooze", "Break down", "Edit", "More actions"]) {
      const btn = r.getByRole("button", { name, exact: true });
      await expect(btn, `row action "${name}"`).toHaveCount(1);
      await btn.focus();
      await expect(btn).toBeFocused();
      await expect.poll(() => opacityOf(cluster)).toBe("1");
      expect(await btn.locator("svg").count(), `"${name}" renders an svg icon`).toBe(1);
    }
    expect(await cluster.innerText()).not.toMatch(EMOJI);
    // …and the gate covers ACCESSIBLE NAMES, not just rendered text (#249):
    // an aria-label smuggling a glyph past the innerText check fails here.
    for (const name of await clusterNames(cluster)) {
      expect(name, `cluster accessible name "${name}"`).not.toMatch(EMOJI);
    }

    // Tab actually walks the cluster — reachability, not just programmatic
    // focus. Start on the first action and collect what Tab lands on until
    // focus leaves the row.
    await r.getByRole("button", { name: "Snooze", exact: true }).focus();
    const reached = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const inRow = await r.evaluate((el) => el.contains(document.activeElement));
      if (!inRow) break;
      reached.add(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return (el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim();
        }),
      );
      await page.keyboard.press("Tab");
    }
    for (const name of ["Snooze", "Break down", "Edit", "More actions"]) {
      expect([...reached], `Tab reaches "${name}"`).toContain(name);
    }

    // A cluster action ACTIVATES by keyboard: Enter on Break down opens the
    // breakdown panel (SubtaskEditor), Enter again closes it (it toggles).
    const breakDown = r.getByRole("button", { name: "Break down", exact: true });
    await breakDown.focus();
    await page.keyboard.press("Enter");
    await expect(subtaskEditor(page)).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(subtaskEditor(page)).toHaveCount(0);

    // The kebab is a keyboard-complete popover: Enter opens, the relocated
    // "Move under…" and "Delete" are buttons reachable by arrow keys, Esc
    // closes and returns focus to the trigger. No click anywhere.
    const kebab = r.getByRole("button", { name: "More actions", exact: true });
    await kebab.focus();
    await page.keyboard.press("Enter");
    const menu = page.locator(".row-menu");
    await expect(menu).toBeVisible();
    const moveItem = menu.getByRole("button", { name: /^Move under/ });
    const deleteItem = menu.getByRole("button", { name: "Delete", exact: true });
    await expect(moveItem).toBeVisible();
    await expect(deleteItem).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(moveItem).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(deleteItem).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(kebab).toBeFocused();

    // Tabbing AWAY from the open popover closes it too: without a focusout
    // close, a keyboard user leaves an invisible open menu behind with a
    // stale aria-expanded (and could open a second row's menu alongside it).
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await expect(kebab).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Tab"); // → Move under…
    await expect(moveItem).toBeFocused();
    await page.keyboard.press("Tab"); // → Delete
    await expect(deleteItem).toBeFocused();
    await page.keyboard.press("Tab"); // → out of the wrap
    await expect(menu).toHaveCount(0);
    await expect(kebab).toHaveAttribute("aria-expanded", "false");
  });

  test("a parent's order-mode flip carries a glyph-free accessible name", async ({ page }) => {
    // #249: the arrows live in the SVG icon only. This row HAS subtasks, so
    // its cluster holds the one button the main row's gate never sees — the
    // order-mode flip, whose old names ("→ in order" / "⇄ any order") were
    // exactly the compat exception this test forbids reintroducing.
    await page.goto("/tasks");
    const parent = taskTree(page).locator(".task-row").filter({ hasText: STEPPED_TITLE });
    await expect(parent).toBeVisible();
    const cluster = parent.locator(".row-actions");
    await expect(cluster).toHaveCount(1, { timeout: 2000 });
    const flip = parent.getByRole("button", { name: "Any order", exact: true });
    await expect(flip).toHaveCount(1);
    expect(await flip.locator("svg").count(), "flip renders an svg icon").toBe(1);
    // The gate walks EVERY button in the row, not just the cluster: the
    // expand/collapse caret sits before the title, outside .row-actions, and
    // without its aria-label its accessible name IS the triangle glyph.
    await expect(
      parent.getByRole("button", { name: "Collapse subtasks", exact: true }),
    ).toHaveCount(1);
    for (const name of await clusterNames(parent)) {
      expect(name, `row accessible name "${name}"`).not.toMatch(EMOJI);
    }
  });

  test("the nav renders svg icons and zero emoji chrome", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator(".sidenav");
    await expect(nav).toBeVisible();

    // Every entry carries exactly one inline SVG icon…
    const links = await nav.getByRole("link").all();
    expect(links.length).toBeGreaterThanOrEqual(5);
    for (const link of links) {
      expect(await link.locator("svg").count()).toBe(1);
    }

    // …that must NOT leak into the accessible name (today's emoji spans are
    // aria-hidden and five specs select tabs by bare label — keep that).
    for (const name of ["Draw", "Tasks", "Goals", "Stats", "Settings"]) {
      await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
    }

    // Zero emoji chrome in the whole nav — the 🃏 brand included.
    expect(await nav.innerText()).not.toMatch(EMOJI);
  });
});

test.describe("touch (hover: none)", () => {
  // A touch device WIDER than the 640px phone breakpoint: this isolates the
  // `@media (hover: none)` always-visible rule from the #193 phone block,
  // which has its own wrap/44px rules and its own spec (mobile-journey).
  // Not a devices[] spread: device descriptors carry defaultBrowserType,
  // which is illegal inside a describe. isMobile is what flips Chromium's
  // emulation to `hover: none` / `pointer: coarse`; hasTouch enables tap().
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 900, height: 800 } });

  test("row actions are always visible without hover", async ({ page }) => {
    await page.goto("/tasks");
    // Guard: the emulation really is a hover-incapable device, or the test
    // proves nothing.
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);

    const r = row(page);
    await expect(r).toBeVisible();
    const cluster = r.locator(".row-actions");
    await expect(cluster).toHaveCount(1, { timeout: 2000 });
    // No hover, no focus — visible anyway.
    expect(await opacityOf(cluster)).toBe("1");
    for (const name of ["Snooze", "Break down", "Edit", "More actions"]) {
      await expect(r.getByRole("button", { name, exact: true })).toBeVisible();
    }
    // The kebab works by tap: menu opens, holds the relocated actions.
    await r.getByRole("button", { name: "More actions", exact: true }).tap();
    const menu = page.locator(".row-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("button", { name: /^Move under/ })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
  });
});
