import { describe, expect, it } from "vitest";
import { pickWarmup, stalenessAnchor, type Candidate } from "../../src/services/drawService.js";
import { xpMultiplier } from "../../src/services/gamificationService.js";

// Warm-up draw (#57, ADR-30): the deterministic pick and the XP multiplier
// matrix. Selection: minimum effort, tie-break most stale (the shared
// stalenessFactor anchor), final tie-break lowest id; the cooldown applies
// as EXCLUSION. XP: warm-up ×1.25 in window / ×1.0 late and NEVER the drawn
// ×1.5; momentum ×1.25 on other cards, every combination capped at ×1.5.

const NOW = new Date("2026-07-14T12:00:00Z");

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 1,
    parentId: null,
    impact: 3,
    effortMinutes: 20,
    dueDate: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    recurEveryDays: null,
    lastDrawnAt: null,
    lastCompletedAt: null,
    deferredUntil: null,
    ...overrides,
  };
}

describe("pickWarmup: deterministic minimum-effort selection", () => {
  it("deals the smallest effort regardless of impact, urgency, and staleness", () => {
    const heavyweight = candidate({
      id: 1,
      effortMinutes: 25,
      impact: 5, // impact²/effort would dominate any weighted pick
      dueDate: "2026-07-14", // overdue-adjacent urgency ×~4
      createdAt: "2026-01-01T00:00:00.000Z", // staleness capped at ×2
    });
    const tiny = candidate({ id: 2, effortMinutes: 5, impact: 1 });
    expect(pickWarmup([heavyweight, tiny], NOW, 60)?.id).toBe(2);
    // Order in the array must not matter — the pick is a pure minimum.
    expect(pickWarmup([tiny, heavyweight], NOW, 60)?.id).toBe(2);
  });

  it("the same deck state always deals the same card", () => {
    const pool = [
      candidate({ id: 3, effortMinutes: 10 }),
      candidate({ id: 1, effortMinutes: 5 }),
      candidate({ id: 2, effortMinutes: 5, createdAt: "2026-07-10T00:00:00.000Z" }),
    ];
    const first = pickWarmup(pool, NOW, 60)?.id;
    for (let i = 0; i < 20; i++) {
      expect(pickWarmup(pool, NOW, 60)?.id).toBe(first);
    }
  });

  it("breaks effort ties by the most stale card (older createdAt wins)", () => {
    const fresh = candidate({ id: 1, effortMinutes: 5, createdAt: "2026-07-13T00:00:00.000Z" });
    const stale = candidate({ id: 2, effortMinutes: 5, createdAt: "2026-06-01T00:00:00.000Z" });
    expect(pickWarmup([fresh, stale], NOW, 60)?.id).toBe(2);
  });

  it("uses the recurring last-completion anchor: recently done recurring loses to an older card", () => {
    const recurring = candidate({
      id: 1,
      effortMinutes: 5,
      recurEveryDays: 7,
      createdAt: "2026-01-01T00:00:00.000Z", // ancient…
      lastCompletedAt: "2026-07-13T12:00:00.000Z", // …but done yesterday
    });
    const older = candidate({ id: 2, effortMinutes: 5, createdAt: "2026-07-01T00:00:00.000Z" });
    expect(stalenessAnchor(recurring).toISOString()).toBe("2026-07-13T12:00:00.000Z");
    expect(pickWarmup([recurring, older], NOW, 60)?.id).toBe(2);
  });

  it("bumps the anchor to the snooze wake time: a woken card is fresher than its createdAt", () => {
    const woken = candidate({
      id: 1,
      effortMinutes: 5,
      createdAt: "2026-01-01T00:00:00.000Z",
      deferredUntil: "2026-07-12T00:00:00.000Z", // woke two days ago
    });
    const older = candidate({ id: 2, effortMinutes: 5, createdAt: "2026-06-01T00:00:00.000Z" });
    expect(stalenessAnchor(woken).toISOString()).toBe("2026-07-12T00:00:00.000Z");
    expect(pickWarmup([woken, older], NOW, 60)?.id).toBe(2);
  });

  it("final tie-break: lowest id wins on identical effort and staleness", () => {
    const a = candidate({ id: 7, effortMinutes: 5 });
    const b = candidate({ id: 3, effortMinutes: 5 });
    expect(pickWarmup([a, b], NOW, 60)?.id).toBe(3);
    expect(pickWarmup([b, a], NOW, 60)?.id).toBe(3);
  });

  it("excludes cards drawn within the cooldown instead of dampening them", () => {
    const justDealt = candidate({
      id: 1,
      effortMinutes: 5,
      lastDrawnAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(), // 10 min ago
    });
    const bigger = candidate({ id: 2, effortMinutes: 25 });
    // The smallest card is cooling down → the deal falls to the next one.
    expect(pickWarmup([justDealt, bigger], NOW, 60)?.id).toBe(2);
  });

  it("re-admits a card once the cooldown has passed", () => {
    const cooled = candidate({
      id: 1,
      effortMinutes: 5,
      lastDrawnAt: new Date(NOW.getTime() - 61 * 60_000).toISOString(),
    });
    expect(pickWarmup([cooled, candidate({ id: 2, effortMinutes: 25 })], NOW, 60)?.id).toBe(1);
  });

  it("returns null when exclusion empties an otherwise non-empty pool (cooling down)", () => {
    const pool = [
      candidate({ id: 1, effortMinutes: 5, lastDrawnAt: NOW.toISOString() }),
      candidate({
        id: 2,
        effortMinutes: 10,
        lastDrawnAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
      }),
    ];
    expect(pickWarmup(pool, NOW, 60)).toBeNull();
  });

  it("even a single-card pool is excluded while cooling — no deal-discard-deal churn", () => {
    // The weighted draw skips its dampener for a pool of one; the warm-up
    // must NOT copy that: re-dealing the card just discarded is exactly the
    // churn the exclusion exists to prevent.
    const only = candidate({ id: 1, effortMinutes: 5, lastDrawnAt: NOW.toISOString() });
    expect(pickWarmup([only], NOW, 60)).toBeNull();
  });
});

