/**
 * Estimation coaching (#55, ADR-27): pure decision logic shared by the
 * TaskForm hint and the Stats page bias statements. Everything here is
 * read-only advice — nothing in this module (or its callers) ever mutates an
 * estimate, blocks a submit, or feeds the draw weights.
 */

/** Qualifying tasks a category needs before any coaching shows. */
export const MIN_SAMPLE = 3;

/** The hint appears only when |ratio − 1| exceeds this. */
export const DIVERGENCE = 0.25;

/**
 * Same accurate band as the server (statsService ACCURATE_MIN/MAX, inclusive
 * after rounding): inside it a category's estimates count as on point.
 */
export const ACCURATE_MIN = 0.9;
export const ACCURATE_MAX = 1.1;

/** What a coaching consumer needs to know about a category's history. */
export interface BiasSample {
  taskCount: number;
  /** tracked / estimated over the category's qualifying tasks. */
  ratio: number;
}

export interface EstimateHint {
  suggestedMinutes: number;
  ratio: number;
}

/**
 * Suggestions are rounded to the nearest 5 minutes; the floor keeps a tiny
 * product (e.g. 10 min × 0.2) from rounding down to a nonsensical "~0 min".
 */
export function roundSuggestion(minutes: number): number {
  return Math.max(5, Math.round(minutes / 5) * 5);
}

/**
 * The passive TaskForm hint. Null (= render nothing) unless ALL preconditions
 * hold: a category history exists, it meets the minimum sample, the user has
 * entered a positive estimate, and history diverges from it by more than
 * DIVERGENCE. The returned suggestion is advice only — the field value and
 * the submitted payload stay exactly what the user typed.
 */
export function estimateHint(
  bias: BiasSample | undefined,
  enteredMinutes: number | null,
): EstimateHint | null {
  if (!bias || bias.taskCount < MIN_SAMPLE) return null;
  if (enteredMinutes === null || !Number.isFinite(enteredMinutes) || enteredMinutes <= 0)
    return null;
  if (Math.abs(bias.ratio - 1) <= DIVERGENCE) return null;
  return {
    suggestedMinutes: roundSuggestion(enteredMinutes * bias.ratio),
    ratio: bias.ratio,
  };
}

/** "history suggests ~45 min (you track 1.5× your Uni estimates)" */
export function hintText(hint: EstimateHint, categoryName: string): string {
  return `history suggests ~${hint.suggestedMinutes} min (you track ${hint.ratio}× your ${categoryName} estimates)`;
}

/**
 * Plain-language per-category statement for the Stats page. Null below the
 * minimum sample — the section renders nothing then, not a placeholder.
 * Inside the accurate band the line stays short and positive; outside it the
 * tone follows the block's tendency convention (ratio > 1 = you under-estimate).
 */
export function biasStatement(cat: BiasSample & { name: string }): string | null {
  if (cat.taskCount < MIN_SAMPLE) return null;
  const tasks = `${cat.taskCount} task${cat.taskCount === 1 ? "" : "s"}`;
  if (cat.ratio > ACCURATE_MAX)
    return `${cat.name}: tracked ${cat.ratio}× estimated over ${tasks} — pad your ${cat.name} estimates.`;
  if (cat.ratio < ACCURATE_MIN)
    return `${cat.name}: tracked ${cat.ratio}× estimated over ${tasks} — your ${cat.name} estimates run high, trim them.`;
  return `${cat.name}: estimates on point over ${tasks}.`;
}
