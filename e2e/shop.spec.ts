import { expect, test, type Page } from "@playwright/test";

const INTENT_KEY = "draw:shop:pack-purchase-intent";
const RESUME_REF = "123e4567-e89b-42d3-a456-426614174000";

async function serverShop(page: Page) {
  const response = await page.request.get("/api/shop");
  expect(response.ok()).toBe(true);
  return response.json();
}

async function mockShop(page: Page, overrides: Record<string, unknown> = {}) {
  const base = await serverShop(page);
  const state = {
    ...base,
    gold: 500,
    goldenTickets: 1,
    freezesBanked: 1,
    freezeBankCap: 2,
    nextSecretChanceBps: 550,
    backs: base.backs.map((back: { key: string }) => ({
      ...back,
      owned: back.key === "classic" || back.key === "ember",
    })),
    equipped: "classic",
    ...overrides,
  };
  await page.route("**/api/shop", (route) => route.fulfill({ json: state }));
  return state;
}

function purchaseResult(state: Awaited<ReturnType<typeof mockShop>>, body: any, bonus = "none") {
  return {
    opening: {
      openingOrder: 1,
      ref: body.ref,
      payment: body.payment,
      back: { key: "midnight", name: "Midnight stars", rarity: "common" },
      duplicate: false,
      appliedSecretChanceBps: 500,
      duplicateRefundGold: 0,
      bonus,
      bonusGold: bonus === "pouch" ? 50 : 0,
      openedAt: "2026-08-23T00:00:00.000Z",
    },
    shop: { ...state, gold: 400, backs: state.backs.map((back: any) => ({ ...back, owned: back.key === "midnight" || back.owned })) },
    replayed: false,
  };
}

test("renders the exact server snapshot, eligibility, and conditional Ticket control", async ({ page }) => {
  await mockShop(page, { gold: -7, goldenTickets: 0, packCost: 137, nextSecretChanceBps: 500 });
  await page.goto("/stats");
  const shop = page.getByTestId("shop");
  await shop.scrollIntoViewIfNeeded();

  await expect(shop).toContainText("-7 Gold");
  await expect(shop).toContainText("0 Golden Tickets");
  await expect(shop).toContainText("Freeze bank 1/2");
  await expect(shop).toContainText("Secret chance 5%");
  await expect(shop.getByRole("button", { name: "Open pack — 137 Gold" })).toBeDisabled();
  await expect(shop.getByRole("button", { name: /Golden Ticket/ })).toHaveCount(0);
  await expect(shop.locator(".shop-back")).toHaveCount(15);

  await page.unroute("**/api/shop");
  await mockShop(page, { gold: 137, goldenTickets: 1, packCost: 137, nextSecretChanceBps: 550 });
  await page.reload();
  await expect(shop).toContainText("Secret chance 5.5%");
  await expect(shop.getByRole("button", { name: "Open pack — 137 Gold" })).toBeEnabled();
  await expect(shop.getByRole("button", { name: "Open pack — Golden Ticket" })).toBeEnabled();
});

test("all known CSS-only backgrounds are distinct, shared, and unknown falls back to Classic", async ({ page }) => {
  await page.goto("/stats");
  const swatches = page.getByTestId("shop").locator(".shop-back-swatch");
  await expect(swatches).toHaveCount(15);

  const paints = await swatches.evaluateAll((nodes) =>
    nodes.map((node) => {
      const drawFace = document.createElement("span");
      drawFace.className = "draw-face front";
      const key = node.getAttribute("data-back");
      if (key) drawFace.setAttribute("data-back", key);
      document.body.append(drawFace);
      const swatchPaint = getComputedStyle(node).background;
      const drawPaint = getComputedStyle(drawFace).background;
      drawFace.remove();
      return { key: key ?? "classic", swatchPaint, drawPaint };
    }),
  );
  expect(new Set(paints.map(({ swatchPaint }) => swatchPaint)).size).toBe(15);
  for (const paint of paints) {
    expect(paint.swatchPaint).toBe(paint.drawPaint);
    expect(paint.swatchPaint).not.toContain("url(");
  }

  const fallback = await page.evaluate(() => {
    const classic = document.createElement("span");
    classic.className = "draw-face front";
    const unknown = classic.cloneNode() as HTMLElement;
    unknown.setAttribute("data-back", "future-back");
    document.body.append(classic, unknown);
    const result = [getComputedStyle(classic).background, getComputedStyle(unknown).background];
    classic.remove();
    unknown.remove();
    return result;
  });
  expect(fallback[1]).toBe(fallback[0]);
  await expect(swatches.first()).not.toHaveAttribute("data-back");
});

