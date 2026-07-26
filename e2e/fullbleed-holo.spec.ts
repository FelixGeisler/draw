import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { drawFromGoal, resolveCurrentDraw } from "./helpers.js";

// Issue #123 (supersedes the #115 TCG frame, ADR-33): the drawn card and the
// trophy-pile cards carry their info as the app's subtle chips — category
// pill (computed WCAG ink), effort chip, impact stars, due/window badges —
// with the generated art as the FULL-BLEED background of the whole card face
// under a legibility scrim, and an iridescent holo shimmer on drawn 5★
// goal-linked cards (static under prefers-reduced-motion). No TCG furniture
// anywhere: no ATK/DEF stat box, no type line, no level-star row.
//
// E2E runs AI-degraded (no API key), so art can never be GENERATED here; the
// two art-presence tests stub the art GET endpoints at the network level —
// the sanctioned degraded seam — to exercise the client's full-bleed
// rendering with a deterministic SVG. Shares the serial E2E database; every
// assertion scopes to this file's uniquely-titled cards.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "Fullbleed holo goal";
const HOLO_TITLE = "Fullbleed five star holo card";
const HOLO_DESC = "A well-described high-leverage endeavor.";
const CHORE_CATEGORY = "Fullbleed chores";
const CHORE_TITLE = "Fullbleed three star chore";
const LONG_GOAL_TITLE = "Fullbleed long content goal";
// PR #125 review repro: a sentence-length title (AI-generated tasks routinely
// have them) plus a paragraph description used to overflow the fixed face.
const LONG_TITLE =
  "Rehearse the two-minute demo flow until the transitions feel effortless and every screen state is preloaded before the call";
const LONG_DESC =
  "Run the full flow twice with the projector profile active. Preload the draw page, the goals board and the history calendar in separate tabs, confirm the seeded demo deck still matches the script, and note every place where a transition stutters or a tooltip lingers. Then run it once more cold, phone on the desk, narrating out loud at presentation pace to catch the spots where the story outruns the screen.";

// Deterministic stand-in for generated art: visibly non-gradient, fine to
// serve from a route stub (the client renders it as an <img> data URI).
const ART_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 420'>" +
  "<rect width='300' height='420' fill='#274060'/>" +
  "<circle cx='150' cy='210' r='90' fill='#89b4fa'/></svg>";

let holoTaskId: number;
let categoryName: string;
let categoryRgb: string;

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

async function seedHoloCard(request: APIRequestContext) {
  const goal = await (await request.post("/api/goals", { data: { title: GOAL_TITLE } })).json();
  const categories: { id: number; name: string; color: string }[] = await (
    await request.get("/api/categories")
  ).json();
  categoryName = categories[0].name;
  categoryRgb = hexToRgb(categories[0].color);
  const task = await (
    await request.post("/api/tasks", {
      data: {
        title: HOLO_TITLE,
        description: HOLO_DESC,
        categoryId: categories[0].id,
        goalId: goal.id,
        impact: 5,
        effortMinutes: 12,
        dueDate: "2026-07-30",
      },
    })
  ).json();
  holoTaskId = task.id;
}

/** Serve the per-task art GET (degraded 503 otherwise) with the stub SVG.
 *  Anchored regex: never catches the POST …/card-art/regenerate. */
async function stubDrawnCardArt(page: Page) {
  await page.route(/\/api\/tasks\/\d+\/card-art$/, (route) =>
    route.fulfill({ json: { svg: ART_SVG } }),
  );
}

