import { describe, expect, it } from "vitest";
import {
  applyPlanError,
  createChangeset,
  expandOversizedSubtasks,
  isDraftId,
  stageCreateSubtasks,
  stageCreateTask,
  type StagingContext,
} from "../../src/services/agentStaging.js";

// Pure staging-engine tests (#31, ADR-37): no DB, no SDK, no Express — the
// lookup context is injected. This is the acceptance criterion "tool
// handlers, changeset accumulator, and apply are pure functions unit-tested
// without the SDK".

function ctx(overrides: Partial<StagingContext> = {}): StagingContext {
  return {
    categoryExists: (id) => id === 1,
    goalExists: (id) => id === 7,
    taskInfo: (id) =>
      id === 10
        ? { isSubtask: false, archived: false }
        : id === 11
          ? { isSubtask: true, archived: false }
          : id === 12
            ? { isSubtask: false, archived: true }
            : null,
    maxDrawEffort: 30,
    ...overrides,
  };
}

describe("stageCreateTask", () => {
  it("stages a draft, returns a draft id, and never reports a write", () => {
    const cs = createChangeset();
    const outcome = stageCreateTask(cs, { title: "Open the syllabus", categoryId: 1 }, ctx());
    expect(outcome.isError).toBeUndefined();
    const parsed = JSON.parse(outcome.text);
    expect(parsed.staged).toBe(true);
    expect(isDraftId(parsed.draftId)).toBe(true);
    expect(parsed.note).toMatch(/nothing is saved/i);
    expect(cs.ops).toHaveLength(1);
    expect(cs.ops[0]).toMatchObject({ kind: "create_task", draftId: parsed.draftId });
  });

  it("mints sequential unique draft ids", () => {
    const cs = createChangeset();
    const a = JSON.parse(stageCreateTask(cs, { title: "a", categoryId: 1 }, ctx()).text);
    const b = JSON.parse(stageCreateTask(cs, { title: "b", categoryId: 1 }, ctx()).text);
    expect(a.draftId).toBe("draft-1");
    expect(b.draftId).toBe("draft-2");
  });

  it("rejects an unknown category with an actionable error and stages nothing", () => {
    const cs = createChangeset();
    const outcome = stageCreateTask(cs, { title: "t", categoryId: 99 }, ctx());
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/list_categories/);
    expect(cs.ops).toHaveLength(0);
  });

  it("rejects an unknown goal", () => {
    const cs = createChangeset();
    const outcome = stageCreateTask(cs, { title: "t", categoryId: 1, goalId: 99 }, ctx());
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/list_goals/);
  });

  it("pre-checks the ADR-4 impact gate for goal-less root drafts", () => {
    const cs = createChangeset();
    const outcome = stageCreateTask(cs, { title: "t", categoryId: 1, impact: 5 }, ctx());
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/ADR-4/);
    // The neutral 3 passes, like the route.
    expect(stageCreateTask(cs, { title: "t", categoryId: 1, impact: 3 }, ctx()).isError).toBeUndefined();
  });

  it("accepts a draft parent that is a staged root, rejects a staged subtask parent (ADR-16)", () => {
    const cs = createChangeset();
    stageCreateTask(cs, { title: "root", categoryId: 1 }, ctx()); // draft-1
    stageCreateTask(cs, { title: "leaf", categoryId: 1, parentId: "draft-1" }, ctx()); // draft-2
    const nested = stageCreateTask(cs, { title: "grand", categoryId: 1, parentId: "draft-2" }, ctx());
    expect(nested.isError).toBe(true);
    expect(nested.text).toMatch(/one level deep/);
  });

  it("rejects an unknown draft parent reference", () => {
    const cs = createChangeset();
    const outcome = stageCreateTask(cs, { title: "t", categoryId: 1, parentId: "draft-9" }, ctx());
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/draft-9/);
  });

  it("mirrors the route guards for real parent ids: missing, subtask, archived", () => {
    const cs = createChangeset();
    expect(stageCreateTask(cs, { title: "t", categoryId: 1, parentId: 99 }, ctx()).text).toMatch(
      /not found/,
    );
    expect(stageCreateTask(cs, { title: "t", categoryId: 1, parentId: 11 }, ctx()).text).toMatch(
      /one level deep/,
    );
    expect(stageCreateTask(cs, { title: "t", categoryId: 1, parentId: 12 }, ctx()).text).toMatch(
      /archived/,
    );
    expect(cs.ops).toHaveLength(0);
  });

  it("warns — but stages — an oversized root task, pointing at create_subtasks", () => {
    const cs = createChangeset();
    const outcome = stageCreateTask(cs, { title: "Big", categoryId: 1, effortMinutes: 120 }, ctx());
    expect(outcome.isError).toBeUndefined();
    const parsed = JSON.parse(outcome.text);
    expect(parsed.warnings?.[0]).toMatch(/split the work, never shrink/);
    // The estimate is staged VERBATIM — never clamped.
    expect(cs.ops[0]).toMatchObject({ task: { effortMinutes: 120 } });
  });

  it("splits an oversized PARENTED create into sibling parts — same policy as create_subtasks", () => {
    // A create_task with a parentId stages a LEAF: staged verbatim it would
    // be undrawable and unfixable (ADR-16 — a subtask draft takes no
    // breakdown), so it takes the create_subtasks split instead.
    const cs = createChangeset();
    const outcome = stageCreateTask(
      cs,
      { title: "Solve the sheet", categoryId: 1, parentId: 10, effortMinutes: 75 },
      ctx(),
    );
    expect(outcome.isError).toBeUndefined();
    const parsed = JSON.parse(outcome.text);
    expect(parsed.parts).toHaveLength(3); // ceil(75/30)
    expect(parsed.warnings?.[0]).toMatch(/split, never clamp/);
    // The old advice would be illegal here: a subtask draft takes no create_subtasks.
    expect(parsed.warnings?.[0]).not.toMatch(/create_subtasks under this draft/i);

    expect(cs.ops).toHaveLength(3);
    for (const op of cs.ops) {
      expect(op).toMatchObject({ kind: "create_task", task: { parentId: 10, categoryId: 1 } });
    }
    const minutes = cs.ops.map((op) => (op.kind === "create_task" ? op.task.effortMinutes! : 0));
    expect(minutes.reduce((a, b) => a + b, 0)).toBe(75); // total preserved
    expect(Math.max(...minutes)).toBeLessThanOrEqual(30); // every part drawable
    expect(cs.ops[0]).toMatchObject({ task: { title: "Solve the sheet (part 1/3)" } });
  });

  it("splits an oversized create under a DRAFT parent and the resulting plan applies cleanly", () => {
    const cs = createChangeset();
    stageCreateTask(cs, { title: "root", categoryId: 1 }, ctx()); // draft-1
    const outcome = stageCreateTask(
      cs,
      { title: "Long proof", categoryId: 1, parentId: "draft-1", effortMinutes: 61 },
      ctx(),
    );
    expect(outcome.isError).toBeUndefined();
    expect(cs.ops).toHaveLength(4); // root + ceil(61/30) parts
    for (const op of cs.ops.slice(1)) {
      expect(op).toMatchObject({ kind: "create_task", task: { parentId: "draft-1" } });
    }
    // The parts reference an earlier create_task op — apply's plan check passes.
    expect(applyPlanError(cs.ops)).toBeNull();
  });

  it("stages a parented create within the limit as one verbatim draft — no split", () => {
    const cs = createChangeset();
    const outcome = stageCreateTask(
      cs,
      { title: "Small step", categoryId: 1, parentId: 10, effortMinutes: 30 },
      ctx(),
    );
    const parsed = JSON.parse(outcome.text);
    expect(parsed.draftId).toBe("draft-1");
    expect(parsed.parts).toBeUndefined();
    expect(cs.ops).toHaveLength(1);
  });
});

