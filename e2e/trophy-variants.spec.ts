import { expect, test } from "@playwright/test";

// Trophy variants (#204): each achieved goal earns one of six designs,
// derived from its id — never stored. What the UI must uphold: the pick is
// deterministic (a reload cannot re-roll a trophy), goals achieved together
// get different designs (sequential ids never collide inside one rotation),
// and ADR-46's name-only-at-rest behaviour survives untouched, since only
// the art's src changed.
test.describe.configure({ mode: "serial" });

const GOAL_A = "Win the e2e variant sprint";
const GOAL_B = "Win the e2e variant regatta";

test("two goals achieved together hang different trophies, stable across reload", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });

  // Seed through the API: two goals created back-to-back get consecutive ids,
  // which is exactly the adjacent-variety case the design guarantees.
  for (const title of [GOAL_A, GOAL_B]) {
    const res = await page.request.post("/api/goals", { data: { title } });
    if (!res.ok()) throw new Error(`seed: create goal failed (${res.status()})`);
    const goal = await res.json();
    const done = await page.request.patch(`/api/goals/${goal.id}`, {
      data: { status: "achieved" },
    });
    if (!done.ok()) throw new Error(`seed: achieve goal failed (${done.status()})`);
  }

  await page.goto("/goals");
  const artA = page.locator(".goal-cup").filter({ hasText: GOAL_A }).locator("img.goal-cup-art");
  const artB = page.locator(".goal-cup").filter({ hasText: GOAL_B }).locator("img.goal-cup-art");
  await expect(artA).toBeVisible();
  await expect(artB).toBeVisible();

  // Each cup renders a real design from the derived pick…
  const variantA = await artA.getAttribute("data-variant");
  const variantB = await artB.getAttribute("data-variant");
  expect(variantA).toMatch(/^(cup|chalice|star|laurel|obelisk|shield)$/);
  expect(variantB).toMatch(/^(cup|chalice|star|laurel|obelisk|shield)$/);
  // …the neighbors differ (consecutive ids, one rotation apart at most)…
  expect(variantA).not.toBe(variantB);

  // …and a reload changes nothing: the pick is a fact about the goal, not
  // about the render. A trophy that re-rolled on refresh would make the
  // shelf feel like a slot machine.
  await page.reload();
  await expect(artA).toHaveAttribute("data-variant", variantA!);
  await expect(artB).toHaveAttribute("data-variant", variantB!);

  // ADR-46 untouched: name-only at rest, the reveal strip stays hidden.
  await page.mouse.move(0, 0);
  const cupA = page.locator(".goal-cup").filter({ hasText: GOAL_A });
  await expect(cupA.locator(".goal-cup-reveal")).toHaveCSS("opacity", "0");
  await cupA.hover();
  await expect(cupA.locator(".goal-cup-reveal")).toHaveCSS("opacity", "1");
});

test.afterAll(async ({ request }) => {
  // The suite shares one database — a leaked achieved goal would appear in
  // every later shelf assertion.
  const goals: { id: number; title: string }[] = await (
    await request.get("/api/goals?status=achieved")
  ).json();
  for (const g of goals.filter((g) => g.title === GOAL_A || g.title === GOAL_B)) {
    const res = await request.delete(`/api/goals/${g.id}`);
    if (!res.ok()) throw new Error(`cleanup: delete goal ${g.id} failed (${res.status()})`);
  }
});
