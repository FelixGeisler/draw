import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { resolveCurrentDraw } from "./helpers.js";

// Warm-up draw (#57, ADR-30): the idle deck offers a secondary button that
// deterministically deals the smallest eligible card, marked with a badge;
// completing it pays the warm-up bonus and the button stays disabled until
// the next allowance window. Cheap by design — the selection matrix and XP
// rules live in unit/integration tests.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "E2E warmup goal";
const SMALL_TASK = "Sharpen one pencil";
const BIG_TASK = "Reorganize the whole desk";

async function seed(request: APIRequestContext) {
  const goal = await (await request.post("/api/goals", { data: { title: GOAL_TITLE } })).json();
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  const ids: Record<string, number> = {};
  // The small card gets impact 5 on purpose: a drawn impact-5 completion
  // mints a foil trophy (#62) — the deal below must NOT (ADR-30).
  for (const [title, effortMinutes, impact] of [
    [SMALL_TASK, 5, 5],
    [BIG_TASK, 25, 3],
  ] as const) {
    const task = await (
      await request.post("/api/tasks", {
        data: { title, categoryId: categories[0].id, goalId: goal.id, effortMinutes, impact },
      })
    ).json();
    ids[title] = task.id;
  }
  return ids;
}

test("warm-up deals the smallest card with its badge; completing pays the bonus and spends the allowance", async ({
  page,
}) => {
  const ids = await seed(page.request);
  await resolveCurrentDraw(page);
  await page.goto("/");
  await page.locator(".draw-filters select").selectOption({ label: `🎯 ${GOAL_TITLE}` });

  const warmupButton = page.getByRole("button", { name: /Warm-up — deal my smallest card/ });
  await expect(warmupButton).toBeEnabled();
  await warmupButton.click();

  // Deterministic: the 5-minute card, never the 25-minute one.
  await expect(page.locator(".draw-card")).toHaveClass(/flipped/);
  await expect(page.locator(".draw-face.back h2")).toHaveText(SMALL_TASK);
  await expect(page.locator(".warmup-chip")).toHaveText("🔰 Warm-up");
  await expect(page.getByText("finish within ~15 min for a bonus")).toBeVisible();
  // A deal has no odds — the draw-chance line must not render.
  await expect(page.locator(".draw-chance")).not.toBeVisible();
  // The button left with the idle deck: a revealed card cannot be re-rolled.
  await expect(warmupButton).not.toBeVisible();

  // The dealt card is the persisted current draw: badge survives a reload.
  await page.reload();
  await expect(page.locator(".draw-face.back h2")).toHaveText(SMALL_TASK);
  await expect(page.locator(".warmup-chip")).toBeVisible();

  // Complete it: XP bonus feedback appears with the confetti…
  await page.getByRole("button", { name: "✓ Done" }).click();
  await expect(page.getByText("🔰 Warm-up bonus: +25% XP")).toBeVisible();

  // The trophy stays PLAIN although the card is impact 5: it was handed out,
  // not gambled, so no foil rarity and no "(drawn)" in the label (ADR-30).
  const trophy = page.locator(".trophy-card", { hasText: SMALL_TASK });
  await expect(trophy).toBeVisible();
  await expect(trophy).not.toHaveClass(/rarity-/);
  await expect(trophy).toHaveAttribute("aria-label", /XP$/);

  // …and the allowance is spent: disabled button plus the countdown hint.
  await expect(warmupButton).toBeDisabled();
  await expect(page.getByText(/next warm-up at/)).toBeVisible();

  // Shared-DB hygiene: the completion above arms momentum (×1.25) for every
  // task completed in the next 30 wall-clock minutes — later specs asserting
  // exact XP would flake. Reopening deletes the completion, which disarms
  // momentum by construction (ADR-2 derived state).
  await page.request.patch(`/api/tasks/${ids[SMALL_TASK]}`, { data: { status: "open" } });
});
