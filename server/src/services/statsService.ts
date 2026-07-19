import { db } from "../db.js";

export interface Stats {
  totalMinutes: number;
  byCategory: { categoryId: number; name: string; color: string; minutes: number }[];
  byImpact: { impact: number; minutes: number }[];
  byGoal: { goalId: number; title: string; minutes: number }[];
  completed: { count: number; avgEffortMinutes: number | null };
  estimation: Estimation;
  leverageInsights: string[];
  weeklyGrade: string | null;
}

/**
 * One task completed in range. `estimatedMinutes` is what the tracked minutes
 * are compared against — the per-cycle estimate times the number of tracked
 * in-range cycles (null when the task was never estimated).
 */
export interface EstimationInputRow {
  taskId: number;
  estimatedMinutes: number | null;
  trackedMinutes: number;
  categoryId: number;
  categoryName: string;
  categoryColor: string;
}

export type Tendency = "under" | "over" | "accurate";

// Summary-only since #155 (ADR-41): the per-task array was an unbounded
// overwhelm surface on the Stats page and had no other consumer, so it is
// no longer computed or shipped.
export interface Estimation {
  summary: {
    taskCount: number;
    totalEstimatedMinutes: number;
    totalTrackedMinutes: number;
    accuracyRatio: number | null;
    tendency: Tendency | null;
  };
  byCategory: {
    categoryId: number;
    name: string;
    color: string;
    /** Qualifying tasks aggregated into this row (#55 coaching thresholds). */
    taskCount: number;
    estimatedMinutes: number;
    trackedMinutes: number;
    ratio: number;
  }[];
}

/**
 * Per-category all-history estimation bias (#55): the estimation block's
 * byCategory aggregation reduced to what coaching needs. Thresholding on
 * `taskCount` is deliberately NOT applied here — showing or hiding a
 * category is a display decision that lives in the client.
 */
export interface CategoryBias {
  categoryId: number;
  name: string;
  color: string;
  taskCount: number;
  ratio: number;
}

/** Ratios within this band (inclusive, after rounding) count as accurate. */
const ACCURATE_MIN = 0.9;
const ACCURATE_MAX = 1.1;

const round2 = (n: number) => Math.round(n * 100) / 100;

function tendencyFor(ratio: number): Tendency {
  // ratio = tracked / estimated: taking longer than planned means the
  // estimate was too low — you *under*-estimate.
  if (ratio > ACCURATE_MAX) return "under";
  if (ratio < ACCURATE_MIN) return "over";
  return "accurate";
}

/**
 * Pure estimated-vs-tracked aggregation (no DB). Tasks without a positive
 * effort estimate are excluded here rather than treated as 0 — a zero
 * estimate would fake a broken ratio (and divide by zero). Tasks without
 * tracked time in any attributed cycle never reach this function
 * (computeStats drops them before calling).
 */
export function buildEstimation(rows: EstimationInputRow[]): Estimation {
  const qualifying = rows.filter(
    (r): r is EstimationInputRow & { estimatedMinutes: number } =>
      r.estimatedMinutes !== null && r.estimatedMinutes > 0,
  );

  const totalEstimated = qualifying.reduce((sum, r) => sum + r.estimatedMinutes, 0);
  const totalTracked = qualifying.reduce((sum, r) => sum + r.trackedMinutes, 0);
  const accuracyRatio = totalEstimated > 0 ? round2(totalTracked / totalEstimated) : null;

  const catMap = new Map<
    number,
    {
      categoryId: number;
      name: string;
      color: string;
      taskCount: number;
      estimatedMinutes: number;
      trackedMinutes: number;
    }
  >();
  for (const r of qualifying) {
    const cat = catMap.get(r.categoryId) ?? {
      categoryId: r.categoryId,
      name: r.categoryName,
      color: r.categoryColor,
      taskCount: 0,
      estimatedMinutes: 0,
      trackedMinutes: 0,
    };
    cat.taskCount += 1;
    cat.estimatedMinutes += r.estimatedMinutes;
    cat.trackedMinutes += r.trackedMinutes;
    catMap.set(r.categoryId, cat);
  }
  const byCategory = [...catMap.values()]
    .map((c) => ({
      ...c,
      trackedMinutes: Math.round(c.trackedMinutes),
      ratio: round2(c.trackedMinutes / c.estimatedMinutes),
    }))
    .sort((a, b) => b.trackedMinutes - a.trackedMinutes || a.categoryId - b.categoryId);

  return {
    summary: {
      taskCount: qualifying.length,
      totalEstimatedMinutes: totalEstimated,
      totalTrackedMinutes: Math.round(totalTracked),
      accuracyRatio,
      tendency: accuracyRatio === null ? null : tendencyFor(accuracyRatio),
    },
    byCategory,
  };
}

