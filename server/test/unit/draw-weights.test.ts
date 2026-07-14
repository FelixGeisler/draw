import { describe, expect, it } from "vitest";
import { stalenessFactor, urgencyFactor, weight, type Candidate } from "../../src/services/drawService.js";

const NOW = new Date("2026-07-14T12:00:00Z");

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 1,
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

  // ADR-14: deferred_until is retained after expiry as the wake timestamp —
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
