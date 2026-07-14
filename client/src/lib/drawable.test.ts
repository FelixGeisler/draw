import { describe, expect, it } from "vitest";
import { classifyTask, flattenOpen } from "./drawable";
import type { Task } from "../api/types";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "t",
    description: null,
    categoryId: 1,
    goalId: null,
    parentId: null,
    impact: 3,
    effortMinutes: 20,
    dueDate: null,
    recurEveryDays: null,
    status: "open",
    createdAt: "2026-07-14T00:00:00Z",
    completedAt: null,
    lastDrawnAt: null,
    hasOpenChildren: 0,
    ...overrides,
  };
}

describe("classifyTask", () => {
  it("classifies by effort against the limit", () => {
    expect(classifyTask(task({ effortMinutes: 30 }), 30)).toBe("ready");
    expect(classifyTask(task({ effortMinutes: 31 }), 30)).toBe("too-big");
    expect(classifyTask(task({ effortMinutes: null }), 30)).toBe("needs-estimate");
  });

  it("treats parents with open children as containers regardless of effort", () => {
    expect(classifyTask(task({ hasOpenChildren: 1, effortMinutes: 10 }), 30)).toBe("container");
  });

  it("respects a custom effort limit", () => {
    expect(classifyTask(task({ effortMinutes: 45 }), 60)).toBe("ready");
  });
});

describe("flattenOpen", () => {
  it("flattens roots and subtasks, skipping non-open ones", () => {
    const tree = [
      task({ id: 1, subtasks: [task({ id: 2 }), task({ id: 3, status: "done" })] }),
      task({ id: 4, status: "done", subtasks: [task({ id: 5 })] }),
    ];
    expect(flattenOpen(tree).map((t) => t.id)).toEqual([1, 2, 5]);
  });
});