test("Gold and Ticket responses reveal background then effective bonus from exact snapshots", async ({ page }) => {
  const state = await mockShop(page);
  const requests: any[] = [];
  await page.route("**/api/shop/buy", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const reply = purchaseResult(state, body, body.payment === "gold" ? "none" : "ticket");
    reply.opening.openingOrder = requests.length;
    if (body.payment === "ticket") {
      reply.opening.duplicate = true;
      reply.opening.duplicateRefundGold = 40;
    }
    await route.fulfill({ json: reply });
  });

  await page.goto("/stats");
  const shop = page.getByTestId("shop");
  const goldButton = shop.getByRole("button", { name: "Open pack — 100 Gold" });
  await goldButton.click();
  const dialog = page.getByRole("dialog", { name: "Pack opening" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await expect(dialog.getByRole("status")).toHaveText("Background ready to reveal.");
  await expect(dialog).not.toContainText("Midnight stars");
  await expect(dialog.locator(".pack-reveal-card")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Reveal background" })).toBeFocused();
  await dialog.getByRole("button", { name: "Reveal background" }).press("Enter");
  await expect(dialog.locator(".pack-reveal-card")).toHaveCount(1);
  await expect(dialog).toContainText("Midnight stars");
  await expect(dialog).toContainText("common");
  await expect(dialog).toContainText("New background");
  await expect(dialog).toContainText("Duplicate refund: 0 Gold");
  await expect(dialog.getByRole("button", { name: "Skip reveal" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Close pack reveal" })).toBeFocused();
  await expect(page.locator("body > canvas")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Close pack reveal" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("body > canvas")).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await expect(goldButton).toBeFocused();
  await expect(shop).toContainText("400 Gold");

  await shop.getByRole("button", { name: "Open pack — Golden Ticket" }).click();
  await expect(dialog).not.toContainText("Golden Ticket +1");
  await dialog.getByRole("button", { name: "Reveal background" }).click();
  await expect(dialog.locator(".pack-reveal-card")).toHaveCount(2);
  await expect(dialog).toContainText("Duplicate refund: 40 Gold");
  await expect(dialog).not.toContainText("Golden Ticket +1");
  await expect(dialog.getByRole("button", { name: "Reveal bonus" })).toBeFocused();
  await expect(page.locator("body > canvas")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Reveal bonus" }).press("Space");
  await expect(dialog).toContainText("Golden Ticket +1");
  await expect(page.locator("body > canvas")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Close pack reveal" })).toBeFocused();
  await dialog.getByRole("button", { name: "Close pack reveal" }).click();

  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual({ item: "pack", payment: "gold", ref: requests[0].ref });
  expect(requests[1]).toEqual({ item: "pack", payment: "ticket", ref: requests[1].ref });
  expect(requests[0].ref).toMatch(/^[0-9a-f-]{36}$/i);
  expect(requests[1].ref).not.toBe(requests[0].ref);
  await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), INTENT_KEY)).toBeNull();
});

test("every effective bonus and duplicate tier has exact ordered card semantics", async ({ page }) => {
  const state = await mockShop(page);
  const cases = [
    { bonus: "none", rarity: "common", duplicate: true, refund: 10, label: null },
    { bonus: "freeze", rarity: "rare", duplicate: true, refund: 20, label: "Freeze +1" },
    { bonus: "pouch", rarity: "ultra-rare", duplicate: true, refund: 40, label: "Gold Pouch +50 Gold" },
    { bonus: "ticket", rarity: "secret-rare", duplicate: true, refund: 100, label: "Golden Ticket +1" },
  ] as const;
  let current = cases[0];
  let openingOrder = 0;
  await page.route("**/api/shop/buy", async (route) => {
    const body = route.request().postDataJSON();
    const reply = purchaseResult(state, body, current.bonus);
    reply.opening.openingOrder = ++openingOrder;
    reply.opening.back.rarity = current.rarity;
    reply.opening.duplicate = current.duplicate;
    reply.opening.duplicateRefundGold = current.refund;
    await route.fulfill({ json: reply });
  });

  await page.goto("/stats");
  const shop = page.getByTestId("shop");
  const dialog = page.getByRole("dialog", { name: "Pack opening" });
  for (const example of cases) {
    current = example;
    await shop.getByRole("button", { name: "Open pack — 100 Gold" }).click();
    await expect(dialog.locator(".pack-reveal-card")).toHaveCount(1);
    await dialog.getByRole("button", { name: "Skip reveal" }).click();
    await expect(dialog.getByRole("status")).toContainText("All cards revealed");
    await expect(page.locator("body > canvas")).toHaveCount(0);
    const cardCount = example.label ? 2 : 1;
    await expect(dialog.locator(".pack-reveal-card")).toHaveCount(cardCount);
    const revealedFaces = dialog.locator(".pack-reveal-card-face");
    await expect(revealedFaces).toHaveCount(cardCount);
    await expect(revealedFaces.first()).toBeVisible();
    await expect(revealedFaces.last()).toBeVisible();
    await expect(revealedFaces.first()).toHaveCSS("animation-name", "none");
    await expect(revealedFaces.last()).toHaveCSS("animation-name", "none");
    await expect(dialog).toContainText(example.rarity);
    await expect(dialog).toContainText(example.duplicate ? "Duplicate" : "New background");
    await expect(dialog).toContainText(`Duplicate refund: ${example.refund} Gold`);
    if (example.label) await expect(dialog).toContainText(example.label);
    await expect(dialog).not.toContainText(/XP|level|selected Freeze/i);
    if (example.bonus === "pouch") {
      await expect(dialog).not.toContainText("Freeze +1");
    }
    await dialog.getByRole("button", { name: "Close pack reveal" }).click();
  }
});

test("a full Freeze bank presents the effective Pouch and common duplicate refund", async ({ page }) => {
  const state = await mockShop(page, { freezesBanked: 2, freezeBankCap: 2 });
  await page.route("**/api/shop/buy", async (route) => {
    const body = route.request().postDataJSON();
    const reply = purchaseResult(state, body, "pouch");
    reply.opening.back = { key: "ember", name: "Ember lattice", rarity: "common" };
    reply.opening.duplicate = true;
    reply.opening.duplicateRefundGold = 10;
    reply.shop = { ...state, gold: 460 };
    await route.fulfill({ json: reply });
  });

  await page.goto("/stats");
  const shop = page.getByTestId("shop");
  await expect(shop).toContainText("Freeze bank 2/2");
  await shop.getByRole("button", { name: "Open pack — 100 Gold" }).click();

  const dialog = page.getByRole("dialog", { name: "Pack opening" });
  await dialog.getByRole("button", { name: "Reveal background" }).click();
  await expect(dialog).toContainText("Ember lattice");
  await expect(dialog).toContainText("common");
  await expect(dialog).toContainText("Duplicate refund: 10 Gold");
  await expect(dialog).not.toContainText(/Gold Pouch|Freeze \+1/);

  await dialog.getByRole("button", { name: "Reveal bonus" }).click();
  await expect(dialog.locator(".pack-reveal-card")).toHaveCount(2);
  await expect(dialog.locator(".pack-reveal-bonus.bonus-pouch")).toHaveCount(1);
  await expect(dialog.locator(".pack-reveal-bonus.bonus-freeze")).toHaveCount(0);
  await expect(dialog).toContainText("Gold Pouch +50 Gold");
  await expect(dialog).not.toContainText(/Freeze \+1|XP|level|selected Freeze/i);
  await expect(shop).toContainText("460 Gold");
  await dialog.getByRole("button", { name: "Close pack reveal" }).click();
});

test("modal traps focus, ignores backdrop dismissal, and Escape hides unrevealed facts", async ({ page }) => {
  const state = await mockShop(page);
  await page.route("**/api/shop/buy", async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({ json: purchaseResult(state, body, "ticket") });
  });
  await page.goto("/stats");
  await page.getByTestId("shop").getByRole("button", { name: "Open pack — 100 Gold" }).click();
  const dialog = page.getByRole("dialog", { name: "Pack opening" });
  const reveal = dialog.getByRole("button", { name: "Reveal background" });
  const close = dialog.getByRole("button", { name: "Close pack reveal" });
  await expect(reveal).toBeFocused();
  await reveal.press("Shift+Tab");
  await expect(close).toBeFocused();
  await close.press("Tab");
  await expect(reveal).toBeFocused();
  await page.locator(".pack-reveal-backdrop").click({ position: { x: 2, y: 2 } });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText("Midnight stars");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Pack opening" })).toHaveCount(0);
});

test("reduced motion opens complete with parity and no reveal motion or confetti", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const state = await mockShop(page);
  await page.route("**/api/shop/buy", async (route) => {
    const body = route.request().postDataJSON();
    const reply = purchaseResult(state, body, "freeze");
    reply.opening.duplicate = true;
    reply.opening.duplicateRefundGold = 20;
    await route.fulfill({ json: reply });
  });
  await page.goto("/stats");
  await page.getByTestId("shop").getByRole("button", { name: "Open pack — 100 Gold" }).click();
  const dialog = page.getByRole("dialog", { name: "Pack opening" });
  await expect(dialog.locator(".pack-reveal-card")).toHaveCount(2);
  await expect(dialog).toContainText("Midnight stars");
  await expect(dialog).toContainText("Duplicate refund: 20 Gold");
  await expect(dialog).toContainText("Freeze +1");
  await expect(dialog.getByRole("button", { name: /Reveal|Skip/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Close pack reveal" })).toBeFocused();
  await expect(dialog.locator(".pack-reveal-card-face").first()).toHaveCSS("animation-name", "none");
  await expect(page.locator("canvas")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("only an initial transport rejection gets one identical automatic retry", async ({ page }) => {
  const state = await mockShop(page);
  const requests: any[] = [];
  await page.route("**/api/shop/buy", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    if (requests.length === 1) await route.abort("connectionfailed");
    else await route.fulfill({ json: purchaseResult(state, body) });
  });
  await page.goto("/stats");
  await page.getByTestId("shop").getByRole("button", { name: "Open pack — 100 Gold" }).click();
  await expect(page.getByRole("dialog", { name: "Pack opening" })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), INTENT_KEY)).toBeNull();
});

test("HTTP errors are definitive, are not retried, and leave the displayed shop unchanged", async ({ page }) => {
  await mockShop(page, { gold: 321 });
  let requests = 0;
  await page.route("**/api/shop/buy", async (route) => {
    requests += 1;
    await route.fulfill({ status: 400, json: { error: "insufficient Gold" } });
  });
  await page.goto("/stats");
  const shop = page.getByTestId("shop");
  await shop.getByRole("button", { name: "Open pack — 100 Gold" }).click();
  await expect(shop.getByRole("alert")).toHaveText("insufficient Gold");
  await expect(page.getByRole("dialog", { name: "Pack opening" })).toHaveCount(0);
  expect(requests).toBe(1);
  await expect(shop).toContainText("321 Gold");
  await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), INTENT_KEY)).toBeNull();
});

test("an invalid success stays unresolved and manual retry reuses the same identity once", async ({ page }) => {
  const state = await mockShop(page);
  const requests: any[] = [];
  await page.route("**/api/shop/buy", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    if (requests.length === 1) await route.fulfill({ json: { opening: {} } });
    else await route.fulfill({ json: purchaseResult(state, body, "freeze") });
  });
  await page.goto("/stats");
  const shop = page.getByTestId("shop");
  await shop.getByRole("button", { name: "Open pack — 100 Gold" }).click();
  await expect(shop.getByRole("button", { name: "Retry purchase — gold" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Pack opening" })).toHaveCount(0);
  await expect(shop.getByRole("button", { name: "Open pack — 100 Gold" })).toBeDisabled();
  await expect(shop.getByTitle("Equip Ember lattice")).toBeEnabled();
  expect(requests).toHaveLength(1);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), INTENT_KEY)).not.toBeNull();

  await shop.getByRole("button", { name: "Retry purchase — gold" }).click();
  const dialog = page.getByRole("dialog", { name: "Pack opening" });
  await dialog.getByRole("button", { name: "Reveal background" }).click();
  await expect(dialog).not.toContainText("Freeze +1");
  await dialog.getByRole("button", { name: "Reveal bonus" }).click();
  await expect(dialog).toContainText("Freeze +1");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

test("reload offers manual bound-payment resume without a mount-time POST", async ({ page }) => {
  const state = await mockShop(page);
  await page.addInitScript(
    ({ key, ref }) =>
      sessionStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          ref,
          payment: "ticket",
          automaticRetryConsumed: true,
        }),
      ),
    { key: INTENT_KEY, ref: RESUME_REF },
  );
  const requests: any[] = [];
  await page.route("**/api/shop/buy", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    await route.fulfill({ json: { ...purchaseResult(state, body), replayed: true } });
  });

  await page.goto("/stats");
  const shop = page.getByTestId("shop");
  await expect(shop.getByRole("button", { name: "Resume purchase — ticket" })).toBeVisible();
  expect(requests).toHaveLength(0);
  await expect(shop.getByRole("button", { name: "Open pack — 100 Gold" })).toBeDisabled();
  await expect(shop.getByRole("button", { name: "Open pack — Golden Ticket" })).toBeDisabled();
  await expect(shop.getByTitle("Equip Ember lattice")).toBeEnabled();

  const resume = shop.getByRole("button", { name: "Resume purchase — ticket" });
  await resume.click();
  const dialog = page.getByRole("dialog", { name: "Pack opening" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close pack reveal" }).click();
  await expect(shop.getByRole("heading", { name: "Shop" })).toBeFocused();
  expect(requests).toEqual([{ item: "pack", payment: "ticket", ref: RESUME_REF }]);
});

test("storage failure prevents a POST and shows an actionable error", async ({ page }) => {
  await mockShop(page);
  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException("blocked", "SecurityError");
      return original.call(this, name, value);
    };
  }, INTENT_KEY);
  let requests = 0;
  await page.route("**/api/shop/buy", async (route) => {
    requests += 1;
    await route.abort();
  });
  await page.goto("/stats");
  const shop = page.getByTestId("shop");
  await shop.getByRole("button", { name: "Open pack — 100 Gold" }).click();
  await expect(shop.getByRole("alert")).toContainText("saved for safe retry");
  expect(requests).toBe(0);
});

