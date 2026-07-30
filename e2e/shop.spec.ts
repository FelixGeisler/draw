import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

// The XP shop (#230, ADR-62): buy a booster pack with earned XP, watch it
// OPEN (the #224 stage idiom — the whole reason packs exist), equip a pulled
// card back, and see the Draw page deck actually wear it. Alphabetically
// after core-journey/earned-achievements (no unlock theft — "s" is late) and
// cleans up its completions so the trophy-pile geometry stays intact.
test.describe.configure({ mode: "serial" });

const SEED_PREFIX = "Shop XP seed";
let pulledKey: string | null = null;

async function seedXp(request: APIRequestContext) {
  // Nine plain 30-min completions at 30 XP each = 270 XP, honestly earned
  // through the same completion door everything else uses.
  const categories: { id: number }[] = await (await request.get("/api/categories")).json();
  for (let i = 0; i < 9; i++) {
    const task = await (
      await request.post("/api/tasks", {
        data: { title: `${SEED_PREFIX} ${i}`, categoryId: categories[0].id, effortMinutes: 30 },
      })
    ).json();
    await request.patch(`/api/tasks/${task.id}`, { data: { status: "done" } });
  }
}

test("buying a pack opens it on the stage; the pulls become equippable card backs", async ({
  page,
}) => {
  await seedXp(page.request);
  const before = (await (await page.request.get("/api/shop")).json()) as { xp: number };
  expect(before.xp).toBeGreaterThanOrEqual(250); // 9 × 30 XP, pack affordable

  await page.goto("/stats");
  const shop = page.getByTestId("shop");
  await shop.scrollIntoViewIfNeeded();
  await expect(shop.getByText(/XP to spend/)).toBeVisible();

  await shop.getByRole("button", { name: /Open pack/ }).click();

  // The pack opens on the #224 stage: two face-down pulls, revealed by
  // clicking, then the stage closes on the final click.
  const opening = page.getByTestId("pack-opening");
  await expect(opening).toBeVisible();
  await expect(opening.locator(".shop-pull")).toHaveCount(2);
  await opening.click();
  await expect(opening.locator(".shop-pull.revealed")).toHaveCount(1);
  await opening.click();
  await expect(opening.locator(".shop-pull.revealed")).toHaveCount(2);
  await opening.click();
  await expect(page.getByTestId("pack-opening")).toHaveCount(0);

  // The pull landed in the owned set. Which back is random — read it from the
  // API and equip it through the UI by its display name.
  const after = (await (await page.request.get("/api/shop")).json()) as {
    xp: number;
    backs: { key: string; name: string; owned: boolean }[];
  };
  const pulled = after.backs.find((b) => b.owned && b.key !== "classic")!;
  expect(pulled).toBeTruthy();
  pulledKey = pulled.key;
  // The charge landed too: xp fell by the pack cost net of any dup refunds
  // (75 or 150), never by more.
  expect(before.xp - after.xp).toBeGreaterThanOrEqual(100);
  expect(before.xp - after.xp).toBeLessThanOrEqual(250);

  await shop.getByRole("button", { name: new RegExp(pulled.name) }).click();
  await expect(
    shop.locator(".shop-back.equipped").getByText(pulled.name),
  ).toBeVisible();
});

test("the Draw page deck wears the equipped back", async ({ page }) => {
  expect(pulledKey).not.toBeNull();
  await page.goto("/");
  await expect(page.locator(".draw-face.front")).toHaveAttribute("data-back", pulledKey!);
});

test.afterAll(async ({ request }) => {
  // Trophy-pile geometry (later specs count today's pile card by card): the
  // seeded completions leave with their tasks. Equip back to classic so the
  // front face renders the default weave for every later spec.
  await request.post("/api/shop/equip", { data: { back: "classic" } });
  const tasks: { id: number; title: string }[] = await (
    await request.get("/api/tasks?status=all")
  ).json();
  for (const t of tasks.filter((t) => t.title.startsWith(SEED_PREFIX))) {
    await request.delete(`/api/tasks/${t.id}`);
  }
});
