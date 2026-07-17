import { describe, expect, it } from "vitest";
import {
  buildOperations,
  cascadeExclusions,
  countChanges,
  seedEdits,
  type RowEdit,
} from "./assistantReview";
import type { StagedOp } from "../hooks/useAssistant";

// The staged-changes review model (#31, ADR-37): whatever buildOperations
// emits must pass the server's applyPlanError — in particular, no op may
// reference a draft parent that dropped out of the plan, whether the parent
// was UNCHECKED or its TITLE CLEARED (both are "skip this op" semantics).

const OPS: StagedOp[] = [
  { kind: "create_task", draftId: "draft-1", task: { title: "Umbrella", categoryId: 1 } },
  {
    kind: "create_task",
    draftId: "draft-2",
    task: { title: "Child task", categoryId: 1, parentId: "draft-1" },
  },
  {
    kind: "create_subtasks",
    draftId: "draft-3",
    parentId: "draft-1",
    subtasks: [
      { draftId: "draft-4", title: "Step one", effortMinutes: 20 },
      { draftId: "draft-5", title: "Step two", effortMinutes: 25 },
    ],
  },
];

function freshEdits(): Record<string, RowEdit> {
  return seedEdits(OPS, {});
}

describe("seedEdits", () => {
  it("seeds every draft row included, preserving rows already edited", () => {
    const prev: Record<string, RowEdit> = {
      "draft-4": { included: false, title: "Edited step", effortMinutes: 5 },
    };
    const edits = seedEdits(OPS, prev);
    expect(Object.keys(edits).sort()).toEqual(["draft-1", "draft-2", "draft-4", "draft-5"]);
    expect(edits["draft-1"]).toEqual({ included: true, title: "Umbrella", effortMinutes: null });
    expect(edits["draft-4"]).toEqual(prev["draft-4"]); // user edits survive re-seeding
  });
});

describe("cascadeExclusions", () => {
  it("deselecting a draft parent deselects its child drafts and subtasks", () => {
    const edits = freshEdits();
    edits["draft-1"] = { ...edits["draft-1"], included: false };
    const next = cascadeExclusions(OPS, edits);
    expect(next["draft-2"].included).toBe(false);
    expect(next["draft-4"].included).toBe(false);
    expect(next["draft-5"].included).toBe(false);
  });
});

describe("buildOperations", () => {
  it("commits everything when all rows are included and titled", () => {
    const operations = buildOperations(OPS, freshEdits());
    expect(operations).toHaveLength(3);
    expect(countChanges(operations)).toBe(4);
  });

  it("drops the children of an UNCHECKED parent even when their edits still say included", () => {
    // Structural safety net: even if the visual cascade were bypassed, the
    // emitted plan must not reference a dropped parent (server 400).
    const edits = freshEdits();
    edits["draft-1"] = { ...edits["draft-1"], included: false };
    const operations = buildOperations(OPS, edits);
    expect(operations).toHaveLength(0);
  });

  it("drops the children of a parent whose TITLE was cleared — no unreferenced draft parent survives", () => {
    const edits = freshEdits();
    edits["draft-1"] = { ...edits["draft-1"], title: "   " };
    const operations = buildOperations(OPS, edits);
    expect(operations).toHaveLength(0);
    expect(countChanges(operations)).toBe(0); // Apply disables on 0 changes
  });

  it("keeps subtasks under a REAL parent id when a sibling draft parent drops", () => {
    const ops: StagedOp[] = [
      ...OPS,
      {
        kind: "create_subtasks",
        draftId: "draft-6",
        parentId: 42, // real task — unaffected by draft-1 dropping
        subtasks: [{ draftId: "draft-7", title: "Real-parent step" }],
      },
    ];
    const edits = seedEdits(ops, {});
    edits["draft-1"] = { ...edits["draft-1"], title: "" };
    const operations = buildOperations(ops, edits);
    expect(operations).toEqual([
      expect.objectContaining({ draftId: "draft-6", parentId: 42 }),
    ]);
  });

  it("skips title-less subtask rows without dropping their siblings", () => {
    const edits = freshEdits();
    edits["draft-4"] = { ...edits["draft-4"], title: "" };
    const operations = buildOperations(OPS, edits);
    const subtasksOp = operations.find((op) => op.kind === "create_subtasks");
    expect(subtasksOp?.kind === "create_subtasks" && subtasksOp.subtasks.map((s) => s.draftId)).toEqual([
      "draft-5",
    ]);
  });

  it("applies title edits trimmed and omits cleared minutes instead of sending 0 (#84)", () => {
    const edits = freshEdits();
    edits["draft-1"] = { ...edits["draft-1"], title: "  Renamed umbrella  " };
    edits["draft-4"] = { ...edits["draft-4"], effortMinutes: null };
    const operations = buildOperations(OPS, edits);
    const root = operations.find((op) => op.draftId === "draft-1");
    expect(root?.kind === "create_task" && root.task.title).toBe("Renamed umbrella");
    const subtasksOp = operations.find((op) => op.kind === "create_subtasks");
    const stepOne = subtasksOp?.kind === "create_subtasks" ? subtasksOp.subtasks[0] : undefined;
    expect(stepOne?.effortMinutes).toBeUndefined();
  });
});
