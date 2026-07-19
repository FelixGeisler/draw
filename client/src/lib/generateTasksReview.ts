import type { GeneratedTask } from "../hooks/useAi";

// Pure review-list model for the generate-tasks panel (#29). The flat
// SuggestionList was designed for 2-10 rows; a 40-exercise import needs
// grouped part rows, coupled checkboxes, and a summary the user can
// spot-check against the real material — all extracted here so the logic
// is unit-testable without rendering.

export interface ReviewPart {
  title: string;
  minutes: number;
  included: boolean;
}

export interface ReviewItem {
  label: string | null;
  title: string;
  points: number | null;
  /** Editable effort: starts from statedMinutes (verbatim) or the model estimate. */
  minutes: number;
  /** The material's own total, frozen at review start — provenance cites this, not the user's edit. */
  sourceMinutes: number;
  impact: 1 | 2 | 3 | 4 | 5;
  impactSource: "points" | "model";
  /**
   * True once the user edits the star rating at review (#161). The
   * impactSource "(model estimate)" annotation is shown only while this is
   * false — after a manual edit the value is the user's, not the model's.
   */
  impactTouched: boolean;
  rationale: string;
  included: boolean;
  /** Non-empty when the exercise commits as flat part-leaves instead of one leaf. */
  parts: ReviewPart[];
}

export function toReviewItems(tasks: GeneratedTask[]): ReviewItem[] {
  return tasks.map((t) => {
    const minutes = Math.max(1, Math.round(t.statedMinutes ?? t.estimatedMinutes));
    return {
      label: t.label,
      title: t.title,
      points: t.points,
      minutes,
      sourceMinutes: minutes,
      impact: t.impact,
      impactSource: t.impactSource,
      impactTouched: false,
      rationale: t.rationale,
      included: true,
      parts: t.parts.map((p) => ({ title: p.title, minutes: p.minutes, included: true })),
    };
  });
}

/**
 * Set an exercise's impact from the review StarPicker (#161) and mark it
 * touched, which drops the impactSource annotation — the rating is now the
 * user's, not the model's/point-derived one. A split exercise's parts inherit
 * this impact at commit (commitLeaves), so one picker per exercise is enough.
 */
export function setItemImpact(items: ReviewItem[], index: number, impact: number): ReviewItem[] {
  return items.map((item, i) =>
    i === index ? { ...item, impact: impact as ReviewItem["impact"], impactTouched: true } : item,
  );
}

/** Toggle an exercise; its parts always follow — a part cannot stay accepted under an excluded exercise. */
export function setItemIncluded(items: ReviewItem[], index: number, included: boolean): ReviewItem[] {
  return items.map((item, i) =>
    i === index
      ? { ...item, included, parts: item.parts.map((p) => ({ ...p, included })) }
      : item,
  );
}

/**
 * Toggle one part. The exercise checkbox reflects "any part included", so
 * excluding the last part excludes the exercise and re-including any part
 * re-includes it — the summary counts stay honest either way.
 */
export function setPartIncluded(
  items: ReviewItem[],
  index: number,
  partIndex: number,
  included: boolean,
): ReviewItem[] {
  return items.map((item, i) => {
    if (i !== index) return item;
    const parts = item.parts.map((p, j) => (j === partIndex ? { ...p, included } : p));
    return { ...item, included: parts.some((p) => p.included), parts };
  });
}

export function setAllIncluded(items: ReviewItem[], included: boolean): ReviewItem[] {
  return items.map((item) => ({
    ...item,
    included,
    parts: item.parts.map((p) => ({ ...p, included })),
  }));
}

export interface ReviewSummary {
  /** Included exercises — the number to spot-check against the material. */
  exerciseCount: number;
  /** Leaves that will be created (a split exercise counts per included part). */
  leafCount: number;
  /** Sum over included exercises that carry points; null when none do. */
  points: number | null;
  /** Sum over the leaves that will be created. */
  minutes: number;
  /** Included exercises committing as parts. */
  splitCount: number;
}

