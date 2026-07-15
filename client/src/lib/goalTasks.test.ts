import { describe, expect, it } from "vitest";
import { filterByTitle, linkableTasks } from "./goalTasks";
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
    deferredUntil: null,
    blocked: false,
    subtaskOrderMode: "parallel",
    windowDays: null,
    windowStart: null,
    windowEnd: null,
    hasOpenChildren: 0,
    heldBack: 0,
    ...overrides,
  };
}

// Pins the GoalCard link-existing picker's candidate set (#87): open,
// goal-less ROOT tasks only. The API list is pre-filtered to open roots, but
// the picker must stay honest even if its source changes.
describe("linkableTasks", () => {
  it("keeps open goal-less root tasks", () => {
    const t = task({ id: 7 });
    expect(linkableTasks([t])).toEqual([t]);
  });

  it("excludes goal-linked tasks — the picker never MOVES a task between goals", () => {
    expect(linkableTasks([task({ goalId: 3 })])).toEqual([]);
  });

  it("excludes subtasks — they follow their parent's goal (cascade #76)", () => {
    expect(linkableTasks([task({ parentId: 12 })])).toEqual([]);
  });

  it("excludes done and archived tasks", () => {
    expect(linkableTasks([task({ status: "done" }), task({ status: "archived" })])).toEqual([]);
  });

  it("keeps snoozed and blocked tasks — out of the deck is not out of the goal", () => {
    const snoozed = task({ id: 1, deferredUntil: "2099-01-01T00:00:00Z" });
    const blocked = task({ id: 2, blocked: true });
    expect(linkableTasks([snoozed, blocked])).toEqual([snoozed, blocked]);
  });
});

describe("filterByTitle", () => {
  const tasks = [
    task({ id: 1, title: "Skim lecture notes" }),
    task({ id: 2, title: "Do past exam 2019" }),
    task({ id: 3, title: "Rewrite NOTES summary" }),
  ];

  it("matches case-insensitively on a substring", () => {
    expect(filterByTitle(tasks, "notes").map((t) => t.id)).toEqual([1, 3]);
  });

  it("keeps everything for a blank or whitespace-only query", () => {
    expect(filterByTitle(tasks, "")).toEqual(tasks);
    expect(filterByTitle(tasks, "   ")).toEqual(tasks);
  });

  it("trims the query before matching", () => {
    expect(filterByTitle(tasks, "  exam ").map((t) => t.id)).toEqual([2]);
  });

  it("returns nothing when no title matches", () => {
    expect(filterByTitle(tasks, "quantum")).toEqual([]);
  });
});
