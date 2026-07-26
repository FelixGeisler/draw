import { describe, expect, it } from "vitest";
import { isRestorable, type RestorableTask } from "../../src/services/drawService.js";
import { DRAWABLE_VECTORS, VECTOR_NOW, materializeWindow } from "../../../shared/drawableVectors.js";

// Deck eligibility exists twice by design (ADR-2 predicate, one per tier):
// the candidate WHERE clause / isRestorable() here, classifyTask() on the
// client. Both suites run the SAME vectors (shared/drawableVectors.ts) —
// membership drift between server and client fails a suite, not the user.
// The client-side run lives in client/src/lib/drawable.test.ts.

const NOW = new Date(VECTOR_NOW);

describe("shared eligibility vectors (parity with classifyTask)", () => {
  for (const v of DRAWABLE_VECTORS) {
    it(`${v.name} → ${v.expected === "ready" ? "in the deck" : "out"}`, () => {
      // Windows are local wall-clock (#33), so window vectors carry offsets
      // relative to NOW instead of fixed weekdays — deterministic anywhere.
      const window = v.window
        ? materializeWindow(v.window, NOW)
        : { windowDays: null, windowStart: null, windowEnd: null };
      const task: RestorableTask = {
        status: "open",
        effortMinutes: v.effortMinutes,
        hasOpenChildren: v.hasOpenChildren,
        // #111: absent in a vector means "same as hasOpenChildren" — an open
        // child is non-archived by definition.
        hasNonArchivedChildren: v.hasNonArchivedChildren ?? v.hasOpenChildren,
        blocked: v.blocked,
        deferredUntil: v.deferredUntil,
        heldBack: v.heldBack,
        // Recurrence schedule (#205): absent means neither field set.
        recurEveryDays: v.recurEveryDays ?? null,
        dueDate: v.dueDate ?? null,
        ...window,
      };
      expect(isRestorable(task, v.maxEffort, NOW)).toBe(v.expected === "ready");
    });
  }
});
