import { expect, test, type Page } from "@playwright/test";
import { resolveCurrentDraw } from "./helpers.js";

// Daily hand (#59, ADR-34): the Draw page's morning ritual — deal a small
// budgeted hand as today's plan, play a card, complete it, watch it leave the
// strip. One happy path by design; the deal algorithm, the eligibility rules
// and every pruning case live in the unit/integration suites.
test.describe.configure({ mode: "serial" });

const CARDS = [
  { title: "E2E hand — draft the agenda", effortMinutes: 20 },
  { title: "E2E hand — file the receipts", effortMinutes: 25 },
  { title: "E2E hand — water the plants", effortMinutes: 30 },
]; // 75 minutes — the whole hand fits the default 90-minute budget.

const PLAYED = CARDS[0].title;

/**
 * Make this spec's cards the ENTIRE draw pool, so a random weighted deal is
 * still a deterministic hand. The suite shares one database, and the deal
 * (unlike the draw) has no category/goal filter to scope it with.
 *
 * Blocking is reversible BY CONSTRUCTION here: every id comes from
 * GET /api/draw/pool, whose candidates are drawable — hence unblocked — so
 * restoring them to `blocked: false` returns them to exactly the state they
 * were in. (deferred_until, last_drawn_at and the rest are untouched by a
 * `blocked` PATCH.) Returns the restore function.
 */
async function isolatePool(page: Page): Promise<() => Promise<void>> {
  const pool = await (await page.request.get("/api/draw/pool")).json();
  const ids: number[] = pool.candidates.map((c: { id: number }) => c.id);
  for (const id of ids) {
    await page.request.patch(`/api/tasks/${id}`, { data: { blocked: true } });
  }
  return async () => {
    for (const id of ids) {
      await page.request.patch(`/api/tasks/${id}`, { data: { blocked: false } });
    }
  };
}