/**
 * Per-completion attribution of tracked time: each completion owns the
 * entries started after the previous completion (if any) and at or before its
 * own timestamp, and every in-range completion's window counts. Recurring
 * tasks (recur_every_days) complete over and over, so a lifetime sum would
 * count every earlier cycle's entries against a single per-cycle estimate and
 * inflate the ratio each cycle (#39). One-shot tasks have no previous
 * completion, so all their work counts even when it started before the range.
 * Cycles without tracked minutes contribute nothing — not even to `cycles` —
 * because a checkbox-only completion says nothing about estimation accuracy;
 * counting it would fake an over-estimate. Attributing every tracked in-range
 * cycle (not just the latest) keeps a task visible when only an earlier
 * in-range cycle was timed (#48). ISO-8601 strings compare lexicographically —
 * `from`/`to` may be date-only prefixes, as in the SQL range filters.
 */
export function trackedCyclesInRange(
  completions: string[],
  entries: { startedAt: string; minutes: number }[],
  from: string,
  to: string,
): { minutes: number; cycles: number } {
  const sorted = [...completions].sort();
  let minutes = 0;
  let cycles = 0;
  sorted.forEach((completedAt, i) => {
    if (completedAt < from || completedAt >= to) return;
    // "" sorts before every timestamp: no previous completion = no lower bound.
    const prev = i > 0 ? sorted[i - 1] : "";
    const cycleMinutes = entries
      .filter((e) => e.startedAt > prev && e.startedAt <= completedAt)
      .reduce((sum, e) => sum + e.minutes, 0);
    if (cycleMinutes > 0) {
      minutes += cycleMinutes;
      cycles += 1;
    }
  });
  return { minutes, cycles };
}

/** Minutes per time entry (alias `e`), running entries counted up to now. */
export const MINUTES_EXPR = `(julianday(COALESCE(e.ended_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) - julianday(e.started_at)) * 1440.0`;

/**
 * Tasks completed in [from, to) with tracked time attributed per cycle in
 * trackedCyclesInRange (#39, #48): SQL only fetches the raw completions and
 * entries per task — the deliberately unfiltered entry list lets one-shot
 * tasks count work started before the range, while recurring tasks count
 * only cycles completed in range. Shared by the range-scoped estimation
 * block and the all-history bias endpoint (#55) so both apply identical
 * qualifying rules.
 */
function estimationRowsInRange(from: string, to: string): EstimationInputRow[] {
  const completedInRange = db
    .prepare(
      `SELECT t.id AS taskId, t.effort_minutes AS estimatedMinutes,
              c.id AS categoryId, c.name AS categoryName, c.color AS categoryColor
       FROM tasks t
       JOIN categories c ON c.id = t.category_id
       WHERE EXISTS (
         SELECT 1 FROM completions co
         WHERE co.task_id = t.id AND co.completed_at >= ? AND co.completed_at < ?
       )`,
    )
    .all(from, to) as Omit<EstimationInputRow, "trackedMinutes">[];

  const completionsStmt = db.prepare(
    "SELECT completed_at AS completedAt FROM completions WHERE task_id = ?",
  );
  const entriesStmt = db.prepare(
    `SELECT e.started_at AS startedAt, ${MINUTES_EXPR} AS minutes FROM time_entries e WHERE e.task_id = ?`,
  );

  const rows: EstimationInputRow[] = [];
  for (const task of completedInRange) {
    const completions = (completionsStmt.all(task.taskId) as { completedAt: string }[]).map(
      (r) => r.completedAt,
    );
    const entries = entriesStmt.all(task.taskId) as { startedAt: string; minutes: number }[];
    const { minutes, cycles } = trackedCyclesInRange(completions, entries, from, to);
    // No tracked time in any attributed cycle — nothing to compare, same as
    // a never-tracked task. Several tracked cycles compare against one
    // per-cycle estimate each.
    if (cycles > 0)
      rows.push({
        ...task,
        estimatedMinutes: task.estimatedMinutes === null ? null : task.estimatedMinutes * cycles,
        trackedMinutes: minutes,
      });
  }
  return rows;
}

// All-history bounds for the bias endpoint: ISO-8601 strings compare
// lexicographically (see trackedCyclesInRange and the SQL range filters),
// so "" sorts before every timestamp and year 9999 after every plausible one.
const ALL_HISTORY_FROM = "";
const ALL_HISTORY_TO = "9999-12-31";

/**
 * Per-category estimation bias over ALL history (#55), reusing the same
 * qualifying rules (positive estimate, tracked time in an attributed cycle)
 * and per-cycle attribution (ADR-15, #48) as the range-scoped estimation
 * block. Read-only coaching input — never feeds the draw weights (ADR-27).
 */
