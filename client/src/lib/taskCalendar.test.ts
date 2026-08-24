import { describe, expect, it } from "vitest";
import type { Task } from "../api/types";
import { localDay } from "./localDay";
import {
  deriveTaskCalendar,
  isDayInMonth,
  monthForDay,
  monthGridDays,
  scheduledTasks,
  shiftMonth,
} from "./taskCalendar";

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "Task",
    description: null,
    categoryId: 1,
    goalId: null,
    parentId: null,
    impact: 3,
    effortMinutes: null,
    dueDate: "2026-07-15",
    recurEveryDays: null,
    status: "open",
    createdAt: "2026-07-01T00:00:00.000Z",
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
    ...over,
  };
}

describe("task calendar local months", () => {
  it("uses local calendar days and exact YYYY-MM membership", () => {
    expect(localDay(new Date(2026, 6, 1, 0, 30))).toBe("2026-07-01");
    expect(monthForDay("2026-07-31")).toBe("2026-07");
    expect(isDayInMonth("2026-07-31", "2026-07")).toBe(true);
    expect(isDayInMonth("2026-08-01", "2026-07")).toBe(false);
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("builds a Monday-first month without DST-sensitive arithmetic", () => {
    const cells = monthGridDays("2026-07");
    expect(cells.slice(0, 3)).toEqual([null, null, "2026-07-01"]); // Wednesday
    expect(cells.at(-1)).toBe(null);
    expect(cells.filter(Boolean)).toHaveLength(31);
  });
});

describe("scheduledTasks", () => {
  it("flattens roots and subtasks while filtering only status and due date", () => {
    const step = task({ id: 2, title: "Step", parentId: 1, blocked: true });
    const root = task({ id: 1, title: "Root", subtasks: [step] });
    const done = task({ id: 3, status: "done" });
    const archived = task({ id: 4, status: "archived" });
    const undated = task({ id: 5, dueDate: null });

    expect(scheduledTasks([root, done, archived, undated])).toEqual([
      root,
      step,
    ]);
  });

  it("does not expand recurring tasks beyond the payload's current due date", () => {
    const recurring = task({ id: 8, dueDate: "2026-07-20", recurEveryDays: 7 });
    const data = deriveTaskCalendar([recurring], "2026-07", "2026-07-10");
    expect(data.scheduled).toEqual([recurring]);
    expect(data.monthDays).toEqual([
      { date: "2026-07-20", tasks: [recurring] },
    ]);
  });
});

describe("deriveTaskCalendar", () => {
  it("orders overdue by oldest day then title and each day by title", () => {
    const beta = task({ id: 2, title: "Beta", dueDate: "2026-07-08" });
    const alpha = task({ id: 1, title: "Alpha", dueDate: "2026-07-08" });
    const oldest = task({ id: 3, title: "Oldest", dueDate: "2026-07-01" });
    const today = task({ id: 4, title: "Today", dueDate: "2026-07-10" });
    const data = deriveTaskCalendar(
      [beta, alpha, oldest, today],
      "2026-07",
      "2026-07-10",
    );

    expect(data.overdue.map((item) => item.title)).toEqual([
      "Oldest",
      "Alpha",
      "Beta",
    ]);
    expect(
      data.monthDays.find((day) => day.date === "2026-07-08")?.tasks,
    ).toEqual([alpha, beta]);
    expect(data.overdue).not.toContain(today);
  });

  it("returns empty results for no scheduled work and for an empty selected month", () => {
    expect(deriveTaskCalendar([], "2026-07", "2026-07-10")).toEqual({
      scheduled: [],
      overdue: [],
      monthDays: [],
    });
    const august = task({ dueDate: "2026-08-02" });
    expect(
      deriveTaskCalendar([august], "2026-07", "2026-07-10").monthDays,
    ).toEqual([]);
  });
});
