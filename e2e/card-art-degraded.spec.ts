import { expect, test } from "@playwright/test";
import { drawFromGoal } from "./helpers.js";

// Issue #27, the only E2E-affordable path: E2E always runs AI-degraded
// (playwright.config.ts blanks ANTHROPIC_API_KEY), so the card-art endpoint
// answers 503 ai_not_configured — and the drawn card must look and behave
// exactly as before: default gradient, no art layer, no error UI. The live
// generation path is covered by integration tests with generation mocked.
test.describe.configure({ mode: "serial" });

const GOAL_TITLE = "E2E card art goal";
const TASK_TITLE = "Card-art degraded task";

test("degraded draw: card renders instantly with default styling, art 503 is swallowed", async ({
  page,
}) => {
  const goal = await (
    await page.request.post("/api/goals", { data: { title: GOAL_TITLE } })
  ).json();
  const categories: { id: number }[] = await (await page.request.get("/api/categories")).json();
  const task = await (
    await page.request.post("/api/tasks", {
      data: { title: TASK_TITLE, categoryId: categories[0].id, goalId: goal.id, effortMinutes: 10 },
    })
  ).json();

  // Arm the listener before drawing: the reveal must trigger exactly one
  // card-art request, and it must come back as the degraded 503.
  const artResponse = page.waitForResponse((r) => r.url().includes("/card-art"));
  await drawFromGoal(page, GOAL_TITLE);
  await expect(page.locator(".draw-face.back h2")).toHaveText(TASK_TITLE);
  expect((await artResponse).status()).toBe(503);

  // No art layer, no scrim — the default card-back gradient stands alone.
  await expect(page.locator(".draw-art")).toHaveCount(0);
  await expect(page.locator(".draw-art-scrim")).toHaveCount(0);

  // #113: the regenerate control exists only when there is art to replace —
  // degraded mode hides it entirely (silent contract, no inert stub either).
  await expect(page.getByRole("button", { name: "Regenerate artwork" })).toHaveCount(0);

  // No error surfaced anywhere: the card stays fully actionable.
  await expect(page.getByText(/error|failed|not configured/i)).toHaveCount(0);
  for (const name of ["▶ Start now", "✓ Done", "💤 Not now", "✎ Edit"]) {
    await expect(page.getByRole("button", { name })).toBeVisible();
  }

  // Leave the serial DB tidy for the later journeys: no completion (they
  // assert a fresh 0-XP baseline) and no snooze/block (they assert the
  // Snoozed group empties) — deleting the task leaves no trace and clears
  // the persisted current draw server-side.
  await page.request.delete(`/api/tasks/${task.id}`);
  const current = await (await page.request.get("/api/draw/current")).json();
  expect(current?.task ?? null).toBeNull();
});
