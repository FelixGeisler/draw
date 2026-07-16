import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { drawFromGoal } from "./helpers.js";

// Issue #124: achievements render as collectible cards with rarity tiers.
// Presentation only — no unlock logic, schema or payload changed (ADR-5) — so
// everything here is asserted against REAL unlocks flowing through the normal
// completeTask path.
//
// Shares the serial E2E database, and Playwright runs spec files
// alphabetically — which pins this FILENAME between two neighbours:
//   * AFTER core-journey.spec.ts ("core-" < "earned-"), which asserts a
//     pristine "0 XP" / "Lv 1" before its own first completion; a completion
//     from here would break it. The same implicit rule already keeps
//     trophy-*.spec.ts honest.
//   * BEFORE fullbleed-holo.spec.ts ("earned-" < "fullbleed-"), which
//     completes a 5★ goal-linked task carrying a future due date — i.e. it
//     unlocks early_bird as a side effect. An achievement unlocks exactly ONCE
//     (append-only table), so the fresh-unlock toast asserted below belongs to
//     whichever spec reaches it first. Nothing earlier can take it: early_bird
//     needs a due date, and no spec before this one sets one.
// early_bird is the only tier this file can honestly earn at this point in the
// run; streak_30 is its mirror — 30 completed days is unreachable in E2E, so
// it is permanently the locked, face-down example.
test.describe.configure({ mode: "serial" });

const GOAL = "Collectible early bird goal";
const TASK = "Collectible early bird card";

function card(page: Page, key: string) {
  return page.locator(`.ach-card[data-key="${key}"]`);
}

/** Computed background of a card's sheen overlay pseudo-element. */
function sheen(page: Page, key: string) {
  return card(page, key)
    .locator(".ach-card-inner")
    .evaluate((el) => ({
      image: getComputedStyle(el, "::after").backgroundImage,
      animation: getComputedStyle(el, "::after").animationName,
    }));
}

test("unlocking deals the achievement as a card in the toast", async ({ page }) => {
  const goal = await (await page.request.post("/api/goals", { data: { title: GOAL } })).json();
  const categories: { id: number }[] = await (await page.request.get("/api/categories")).json();
  const due = new Date();
  due.setDate(due.getDate() + 3);
  const task = await (
    await page.request.post("/api/tasks", {
      data: {
        title: TASK,
        categoryId: categories[0].id,
        goalId: goal.id,
        impact: 5, // a 5★ goal-linked task finished before its due date == early_bird
        effortMinutes: 5,
        dueDate: due.toISOString().slice(0, 10),
      },
    })
  ).json();

  await drawFromGoal(page, GOAL);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK);
  await page.getByRole("button", { name: "✓ Done" }).click();

  // The heading stays real text — the card face is paint, and the toast has to
  // mean something to a screen reader (core-journey.spec.ts pins it too).
  await expect(page.getByText("🏆 Achievement unlocked").first()).toBeVisible();

  // The unlock presents the actual card, not a text line. Scoped to THIS
  // toast: a run where the suite's earlier specs have not already claimed
  // first_draw / first_completion stacks several toasts at once.
  const toast = page.locator(".ach-toast", {
    has: page.locator('.ach-card[data-key="early_bird"]'),
  });
  const toastCard = toast.locator(".ach-card");
  await expect(toastCard).toBeVisible();
  await expect(toastCard).toHaveAttribute("data-rarity", "rare");
  await expect(toastCard.locator(".ach-art")).toBeVisible();
  await expect(toastCard.locator(".ach-name")).toHaveText("Early bird");

  // The card is dealt face-down and flipped: it lands face-up.
  await expect(toast.locator(".ach-toast-flip")).toHaveClass(/revealed/);

  // Hand the shared DB back as we found it. Reopening deletes the latest
  // completion (the documented undo invariant), which keeps today's trophy
  // pile — asserted card-by-card in trophy-pile.spec.ts, and geometry-sensitive
  // once the row wraps — exactly the size the rest of the suite expects; the
  // XP goes with it. The achievement itself STAYS unlocked, because the
  // achievements table is append-only (ADR-5) — which is precisely what lets
  // the grid tests below still find an earned rare card. Archiving afterwards
  // keeps this task out of everyone else's deck.
  const reopen = await page.request.patch(`/api/tasks/${task.id}`, { data: { status: "open" } });
  expect(reopen.ok()).toBe(true);
  const archive = await page.request.patch(`/api/tasks/${task.id}`, { data: { status: "archived" } });
  expect(archive.ok()).toBe(true);
});

