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
  | { type: "root-zone" };

export type DropVerdict =
  /** Dropping nests the dragged task under targetId (menu: "Move under…"). */
  | { kind: "nest"; targetId: number; blockReason: string | null }
  /** Dropping promotes the dragged task to top level (menu: "⤴"). */
  | { kind: "promote"; blockReason: string | null }
  /** Not a target for this drag — no highlight, no feedback. */
  | { kind: "inert" };

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
  // Done/archived rows are never offered by the menu — inert here too, not
  // "blocked with a reason". The predicate is reparentTargets' own filter,
  // so the two inputs cannot diverge on what is offered.
  if (!isOfferableTarget(spot.task)) return { kind: "inert" };
  // A dragged subtask has exactly one gesture: promote via the root zone.
  // Same predicate as TaskRow's "Move under…" button gate — rows stay inert
  // rather than DnD growing a move-to-another-parent path the menu lacks.
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
