import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { drawFromGoal } from "./helpers.js";

// Issue #62: deterministic rarity on trophy-pile cards. A completion that
// happened while the task was on the drawn card gets rare-card aesthetics —
// drawn impact-5 = holo (#123, formerly foil), drawn impact-4 = silver, everything else exactly
// today's plain card. Rarity is derived at render time from (wasDrawn,
// impact); the drawn completions here flow through a REAL draw so was_drawn
// is genuine (server-derived from the persisted current draw, ADR-13).
// Shares the serial E2E database — every assertion scopes to this file's
// uniquely-titled cards.
test.describe.configure({ mode: "serial" });

const HOLO_GOAL = "Rarity holo goal";
const SILVER_GOAL = "Rarity silver goal";
const HOLO_TITLE = "Rarity holo five star drawn";
const SILVER_TITLE = "Rarity silver four star drawn";
const PLAIN_TITLE = "Rarity plain five star not drawn";

/** Goal-scoped seeding makes drawFromGoal deterministic: one drawable card. */
async function seedGoalTask(
  request: APIRequestContext,
  goalTitle: string,
  taskTitle: string,
  impact: number,
) {
  const goal = await (await request.post("/api/goals", { data: { title: goalTitle } })).json();
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  return (
    await request.post("/api/tasks", {
      data: { title: taskTitle, categoryId: categories[0].id, goalId: goal.id, impact, effortMinutes: 5 },
    })
  ).json();
}

/** Draw the goal's only card and complete it through the UI. */
async function drawAndComplete(page: Page, goalTitle: string, taskTitle: string) {
  await drawFromGoal(page, goalTitle);
  await expect(page.locator(".draw-face.back h2")).toHaveText(taskTitle);
  await page.getByRole("button", { name: "✓ Done" }).click();
}

function pileCard(page: Page, title: string) {
  return page.locator(".trophy-card", { hasText: title });
}

/** Computed animation-name of the card's sheen overlay pseudo-element. */
async function sheenAnimation(card: ReturnType<typeof pileCard>) {
  return card.evaluate((el) => {
    const inner = el.querySelector(".trophy-card-inner");
    return inner ? getComputedStyle(inner, "::after").animationName : null;
  });
}

test("a drawn impact-5 completion renders the holo sheen", async ({ page }) => {
  await seedGoalTask(page.request, HOLO_GOAL, HOLO_TITLE, 5);
  await drawAndComplete(page, HOLO_GOAL, HOLO_TITLE);

  const holo = pileCard(page, HOLO_TITLE);
  await expect(holo).toHaveClass(/rarity-holo/);
  // The tier is announced, not visual-only: appended after the (drawn) XP part.
  await expect(holo).toHaveAttribute("aria-label", /XP \(drawn\), holo$/);
  // The sheen is a real painted overlay on the inner card face.
  const bg = await holo.evaluate((el) =>
    getComputedStyle(el.querySelector(".trophy-card-inner")!, "::after").backgroundImage,
  );
  expect(bg).toContain("linear-gradient");
});

test("a drawn impact-4 completion renders the silver sheen", async ({ page }) => {
  await seedGoalTask(page.request, SILVER_GOAL, SILVER_TITLE, 4);
  await drawAndComplete(page, SILVER_GOAL, SILVER_TITLE);

  const silver = pileCard(page, SILVER_TITLE);
  await expect(silver).toHaveClass(/rarity-silver/);
  await expect(silver).toHaveAttribute("aria-label", /XP \(drawn\), silver$/);
});

test("a not-drawn five-star completion stays a plain card", async ({ page }) => {
  // Completed via the API without any draw — the was_drawn heuristic must
  // not fire, so despite impact 5 the card renders exactly as today.
  const goal = await (
    await page.request.post("/api/goals", { data: { title: "Rarity plain goal" } })
  ).json();
  const categories: { id: number }[] = await (await page.request.get("/api/categories")).json();
  const task = await (
    await page.request.post("/api/tasks", {
      data: { title: PLAIN_TITLE, categoryId: categories[0].id, goalId: goal.id, impact: 5, effortMinutes: 5 },
    })
  ).json();
  await page.request.patch(`/api/tasks/${task.id}`, { data: { status: "done" } });

  await page.goto("/");
  const plain = pileCard(page, PLAIN_TITLE);
  await expect(plain).toBeVisible();
  await expect(plain).not.toHaveClass(/rarity-/);
  await expect(plain).toHaveAttribute("aria-label", /XP$/); // no (drawn), no tier
  const bg = await plain.evaluate((el) =>
    getComputedStyle(el.querySelector(".trophy-card-inner")!, "::after").backgroundImage,
  );
  expect(bg).toBe("none");
});

test("the shine sweep runs only while lifted, and reduced motion stills it", async ({ page }) => {
  await page.goto("/");
  const holo = pileCard(page, HOLO_TITLE);

  // Collapsed in the pile: the sheen is static.
  expect(await sheenAnimation(holo)).toBe("none");

  // Lifted (hover): the slow sweep runs. The lift must not reflow the pile —
  // a sibling's box stays put (scoped scroll first; boundingBox is
  // viewport-relative).
  await holo.scrollIntoViewIfNeeded();
  const sibling = pileCard(page, SILVER_TITLE);
  const before = await sibling.boundingBox();
  await holo.hover();
  expect(await sheenAnimation(holo)).toBe("trophy-sheen-sweep");
  expect(await sibling.boundingBox()).toEqual(before);

  // prefers-reduced-motion: the sheen stays painted, the sweep does not.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await holo.hover();
  expect(await sheenAnimation(holo)).toBe("none");
  const bg = await holo.evaluate((el) =>
    getComputedStyle(el.querySelector(".trophy-card-inner")!, "::after").backgroundImage,
  );
  expect(bg).toContain("linear-gradient");
});

test("the stats-page History calendar reuses the tiers on the day's tile and detail", async ({
  page,
}) => {
  await page.goto("/stats");

  // All three completions landed today, so today's tile wears the day's RAREST
  // completion (holo) — its glint and its aria-label both name it.
  const cell = page.locator(".cal-cell.today");
  await expect(cell).toHaveClass(/rarity-holo/);
  await expect(cell).toHaveAttribute("aria-label", /holo$/);

  // The docked detail keeps EACH card's own tier: holo, silver, and a plain
  // completion with no tier word at all.
  await cell.hover();
  const detail = page.locator(".cal-detail");
  await expect(detail.locator(".cal-detail-card", { hasText: HOLO_TITLE })).toContainText("holo");
  await expect(detail.locator(".cal-detail-card", { hasText: SILVER_TITLE })).toContainText("silver");
  const plainLine = detail.locator(".cal-detail-card", { hasText: PLAIN_TITLE });
  await expect(plainLine).toBeVisible();
  await expect(plainLine).not.toContainText(/holo|silver/);
});
