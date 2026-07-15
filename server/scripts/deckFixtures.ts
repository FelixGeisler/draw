/**
 * The #30 validation deck — shared by the exploratory simulation
 * (scripts/sim-issue30.ts) and the guarding unit tests
 * (test/unit/draw-weights.test.ts), so "the same mixed deck" the issue's
 * acceptance criteria refer to is pinned in exactly one place.
 */
import type { Candidate } from "../src/services/drawService.js";

export interface SimTask extends Candidate {
  title: string;
  organic: boolean;
}

/** Fixed clock for the scenario: a Wednesday noon (local). */
export const SIM_NOW = new Date("2026-07-15T12:00:00");

/** Synthetic id of the import's umbrella parent (never itself a candidate). */
export const IMPORT_PARENT_ID = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(n: number, from: Date): string {
  return new Date(from.getTime() - n * DAY_MS).toISOString();
}

function dueIn(n: number, from: Date): string {
  return new Date(from.getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

function task(id: number, title: string, organic: boolean, now: Date, overrides: Partial<SimTask>): SimTask {
  return {
    id,
    title,
    organic,
    parentId: null,
    impact: 3,
    effortMinutes: 20,
    dueDate: null,
    createdAt: now.toISOString(),
    recurEveryDays: null,
    lastDrawnAt: null,
    lastCompletedAt: null,
    deferredUntil: null,
    ...overrides,
  };
}

/**
 * A typical organic evening deck (12 tasks): 3 chores (one overdue —
 * urgency ×5), 3 admin tasks with deadlines inside the 7-day urgency ramp,
 * 6 goal/personal tasks of mixed age. The ages give the staleness spread a
 * weeks-old deck really has (1.0 up to the ×2 cap).
 */
export function organicDeck(now: Date): SimTask[] {
  return [
    task(1, "Take out recycling", true, now, { impact: 2, effortMinutes: 5, recurEveryDays: 7, lastCompletedAt: daysAgo(8, now), createdAt: daysAgo(90, now), dueDate: dueIn(-1, now) }),
    task(2, "Water plants", true, now, { impact: 1, effortMinutes: 5, recurEveryDays: 3, lastCompletedAt: daysAgo(2, now), createdAt: daysAgo(90, now), dueDate: dueIn(1, now) }),
    task(3, "Empty dishwasher", true, now, { impact: 1, effortMinutes: 10, createdAt: daysAgo(2, now) }),
    task(4, "Reply to landlord email", true, now, { impact: 3, effortMinutes: 10, createdAt: daysAgo(5, now), dueDate: dueIn(3, now) }),
    task(5, "Book dentist appointment", true, now, { impact: 3, effortMinutes: 10, createdAt: daysAgo(20, now) }),
    task(6, "Pay car insurance", true, now, { impact: 4, effortMinutes: 15, createdAt: daysAgo(10, now), dueDate: dueIn(5, now) }),
    task(7, "Stretch routine", true, now, { impact: 2, effortMinutes: 15, recurEveryDays: 2, lastCompletedAt: daysAgo(1, now), createdAt: daysAgo(60, now) }),
    task(8, "Read 20 pages", true, now, { impact: 3, effortMinutes: 25, createdAt: daysAgo(3, now) }),
    task(9, "Write blog outline", true, now, { impact: 4, effortMinutes: 30, createdAt: daysAgo(15, now) }),
    task(10, "Practice guitar", true, now, { impact: 3, effortMinutes: 20, createdAt: daysAgo(7, now) }),
    task(11, "Clean desk", true, now, { impact: 2, effortMinutes: 10, createdAt: daysAgo(30, now) }),
    task(12, "Update budget spreadsheet", true, now, { impact: 3, effortMinutes: 15, createdAt: daysAgo(12, now) }),
  ];
}

/**
 * The #29 import: one umbrella parent + flat leaves, committed at `now`.
 * - impact: normalizeImpacts assigns exact quintiles by point rank — 40
 *   distinct point values → exactly 8 leaves each of impact 1..5.
 * - effort: exam exercises state 10-45 minutes, but splitOversized
 *   guarantees every committed leaf is <= max_draw_effort (default 30), so
 *   ALL leaves are pool-eligible; the deterministic cycle mixes 10..30.
 * - fresh (staleness 1.0), no due dates (#29 keeps due dates off generated
 *   tasks by design), default subtask_order_mode 'parallel' (#29's commit
 *   path sends no orderMode).
 */
export function importLeaves(count: number, now: Date, parentId = IMPORT_PARENT_ID): SimTask[] {
  const efforts = [10, 15, 20, 25, 30, 20, 15, 25, 30, 20];
  const leaves: SimTask[] = [];
  for (let i = 0; i < count; i++) {
    const impact = 1 + Math.floor((i / count) * 5); // rank quintiles
    leaves.push(
      task(parentId * 100 + i, `Ex ${i + 1}`, false, now, {
        impact,
        effortMinutes: efforts[i % efforts.length],
        createdAt: now.toISOString(),
        parentId,
      }),
    );
  }
  return leaves;
}