test("real first-pull journey earns Gold, opens, equips, and paints Draw", async ({ page }) => {
  await page.goto("/stats");
  expect(await page.evaluate((key) => sessionStorage.getItem(key), INTENT_KEY)).toBeNull();

  const before = await serverShop(page);
  expect(before.backs.filter((back: { owned: boolean }) => back.owned).map((back: { key: string }) => back.key)).toEqual(["classic"]);
  expect(before).toMatchObject({
    equipped: "classic",
    goldenTickets: 0,
    nextSecretChanceBps: 500,
    freezesBanked: 0,
  });

  const categories = await (await page.request.get("/api/categories")).json();
  const created = await (
    await page.request.post("/api/tasks", {
      data: {
        title: "E2E fund first Gold pack",
        categoryId: categories[0].id,
        effortMinutes: 1000,
      },
    })
  ).json();
  const completed = await page.request.patch(`/api/tasks/${created.id}`, { data: { status: "done" } });
  expect(completed.ok()).toBe(true);
  const funded = await serverShop(page);
  expect(funded.gold - before.gold).toBeGreaterThanOrEqual(100);

  await page.reload();
  let purchaseRequests = 0;
  let committedRef = "";
  await page.route("**/api/shop/buy", async (route) => {
    purchaseRequests += 1;
    const body = route.request().postDataJSON();
    if (purchaseRequests === 1) {
      committedRef = body.ref;
      const committed = await route.fetch();
      expect(committed.ok()).toBe(true);
      await route.abort("connectionfailed");
    } else {
      expect(body.ref).toBe(committedRef);
      await route.continue();
    }
  });
  const shop = page.getByTestId("shop");
  await shop.getByRole("button", { name: `Open pack — ${funded.packCost} Gold` }).click();
  const dialog = page.getByRole("dialog", { name: "Pack opening" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Reveal background" }).click();
  if (await dialog.getByRole("button", { name: "Reveal bonus" }).count()) {
    await dialog.getByRole("button", { name: "Reveal bonus" }).click();
  }
  await expect(dialog).toContainText("New background");

  expect(purchaseRequests).toBe(2);
  const after = await serverShop(page);
  const newlyOwned = after.backs.filter((back: { key: string; owned: boolean }) => back.owned && back.key !== "classic");
  expect(newlyOwned).toHaveLength(1);
  await expect(dialog).toContainText(newlyOwned[0].name);
  await dialog.getByRole("button", { name: "Close pack reveal" }).click();
  await shop.getByTitle(`Equip ${newlyOwned[0].name}`).click();
  await expect(shop.getByTitle(`Equip ${newlyOwned[0].name}`)).toBeDisabled();

  await page.goto("/");
  await expect(page.locator(".draw-face.front").first()).toHaveAttribute("data-back", newlyOwned[0].key);
});