test("drawn 5★ goal-linked card: chips carry the info, holo shimmers, no TCG furniture", async ({
  page,
}) => {
  await seedHoloCard(page.request);
  await drawFromGoal(page, GOAL_TITLE);

  const back = page.locator(".draw-face.back");
  await expect(back.locator("h2")).toHaveText(HOLO_TITLE);

  // The info is the app's subtle chips again: category pill (raw category
  // color as background, ink the COMPUTED WCAG choice — for the seeded
  // #4f8cff that is the dark ink; lib/cardVisuals unit tests pin the choice
  // per color), effort chip, due badge, impact stars (goal-linked, ADR-4).
  const pill = back.locator(".category-pill");
  await expect(pill).toHaveText(categoryName);
  await expect(pill).toHaveCSS("background-color", categoryRgb);
  await expect(back.locator(".chip", { hasText: "12 min" })).toBeVisible();
  await expect(back.locator(".chip", { hasText: "due 2026-07-30" })).toBeVisible();
  await expect(back.locator("[title='Impact 5/5']")).toBeVisible();
  await expect(back.getByText(HOLO_DESC)).toBeVisible();

  // The TCG furniture is gone — no stat box, no literal ATK/DEF, no type
  // line, no level-star row, no frame element at all.
  await expect(back.getByText(/ATK\/|DEF\//)).toHaveCount(0);
  for (const dead of [".card-frame", ".cf-stats", ".cf-atk", ".cf-def", ".cf-type-line", ".cf-stars"]) {
    await expect(page.locator(dead)).toHaveCount(0);
  }

  // Holo (#123): drawn 5★ goal-linked → the iridescent overlay paints and
  // its slow drift runs.
  const holo = back.locator(".draw-holo");
  await expect(holo).toBeVisible();
  await expect(holo).toHaveCSS("animation-name", "holo-drift");
  const bg = await holo.evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(bg).toContain("linear-gradient");

  // prefers-reduced-motion: the shimmer freezes but the sheen stays painted.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(holo).toHaveCSS("animation-name", "none");
  expect(await holo.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
    "linear-gradient",
  );

  // Degraded mode (E2E has no API key): no art layers, no regenerate — the
  // face's own gradient stands alone and still reads intentional (#27).
  await expect(page.locator(".draw-art")).toHaveCount(0);
  await expect(page.locator(".draw-art-scrim")).toHaveCount(0);
  await expect(page.locator(".draw-art-regen")).toHaveCount(0);
});

test("art is the FULL-BLEED background of the whole card face, under a legibility scrim", async ({
  page,
}) => {
  // The card from the previous test is still the persisted current draw; a
  // fresh page load refetches its art — served by the stub this time.
  await stubDrawnCardArt(page);
  await page.goto("/");
  const back = page.locator(".draw-face.back");
  await expect(back.locator("h2")).toHaveText(HOLO_TITLE); // restored (#25)
  // Let the restore's flip transition SETTLE before measuring geometry —
  // toHaveCSS retries until the 0.65s rotateY lands on its final matrix.
  await expect(page.locator(".draw-card")).toHaveCSS(
    "transform",
    "matrix3d(-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1)",
  );

  // Full bleed: the art <img> spans the entire card face, not a window.
  // Tolerance covers the face's 1px border (inset: 0 positions against the
  // padding box) plus sub-pixel rounding under the 3D flip transform.
  const art = page.locator(".draw-art");
  await expect(art).toBeVisible();
  const artBox = (await art.boundingBox())!;
  const faceBox = (await back.boundingBox())!;
  expect(Math.abs(artBox.x - faceBox.x)).toBeLessThanOrEqual(4);
  expect(Math.abs(artBox.y - faceBox.y)).toBeLessThanOrEqual(4);
  expect(Math.abs(artBox.width - faceBox.width)).toBeLessThanOrEqual(4);
  expect(Math.abs(artBox.height - faceBox.height)).toBeLessThanOrEqual(4);

  // The legibility scrim sits between art and text, and the chips keep a
  // solid backing — text never sits raw on art.
  const scrim = page.locator(".draw-art-scrim");
  await expect(scrim).toBeVisible();
  expect(await scrim.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
    "linear-gradient",
  );
  await expect(back.locator(".chip", { hasText: "12 min" })).toBeVisible();

  // With art present the #113 regenerate control returns, and the holo
  // still composes above the art.
  await expect(page.getByRole("button", { name: "Regenerate artwork" })).toBeVisible();
  await expect(back.locator(".draw-holo")).toBeVisible();
});

test("the focus view keeps exactly the category pill — essentials plus clock, no card chrome", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".draw-face.back h2")).toHaveText(HOLO_TITLE);
  await page.getByRole("button", { name: "▶ Start now" }).click();

  const overlay = page.locator(".focus-overlay");
  await expect(overlay).toBeVisible();
  const pill = overlay.locator(".category-pill");
  await expect(pill).toHaveText(categoryName);
  await expect(pill).toHaveCSS("background-color", categoryRgb);
  // Deliberately no art and no holo inside the overlay: focus mode stays
  // "card essentials and the clock" (#56).
  await expect(overlay.locator(".draw-art")).toHaveCount(0);
  await expect(overlay.locator(".draw-holo")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(overlay).not.toBeVisible();
  await page.request.post("/api/timer/stop");
});

