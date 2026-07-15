import { describe, expect, it } from "vitest";
import {
  poolWeights,
  siblingDamping,
  stalenessFactor,
  urgencyFactor,
  weight,
  type Candidate,
} from "../../src/services/drawService.js";
import { importLeaves, organicDeck, SIM_NOW } from "../../scripts/deckFixtures.js";

const NOW = new Date("2026-07-14T12:00:00Z");

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 1,
    parentId: null,
    impact: 3,
    effortMinutes: 20,
    dueDate: null,
    createdAt: NOW.toISOString(),
    recurEveryDays: null,
    lastDrawnAt: null,
    lastCompletedAt: null,
    deferredUntil: null,
    ...overrides,
  };
}

describe("urgencyFactor", () => {
  it("is neutral without a due date", () => {
    expect(urgencyFactor(null, NOW)).toBe(1);
  });

  it("is neutral when the due date is more than 7 days away", () => {
    expect(urgencyFactor("2026-08-30", NOW)).toBe(1);
  });

  it("ramps up as the due date approaches", () => {
    const in6days = urgencyFactor("2026-07-20", NOW);
    const in2days = urgencyFactor("2026-07-16", NOW);
    const today = urgencyFactor("2026-07-14", NOW);
    expect(in6days).toBeGreaterThan(1);
    expect(in2days).toBeGreaterThan(in6days);
    expect(today).toBeGreaterThan(in2days);
    expect(today).toBeLessThanOrEqual(4);
  });

  it("boosts overdue tasks to x5", () => {
    expect(urgencyFactor("2026-07-10", NOW)).toBe(5);
  });
});

describe("stalenessFactor", () => {
  it("starts near 1 for a brand-new task", () => {
    expect(stalenessFactor(candidate(), NOW)).toBeCloseTo(1, 2);
  });

  it("grows with age and caps at x2 after 30 days", () => {
    const tenDays = stalenessFactor(
      candidate({ createdAt: "2026-07-04T12:00:00Z" }),
      NOW,
    );
    const ninetyDays = stalenessFactor(
      candidate({ createdAt: "2026-04-15T12:00:00Z" }),
      NOW,
    );
    expect(tenDays).toBeCloseTo(1 + 10 / 30, 2);
    expect(ninetyDays).toBe(2);
  });

  it("uses last completion instead of creation for recurring tasks", () => {
    const recurring = candidate({
      recurEveryDays: 7,
      createdAt: "2026-01-01T00:00:00Z", // very old
      lastCompletedAt: "2026-07-13T12:00:00Z", // but done yesterday
    });
    expect(stalenessFactor(recurring, NOW)).toBeCloseTo(1 + 1 / 30, 2);
  });

  // ADR-17: deferred_until is retained after expiry as the wake timestamp —
  // snooze time must not count as "lying around".
  it("counts from the wake time, not creation, after a snooze expired", () => {
    const woken = candidate({
      createdAt: "2026-01-01T00:00:00Z", // ~195 days old — would cap at x2
      deferredUntil: "2026-07-09T12:00:00Z", // woke 5 days ago
    });
    expect(stalenessFactor(woken, NOW)).toBeCloseTo(1 + 5 / 30, 2);
  });

  it("ignores a wake time older than the creation date", () => {
    const preDeferred = candidate({
      createdAt: "2026-07-04T12:00:00Z", // 10 days old
      deferredUntil: "2026-06-01T00:00:00Z", // snooze long before creation? keep createdAt
    });
    expect(stalenessFactor(preDeferred, NOW)).toBeCloseTo(1 + 10 / 30, 2);
  });

  it("recurring tasks count from the wake time when it is after the last completion", () => {
    const recurringWoken = candidate({
      recurEveryDays: 7,
      createdAt: "2026-01-01T00:00:00Z",
      lastCompletedAt: "2026-06-14T12:00:00Z", // a month ago
      deferredUntil: "2026-07-12T12:00:00Z", // but woke 2 days ago
    });
    expect(stalenessFactor(recurringWoken, NOW)).toBeCloseTo(1 + 2 / 30, 2);
  });
});

describe("weight", () => {
  it("prefers high-impact low-effort over low-impact high-effort", () => {
    const quickWin = weight(candidate({ impact: 5, effortMinutes: 10 }), NOW, 60, 5);
    const slog = weight(candidate({ impact: 1, effortMinutes: 30 }), NOW, 60, 5);
    // 25/10 vs 1/30 → factor 75
    expect(quickWin / slog).toBeGreaterThan(50);
  });

  it("floors effort at 5 minutes so 1-minute tasks cannot dominate absurdly", () => {
    const oneMin = weight(candidate({ effortMinutes: 1 }), NOW, 60, 5);
    const fiveMin = weight(candidate({ effortMinutes: 5 }), NOW, 60, 5);
    expect(oneMin).toBe(fiveMin);
  });

  it("dampens recently drawn tasks when the pool has alternatives", () => {
    const fresh = weight(candidate(), NOW, 60, 5);
    const justDrawn = weight(
      candidate({ lastDrawnAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() }),
      NOW,
      60,
      5,
    );
    expect(justDrawn).toBeCloseTo(fresh * 0.15, 5);
  });

  it("does not dampen when it is the only candidate", () => {
    const justDrawn = weight(
      candidate({ lastDrawnAt: NOW.toISOString() }),
      NOW,
      60,
      1,
    );
    expect(justDrawn).toBeCloseTo(weight(candidate(), NOW, 60, 1), 5);
  });

  it("lets urgency beat impact when a deadline looms", () => {
    const dueToday = weight(candidate({ impact: 2, effortMinutes: 25, dueDate: "2026-07-14" }), NOW, 60, 5);
    const noDeadline = weight(candidate({ impact: 3, effortMinutes: 20 }), NOW, 60, 5);
    expect(dueToday).toBeGreaterThan(noDeadline);
  });
});

