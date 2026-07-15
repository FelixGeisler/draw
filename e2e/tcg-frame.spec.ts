import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { drawFromGoal, resolveCurrentDraw } from "./helpers.js";

// Issue #115: the drawn card renders as a TCG frame with the canonical
// attribute mapping — level stars = impact (goal-linked only, ADR-4), type
// line = category (colored pill, computed ink), ATK = estimated minutes,
// DEF = tracked minutes, flavor text = description — and degrades gracefully:
// a bare chore drops stars/flavor, an estimate edited away drops ATK, and the
// AI-degraded E2E environment always exercises the gradient art placeholder.
// Shares the serial E2E database; every assertion scopes to this file's
// uniquely-titled cards.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "TCG frame goal";
const FULL_TITLE = "TCG frame full attribute card";
const FULL_DESC = "Flavor text: a well-described endeavor.";
const CHORE_CATEGORY = "TCG chores";
const CHORE_TITLE = "TCG frame bare chore";

let categoryName: string;
let categoryRgb: string;

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

async function seedFullCard(request: APIRequestContext) {
  const goal = await (await request.post("/api/goals", { data: { title: GOAL_TITLE } })).json();
  const categories: { id: number; name: string; color: string }[] = await (
    await request.get("/api/categories")
  ).json();
  categoryName = categories[0].name;
  categoryRgb = hexToRgb(categories[0].color);
  await request.post("/api/tasks", {
    data: {
      title: FULL_TITLE,
      description: FULL_DESC,
      categoryId: categories[0].id,
      goalId: goal.id,
      impact: 4,
      effortMinutes: 12,
    },
  });
}

test("fully-attributed card: name bar, level stars, type line, ATK/DEF, flavor", async ({
  page,
}) => {
  await seedFullCard(page.request);
  await drawFromGoal(page, GOAL_TITLE);

  const frame = page.locator(".draw-face.back .card-frame");
  await expect(frame).toBeVisible();

  // Name bar — the title stays an h2, the pinned selector across the suite.
  await expect(page.locator(".draw-face.back h2")).toHaveText(FULL_TITLE);

  // Level stars = impact (goal-linked, so they render), with the value in
  // the accessible title.
  await expect(frame.locator(".cf-stars")).toBeVisible();
  await expect(frame.locator(".cf-stars [title='Impact 4/5']")).toBeVisible();

  // Type line = category: the category color as background, the ink a
  // COMPUTED WCAG choice (lib/cardFrame.ts — for the seeded #4f8cff that is
  // the dark ink; the unit tests pin the choice per color).
  const typeLine = frame.locator(".cf-type-line");
  await expect(typeLine).toHaveText(categoryName);
  await expect(typeLine).toHaveCSS("background-color", categoryRgb);

  // ATK = estimated minutes, DEF = tracked minutes (nothing tracked yet).
  await expect(frame.locator(".cf-atk")).toHaveText("ATK/12");
  await expect(frame.locator(".cf-def")).toHaveText("DEF/0");

  // Flavor text = description, small italics in the text box.
  const flavor = frame.locator(".cf-flavor");
  await expect(flavor).toHaveText(FULL_DESC);
  await expect(flavor).toHaveCSS("font-style", "italic");

  // The estimate lives in ATK alone — the old "N min" chip would duplicate it.
  await expect(page.locator(".draw-face.back").getByText("12 min")).toHaveCount(0);

  // Degraded mode (E2E has no API key): the portrait art window renders the
  // gradient placeholder — frame intentional, no art layers, no regenerate.
  await expect(frame.locator(".cf-art")).toBeVisible();
  await expect(page.locator(".draw-art")).toHaveCount(0);
  await expect(page.locator(".draw-art-scrim")).toHaveCount(0);
  await expect(page.locator(".draw-art-regen")).toHaveCount(0);
});

test("the focus view adopts exactly the type-line pill — essentials plus clock, no full frame", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".draw-face.back h2")).toHaveText(FULL_TITLE); // restored (#25)
  await page.getByRole("button", { name: "▶ Start now" }).click();

  const overlay = page.locator(".focus-overlay");
  await expect(overlay).toBeVisible();
  const pill = overlay.locator(".cf-type-line");
  await expect(pill).toHaveText(categoryName);
  await expect(pill).toHaveCSS("background-color", categoryRgb);
  // Deliberately NOT the full frame: focus mode stays "card essentials and
  // the clock" (#56) — no stat line, no art window inside the overlay.
  await expect(overlay.locator(".cf-stats")).toHaveCount(0);
  await expect(overlay.locator(".cf-art")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(overlay).not.toBeVisible();
  await page.request.post("/api/timer/stop");
});

test("completing the card mints a mini-frame trophy: stars, pill, time footer, sheen over art", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".draw-face.back h2")).toHaveText(FULL_TITLE);
  await page.getByRole("button", { name: "✓ Done" }).click();

  const trophy = page.locator(".trophy-card", { hasText: FULL_TITLE });
  await expect(trophy).toBeVisible();

  // Level stars on the mini-frame (goal-linked completion), collapsed too.
  await expect(trophy.locator(".trophy-stars [title='Impact 4/5']")).toBeVisible();

  // Completion time sits in the always-visible footer — no lift required.
  await expect(trophy.locator(".trophy-time")).toHaveText(/\d{1,2}:\d{2}/);

  // Drawn impact-4 => the #107 silver sheen composes above the mini-frame.
  await expect(trophy).toHaveClass(/rarity-silver/);

  // Lift reveals the type-line pill with the category color.
  await trophy.scrollIntoViewIfNeeded();
  await trophy.hover();
  const pill = trophy.locator(".trophy-details .cf-type-line");
  await expect(pill).toHaveText(categoryName);
  await expect(pill).toHaveCSS("background-color", categoryRgb);
});

test("bare chore: no stars, no flavor — and an estimate edited away drops ATK", async ({
  page,
}) => {
  // A category of its own makes the category-filtered draw deterministic.
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
  await expect(page.locator(".draw-face.back h2")).toHaveText(CHORE_TITLE);

  const frame = page.locator(".draw-face.back .card-frame");
  // No goal -> no star row (ADR-4); no description -> no flavor text.
  await expect(frame.locator(".cf-stars")).toHaveCount(0);
  await expect(frame.locator(".cf-flavor")).toHaveCount(0);
  // The frame still reads intentional: type line (pale color -> dark ink,
  // the computed choice), art placeholder, and both stats.
  const typeLine = frame.locator(".cf-type-line");
  await expect(typeLine).toHaveText(CHORE_CATEGORY);
  await expect(typeLine).toHaveCSS("background-color", hexToRgb("#ffb64f"));
  await expect(typeLine).toHaveCSS("color", "rgb(18, 20, 26)");
  await expect(frame.locator(".cf-art")).toBeVisible();
  await expect(frame.locator(".cf-atk")).toHaveText("ATK/7");
  await expect(frame.locator(".cf-def")).toHaveText("DEF/0");

  // Editing the estimate away (#88's sanctioned escape keeps the card in the
  // session): ATK disappears, DEF stays — no estimate, no ATK.
  await page.getByRole("button", { name: "✎ Edit" }).click();
  await page.getByTitle("Effort estimate in minutes").fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(frame.locator(".cf-atk")).toHaveCount(0);
  await expect(frame.locator(".cf-def")).toHaveText("DEF/0");
  await expect(page.locator(".draw-hint")).toContainText("out of the deck");
});