test("the collection shows earned cards face-up and unearned ones face-down with the hint", async ({
  page,
}) => {
  await page.goto("/stats");

  // Earned: face-up — art, name, earned date, no criteria line.
  const earned = card(page, "early_bird");
  await expect(earned).toHaveClass(/unlocked/);
  await expect(earned.locator(".ach-art")).toBeVisible();
  await expect(earned.locator(".ach-name")).toHaveText("Early bird");
  await expect(earned.locator(".ach-date")).toContainText("unlocked 20");
  await expect(earned.locator(".ach-hint")).toHaveCount(0);

  // Unearned: face-down — but the criteria stay readable (the issue's
  // deliberate openness; no "???" mystery cards) and the art stays behind it
  // as a silhouette rather than being dropped.
  const unearned = card(page, "streak_30");
  await expect(unearned).toHaveClass(/locked/);
  await expect(unearned.locator(".ach-name")).toHaveText("Unstoppable");
  await expect(unearned.locator(".ach-hint")).toHaveText("30 completed days in one unbroken streak.");
  await expect(unearned.locator(".ach-date")).toHaveCount(0);
  await expect(unearned.locator(".ach-art")).toBeVisible();

  // Card-shaped tiles, not panels: portrait, the draw card's 5:7 ratio.
  const box = (await earned.boundingBox())!;
  expect(box.height).toBeGreaterThan(box.width);
  expect(box.height / box.width).toBeCloseTo(7 / 5, 1);

  // The rejected TCG frame stays dead on these cards too (#123/ADR-33).
  await expect(earned.locator(".trophy-stars, .cf-frame, .cf-stats")).toHaveCount(0);
  await expect(earned).not.toContainText("ATK");
  await expect(earned).not.toContainText("DEF");
});

test("rarity grades the sheen: legendary tiered, common plain", async ({ page }) => {
  await page.goto("/stats");

  // Same assertion style as trophy-rarity.spec.ts: the tier is a class, and
  // "common" is the ABSENCE of one — plain is no sheen, not a tier of one.
  await expect(card(page, "streak_30")).toHaveClass(/rarity-legendary/);
  await expect(card(page, "deck_clearer")).toHaveClass(/rarity-legendary/);
  await expect(card(page, "level_10")).toHaveClass(/rarity-epic/);
  await expect(card(page, "early_bird")).toHaveClass(/rarity-rare/);
  await expect(card(page, "first_draw")).not.toHaveClass(/rarity-/);
  await expect(card(page, "first_completion")).not.toHaveClass(/rarity-/);

  // An EARNED rare paints a real sheen...
  expect((await sheen(page, "early_bird")).image).toContain("linear-gradient");

  // ...an earned common paints none at all (first_draw is unlocked by the
  // core journey's very first click).
  await expect(card(page, "first_draw")).toHaveClass(/unlocked/);
  expect((await sheen(page, "first_draw")).image).toBe("none");

  // An UNEARNED card never shimmers, however legendary it will be: the reward
  // has not been earned yet.
  expect((await sheen(page, "streak_30")).image).toBe("none");
});

test("reduced motion keeps the sheen painted but still", async ({ page }) => {
  await page.goto("/stats");
  const earned = card(page, "early_bird");
  await earned.scrollIntoViewIfNeeded();

  // Motion is gated behind no-preference, so reduced motion stills the sweep
  // without touching the paint (the #62/#123 pattern).
  await page.emulateMedia({ reducedMotion: "reduce" });
  await earned.hover();
  const still = await sheen(page, "early_bird");
  expect(still.animation).toBe("none");
  expect(still.image).toContain("linear-gradient");

  // The toast's flip is motion too: no transition under reduced motion, so an
  // unlock is a static appear rather than a spin.
  const flipTransition = await page.evaluate(() => {
    const d = document.createElement("div");
    d.className = "ach-toast-flip";
    document.body.append(d);
    const t = getComputedStyle(d).transitionDuration;
    d.remove();
    return t;
  });
  expect(flipTransition).toBe("0s");
});
