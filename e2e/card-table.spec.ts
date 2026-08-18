import { expect, test, type Locator, type Page } from "@playwright/test";
import { drawFromGoal } from "./helpers.js";

/**
 * Card-table identity (#255) — the Draw stage's reskin contract.
 *
 * SPEC-FIRST: written before the implementation, in two layers:
 *
 *   - Plain `test(...)` — invariants that pass TODAY and must survive the
 *     reskin: the category pill's raw-color fill + computed ink, the
 *     reduced-motion deal (flipped card, pure flip matrix, zero animated
 *     card chrome, zero canvas), and the action row's stable geometry under
 *     card hover. These are the guardrails the retune must not break.
 *   - The NEW look (started as `test.fixme`, flipped as #255 landed): serif
 *     on the card-face title only, the one-shot gilt sheen sweep on arrival,
 *     and the hover tilt living BELOW `.draw-card`.
 *
 * Anchors this file PINS for the implementation (chosen here, honored there):
 *   - The deal sheen is a pseudo-element of `.draw-face.back` (`::after`,
 *     the #124 oversized background-position pattern) — never a `<canvas>`
 *     (draw-confetti-gate/warmup-draw count canvases page-wide) and never a
 *     new sibling above `.draw-holo`.
 *   - The hover tilt transforms `.draw-face.back`, NOT `.draw-card`:
 *     fullbleed-holo.spec.ts pins `.draw-card`'s settled transform to the
 *     exact pure-flip matrix3d, and Playwright leaves the mouse over the
 *     card after clicking it — a `:hover` transform on `.draw-card` breaks
 *     those asserts. If the implementation tilts a different inner element,
 *     move THAT locator here consciously; the `.draw-card` half is
 *     untouchable.
 *
 * Shares the serial E2E database; seeds its own goal, task and category
 * (with a KNOWN brass-adjacent color — the sharpest probe for the
 * "category color is data, never brass-uniformed" rule) and removes them in
 * afterAll. Never completes a task: no XP, no trophies, no achievement
 * unlocks leak to later specs.
 */
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "CT255 Card table goal";
const TASK_TITLE = "CT255 Inspect the felt and the gilt edge";
const TASK_DESC = "Walk the rail once and check every seam by hand.";
const CATEGORY_NAME = "CT255 Brasswork";
// Deliberately brass-adjacent: if the reskin uniforms pills toward the
// accent, this rgb-compare fails loudly instead of passing by coincidence.
const CATEGORY_HEX = "#d9a441";
const CATEGORY_RGB = "rgb(217, 164, 65)";
// lib/cardVisuals DARK_INK (#12141a): the computed WCAG choice for this pale
// background. Byte-pinned there and in fullbleed-holo — never re-derived
// from a retuned --bg.
const DARK_INK_RGB = "rgb(18, 20, 26)";
// The settled flip is a PURE 180° rotateY (fullbleed-holo pins the same).
const PURE_FLIP_MATRIX = "matrix3d(-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1)";
// Serif = the Georgia stack or the generic keyword; the app's sans stack
// ("Segoe UI", system-ui, sans-serif) must never match.
const SERIF = /georgia|iowan|times|(^|,)\s*serif\s*(,|$)/i;

test.beforeAll(async ({ request }) => {
  const goalRes = await request.post("/api/goals", { data: { title: GOAL_TITLE } });
  expect(goalRes.ok(), `POST /api/goals → ${goalRes.status()}`).toBeTruthy();
  const goal = await goalRes.json();

  // Own category with a pinned color; a leftover from an aborted run is
  // reused with the color re-pinned (name is UNIQUE → 409).
  let catRes = await request.post("/api/categories", {
    data: { name: CATEGORY_NAME, color: CATEGORY_HEX },
  });
  if (catRes.status() === 409) {
    const cats: { id: number; name: string }[] = await (
      await request.get("/api/categories")
    ).json();
    const mine = cats.find((c) => c.name === CATEGORY_NAME);
    expect(mine, `409 on POST but "${CATEGORY_NAME}" not found`).toBeDefined();
    catRes = await request.patch(`/api/categories/${mine!.id}`, {
      data: { color: CATEGORY_HEX },
    });
  }
  expect(catRes.ok(), `seed category → ${catRes.status()}`).toBeTruthy();
  const category = await catRes.json();

  // Impact 3 on purpose: never holo-eligible (impact-5 + goal), so the deal
  // sheen and the holo drift can never be confused for one another here.
  const taskRes = await request.post("/api/tasks", {
    data: {
      title: TASK_TITLE,
      description: TASK_DESC,
      categoryId: category.id,
      goalId: goal.id,
      impact: 3,
      effortMinutes: 10,
    },
  });
  expect(taskRes.ok(), `POST /api/tasks → ${taskRes.status()}`).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  // Shared suite DB: the seeded card is drawable and the last test leaves a
  // persisted current draw — deleting the task clears it lazily (ADR-17
  // validation on the next GET /api/draw/current).
  const tasks: { id: number; title: string }[] = await (
    await request.get("/api/tasks?status=all")
  ).json();
  for (const t of tasks.filter((t) => t.title.startsWith("CT255 "))) {
    await request.delete(`/api/tasks/${t.id}`);
  }
  const goals: { id: number; title: string }[] = await (await request.get("/api/goals")).json();
  for (const g of goals.filter((g) => g.title.startsWith("CT255 "))) {
    await request.delete(`/api/goals/${g.id}`);
  }
  const cats: { id: number; name: string }[] = await (
    await request.get("/api/categories")
  ).json();
  for (const c of cats.filter((c) => c.name === CATEGORY_NAME)) {
    await request.delete(`/api/categories/${c.id}`);
  }
});

