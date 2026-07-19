import { db } from "../db.js";

/**
 * Stored sibling ordering (#157, ADR-43) — the pure position math behind the
 * reorder endpoint and split-in-place placement. `sort_order` is a REAL
 * fractional key: a reorder drops a task at the MIDPOINT of its two new
 * neighbors and touches nothing else, so an everyday move is a single-row
 * write. Only when REAL precision leaves no representable value strictly
 * between the neighbors (repeated bisection of the same gap) do we renormalize
 * the whole breakdown to integer gaps — rare, single-user, one write per
 * sibling. Roots are excluded: they are not reorderable (ADR-43), so nothing
 * here ever runs on a parentId of null.
 */

export interface OrderedSibling {
  id: number;
  sortOrder: number;
}

/**
 * The sort_order for a task inserted immediately after `before` and
 * immediately before `after` (both are neighbor sort_order values; null =
 * that open end of the list). Returns null when no REAL value fits strictly
 * between the neighbors — the caller renormalizes and retries by direct
 * assignment.
 *
 * `before == null` (moving to the front) bisects toward the 0 sentinel: the
 * result stays > 0, so it never collides with the trigger's "unstamped"
 * marker. `after == null` (moving to the end) is a plain +1 past the last
 * sibling — an append can never underflow.
 */
export function midpointOrder(before: number | null, after: number | null): number | null {
  if (before == null && after == null) return 1; // empty breakdown — first position
  if (before == null) {
    const mid = after! / 2;
    return mid > 0 && mid < after! ? mid : null;
  }
  if (after == null) return before + 1;
  const mid = (before + after) / 2;
  return mid > before && mid < after ? mid : null;
}

/**
 * `n` strictly-increasing sort_order values inside `(before, after)` — the
 * split-in-place placement (#108 amended by #157): the parts occupy the
 * archived original's slot, ahead of every later sibling and in array order
 * among themselves. `after == null` = open end (unit gaps past `before`).
 */
export function spreadBetween(before: number, after: number | null, n: number): number[] {
  if (after == null) {
    return Array.from({ length: n }, (_, i) => before + i + 1);
  }
  const step = (after - before) / (n + 1);
  return Array.from({ length: n }, (_, i) => before + step * (i + 1));
}

/**
 * Move `taskId` so it sits immediately before `beforeId` among its siblings
 * (or last when `beforeId` is null). The caller has already checked that
 * `taskId` is a subtask (its parent is `parentId`) and that `beforeId`, when
 * non-null, is a sibling — the pure guards live in the route. Runs inside the
 * caller's transaction. Midpoint first; renormalize-then-place on underflow.
 */
export function reorderSibling(parentId: number, taskId: number, beforeId: number | null): void {
  // Every sibling EXCEPT the one being moved, in canonical (sort_order, id)
  // order — the moved task's current slot is irrelevant to where it lands.
  const siblings = db
    .prepare(
      "SELECT id, sort_order AS sortOrder FROM tasks WHERE parent_id = ? AND id != ? ORDER BY sort_order ASC, id ASC",
    )
    .all(parentId, taskId) as OrderedSibling[];

  let beforeOrder: number | null;
  let afterOrder: number | null;
  if (beforeId == null) {
    beforeOrder = siblings.length ? siblings[siblings.length - 1].sortOrder : null;
    afterOrder = null;
  } else {
    const idx = siblings.findIndex((s) => s.id === beforeId);
    // idx >= 0: the route guarantees beforeId is a sibling and beforeId != taskId.
    afterOrder = siblings[idx].sortOrder;
    beforeOrder = idx > 0 ? siblings[idx - 1].sortOrder : null;
  }

  const mid = midpointOrder(beforeOrder, afterOrder);
  if (mid != null) {
    db.prepare("UPDATE tasks SET sort_order = ? WHERE id = ?").run(mid, taskId);
    return;
  }

  // Underflow: rewrite the whole breakdown to integer gaps with the moved task
  // spliced into its target slot, so the next midpoint has room again.
  const finalOrder: number[] = [];
  if (beforeId == null) {
    for (const s of siblings) finalOrder.push(s.id);
    finalOrder.push(taskId);
  } else {
    for (const s of siblings) {
      if (s.id === beforeId) finalOrder.push(taskId);
      finalOrder.push(s.id);
    }
  }
  const update = db.prepare("UPDATE tasks SET sort_order = ? WHERE id = ?");
  finalOrder.forEach((id, i) => update.run(i + 1, id));
}
