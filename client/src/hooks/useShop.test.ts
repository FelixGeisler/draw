import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import {
  applyPackPurchaseSnapshot,
  PACK_BONUS_LABELS,
  PackResponseError,
  PackTransportError,
  requestPackPurchase,
  type BackRarity,
  type PackPurchaseResult,
  type ShopState,
} from "./useShop";

const CATALOG: Array<[string, string, BackRarity]> = [
  ["classic", "Classic weave", "common"],
  ["ember", "Ember lattice", "common"],
  ["tide", "Tide glass", "common"],
  ["midnight", "Midnight stars", "common"],
  ["parchment", "Aged parchment", "common"],
  ["graphite", "Graphite weave", "common"],
  ["meadow", "Meadow braid", "rare"],
  ["royal", "Royal filigree", "rare"],
  ["sakura", "Sakura glass", "rare"],
  ["circuit", "Neon circuit", "rare"],
  ["frost", "Frost lattice", "rare"],
  ["aurum", "Aurum crest", "ultra-rare"],
  ["aurora", "Aurora silk", "ultra-rare"],
  ["obsidian", "Obsidian gold", "ultra-rare"],
  ["prism", "Prism foil", "secret-rare"],
];

function shop(overrides: Partial<ShopState> = {}): ShopState {
  return {
    gold: -7,
    goldenTickets: 1,
    packCost: 100,
    nextSecretChanceBps: 550,
    freezesBanked: 1,
    freezeBankCap: 2,
    backs: CATALOG.map(([key, name, rarity], index) => ({
      key,
      name,
      rarity,
      owned: index < 2,
    })),
    equipped: "ember",
    ...overrides,
  };
}

function response(overrides: Partial<PackPurchaseResult> = {}): PackPurchaseResult {
  return {
    opening: {
      openingOrder: 1,
      ref: "123e4567-e89b-42d3-a456-426614174000",
      payment: "gold",
      back: { key: "midnight", name: "Midnight stars", rarity: "common" },
      duplicate: false,
      appliedSecretChanceBps: 500,
      duplicateRefundGold: 0,
      bonus: "none",
      bonusGold: 0,
      openedAt: "2026-08-23T00:00:00.000Z",
    },
    shop: shop({ gold: 0, nextSecretChanceBps: 500 }),
    replayed: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("one-at-a-time pack HTTP attempt", () => {
  it.each(["gold", "ticket"] as const)("sends the exact %s request body", async (payment) => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const ref = "123e4567-e89b-42d3-a456-426614174000";
    await requestPackPurchase({ item: "pack", payment, ref });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/shop/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item: "pack", payment, ref }),
    });
  });

  it("classifies fetch rejection as transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(
      requestPackPurchase({ item: "pack", payment: "gold", ref: "r" }),
    ).rejects.toBeInstanceOf(PackTransportError);
  });

  it("classifies every HTTP response as a definitive ApiError without retry policy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "insufficient Gold" }), { status: 400 }),
      ),
    );
    await expect(
      requestPackPurchase({ item: "pack", payment: "gold", ref: "r" }),
    ).rejects.toMatchObject({ status: 400, message: "insufficient Gold" } satisfies Partial<ApiError>);
  });

  it.each([
    new Response("not-json", { status: 200 }),
    new Response(JSON.stringify({ opening: {}, shop: {} }), { status: 200 }),
  ])("keeps unreadable/invalid successful responses distinguishable", async (reply) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply));
    await expect(
      requestPackPurchase({ item: "pack", payment: "gold", ref: "r" }),
    ).rejects.toBeInstanceOf(PackResponseError);
  });
});

describe("authoritative result/cache contract", () => {
  it("uses the exact effective-bonus labels", () => {
    expect(PACK_BONUS_LABELS).toEqual({
      none: "No bonus",
      freeze: "Freeze +1",
      pouch: "Gold Pouch +50 Gold",
      ticket: "Golden Ticket +1",
    });
  });

  it("accepts the ordered 15-entry snapshot without deriving or clamping its values", () => {
    const snapshot = shop();
    expect(snapshot.backs.map(({ key, name, rarity }) => [key, name, rarity])).toEqual(CATALOG);
    expect(snapshot).toMatchObject({
      gold: -7,
      goldenTickets: 1,
      freezesBanked: 1,
      freezeBankCap: 2,
      nextSecretChanceBps: 550,
      equipped: "ember",
    });
  });

  it("replaces ['shop'] exactly and invalidates only the authoritative aggregate", () => {
    const queryClient = new QueryClient();
    const set = vi.spyOn(queryClient, "setQueryData");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const purchase = response();

    applyPackPurchaseSnapshot(queryClient, purchase);

    expect(set).toHaveBeenCalledWith(["shop"], purchase.shop);
    expect(queryClient.getQueryData(["shop"])).toBe(purchase.shop);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["gamification"] });
  });
});