const fontFamilyOf = (loc: Locator) =>
  loc.evaluate((el) => getComputedStyle(el).fontFamily);

/** Rounded bounding boxes of every button in the stage action row. */
async function actionBoxes(page: Page) {
  return page.locator(".draw-actions button").evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x * 2) / 2,
        y: Math.round(r.y * 2) / 2,
        w: Math.round(r.width * 2) / 2,
        h: Math.round(r.height * 2) / 2,
      };
    }),
  );
}

test("category pill keeps the raw category-color fill and the computed ink on the drawn card", async ({
  page,
}) => {
  // #120/#123 (re-affirmed by #255): category color is DATA, not chrome.
  // The mockup's uniform brass pills were a sketch — the pill's background
  // is the category's own color on every palette, and its ink is the
  // computed WCAG choice, not a themed constant.
  await drawFromGoal(page, GOAL_TITLE);
  const pill = page.locator(".draw-face.back .category-pill");
  await expect(pill).toHaveText(CATEGORY_NAME);
  await expect(pill).toHaveCSS("background-color", CATEGORY_RGB);
  await expect(pill).toHaveCSS("color", DARK_INK_RGB);
});

test("reduced motion: the deal still lands a flipped card with zero animated card chrome", async ({
  page,
}) => {
  // The #255 deal (arc + one sheen sweep + tilt) is a no-preference-only
  // treat. Under reduce the card must still ARRIVE — same class, same
  // settled matrix — with every gated bit computing to no animation. This
  // passes today and keeps passing after: the sheen's future home
  // (.draw-face.back::after) already computes "none" here, so the reskin
  // cannot regress it without failing this test.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await drawFromGoal(page, GOAL_TITLE);

  const card = page.locator(".draw-card");
  await expect(card).toHaveCSS("transform", PURE_FLIP_MATRIX);

  const names = await page.locator(".draw-face.back").evaluate((el) => [
    getComputedStyle(el).animationName,
    getComputedStyle(el, "::before").animationName,
    getComputedStyle(el, "::after").animationName,
  ]);
  for (const name of names) expect(name, "no animation on the gated card bits").toBe("none");
  await expect(card).toHaveCSS("animation-name", "none");

  // The deal effect must never be canvas-based: draw-confetti-gate and
  // warmup-draw count canvases page-wide in BOTH directions — the only
  // sanctioned canvas in the app is the completion confetti.
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("the action row's buttons hold their exact boxes while the card is hovered", async ({
  page,
}) => {
  // The tilt is on the CARD only, never the action row: Playwright's
  // actionability and real fingers both need stable boxes. Sampled at three
  // pointer positions because a pointer-tracking tilt displaces differently
  // per position — and off-center is where a naive lift/tilt leaks layout.
  await drawFromGoal(page, GOAL_TITLE);
  const buttons = page.locator(".draw-actions button");
  await expect(buttons.first()).toBeVisible();
  const before = await actionBoxes(page);
  // Non-vacuity: Start now / Done / Not now / Break down at minimum.
  expect(before.length).toBeGreaterThanOrEqual(4);

  const face = (await page.locator(".draw-face.back").boundingBox())!;
  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.15, 0.12],
    [0.85, 0.88],
  ]) {
    await page.mouse.move(face.x + face.width * fx, face.y + face.height * fy);
    // Give a would-be tilt/lift transition (contract: ~260ms) time to run —
    // this wait is FOR the absence of motion, so a poll has nothing to poll.
    await page.waitForTimeout(400);
    expect(await actionBoxes(page), `action row moved under hover at ${fx},${fy}`).toEqual(
      before,
    );
  }

  // "No transform may idle or loop on any interactive element": at rest,
  // nothing on the buttons or the faces runs an infinite animation. (The
  // holo drift is exempt by being non-interactive — and absent here anyway:
  // impact 3 is never holo-eligible.)
  await page.mouse.move(0, 0);
  const looping = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".draw-actions button, .draw-face")].flatMap(
      (el) =>
        el
          .getAnimations()
          .filter(
            (a) =>
              a.effect instanceof KeyframeEffect &&
              a.effect.target === el &&
              a.effect.getTiming().iterations === Infinity,
          )
          .map((a) => (a as CSSAnimation).animationName ?? a.id),
    ),
  );
  expect(looping).toEqual([]);
});