export function summarize(items: ReviewItem[]): ReviewSummary {
  let exerciseCount = 0;
  let leafCount = 0;
  let points: number | null = null;
  let minutes = 0;
  let splitCount = 0;
  for (const item of items) {
    if (!item.included) continue;
    exerciseCount += 1;
    if (item.points != null) points = (points ?? 0) + item.points;
    if (item.parts.length === 0) {
      leafCount += 1;
      minutes += item.minutes;
    } else {
      splitCount += 1;
      for (const p of item.parts) {
        if (!p.included) continue;
        leafCount += 1;
        minutes += p.minutes;
      }
    }
  }
  return { exerciseCount, leafCount, points, minutes, splitCount };
}

/** "12h 40m" / "2h" / "45m" — the summary header's duration format. */
export function formatDuration(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Provenance line stored as the leaf's description — the drawn card renders
 * it, so "Exercise 7 · 8 pts · ~45 min · exam.pdf" keeps the source auditable
 * long after the review panel is gone.
 */
export function provenance(item: ReviewItem, sourceName: string | null): string {
  return [
    item.label ? `Exercise ${item.label}` : null,
    item.points != null ? `${item.points} pts` : null,
    `~${item.sourceMinutes} min`,
    sourceName,
  ]
    .filter(Boolean)
    .join(" · ");
}

export interface CommitLeaf {
  title: string;
  description: string;
  effortMinutes: number;
  impact: number;
}

/**
 * The accepted leaves in review order: a partless exercise commits as one
 * leaf, a split exercise as its included parts (flat — the tree stays two
 * levels, umbrella parent + leaves). Edited titles/minutes land as typed,
 * except minutes round to integers and clamp to >= 1: the API wants positive
 * integer minutes (#84), the editable field can hold a decimal (the commit
 * button bypasses form `step` validation), and a cleared number field reads
 * as 0 and must not create a 0-minute drawable leaf. Blank titles are
 * dropped like the other panels do.
 */
export function commitLeaves(items: ReviewItem[], sourceName: string | null): CommitLeaf[] {
  const leaves: CommitLeaf[] = [];
  for (const item of items) {
    if (!item.included) continue;
    const description = provenance(item, sourceName);
    if (item.parts.length === 0) {
      if (!item.title.trim()) continue;
      leaves.push({
        title: item.title.trim(),
        description,
        effortMinutes: Math.max(1, Math.round(item.minutes)),
        impact: item.impact,
      });
    } else {
      for (const p of item.parts) {
        if (!p.included || !p.title.trim()) continue;
        leaves.push({
          title: p.title.trim(),
          description,
          effortMinutes: Math.max(1, Math.round(p.minutes)),
          impact: item.impact,
        });
      }
    }
  }
  return leaves;
}

/**
 * Default umbrella-parent title (#161): derived from the GOAL, not the source
 * file — a file-named parent read as a "weird parent task" appearing out of
 * nowhere. "Machine Learning — generated plan". Always user-editable before
 * commit. Falls back to a generic label for an (impossible in practice) empty
 * goal title.
 */
export function defaultParentTitle(goalTitle: string): string {
  const trimmed = goalTitle.trim();
  return trimmed ? `${trimmed} — generated plan` : "Generated tasks";
}

/**
 * The umbrella toggle's default state (#161): a container parent earns its
 * keep when a large import would otherwise flood the lists as roots (#28/#29),
 * but for a small hand-generated set it is bureaucracy. Pinned client-side:
 * >= 5 accepted leaves default the toggle ON, fewer OFF — always overridable
 * before accepting.
 */
export const UMBRELLA_DEFAULT_THRESHOLD = 5;

export function defaultUmbrella(leafCount: number): boolean {
  return leafCount >= UMBRELLA_DEFAULT_THRESHOLD;
}
