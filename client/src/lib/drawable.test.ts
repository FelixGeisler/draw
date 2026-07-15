import { describe, expect, it } from "vitest";
import { classifyTask, flattenOpen, formatWindow, isSnoozed, isWithinWindow } from "./drawable";
import {
  DRAWABLE_VECTORS,
  VECTOR_NOW,
  WINDOW_VECTORS,
  materializeWindow,
} from "../../../shared/drawableVectors";
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

  // The same vectors pin the server's pool predicate — see
  // shared/drawableVectors.ts and server/test/unit/drawable-vectors.test.ts.
  describe("shared eligibility vectors (parity with drawService)", () => {
    const now = new Date(VECTOR_NOW);
    for (const v of DRAWABLE_VECTORS) {
      it(v.name, () => {
        const t = task({
          hasOpenChildren: v.hasOpenChildren,
          blocked: v.blocked,
          deferredUntil: v.deferredUntil,
          heldBack: v.heldBack,
          effortMinutes: v.effortMinutes,
          // Windows are local wall-clock (#33): materialized from offsets
          // relative to `now`, deterministic in every timezone.
          ...(v.window ? materializeWindow(v.window, now) : {}),
        });
        expect(classifyTask(t, v.maxEffort, now)).toBe(v.expected);
      });
    }
  });
});

// The same vectors pin the server's isWithinWindow — see
// shared/drawableVectors.ts and server/test/unit/window-predicate.test.ts.
describe("isWithinWindow (shared window vectors, parity with drawService)", () => {
  for (const v of WINDOW_VECTORS) {
    it(v.name, () => {
      const [y, m, d, hh, mm] = v.now;
      expect(isWithinWindow(v.days, v.start, v.end, new Date(y, m - 1, d, hh, mm))).toBe(
        v.expected,
      );
    });
  }

  it("a task without a window is always within it", () => {
    expect(isWithinWindow(null, null, null, new Date())).toBe(true);
  });
});

describe("formatWindow", () => {
  it("collapses consecutive weekdays Mon-first", () => {
    expect(formatWindow([1, 2, 3, 4, 5], "08:00", "12:00")).toBe("Mon–Fri 08:00–12:00");
    expect(formatWindow([0, 6], "10:00", "14:00")).toBe("Sat, Sun 10:00–14:00");
  });

  it("lists non-consecutive days individually", () => {
    expect(formatWindow([1, 3, 5], "08:00", "12:00")).toBe("Mon, Wed, Fri 08:00–12:00");
  });

  it("labels a seven-day window daily", () => {
    expect(formatWindow([0, 1, 2, 3, 4, 5, 6], "06:00", "09:00")).toBe("daily 06:00–09:00");
  });

  it("wraps the Mon-first week: Fri–Sun is one range", () => {
    expect(formatWindow([5, 6, 0], "18:00", "24:00")).toBe("Fri–Sun 18:00–24:00");
  });
});

describe("isSnoozed", () => {
  const now = new Date(VECTOR_NOW);

  it("is derived: future deferredUntil or blocked, never a stored flag", () => {
    expect(isSnoozed(task({ deferredUntil: "2026-07-14T13:00:00.000Z" }), now)).toBe(true);
    expect(isSnoozed(task({ blocked: true }), now)).toBe(true);
    expect(isSnoozed(task(), now)).toBe(false);
  });

  it("an expired snooze ends with no write — the retained value is inert", () => {
    expect(isSnoozed(task({ deferredUntil: "2026-07-14T11:00:00.000Z" }), now)).toBe(false);
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
