import { describe, expect, it } from "vitest";
import {
  ALREADY_ROOT_REASON,
  HAS_SUBTASKS_REASON,
  OWN_PARENT_REASON,
  RECURRING_SEQUENTIAL_REASON,
  TARGET_IS_SUBTASK_REASON,
  type ReparentSource,
  type ReparentTargetTask,
} from "./reparent";
import {
  classifyDrop,
  DRAG_THRESHOLD_PX,
  passesDragThreshold,
  REORDER_CROSS_PARENT_REASON,
  REORDER_DONE_REASON,
  type DropSpot,
} from "./taskDnd";

// Drop-target classification (#101): these tests pin the ROUTING — which
// spot gets which rule, and what stays inert. The rule matrix itself
// (moveUnderBlockReason / promoteBlockReason) is reparent.test.ts's job
// (#100) and is not re-tested here; the few reason assertions below exist to
// prove the drag surfaces the shared reasons, not copies of them.

function dragged(overrides: Partial<ReparentSource> = {}): ReparentSource {
  return { id: 1, parentId: null, recurEveryDays: null, hasOpenChildren: 0, ...overrides };
}

function rowSpot(overrides: Partial<ReparentTargetTask> = {}): DropSpot {
  return {
    type: "row",
    task: { id: 2, parentId: null, status: "open", subtaskOrderMode: "parallel", ...overrides },
  };
}

describe("classifyDrop", () => {
  it("nests a dragged childless root dropped on an open root", () => {
    expect(classifyDrop(dragged(), rowSpot())).toEqual({
      kind: "nest",
      targetId: 2,
      blockReason: null,
    });
  });

  it("surfaces the shared block reasons on row targets — never copies of them", () => {
    const block = (task: ReparentSource, spot: DropSpot) => {
      const v = classifyDrop(task, spot);
      return v.kind === "nest" ? v.blockReason : v;
    };
    expect(block(dragged({ id: 2 }), rowSpot({ id: 2 }))).toBe(OWN_PARENT_REASON);
    expect(block(dragged(), rowSpot({ parentId: 9 }))).toBe(TARGET_IS_SUBTASK_REASON);
    expect(block(dragged({ hasOpenChildren: 1 }), rowSpot())).toBe(HAS_SUBTASKS_REASON);
    expect(block(dragged({ recurEveryDays: 2 }), rowSpot({ subtaskOrderMode: "sequential" }))).toBe(
      RECURRING_SEQUENTIAL_REASON,
    );
  });

  it("treats done rows as inert — the menu never offers them either", () => {
    expect(classifyDrop(dragged(), rowSpot({ status: "done" }))).toEqual({ kind: "inert" });
  });

  it("gives a dragged subtask exactly one gesture: rows are inert, the zone promotes", () => {
    const subtask = dragged({ parentId: 7 });
    // Menu parity: subtask rows have no "Move under…", so DnD must not grow
    // a move-to-another-parent path — even over an otherwise valid root.
    expect(classifyDrop(subtask, rowSpot())).toEqual({ kind: "inert" });
    expect(classifyDrop(subtask, { type: "root-zone" })).toEqual({
      kind: "promote",
      blockReason: null,
    });
  });

  it("blocks the zone for a dragged root with the shared already-root reason", () => {
    expect(classifyDrop(dragged(), { type: "root-zone" })).toEqual({
      kind: "promote",
      blockReason: ALREADY_ROOT_REASON,
    });
  });

  it("is inert when the pointer is over nothing resolvable", () => {
    expect(classifyDrop(dragged(), null)).toEqual({ kind: "inert" });
  });
});

// Reorder verdicts (#157): the gap zones between sibling rows. The gaps only
// render while dragging a same-parent open subtask, so the block reasons are
// defensive backstops — but the routing (which gap yields which verdict) is
// pinned here the same way the nest/promote routing is above.
describe("classifyDrop — reorder gaps", () => {
  const sub = (overrides: Partial<ReparentSource> = {}): ReparentSource =>
    dragged({ id: 5, parentId: 7, status: "open", ...overrides });
  const gap = (parentId: number, beforeId: number | null): DropSpot => ({
    type: "gap",
    parentId,
    beforeId,
  });

  it("reorders a same-parent open subtask before a sibling", () => {
    expect(classifyDrop(sub(), gap(7, 9))).toEqual({
      kind: "reorder",
      beforeId: 9,
      blockReason: null,
    });
  });

  it("carries beforeId null (move to the end)", () => {
    expect(classifyDrop(sub(), gap(7, null))).toEqual({
      kind: "reorder",
      beforeId: null,
      blockReason: null,
    });
  });

  it("treats the gap directly before the dragged row as inert — dropping before yourself is a no-op", () => {
    expect(classifyDrop(sub(), gap(7, 5))).toEqual({ kind: "inert" });
  });

  it("blocks a gap in a different breakdown — cross-parent moves are a reparent", () => {
    const v = classifyDrop(sub(), gap(99, 9));
    expect(v).toEqual({ kind: "reorder", beforeId: 9, blockReason: REORDER_CROSS_PARENT_REASON });
  });

  it("blocks a dragged root over a gap (a root has no breakdown of its own)", () => {
    const v = classifyDrop(dragged({ id: 5, parentId: null }), gap(7, 9));
    expect(v).toEqual({ kind: "reorder", beforeId: 9, blockReason: REORDER_CROSS_PARENT_REASON });
  });

  it("blocks a done subtask — only open steps carry a position", () => {
    const v = classifyDrop(sub({ status: "done" }), gap(7, 9));
    expect(v).toEqual({ kind: "reorder", beforeId: 9, blockReason: REORDER_DONE_REASON });
  });
});

describe("passesDragThreshold", () => {
  it("keeps a shaky click below the threshold and a real pull above it", () => {
    expect(passesDragThreshold(10, 10, 12, 12)).toBe(false);
    expect(passesDragThreshold(10, 10, 10 + DRAG_THRESHOLD_PX, 10)).toBe(true);
    // Diagonal distance counts, not per-axis deltas.
    expect(passesDragThreshold(10, 10, 14, 14)).toBe(true);
  });
});