test("deal a day, play a card, complete it — and the hand only shrinks", async ({ page }) => {
  // A leftover card from an earlier spec would block the play (#88) — resolve
  // it first, then take every foreign card out of the deck.
  await resolveCurrentDraw(page);
  const restorePool = await isolatePool(page);

  const categories: { id: number }[] = await (await page.request.get("/api/categories")).json();
  const seeded: number[] = [];
  // try/finally, not a tail call: the suite shares one database and runs
  // fail-fast (retries: 0), so a failure ANYWHERE below must still hand the
  // deck back. Without it one red assertion would leave every foreign task
  // blocked and turn the rest of the run into a cascade of empty-deck
  // failures that hide the actual one.
  try {
    for (const card of CARDS) {
      const task = await (
        await page.request.post("/api/tasks", {
          data: { title: card.title, categoryId: categories[0].id, ...card },
        })
      ).json();
      seeded.push(task.id);
    }

    await page.goto("/");
    const strip = page.locator(".hand-strip");

    // No hand yet: the ritual's entry point, with the budget it will spend.
    const dealButton = strip.getByRole("button", { name: /Deal me a day/ });
    await expect(dealButton).toBeVisible();
    await expect(strip.locator(".hand-budget-input")).toHaveValue("90");

    await dealButton.click();

    // All three cards fit the budget, so the hand is exactly this spec's deck.
    await expect(strip.locator(".hand-card")).toHaveCount(3);
    for (const card of CARDS) {
      await expect(strip.getByText(card.title)).toBeVisible();
    }
    await expect(strip.getByRole("heading", { name: /Today's hand — 3 cards · 75 \/ 90 min/ })).toBeVisible();
    // Dealt is not drawn: nothing is on the table yet.
    await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
    // One hand per day — and deliberately NO redeal (ADR-34): the deal button
    // is gone and nothing has taken its place.
    await expect(dealButton).toBeHidden();
    await expect(strip.getByRole("button", { name: /redeal|deal again/i })).toHaveCount(0);

    // Play a card: it flips over WITHOUT the shuffle (it was dealt this
    // morning — there is nothing left to gamble).
    await strip.locator(".hand-card", { hasText: PLAYED }).click();
    await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
    await expect(page.locator(".draw-face.back h2")).toHaveText(PLAYED);

    // The played card IS the current draw (ADR-13) — a reload restores it.
    await page.reload();
    await expect(page.locator(".draw-face.back h2")).toHaveText(PLAYED);

    // The strip marks it in play, and the rest are locked: playing a second
    // card over a standing one would be a re-roll (#88).
    await expect(strip.locator(".hand-card.in-play")).toContainText(PLAYED);
    await expect(strip.locator(".hand-card", { hasText: CARDS[1].title })).toBeDisabled();

    // Complete it from the card's own actions: it leaves the strip for good.
    await page.locator(".draw-actions").getByRole("button", { name: "✓ Done" }).click();
    await expect(strip.locator(".hand-card")).toHaveCount(2);
    await expect(strip.getByText(PLAYED)).toHaveCount(0);
    await expect(strip.getByRole("heading", { name: /Today's hand — 2 cards · 55 \/ 90 min/ })).toBeVisible();
    // The deck is idle again, so the remaining cards are playable once more.
    await expect(strip.locator(".hand-card", { hasText: CARDS[1].title })).toBeEnabled();
    // Still no second deal: today's hand stands.
    await expect(dealButton).toBeHidden();

    // "Not now" on a hand card takes it out of the deck AND out of the hand
    // (ADR-17) — the honest escape from a card you do not want, and the only
    // one: the hand shrinks, it never re-deals.
    await strip.locator(".hand-card", { hasText: CARDS[1].title }).click();
    await expect(page.locator(".draw-face.back h2")).toHaveText(CARDS[1].title);
    await page.getByRole("button", { name: "💤 Not now" }).click();
    await page.getByRole("button", { name: /Tomorrow/ }).click();
    await expect(strip.locator(".hand-card")).toHaveCount(1);
    await expect(strip.getByText(CARDS[1].title)).toHaveCount(0);

    // Coexistence check (#59 × #118): a played hand card writes THROUGH to the
    // persisted current draw, so completing it from another surface — the
    // TimerBar here — must dismiss BOTH the standing card (the derived view,
    // #110) and the strip card (the ['hand'] invalidation), with no second
    // ✓ Done and nothing left held open. Same "resolved elsewhere" path the
    // #118 residue fix hardened, now exercised through a hand card.
    await strip.locator(".hand-card", { hasText: CARDS[2].title }).click();
    await expect(page.locator(".draw-face.back h2")).toHaveText(CARDS[2].title);
    // Start the timer from the card, Escape the focus overlay: the TimerBar
    // now runs NEXT TO the still-revealed card.
    await page.locator(".draw-actions").getByRole("button", { name: "▶ Start now" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
    // Complete from the TimerBar — the "elsewhere" surface, not the card's own
    // ✓ Done.
    await page.locator(".timer-bar").getByRole("button", { name: "✓ Done" }).click();
    // The standing card leaves on its own — no reload, no click on the card.
    await expect(page.locator(".draw-card")).not.toHaveClass(/flipped/);
    await expect(page.getByText("click to draw")).toBeVisible();
    // ...and so does the strip card: the hand is spent, played out (ADR-34 —
    // no redeal; a fresh one comes tomorrow).
    await expect(strip.locator(".hand-card")).toHaveCount(0);
    await expect(strip.getByText(/Today's hand is played out/)).toBeVisible();
    // The pointer is truly gone server-side — nothing to resurrect on reload.
    expect(await (await page.request.get("/api/draw/current")).json()).toBeNull();

  } finally {
    // Shared-DB hygiene. This spec seeds root tasks and completes one, so
    // without cleanup its cards would linger in every later spec's Tasks page,
    // draw pool, Snoozed section, trophy pile and history skyline. Deleting
    // the tasks takes their completions with them (ON DELETE CASCADE), which
    // is the only way to un-earn the XP a completion mints — and it prunes the
    // hand down to empty on the way out (#59's dangling-id sweep).
    for (const id of seeded) await page.request.delete(`/api/tasks/${id}`);
    await restorePool();
  }
});
