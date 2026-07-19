import {
  isOfferableTarget,
  moveUnderBlockReason,
  offersMoveUnder,
  promoteBlockReason,
  type ReparentSource,
  type ReparentTargetTask,
} from "./reparent";

/**
 * Drop-target classification for the Tasks page drag-and-drop (#101). DnD is
 * an alternative input for the #100 reparent controls — every verdict
 * delegates to lib/reparent.ts, this module only decides WHICH rule applies
 * to whatever the pointer is over. Pure: no DOM, no React.
 */

/** What the pointer is currently over. */
export type DropSpot =
  /** A task row — root or subtask, any status; the verdict sorts them out. */
  | { type: "row"; task: ReparentTargetTask }
  /** The fixed "promote to top level" zone shown while a drag is live. */
  | { type: "root-zone" }
  /**
   * A gap between two sibling rows inside an expanded breakdown (#157) —
   * `beforeId` is the sibling the dragged task would land in front of, null =
   * the end. Only rendered while dragging a subtask of `parentId`.
   */
  | { type: "gap"; parentId: number; beforeId: number | null };

export type DropVerdict =
  /** Dropping nests the dragged task under targetId (menu: "Move under…"). */
  | { kind: "nest"; targetId: number; blockReason: string | null }
  /** Dropping promotes the dragged task to top level (menu: "⤴"). */
  | { kind: "promote"; blockReason: string | null }
  /** Dropping reorders the dragged subtask before `beforeId` (#157). */
  | { kind: "reorder"; beforeId: number | null; blockReason: string | null }
  /** Not a target for this drag — no highlight, no feedback. */
  | { kind: "inert" };

// Reorder is WITHIN one breakdown (#157, ADR-43): a move to a different parent
// is a reparent, which the row-nest path already covers. A done/archived
// subtask has no position to arrange — but the drag handle only exists on open
// rows, so this reason is a defensive backstop, never surfaced in practice.
export const REORDER_CROSS_PARENT_REASON =
  "reorder stays within one breakdown (ADR-43): drop onto a task to move it under a different parent";
export const REORDER_DONE_REASON = "only open subtasks can be reordered";

/** Why the dragged task cannot land in `gapParentId`'s breakdown — null when
 *  the reorder is eligible. `beforeId === dragged.id` is the no-op gap right
 *  before the dragged row itself, treated as inert by the caller. */
function reorderBlockReason(dragged: ReparentSource, gapParentId: number): string | null {
  if (dragged.parentId == null || dragged.parentId !== gapParentId) {
    return REORDER_CROSS_PARENT_REASON;
  }
  if (dragged.status != null && dragged.status !== "open") return REORDER_DONE_REASON;
  return null;
}

/**
 * The verdict for releasing `dragged` over `spot`. Mirrors the #100 menu
 * exactly: what the menu offers is eligible, what it offers disabled is
 * blocked WITH the same reason, and what it never renders is inert.
 */
export function classifyDrop(dragged: ReparentSource, spot: DropSpot | null): DropVerdict {
  if (!spot) return { kind: "inert" };
  if (spot.type === "root-zone") {
    // The zone mirrors the ⤴ button. For a root task that control does not
    // exist — the zone stays visible but blocked with the reason, the same
    // philosophy as the picker's disabled options.
    return { kind: "promote", blockReason: promoteBlockReason(dragged) };
  }
  if (spot.type === "gap") {
    // The gap directly before the dragged row is a no-op — dropping a task
    // before itself is not a move, so it stays inert (no highlight, and the
    // endpoint's own beforeId === id guard never fires).
    if (spot.beforeId === dragged.id) return { kind: "inert" };
    return {
      kind: "reorder",
      beforeId: spot.beforeId,
      blockReason: reorderBlockReason(dragged, spot.parentId),
    };
  }
  // Done/archived rows are never offered by the menu — inert here too, not
  // "blocked with a reason". The predicate is reparentTargets' own filter,
  // so the two inputs cannot diverge on what is offered.
  if (!isOfferableTarget(spot.task)) return { kind: "inert" };
  // A dragged CHILDLESS task — root OR subtask (#167) — can nest under an open
  // root: moveUnderBlockReason below sorts a different root (eligible) from its
  // own parent (ALREADY_UNDER_TARGET_REASON) and a subtask target
  // (TARGET_IS_SUBTASK_REASON, one level deep). A task WITH subtasks is a
  // container that cannot itself become a subtask, so its rows stay inert.
  // Same predicate as TaskRow's "Move under…" button gate — the menu and the
  // drag offer exactly the same set.
  if (!offersMoveUnder(dragged)) return { kind: "inert" };
  return {
    kind: "nest",
    targetId: spot.task.id,
    blockReason: moveUnderBlockReason(dragged, spot.task),
  };
}

/**
 * Pointer travel before a press on the handle becomes a drag — below this a
 * press-and-release is just a click and must not start a drag, so the handle
 * never fights the row's buttons over a slightly shaky click.
 */
export const DRAG_THRESHOLD_PX = 5;

export function passesDragThreshold(x0: number, y0: number, x: number, y: number): boolean {
  return Math.hypot(x - x0, y - y0) >= DRAG_THRESHOLD_PX;
}