test("completing the drawn 5★ mints a holo trophy with a full-bleed art face", async ({
  page,
}) => {
  // Batch pile art (#114, cache-only server-side) served by the stub: only
  // this file's card gets art — every other completion keeps its gradient.
  await page.route(/\/api\/card-art\?taskIds=/, (route) =>
    route.fulfill({ json: { arts: [{ taskId: holoTaskId, svg: ART_SVG }] } }),
  );
  await page.goto("/");
  await expect(page.locator(".draw-face.back h2")).toHaveText(HOLO_TITLE);
  await page.getByRole("button", { name: "✓ Done" }).click();

  const trophy = page.locator(".trophy-card", { hasText: HOLO_TITLE });
  await expect(trophy).toBeVisible();

  // Drawn impact-5 → the holo tier (replacing #107's foil), announced in the
  // aria-label after the (drawn) XP part, painted as the sheen overlay.
  await expect(trophy).toHaveClass(/rarity-holo/);
  await expect(trophy).toHaveAttribute("aria-label", /XP \(drawn\), holo$/);
  const sheen = await trophy.evaluate(
    (el) => getComputedStyle(el.querySelector(".trophy-card-inner")!, "::after").backgroundImage,
  );
  expect(sheen).toContain("linear-gradient");

  // Full-bleed face: the cached art spans the whole card, under the scrim.
  const inner = trophy.locator(".trophy-card-inner");
  const art = trophy.locator(".trophy-art");
  await expect(art).toBeVisible();
  const artBox = (await art.boundingBox())!;
  const innerBox = (await inner.boundingBox())!;
  expect(Math.abs(artBox.width - innerBox.width)).toBeLessThanOrEqual(4);
  expect(Math.abs(artBox.height - innerBox.height)).toBeLessThanOrEqual(4);
  await expect(trophy.locator(".trophy-art-scrim")).toBeVisible();

  // Chips instead of furniture on the pile too: no level-star row, no type
  // line — the footer time chip stays readable collapsed (#114), and the
  // lift reveals the shared category pill.
  await expect(trophy.locator(".trophy-stars")).toHaveCount(0);
  await expect(trophy.locator(".cf-type-line")).toHaveCount(0);
  await expect(trophy.locator(".trophy-time")).toHaveText(/\d{1,2}:\d{2}/);
  await trophy.scrollIntoViewIfNeeded();
  await trophy.hover();
  const pill = trophy.locator(".trophy-details .category-pill");
  await expect(pill).toHaveText(categoryName);
  await expect(pill).toHaveCSS("background-color", categoryRgb);
});

test("a 3★ chore never shimmers: chips only, no holo on the card or its trophy", async ({
  page,
}) => {
  // A category of its own makes the category-filtered draw deterministic;
  // the pale color pins the pill's computed DARK ink (#120's contrast math,
  // kept by #123).
  const category = await (
    await page.request.post("/api/categories", {
      data: { name: CHORE_CATEGORY, color: "#ffb64f" },
    })
  ).json();
  await page.request.post("/api/tasks", {
    data: { title: CHORE_TITLE, categoryId: category.id, effortMinutes: 7 },
  });

  await resolveCurrentDraw(page);
  await page.goto("/");
  await page.locator(".draw-filters .chip", { hasText: CHORE_CATEGORY }).click();
  await page.locator(".draw-face.front").click();
  const back = page.locator(".draw-face.back");
  await expect(back.locator("h2")).toHaveText(CHORE_TITLE);

  // Subtle chips, degraded-grace: effort chip, pale pill with dark ink; no
  // goal → no impact stars (ADR-4), no description → no paragraph.
  await expect(back.locator(".chip", { hasText: "7 min" })).toBeVisible();
  const pill = back.locator(".category-pill");
  await expect(pill).toHaveText(CHORE_CATEGORY);
  await expect(pill).toHaveCSS("background-color", hexToRgb("#ffb64f"));
  await expect(pill).toHaveCSS("color", "rgb(18, 20, 26)");
  await expect(back.locator("[title*='Impact']")).toHaveCount(0);

  // 3★, not goal-linked → no shimmer on the standing card…
  await expect(back.locator(".draw-holo")).toHaveCount(0);

  // …and a plain trophy after completing it (drawn, but not high-leverage).
  await page.getByRole("button", { name: "✓ Done" }).click();
  const trophy = page.locator(".trophy-card", { hasText: CHORE_TITLE });
  await expect(trophy).toBeVisible();
  await expect(trophy).not.toHaveClass(/rarity-/);
  const sheen = await trophy.evaluate(
    (el) => getComputedStyle(el.querySelector(".trophy-card-inner")!, "::after").backgroundImage,
  );
  expect(sheen).toBe("none");
});