describe("stageCreateSubtasks", () => {
  it("stages under a real root parent with per-subtask draft ids", () => {
    const cs = createChangeset();
    const outcome = stageCreateSubtasks(
      cs,
      { parentId: 10, subtasks: [{ title: "s1" }, { title: "s2", effortMinutes: 20 }] },
      ctx(),
    );
    expect(outcome.isError).toBeUndefined();
    const parsed = JSON.parse(outcome.text);
    expect(parsed.subtasks).toHaveLength(2);
    expect(parsed.subtasks.every((s: { draftId: string }) => isDraftId(s.draftId))).toBe(true);
  });

  it("stages under a draft parent", () => {
    const cs = createChangeset();
    stageCreateTask(cs, { title: "root", categoryId: 1 }, ctx()); // draft-1
    const outcome = stageCreateSubtasks(cs, { parentId: "draft-1", subtasks: [{ title: "s" }] }, ctx());
    expect(outcome.isError).toBeUndefined();
    expect(cs.ops[1]).toMatchObject({ kind: "create_subtasks", parentId: "draft-1" });
  });

  it("splits an oversized subtask into parts preserving the total — never clamps", () => {
    const cs = createChangeset();
    const outcome = stageCreateSubtasks(
      cs,
      { parentId: 10, subtasks: [{ title: "Solve exercise 2", effortMinutes: 75 }] },
      ctx(),
    );
    const parsed = JSON.parse(outcome.text);
    expect(parsed.warnings?.[0]).toMatch(/split, never clamp/);
    const op = cs.ops[0];
    if (op.kind !== "create_subtasks") throw new Error("expected create_subtasks");
    expect(op.subtasks).toHaveLength(3); // ceil(75/30)
    expect(op.subtasks.map((s) => s.effortMinutes!).reduce((a, b) => a + b, 0)).toBe(75);
    expect(op.subtasks[0].title).toBe("Solve exercise 2 (part 1/3)");
  });

  it("rejects a subtask parent (ADR-16) and an archived parent", () => {
    const cs = createChangeset();
    expect(stageCreateSubtasks(cs, { parentId: 11, subtasks: [{ title: "s" }] }, ctx()).isError).toBe(
      true,
    );
    expect(stageCreateSubtasks(cs, { parentId: 12, subtasks: [{ title: "s" }] }, ctx()).isError).toBe(
      true,
    );
    expect(cs.ops).toHaveLength(0);
  });
});

