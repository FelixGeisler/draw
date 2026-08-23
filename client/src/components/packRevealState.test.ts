import { describe, expect, it } from "vitest";
import type { BackRarity, EffectivePackBonus, PackPurchaseResult } from "../hooks/useShop";
import {
  createPackRevealSession,
  transitionPackReveal,
  type PackRevealEvent,
} from "./packRevealState";

function purchase(
  bonus: EffectivePackBonus = "none",
  overrides: {
    ref?: string;
    openingOrder?: number;
    rarity?: BackRarity;
    duplicate?: boolean;
    refund?: number;
  } = {},
): PackPurchaseResult {
  return {
    opening: {
      openingOrder: overrides.openingOrder ?? 7,
      ref: overrides.ref ?? "opening-a",
      payment: "gold",
      back: { key: "prism", name: "Prism foil", rarity: overrides.rarity ?? "secret-rare" },
      duplicate: overrides.duplicate ?? true,
      appliedSecretChanceBps: 500,
      duplicateRefundGold: overrides.refund ?? 100,
      bonus,
      bonusGold: bonus === "pouch" ? 50 : 0,
      openedAt: "2026-08-23T00:00:00.000Z",
    },
    shop: {
      gold: 100,
      goldenTickets: 0,
      packCost: 100,
      nextSecretChanceBps: 500,
      freezesBanked: 0,
      freezeBankCap: 2,
      backs: [],
      equipped: "classic",
    },
    replayed: false,
  };
}

function event(session: ReturnType<typeof createPackRevealSession>, action: PackRevealEvent["action"]): PackRevealEvent {
  return { identity: session.identity, action };
}

describe("pack reveal current-session state machine", () => {
  it("completes a one-card opening only on the explicit background reveal", () => {
    const ready = createPackRevealSession(purchase("none"), false);
    expect(ready.stage).toBe("background-ready");
    const complete = transitionPackReveal(ready, event(ready, "reveal-background"));
    expect(complete.session.stage).toBe("complete");
    expect(complete.celebrate).toBe(true);
    expect(transitionPackReveal(complete.session, event(ready, "reveal-background"))).toEqual({
      session: complete.session,
      celebrate: false,
    });
  });

  it.each(["freeze", "pouch", "ticket"] as const)(
    "reveals background before the effective %s bonus and celebrates only the final card",
    (bonus) => {
      const ready = createPackRevealSession(purchase(bonus), false);
      const background = transitionPackReveal(ready, event(ready, "reveal-background"));
      expect(background.session.stage).toBe("bonus-ready");
      expect(background.celebrate).toBe(false);
      const complete = transitionPackReveal(
        background.session,
        event(background.session, "reveal-bonus"),
      );
      expect(complete.session.stage).toBe("complete");
      expect(complete.celebrate).toBe(true);
    },
  );

  it("skip exposes the complete snapshot without celebration", () => {
    const ready = createPackRevealSession(purchase("ticket"), false);
    expect(transitionPackReveal(ready, event(ready, "skip"))).toMatchObject({
      session: { stage: "complete" },
      celebrate: false,
    });
  });

  it("reduced motion starts complete and ignores every reveal event", () => {
    const complete = createPackRevealSession(purchase("freeze"), true);
    expect(complete.stage).toBe("complete");
    for (const action of ["reveal-background", "reveal-bonus", "skip"] as const) {
      expect(transitionPackReveal(complete, event(complete, action))).toEqual({
        session: complete,
        celebrate: false,
      });
    }
  });

  it("ignores stale identity and out-of-order actions", () => {
    const current = createPackRevealSession(purchase("ticket", { ref: "new", openingOrder: 9 }), false);
    const stale: PackRevealEvent = {
      identity: { ref: "old", openingOrder: 8 },
      action: "reveal-background",
    };
    expect(transitionPackReveal(current, stale)).toEqual({ session: current, celebrate: false });
    expect(transitionPackReveal(current, event(current, "reveal-bonus"))).toEqual({
      session: current,
      celebrate: false,
    });
  });

  it.each([
    ["common", false, 0],
    ["rare", true, 20],
    ["ultra-rare", true, 40],
    ["secret-rare", true, 100],
  ] as const)("preserves the exact %s response snapshot", (rarity, duplicate, refund) => {
    const result = purchase("pouch", { rarity, duplicate, refund });
    const session = createPackRevealSession(result, false);
    expect(session.result).toBe(result);
    expect(session.result.opening).toMatchObject({
      back: { rarity },
      duplicate,
      duplicateRefundGold: refund,
      bonus: "pouch",
    });
  });
});