// ---------------------------------------------------------------------------
// The new look (#255).
// ---------------------------------------------------------------------------

test("serif lives on the card-face title ONLY", async ({ page }) => {
  // The ONLY serif in the app: the drawn card's title (Georgia stack).
  // Everything around it stays the sans stack — the Draw page's own H1, the
  // stage action row, the card's description, and the Tasks page H1.
  await drawFromGoal(page, GOAL_TITLE);

  const title = page.locator(".draw-face.back h2");
  await expect(title).toHaveText(TASK_TITLE);
  expect(await fontFamilyOf(title), "card-face title is serif").toMatch(SERIF);

  // Non-vacuity for the negative half: the description IS visible and IS on
  // the same card face — serif is the title's treatment, not the face's.
  const desc = page.locator(".draw-face.back p", { hasText: TASK_DESC });
  await expect(desc).toBeVisible();
  expect(await fontFamilyOf(desc), "card description stays sans").not.toMatch(SERIF);

  expect(
    await fontFamilyOf(page.locator("h1", { hasText: "Draw a card" })),
    "Draw page H1 stays sans",
  ).not.toMatch(SERIF);
  expect(
    await fontFamilyOf(page.locator(".draw-actions button").first()),
    "stage action row stays sans",
  ).not.toMatch(SERIF);

  await page.goto("/tasks");
  const tasksH1 = page.locator("h1", { hasText: "Tasks" });
  await expect(tasksH1).toBeVisible();
  expect(await fontFamilyOf(tasksH1), "Tasks page H1 stays sans").not.toMatch(SERIF);
});

test("the deal ends with ONE gilt sheen sweep — it never loops", async ({ page }) => {
  // The casino line is the operative constraint: a glint you notice when
  // you look, not a casino. The sweep is the #124 pattern (::after with an
  // oversized background-position animation) on `.draw-face.back`, runs
  // ONCE on arrival (~900ms), and is a no-preference-only effect (the
  // reduced-motion spec above pins the "none" side).
  await drawFromGoal(page, GOAL_TITLE);

  const sweep = await page.locator(".draw-face.back").evaluate((el) => {
    const s = getComputedStyle(el, "::after");
    return {
      name: s.animationName,
      iterations: s.animationIterationCount,
      duration: parseFloat(s.animationDuration),
    };
  });
  expect(sweep.name, "the sweep exists on arrival").not.toBe("none");
  expect(sweep.iterations, "the sweep runs exactly once").toBe("1");
  expect(sweep.duration).toBeGreaterThan(0);

  // This card is impact 3 — never holo-eligible. The sweep must not smuggle
  // in a holo layer or reuse its class (fullbleed-holo owns .draw-holo).
  await expect(page.locator(".draw-holo")).toHaveCount(0);
});

test("hover tilt engages below .draw-card — the settled flip matrix survives a hovered card", async ({
  page,
}) => {
  // fullbleed-holo pins `.draw-card`'s settled transform to the exact flip
  // matrix — and Playwright's click leaves the mouse ON the card, so the
  // tilt must be a `.draw-face.back` transform (composed onto its
  // rotateY(180deg)), never a `.draw-card` one.
  await drawFromGoal(page, GOAL_TITLE);
  const card = page.locator(".draw-card");
  const face = page.locator(".draw-face.back");
  await expect(card).toHaveCSS("transform", PURE_FLIP_MATRIX);

  // Park the pointer away from the card and let the tilt RELEASE settle
  // before sampling the face's REST transform: the pointer arrives at (0,0)
  // FROM the card (drawFromGoal's click parks it there, engaging the tilt),
  // so an instant sample would capture a mid-release frame as "rest".
  // The back face's rest is its own pure rotateY(180deg) — the same matrix
  // the card pins — and toHaveCSS retries until the transition lands there.
  // [#255 implementation amendment: was an unsettled instant sample.]
  await page.mouse.move(0, 0);
  await expect(face).toHaveCSS("transform", PURE_FLIP_MATRIX);
  const rest = await face.evaluate((el) => getComputedStyle(el).transform);

  // Hover OFF-CENTER: a perspective tilt is ~zero at dead center.
  const fb = (await face.boundingBox())!;
  await page.mouse.move(fb.x + fb.width * 0.8, fb.y + fb.height * 0.25);
  await expect
    .poll(() => face.evaluate((el) => getComputedStyle(el).transform), {
      message: "the face tilts under an off-center hover",
    })
    .not.toBe(rest);

  // While tilted, `.draw-card` itself has NOT moved.
  await expect(card).toHaveCSS("transform", PURE_FLIP_MATRIX);

  // Mouse away: the tilt releases completely — no transform idles.
  await page.mouse.move(0, 0);
  await expect
    .poll(() => face.evaluate((el) => getComputedStyle(el).transform), {
      message: "the tilt releases fully at rest",
    })
    .toBe(rest);
});
