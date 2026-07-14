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

/** One task completed in range, as fetched from SQL (estimate may be missing). */
export interface EstimationInputRow {
  taskId: number;
  title: string;
  estimatedMinutes: number | null;
  trackedMinutes: number;
  categoryId: number;
  categoryName: string;
  categoryColor: string;
}

export type Tendency = "under" | "over" | "accurate";

export interface Estimation {
  tasks: {
    taskId: number;
    title: string;
    estimatedMinutes: number;
    trackedMinutes: number;
    ratio: number;
  }[];
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
    estimatedMinutes: number;
    trackedMinutes: number;
    ratio: number;
  }[];
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
 * any time entry never reach this function (INNER JOIN in computeStats).
 */
export function buildEstimation(rows: EstimationInputRow[]): Estimation {
  const qualifying = rows.filter(
    (r): r is EstimationInputRow & { estimatedMinutes: number } =>
      r.estimatedMinutes !== null && r.estimatedMinutes > 0,
  );

  const tasks = qualifying
    .map((r) => ({
      taskId: r.taskId,
      title: r.title,
      estimatedMinutes: r.estimatedMinutes,
      trackedMinutes: Math.round(r.trackedMinutes),
      ratio: round2(r.trackedMinutes / r.estimatedMinutes),
    }))
    // Worst under-estimates first; taskId breaks ties deterministically.
    .sort((a, b) => b.ratio - a.ratio || a.taskId - b.taskId);

  const totalEstimated = qualifying.reduce((sum, r) => sum + r.estimatedMinutes, 0);
  const totalTracked = qualifying.reduce((sum, r) => sum + r.trackedMinutes, 0);
  const accuracyRatio = totalEstimated > 0 ? round2(totalTracked / totalEstimated) : null;

  const catMap = new Map<
    number,
    { categoryId: number; name: string; color: string; estimatedMinutes: number; trackedMinutes: number }
  >();
  for (const r of qualifying) {
    const cat = catMap.get(r.categoryId) ?? {
      categoryId: r.categoryId,
      name: r.categoryName,
      color: r.categoryColor,
      estimatedMinutes: 0,
      trackedMinutes: 0,
    };
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
    tasks,
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

/** Minutes per time entry, running entries counted up to now. */
const MINUTES_EXPR = `(julianday(COALESCE(e.ended_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) - julianday(e.started_at)) * 1440.0`;

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

  // Tasks completed in range (EXISTS, not JOIN — recurring tasks may have
  // several completions and must not double-count their entries) with ALL
  // their time entries: work on a task completed this week may have started
  // earlier, so entries are deliberately not range-filtered.
  const estimationRows = db
    .prepare(
      `SELECT t.id AS taskId, t.title, t.effort_minutes AS estimatedMinutes,
              c.id AS categoryId, c.name AS categoryName, c.color AS categoryColor,
              SUM(${MINUTES_EXPR}) AS trackedMinutes
       FROM tasks t
       JOIN categories c ON c.id = t.category_id
       JOIN time_entries e ON e.task_id = t.id
       WHERE EXISTS (
         SELECT 1 FROM completions co
         WHERE co.task_id = t.id AND co.completed_at >= ? AND co.completed_at < ?
       )
       GROUP BY t.id`,
    )
    .all(...range) as EstimationInputRow[];

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
