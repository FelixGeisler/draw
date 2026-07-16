import { describe, expect, it } from "vitest";
import { dealFromPool, HAND_MAX_CARDS } from "../../src/services/handService.js";
import type { PoolCandidate } from "../../src/services/drawService.js";
import { localDate } from "../../src/services/localDay.js";

// Daily hand (#59, ADR-34): the deal algorithm — weighted sampling WITHOUT
// replacement under an effort budget. The pick is random, so the assertions
// here are INVARIANTS over many deals (never exact hands) plus loose
// statistical bounds for the weighting, exactly like the draw-weight suite.

const NOW = new Date("2026-07-14T12:00:00Z");
const COOLDOWN = 60;

function candidate(overrides: Partial<PoolCandidate> = {}): PoolCandidate {
  return {
    id: 1,
    title: "Card",
    categoryId: 1,
    goalId: null,
    parentId: null,
    impact: 3,
    effortMinutes: 20,
    dueDate: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    recurEveryDays: null,
    lastDrawnAt: null,
    lastCompletedAt: null,
    deferredUntil: null,
    windowDays: null,
    windowStart: null,
    windowEnd: null,
    ...overrides,
  };
}

/** A pool of `n` interchangeable cards, ids 1..n. */
function pool(n: number, overrides: Partial<PoolCandidate> = {}): PoolCandidate[] {
  return Array.from({ length: n }, (_, i) => candidate({ id: i + 1, ...overrides }));
}

const effortOf = (hand: PoolCandidate[]) => hand.reduce((sum, c) => sum + c.effortMinutes, 0);

describe("dealFromPool: the budget is a hard cap", () => {
  it("never deals more minutes than the budget, over many random deals", () => {
    const candidates = pool(12, { effortMinutes: 25 });
    for (let i = 0; i < 200; i++) {
      expect(effortOf(dealFromPool(candidates, NOW, COOLDOWN, 90))).toBeLessThanOrEqual(90);
    }
  });

  it("deals nothing when not even the smallest card fits — the pool is fine, the budget is not", () => {
    const candidates = [candidate({ id: 1, effortMinutes: 30 }), candidate({ id: 2, effortMinutes: 45 })];
    expect(dealFromPool(candidates, NOW, COOLDOWN, 29)).toEqual([]);
  });

  it("a card whose effort exactly equals the remaining budget still fits (boundary)", () => {
    const candidates = [candidate({ id: 1, effortMinutes: 30 })];
    expect(dealFromPool(candidates, NOW, COOLDOWN, 30).map((c) => c.id)).toEqual([1]);
  });

  it("stops dealing once only oversized cards are left — it does not overshoot to fill the hand", () => {
    // 20 + 20 fits in 50; the third 20-minute card would make 60. Every deal
    // must stop at two, though five cards are available and the cap is 5.
    const candidates = pool(5, { effortMinutes: 20 });
    for (let i = 0; i < 100; i++) {
      const hand = dealFromPool(candidates, NOW, COOLDOWN, 50);
      expect(hand).toHaveLength(2);
      expect(effortOf(hand)).toBe(40);
    }
  });

  it("deals a MAXIMAL hand: it stops only when no card left over still fits", () => {
    // The honest invariant — the deal never leaves a card on the table it
    // could still have afforded. (It is not "fill the budget": taking 5+5
    // first legitimately leaves 20 minutes that the 25-minute card no longer
    // fits into. What must never happen is stopping while something fits.)
    const candidates = [
      candidate({ id: 1, effortMinutes: 25 }),
      candidate({ id: 2, effortMinutes: 5 }),
      candidate({ id: 3, effortMinutes: 5 }),
    ];
    for (let i = 0; i < 200; i++) {
      const hand = dealFromPool(candidates, NOW, COOLDOWN, 30);
      const left = 30 - effortOf(hand);
      const dealtIds = new Set(hand.map((c) => c.id));
      const stillAffordable = candidates.filter(
        (c) => !dealtIds.has(c.id) && c.effortMinutes <= left,
      );
      expect(stillAffordable).toEqual([]);
    }
  });
});

describe("dealFromPool: hand size", () => {
  it(`never deals more than ${HAND_MAX_CARDS} cards, however generous the budget`, () => {
    const candidates = pool(40, { effortMinutes: 5 }); // 40 × 5 = 200 min available
    for (let i = 0; i < 100; i++) {
      expect(dealFromPool(candidates, NOW, COOLDOWN, 10_000)).toHaveLength(HAND_MAX_CARDS);
    }
  });

  it("deals the whole pool when it is smaller than the cap", () => {
    const candidates = pool(2, { effortMinutes: 10 });
    expect(dealFromPool(candidates, NOW, COOLDOWN, 90)).toHaveLength(2);
  });

  it("deals nothing from an empty pool", () => {
    expect(dealFromPool([], NOW, COOLDOWN, 90)).toEqual([]);
  });
});