describe("expandOversizedSubtasks", () => {
  it("passes small and unestimated rows through untouched", () => {
    const { rows, splitCount } = expandOversizedSubtasks(
      [{ title: "a", effortMinutes: 30 }, { title: "b" }],
      30,
    );
    expect(rows).toEqual([{ title: "a", effortMinutes: 30 }, { title: "b" }]);
    expect(splitCount).toBe(0);
  });

  it("splits into near-equal whole-minute parts summing to the original", () => {
    const { rows, splitCount } = expandOversizedSubtasks([{ title: "big", effortMinutes: 100 }], 30);
    expect(splitCount).toBe(1);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.effortMinutes!).reduce((a, b) => a + b, 0)).toBe(100);
    expect(Math.max(...rows.map((r) => r.effortMinutes!))).toBeLessThanOrEqual(30);
  });

  it("caps the part count and keeps the total even in pathological cases", () => {
    const { rows } = expandOversizedSubtasks([{ title: "huge", effortMinutes: 1000 }], 30);
    expect(rows).toHaveLength(10); // MAX_PARTS_PER_ITEM wins
    expect(rows.map((r) => r.effortMinutes!).reduce((a, b) => a + b, 0)).toBe(1000);
  });
});

describe("applyPlanError", () => {
  const task = (draftId: string, parentId?: number | string) => ({
    kind: "create_task" as const,
    draftId,
    task: { title: "t", categoryId: 1, ...(parentId != null ? { parentId } : {}) },
  });

  it("accepts drafts referencing earlier create_task ops", () => {
    expect(
      applyPlanError([
        task("draft-1"),
        task("draft-2", "draft-1"),
        {
          kind: "create_subtasks",
          draftId: "draft-3",
          parentId: "draft-1",
          subtasks: [{ draftId: "draft-4", title: "s" }],
        },
      ]),
    ).toBeNull();
  });

  it("rejects a forward or missing draft reference — a deselected parent deselects its children", () => {
    expect(applyPlanError([task("draft-2", "draft-1"), task("draft-1")])).toMatch(/draft-1/);
    expect(applyPlanError([task("draft-2", "draft-9")])).toMatch(/draft-9/);
  });

  it("rejects duplicate draft ids, including subtask-level ones", () => {
    expect(applyPlanError([task("draft-1"), task("draft-1")])).toMatch(/duplicate/);
    expect(
      applyPlanError([
        task("draft-1"),
        {
          kind: "create_subtasks",
          draftId: "draft-2",
          parentId: "draft-1",
          subtasks: [
            { draftId: "draft-3", title: "a" },
            { draftId: "draft-3", title: "b" },
          ],
        },
      ]),
    ).toMatch(/duplicate/);
  });

  it("rejects a subtasks op used as a parent reference", () => {
    expect(
      applyPlanError([
        task("draft-1"),
        {
          kind: "create_subtasks",
          draftId: "draft-2",
          parentId: "draft-1",
          subtasks: [{ draftId: "draft-3", title: "s" }],
        },
        task("draft-4", "draft-2"),
      ]),
    ).toMatch(/draft-2/);
  });
});