describe("sibling damping (#30, ADR-25)", () => {
  it("leaves parentless tasks and single children exactly unaffected", () => {
    const topLevel = candidate({ id: 1 });
    const onlyChild = candidate({ id: 2, parentId: 9 });
    const raw = weight(topLevel, NOW, 60, 2);
    expect(siblingDamping(1)).toBe(1);
    expect(poolWeights([topLevel, onlyChild], NOW, 60)).toEqual([raw, raw]);
  });

  it("damps k pool-siblings by exactly sqrt(k), independently per parent", () => {
    const pool = [
      candidate({ id: 1 }),
      ...[2, 3, 4, 5].map((id) => candidate({ id, parentId: 9 })),
      ...[6, 7].map((id) => candidate({ id, parentId: 8 })),
    ];
    const ws = poolWeights(pool, NOW, 60);
    const raw = weight(candidate(), NOW, 60, pool.length);
    expect(ws[0]).toBeCloseTo(raw, 10); // parentless: undamped
    expect(ws[1]).toBeCloseTo(raw / 2, 10); // 4 siblings: /sqrt(4)
    expect(ws[5]).toBeCloseTo(raw / Math.SQRT2, 10); // 2 siblings: /sqrt(2)
  });

  it("counts pool presence, not open siblings: a sequential queue's lone card is undamped", () => {
    // 39 held-back/snoozed siblings never reach the candidate list, so the
    // one card representing the breakdown competes at full weight (#23).
    const pool = [candidate({ id: 1 }), candidate({ id: 2, parentId: 9 })];
    const ws = poolWeights(pool, NOW, 60);
    expect(ws[1]).toBeCloseTo(ws[0], 10);
  });

  it("keeps every damped weight positive", () => {
    const pool = [...organicDeck(SIM_NOW), ...importLeaves(40, SIM_NOW)];
    for (const w of poolWeights(pool, SIM_NOW, 60)) {
      expect(w).toBeGreaterThan(0);
    }
  });
});

// The #30 validation deck (scripts/deckFixtures.ts, explored in depth by
// scripts/sim-issue30.ts): 12 organic tasks — 3 chores (one overdue), 3 due
// admin tasks, 6 goal tasks of mixed age — plus a 40-leaf #29 exam import
// (quintile impacts, 10-30 min, fresh, no due dates). Loose statistical
// bounds, not exact shares, per this suite's randomness rule.
describe("deck flood (#30): 40-sibling import vs the mixed organic deck", () => {
  function importShare(ws: number[], pool: { organic: boolean }[]): number {
    const total = ws.reduce((a, b) => a + b, 0);
    return pool.reduce((a, c, i) => a + (c.organic ? 0 : ws[i]), 0) / total;
  }

  it("documents the pre-change domination: import holds >55% of the mass on day 0", () => {
    const pool = [...organicDeck(SIM_NOW), ...importLeaves(40, SIM_NOW)];
    const raw = pool.map((c) => weight(c, SIM_NOW, 60, pool.length));
    // measured 58.2% (sim-issue30.ts scenario A); 67-74% in leaner decks
    expect(importShare(raw, pool)).toBeGreaterThan(0.55);
  });

  it("documents that waiting makes it worse: the pre-change share grows with staleness", () => {
    const day7 = new Date(SIM_NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
    const pool0 = [...organicDeck(SIM_NOW), ...importLeaves(40, SIM_NOW)];
    // steady-state organic deck a week later; the import ages from 1.0
    const pool7 = [...organicDeck(day7), ...importLeaves(40, SIM_NOW)];
    const share0 = importShare(pool0.map((c) => weight(c, SIM_NOW, 60, pool0.length)), pool0);
    const share7 = importShare(pool7.map((c) => weight(c, day7, 60, pool7.length)), pool7);
    // measured 58.2% -> 63.2%
    expect(share7).toBeGreaterThan(share0);
  });

  it("damping drops the import's aggregate share below 25% while keeping it present", () => {
    const pool = [...organicDeck(SIM_NOW), ...importLeaves(40, SIM_NOW)];
    const share = importShare(poolWeights(pool, SIM_NOW, 60), pool);
    // measured 18.0% — the 40-leaf exam competes like ~sqrt(40) ≈ 6 cards
    expect(share).toBeLessThan(0.25);
    expect(share).toBeGreaterThan(0.1);
  });

  it("damping decays as the import is worked through: share shrinks with the sibling count", () => {
    const shares = [40, 10, 2].map((k) => {
      const pool = [...organicDeck(SIM_NOW), ...importLeaves(k, SIM_NOW)];
      return importShare(poolWeights(pool, SIM_NOW, 60), pool);
    });
    expect(shares[0]).toBeGreaterThan(shares[1]);
    expect(shares[1]).toBeGreaterThan(shares[2]);
  });
});
