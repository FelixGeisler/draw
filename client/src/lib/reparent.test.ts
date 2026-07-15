import { describe, expect, it } from "vitest";
import {
  ALREADY_ROOT_REASON,
  ALREADY_UNDER_TARGET_REASON,
  HAS_SUBTASKS_REASON,
  OWN_PARENT_REASON,
  RECURRING_SEQUENTIAL_REASON,
  TARGET_IS_SUBTASK_REASON,
  moveUnderBlockReason,
  promoteBlockReason,
  reparentTargets,
  type ReparentSource,
  type ReparentTargetTask,
} from "./reparent";
import type { Task } from "../api/types";

// Reparent eligibility (#100): the client mirror of the server's PATCH
// parentId validation matrix, and the single rule source the drag-and-drop
// follow-up (#101) reuses. Every rule carries its reason — the picker shows
// blocked targets disabled WITH the rule instead of silently omitting them.

function source(overrides: Partial<ReparentSource> = {}): ReparentSource {
  return { id: 1, parentId: null, recurEveryDays: null, hasOpenChildren: 0, ...overrides };
}

function target(overrides: Partial<ReparentTargetTask> = {}): ReparentTargetTask {
  return { id: 2, parentId: null, status: "open", subtaskOrderMode: "parallel", ...overrides };
}

describe("moveUnderBlockReason", () => {
  it("allows a childless root under an open parallel root", () => {
    expect(moveUnderBlockReason(source(), target())).toBeNull();
  });

  it("rejects the task itself as its own parent", () => {
    expect(moveUnderBlockReason(source({ id: 7 }), target({ id: 7 }))).toBe(OWN_PARENT_REASON);
  });

  it("rejects a target that is itself a subtask (one level deep, ADR-16)", () => {
    expect(moveUnderBlockReason(source(), target({ parentId: 9 }))).toBe(
      TARGET_IS_SUBTASK_REASON,
    );
  });

  it("rejects a task that has subtasks — listed or open (ADR-16)", () => {
    expect(moveUnderBlockReason(source({ subtasks: [{ id: 5 }] }), target())).toBe(
      HAS_SUBTASKS_REASON,
    );
    // A draw/timer payload shape without a subtasks array still knows.
    expect(moveUnderBlockReason(source({ hasOpenChildren: 1 }), target())).toBe(
      HAS_SUBTASKS_REASON,
    );
  });

  it("calls a move to the current parent out as already-there", () => {
    expect(moveUnderBlockReason(source({ parentId: 2 }), target({ id: 2 }))).toBe(
      ALREADY_UNDER_TARGET_REASON,
    );
  });

  it("rejects a recurring task under a sequential target with the ADR-23 reason", () => {
    expect(
      moveUnderBlockReason(
        source({ recurEveryDays: 3 }),
        target({ subtaskOrderMode: "sequential" }),
      ),
    ).toBe(RECURRING_SEQUENTIAL_REASON);
    // The same recurring task fits a parallel breakdown…
    expect(moveUnderBlockReason(source({ recurEveryDays: 3 }), target())).toBeNull();
    // …and a non-recurring task fits a sequential one.
    expect(
      moveUnderBlockReason(source(), target({ subtaskOrderMode: "sequential" })),
    ).toBeNull();
  });
});

describe("promoteBlockReason", () => {
  it("lets any subtask promote and names why a root cannot", () => {
    expect(promoteBlockReason({ parentId: 4 })).toBeNull();
    expect(promoteBlockReason({ parentId: null })).toBe(ALREADY_ROOT_REASON);
  });
});

describe("reparentTargets", () => {
  const rootTask = (overrides: Partial<Task>): Task =>
    ({
      id: 0,
      title: "t",
      parentId: null,
      status: "open",
      subtaskOrderMode: "parallel",
      recurEveryDays: null,
      hasOpenChildren: 0,
      ...overrides,
    }) as Task;

  it("offers every open root except the task itself, with per-target reasons", () => {
    const roots = [
      rootTask({ id: 1, title: "the mover" }),
      rootTask({ id: 2, title: "plain target" }),
      rootTask({ id: 3, title: "sequential target", subtaskOrderMode: "sequential" }),
      rootTask({ id: 4, title: "done root", status: "done" }),
    ];
    const targets = reparentTargets(source({ id: 1, recurEveryDays: 5 }), roots);
    // Self and the done root are excluded outright…
    expect(targets.map((t) => t.target.id)).toEqual([2, 3]);
    // …while the ADR-23 conflict stays listed, disabled with its reason.
    expect(targets[0].blockReason).toBeNull();
    expect(targets[1].blockReason).toBe(RECURRING_SEQUENTIAL_REASON);
  });
});
