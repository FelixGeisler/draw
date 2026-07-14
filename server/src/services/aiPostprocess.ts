import type { GenerateTasksResult } from "../aiSchemas.js";

// Deterministic post-processing for /api/ai/generate-tasks (#28).
// Pure functions only — no SDK, no DB — so they are unit-testable without an
// API key and reusable by the future assistant's apply step (#31).

export type Impact = 1 | 2 | 3 | 4 | 5;
export type ImpactSource = "points" | "model";

export type GeneratedTask = GenerateTasksResult["tasks"][number];
export type GeneratedPart = GeneratedTask["parts"][number];

export interface ProcessedTask extends GeneratedTask {
  impact: Impact;
  impactSource: ImpactSource;
}

export interface GenerateTasksProcessed {
  sourceOverview: string;
  tasks: ProcessedTask[];
}

// Hygiene caps against model runaway; also stated in the prompt so the model
// aims for them instead of being silently truncated.
export const MAX_ITEMS = 60;
export const MAX_PARTS_PER_ITEM = 10;

function clampMinutes(minutes: number): number {
  return Math.max(1, Math.round(minutes));
}

/**
 * Drop empty titles (tasks and parts), clamp minutes to >= 1 whole minutes,
 * and cap list sizes. `statedMinutes`/`points` are the material's own data and
 * pass through verbatim — post-processing must never rewrite them.
 *
 * A parts list over the cap is dropped ENTIRELY, never truncated: part minutes
 * sum to the item's total, so truncation would silently erase material time
 * (15×10-min parts under statedMinutes 150 must not become 10 parts summing
 * 100). With no parts left, `splitOversized` rebuilds an even split from
 * `statedMinutes ?? estimatedMinutes` that preserves the total within the cap.
 */
export function capAndClean(tasks: GeneratedTask[]): GeneratedTask[] {
  return tasks
    .map((t) => {
      const parts = t.parts
        .map((p) => ({ title: p.title.trim(), minutes: clampMinutes(p.minutes) }))
        .filter((p) => p.title.length > 0);
      return {
        ...t,
        title: t.title.trim(),
        estimatedMinutes: clampMinutes(t.estimatedMinutes),
        parts: parts.length > MAX_PARTS_PER_ITEM ? [] : parts,
      };
    })
    .filter((t) => t.title.length > 0)
    .slice(0, MAX_ITEMS);
}

/**
 * points → impact by quintile of the item's rank among all pointed items
 * (point share and points rank identically, so ranks are enough).
 *
 * When at least half the items carry points, each pointed item's mid-rank
 * percentile maps onto 1-5 (top quintile → 5, bottom → 1). Ties get the same
 * mid-rank, hence the same rating; all-equal points land everything on one
 * middle rating (documented behavior, not a bug). Items the rule cannot rate
 * (no points, or a set where fewer than half have points) fall back to the
 * model's `suggestedImpact` and are flagged `impactSource: "model"`.
 *
 * Points measure leverage toward the graded outcome directly (ADR-4). Time is
 * deliberately NOT folded in: draw weight is already impact²/effort — time in
 * impact would double-count effort.
 */
export function normalizeImpacts(tasks: GeneratedTask[]): ProcessedTask[] {
  const pointed = tasks.filter((t) => t.points != null);
  const usePoints = tasks.length > 0 && pointed.length * 2 >= tasks.length;

  const fromModel = (t: GeneratedTask): ProcessedTask => ({
    ...t,
    impact: t.suggestedImpact,
    impactSource: "model",
  });
  if (!usePoints) return tasks.map(fromModel);

  const points = pointed.map((t) => t.points as number);
  return tasks.map((t) => {
    if (t.points == null) return fromModel(t);
    const below = points.filter((p) => p < (t.points as number)).length;
    const ties = points.filter((p) => p === t.points).length;
    const midRank = (below + ties / 2) / points.length; // in (0, 1)
    const impact = Math.min(5, Math.floor(midRank * 5) + 1) as Impact;
    return { ...t, impact, impactSource: "points" };
  });
}

/** Split `total` minutes into `count` near-equal whole-minute parts that sum to `total`. */
export function evenSplit(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, i) => (i < remainder ? base + 1 : base));
}

function splitPlan(title: string, minutes: number, maxEffort: number): GeneratedPart[] {
  // The parts cap wins over the drawable limit only in pathological cases
  // (minutes > maxEffort * MAX_PARTS_PER_ITEM); the total is always preserved
  // so the review UI shows the material's real numbers.
  const count = Math.min(Math.ceil(minutes / maxEffort), MAX_PARTS_PER_ITEM);
  return evenSplit(minutes, count).map((m, i) => ({
    title: `${title} (part ${i + 1}/${count})`,
    minutes: m,
  }));
}

/**
 * Split, don't clamp: an item longer than `maxEffort` with no model-provided
 * parts becomes ceil(minutes / maxEffort) even parts that preserve the total.
 * The `Math.min` clamp used by breakdown/plan-goal is banned here — it would
 * silently rewrite the material's own time data (a 60-minute exercise must
 * never become a single "30 min" task). Model-provided parts are kept (they
 * follow the material's sub-question boundaries), but any single oversized
 * part is itself split so every leaf stays drawable.
 *
 * MAX_PARTS_PER_ITEM is an invariant of the OUTPUT (PR #42 / ADR-13), so it is
 * re-checked after expansion: when splitting oversized model parts blows the
 * cap (e.g. 10×60-min parts at maxEffort 30 would become 20), the sub-question
 * boundaries are abandoned and the parts' summed minutes are re-split evenly —
 * `splitPlan` enforces the cap and preserves the total in one place.
 */
export function splitOversized<T extends GeneratedTask>(task: T, maxEffort: number): T {
  if (task.parts.length > 0) {
    const parts = task.parts.flatMap((p) =>
      p.minutes > maxEffort ? splitPlan(p.title, p.minutes, maxEffort) : [p],
    );
    if (parts.length <= MAX_PARTS_PER_ITEM) return { ...task, parts };
    const total = Math.round(task.parts.reduce((sum, p) => sum + p.minutes, 0));
    return { ...task, parts: splitPlan(task.title, total, maxEffort) };
  }
  const minutes = task.statedMinutes ?? task.estimatedMinutes;
  if (minutes <= maxEffort) return task;
  return { ...task, parts: splitPlan(task.title, Math.round(minutes), maxEffort) };
}

/** Full deterministic pipeline: hygiene/caps → points→impact → split oversized. */
export function postprocessGenerateTasks(
  result: GenerateTasksResult,
  maxEffort: number,
): GenerateTasksProcessed {
  const tasks = normalizeImpacts(capAndClean(result.tasks)).map((t) =>
    splitOversized(t, maxEffort),
  );
  return { sourceOverview: result.sourceOverview, tasks };
}
