import { describe, expect, it } from "vitest";
import {
  filterByTitle,
  isSearchable,
  LINK_SEARCH_THRESHOLD,
  linkableTasks,
  shownCandidates,
} from "./goalTasks";
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

// Pins the PR #89 review fix: the picker's query filters the list ONLY while
// the search box is rendered (> LINK_SEARCH_THRESHOLD candidates). Linking
// tasks out of a searched list can shrink the pool below the threshold, which
// unmounts the box while the query state survives — the stale, now-invisible
// query must stop filtering, or valid candidates silently disappear.
describe("shownCandidates", () => {
  const aboveThreshold = Array.from({ length: LINK_SEARCH_THRESHOLD + 1 }, (_, i) =>
    task({ id: i + 1, title: i === 0 ? "Do past exam 2019" : `Filler task ${i}` }),
  );

  it("applies the query while the search box is shown (above the threshold)", () => {
    expect(shownCandidates(aboveThreshold, "exam").map((t) => t.id)).toEqual([1]);
  });

  it("ignores a stale query once candidates drop to the threshold — the box is unmounted", () => {
    // The same query that just narrowed the longer list: after a link shrank
    // the pool to the threshold, the user can no longer see, edit, or clear it.
    const atThreshold = aboveThreshold.slice(0, LINK_SEARCH_THRESHOLD);
    expect(shownCandidates(atThreshold, "exam")).toEqual(atThreshold);
  });

  it("never yields 'no match' below the threshold, even for a query matching nothing", () => {
    const few = aboveThreshold.slice(0, 3);
    expect(shownCandidates(few, "quantum")).toEqual(few);
  });

  it("keeps the whole list for a blank query above the threshold", () => {
    expect(shownCandidates(aboveThreshold, "")).toEqual(aboveThreshold);
  });
});

describe("isSearchable", () => {
  it("is false at the threshold and true just above — the box and the filter flip together", () => {
    const tasks = Array.from({ length: LINK_SEARCH_THRESHOLD + 1 }, (_, i) =>
      task({ id: i + 1 }),
    );
    expect(isSearchable(tasks.slice(0, LINK_SEARCH_THRESHOLD))).toBe(false);
    expect(isSearchable(tasks)).toBe(true);
  });
});