describe("xpMultiplier: the ×1.5 cap invariant (#57)", () => {
  it("warm-up completed in its window pays ×1.25 and names the bonus", () => {
    expect(xpMultiplier({ wasDrawn: false, warmup: { inWindow: true }, momentum: false })).toEqual({
      multiplier: 1.25,
      bonus: "warmup",
    });
  });

  it("late warm-up pays plain ×1.0 with no bonus", () => {
    expect(xpMultiplier({ wasDrawn: false, warmup: { inWindow: false }, momentum: false })).toEqual({
      multiplier: 1,
      bonus: null,
    });
  });

  it("a warm-up NEVER receives the drawn ×1.5, even as the persisted current draw", () => {
    // The route derives wasDrawn=true for the current draw — the warm-up
    // branch must override it in both window states.
    expect(
      xpMultiplier({ wasDrawn: true, warmup: { inWindow: true }, momentum: false }).multiplier,
    ).toBe(1.25);
    expect(
      xpMultiplier({ wasDrawn: true, warmup: { inWindow: false }, momentum: false }).multiplier,
    ).toBe(1);
  });

  it("momentum never applies to the warm-up itself — warm-ups cap at ×1.25", () => {
    expect(
      xpMultiplier({ wasDrawn: true, warmup: { inWindow: true }, momentum: true }).multiplier,
    ).toBe(1.25);
  });

  it("momentum pays ×1.25 on a non-drawn card and names the bonus", () => {
    expect(xpMultiplier({ wasDrawn: false, warmup: null, momentum: true })).toEqual({
      multiplier: 1.25,
      bonus: "momentum",
    });
  });

  it("drawn + momentum is capped at ×1.5 — the drawn card gains nothing, so no bonus is named", () => {
    expect(xpMultiplier({ wasDrawn: true, warmup: null, momentum: true })).toEqual({
      multiplier: 1.5,
      bonus: null,
    });
  });

  it("plain and drawn completions are unchanged", () => {
    expect(xpMultiplier({ wasDrawn: false, warmup: null, momentum: false })).toEqual({
      multiplier: 1,
      bonus: null,
    });
    expect(xpMultiplier({ wasDrawn: true, warmup: null, momentum: false })).toEqual({
      multiplier: 1.5,
      bonus: null,
    });
  });

  it("exhaustive: no input combination ever exceeds ×1.5, and warm-ups stay strictly below", () => {
    for (const wasDrawn of [false, true]) {
      for (const warmup of [null, { inWindow: true }, { inWindow: false }]) {
        for (const momentum of [false, true]) {
          const { multiplier } = xpMultiplier({ wasDrawn, warmup, momentum });
          expect(multiplier).toBeLessThanOrEqual(1.5);
          if (warmup) expect(multiplier).toBeLessThanOrEqual(1.25);
        }
      }
    }
  });
});