test("long content stays INSIDE the fixed face — the content block scrolls, nothing paints over the page", async ({
  page,
}) => {
  // PR #125 review (blocker): with a long title + description the centered,
  // unclamped content block grew taller than the 300x420 face and painted
  // over the filter chips above and the ✓ Done / 💤 Not now buttons below.
  // The fix keeps the deleted CardFrame's contract: long content scrolls
  // inside the card instead of blowing the frame.
  const goal = await (
    await page.request.post("/api/goals", { data: { title: LONG_GOAL_TITLE } })
  ).json();
  const categories: { id: number }[] = await (await page.request.get("/api/categories")).json();
  await page.request.post("/api/tasks", {
    data: {
      title: LONG_TITLE,
      description: LONG_DESC,
      categoryId: categories[0].id,
      goalId: goal.id,
      impact: 5,
      effortMinutes: 10,
      // A PAST due date since #205: on a RECURRING task the due date is the
      // next occurrence and a future one keeps the card out of the deck. The
      // chips under test (due + ↻) are unchanged — this spec is about
      // geometry, and it still needs the fullest possible card.
      dueDate: "2026-01-15",
      recurEveryDays: 7,
    },
  });
  await drawFromGoal(page, LONG_GOAL_TITLE);

  const back = page.locator(".draw-face.back");
  await expect(back.locator("h2")).toHaveText(LONG_TITLE);
  // Let the flip transition SETTLE before measuring geometry (see above).
  await expect(page.locator(".draw-card")).toHaveCSS(
    "transform",
    "matrix3d(-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1)",
  );

  // This content IS taller than the face — the wrapper must be scrollable…
  const content = back.locator(".draw-card-content");
  expect(await content.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  // …with everything geometrically contained: the title's first line no
  // longer paints above the card over the category filter chips, and the
  // pill is not pushed off the face.
  const faceBox = (await back.boundingBox())!;
  const titleBox = (await back.locator("h2").boundingBox())!;
  expect(titleBox.y).toBeGreaterThanOrEqual(faceBox.y - 1);
  const pillBox = (await back.locator(".category-pill").boundingBox())!;
  expect(pillBox.y).toBeGreaterThanOrEqual(faceBox.y - 1);
  // …and LEGIBLE, not just contained: without flex-shrink: 0 the pill's
  // overflow: hidden zeroes its min-content floor and the scroll wrapper
  // crushes it to a ~6px sliver with the text clipped away (PR #125
  // review, second round). One intact text line is ~22px.
  expect(pillBox.height).toBeGreaterThan(15);

  // Scrolled to the end, the badges and the odds line sit above the face's
  // bottom edge instead of on top of the ✓ Done / 💤 Not now buttons.
  await content.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(back.locator(".chip", { hasText: "overdue 2026-01-15" })).toBeVisible();
  await expect(back.locator(".chip", { hasText: "↻ 7d" })).toBeVisible();
  const chanceBox = (await back.locator(".draw-chance").boundingBox())!;
  expect(chanceBox.y).toBeGreaterThanOrEqual(faceBox.y - 1);
  expect(chanceBox.y + chanceBox.height).toBeLessThanOrEqual(faceBox.y + faceBox.height + 1);
});