export function computeEstimationBias(): CategoryBias[] {
  const { byCategory } = buildEstimation(estimationRowsInRange(ALL_HISTORY_FROM, ALL_HISTORY_TO));
  return byCategory.map(({ categoryId, name, color, taskCount, ratio }) => ({
    categoryId,
    name,
    color,
    taskCount,
    ratio,
  }));
}

export function computeStats(from: string, to: string): Stats {
  // `to` is exclusive end-of-range (ISO date + 1 day handled by caller)
  const range = [from, to];

  const total = db
    .prepare(
      `SELECT COALESCE(SUM(${MINUTES_EXPR}), 0) AS minutes
       FROM time_entries e WHERE e.started_at >= ? AND e.started_at < ?`,
    )
    .get(...range) as { minutes: number };

  const byCategory = db
    .prepare(
      `SELECT c.id AS categoryId, c.name, c.color, SUM(${MINUTES_EXPR}) AS minutes
       FROM time_entries e JOIN tasks t ON t.id = e.task_id JOIN categories c ON c.id = t.category_id
       WHERE e.started_at >= ? AND e.started_at < ?
       GROUP BY c.id ORDER BY minutes DESC`,
    )
    .all(...range) as Stats["byCategory"];

  const byImpact = db
    .prepare(
      `SELECT t.impact, SUM(${MINUTES_EXPR}) AS minutes
       FROM time_entries e JOIN tasks t ON t.id = e.task_id
       WHERE e.started_at >= ? AND e.started_at < ?
       GROUP BY t.impact ORDER BY t.impact`,
    )
    .all(...range) as Stats["byImpact"];

  const byGoal = db
    .prepare(
      `SELECT g.id AS goalId, g.title, SUM(${MINUTES_EXPR}) AS minutes
       FROM time_entries e JOIN tasks t ON t.id = e.task_id JOIN goals g ON g.id = t.goal_id
       WHERE e.started_at >= ? AND e.started_at < ?
       GROUP BY g.id ORDER BY minutes DESC`,
    )
    .all(...range) as Stats["byGoal"];

  const completed = db
    .prepare(
      `SELECT COUNT(*) AS count, AVG(t.effort_minutes) AS avgEffortMinutes
       FROM completions co JOIN tasks t ON t.id = co.task_id
       WHERE co.completed_at >= ? AND co.completed_at < ?`,
    )
    .get(...range) as Stats["completed"];

  const estimationRows = estimationRowsInRange(from, to);

  const totalMinutes = Math.round(total.minutes);
  const minutesAt = (pred: (impact: number) => boolean) =>
    byImpact.filter((r) => pred(r.impact)).reduce((a, r) => a + r.minutes, 0);

  const lowShare = totalMinutes > 0 ? minutesAt((i) => i <= 2) / total.minutes : 0;
  const highShare = totalMinutes > 0 ? minutesAt((i) => i >= 4) / total.minutes : 0;

  const leverageInsights: string[] = [];
  if (totalMinutes >= 30 && lowShare > 0.5) {
    leverageInsights.push(
      `⚠ ${Math.round(lowShare * 100)}% of your tracked time went to 1–2★ tasks. Is the intro chapter really where the marks are?`,
    );
  }
  if (totalMinutes >= 30 && highShare < 0.1) {
    leverageInsights.push(
      `Your 4–5★ tasks got only ${Math.round(minutesAt((i) => i >= 4))} min. Draw from the high-leverage pile first.`,
    );
  }
  if (totalMinutes >= 30 && highShare >= 0.6) {
    leverageInsights.push(
      `💪 ${Math.round(highShare * 100)}% of your time went to 4–5★ tasks. That's leverage.`,
    );
  }

  let weeklyGrade: string | null = null;
  if (totalMinutes >= 30) {
    weeklyGrade =
      highShare >= 0.6 ? "A" : highShare >= 0.45 ? "B" : highShare >= 0.3 ? "C" : highShare >= 0.15 ? "D" : "F";
  }

  return {
    totalMinutes,
    byCategory: byCategory.map((r) => ({ ...r, minutes: Math.round(r.minutes) })),
    byImpact: byImpact.map((r) => ({ ...r, minutes: Math.round(r.minutes) })),
    byGoal: byGoal.map((r) => ({ ...r, minutes: Math.round(r.minutes) })),
    completed: {
      count: completed.count,
      avgEffortMinutes: completed.avgEffortMinutes ? Math.round(completed.avgEffortMinutes) : null,
    },
    estimation: buildEstimation(estimationRows),
    leverageInsights,
    weeklyGrade,
  };
}
