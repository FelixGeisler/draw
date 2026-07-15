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
import { classifyDrop, DRAG_THRESHOLD_PX, passesDragThreshold, type DropSpot } from "./taskDnd";

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

describe("passesDragThreshold", () => {
  it("keeps a shaky click below the threshold and a real pull above it", () => {
    expect(passesDragThreshold(10, 10, 12, 12)).toBe(false);
    expect(passesDragThreshold(10, 10, 10 + DRAG_THRESHOLD_PX, 10)).toBe(true);
    // Diagonal distance counts, not per-axis deltas.
    expect(passesDragThreshold(10, 10, 14, 14)).toBe(true);
  });
});