describe("dealFromPool: sampling is WITHOUT replacement", () => {
  it("never deals the same card twice", () => {
    const candidates = pool(6, { effortMinutes: 5 });
    for (let i = 0; i < 200; i++) {
      const ids = dealFromPool(candidates, NOW, COOLDOWN, 100).map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("does not mutate the caller's pool", () => {
    const candidates = pool(5, { effortMinutes: 5 });
    dealFromPool(candidates, NOW, COOLDOWN, 100);
    expect(candidates).toHaveLength(5);
  });

  it("every dealt card comes from the pool", () => {
    const candidates = pool(8, { effortMinutes: 10 });
    const ids = new Set(candidates.map((c) => c.id));
    for (let i = 0; i < 50; i++) {
      for (const card of dealFromPool(candidates, NOW, COOLDOWN, 90)) {
        expect(ids.has(card.id)).toBe(true);
      }
    }
  });
});

describe("dealFromPool: the pick is weighted, not uniform", () => {
  it("a high-leverage card lands in the hand far more often than a low-leverage one", () => {
    // impact²/effort: 25/5 = 5 against 1/30 ≈ 0.03 — two orders of magnitude.
    // A one-card budget forces the two to actually compete for the slot.
    const heavy = candidate({ id: 1, impact: 5, effortMinutes: 5 });
    const light = candidate({ id: 2, impact: 1, effortMinutes: 30 });
    let heavyDealt = 0;
    let lightDealt = 0;
    for (let i = 0; i < 300; i++) {
      const ids = dealFromPool([heavy, light], NOW, COOLDOWN, 30).map((c) => c.id);
      if (ids.includes(1)) heavyDealt++;
      if (ids.includes(2)) lightDealt++;
    }
    // Loose bound (the draw suite's convention): dominance, never exact counts.
    expect(heavyDealt).toBeGreaterThan(lightDealt * 3);
  });

  it("the hand is a sample, not a deterministic top-N: the same deck deals different hands", () => {
    // Six equal cards, a 3-card budget. If the deal were "take the best N",
    // every hand would be identical — the redeal-free design leans on this.
    const candidates = pool(6, { effortMinutes: 10 });
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(
        dealFromPool(candidates, NOW, COOLDOWN, 30)
          .map((c) => c.id)
          .sort((a, b) => a - b)
          .join(","),
      );
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("a card cooling down is dampened, not excluded — it can still be dealt", () => {
    // The regular draw's ×0.15 dampener (not the warm-up's exclusion): the
    // hand shares drawTask's weights, so a recently drawn card is unlikely,
    // never impossible.
    const cooling = candidate({ id: 1, lastDrawnAt: new Date(NOW.getTime() - 60_000).toISOString() });
    const fresh = candidate({ id: 2 });
    let coolingDealt = 0;
    for (let i = 0; i < 400; i++) {
      // Budget for exactly one 20-minute card: the two compete head to head.
      if (dealFromPool([cooling, fresh], NOW, COOLDOWN, 20).some((c) => c.id === 1)) coolingDealt++;
    }
    expect(coolingDealt).toBeGreaterThan(0); // dampened…
    expect(coolingDealt).toBeLessThan(200); // …but clearly the underdog
  });
});

describe("dealFromPool: sibling damping (ADR-25) reaches the hand", () => {
  it("a big breakdown does not take over the hand the way raw weights would", () => {
    // 20 siblings of one parent against 2 organic cards, all identical.
    // Undamped, the flood would take ~91% of every slot. Damped by 1/√20 the
    // organic pair stays clearly represented — the invariant is that the hand
    // is not simply all-siblings every morning.
    const siblings = Array.from({ length: 20 }, (_, i) =>
      candidate({ id: 100 + i, parentId: 7, effortMinutes: 10 }),
    );
    const organic = [candidate({ id: 1, effortMinutes: 10 }), candidate({ id: 2, effortMinutes: 10 })];
    let handsWithOrganic = 0;
    for (let i = 0; i < 200; i++) {
      const hand = dealFromPool([...siblings, ...organic], NOW, COOLDOWN, 30); // 3 slots
      if (hand.some((c) => c.parentId == null)) handsWithOrganic++;
    }
    // Undamped this sits near 25%; damped it is a solid majority. Loose bound.
    expect(handsWithOrganic).toBeGreaterThan(100);
  });
});

describe("localDate: the hand's day is the LOCAL calendar day", () => {
  it("formats a date as its local YYYY-MM-DD, zero-padded", () => {
    // Local components, so the assertion is timezone-independent: build the
    // instant from the very components the formatter must echo back.
    expect(localDate(new Date(2026, 6, 4, 23, 30))).toBe("2026-07-04");
    expect(localDate(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");
  });

  it("rolls over at LOCAL midnight — the two instants around it are different days", () => {
    expect(localDate(new Date(2026, 6, 14, 23, 59))).toBe("2026-07-14");
    expect(localDate(new Date(2026, 6, 15, 0, 0))).toBe("2026-07-15");
  });
});
