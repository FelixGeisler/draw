import { describe, expect, it } from "vitest";
import { isWithinWindow, parseWindowDays } from "../../src/services/drawService.js";
import { WINDOW_VECTORS } from "../../../shared/drawableVectors.js";

// Availability-window predicate (#33, ADR-20). It exists twice by design,
// like the eligibility predicate (ADR-2): here on the server (filters the
// candidate pool and guards isRestorable) and mirrored on the client
// (classifyTask's "scheduled" group). Both suites run the SAME vectors from
// shared/drawableVectors.ts — the client run is in drawable.test.ts. The
// vectors pin `now` as LOCAL date components, because the window semantics
// are deliberately local wall-clock (SQLite's UTC time functions were
// rejected for exactly this reason).

describe("isWithinWindow (shared window vectors, parity with the client)", () => {
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

describe("parseWindowDays", () => {
  it("parses the JSON column and passes null through", () => {
    expect(parseWindowDays("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseWindowDays(null)).toBeNull();
  });

  it("contains a corrupt row (hand-edited DB) as unwindowed instead of throwing", () => {
    // Runs on every task payload — one bad row must not break whole endpoints.
    expect(parseWindowDays("[1,2,")).toBeNull();
    // null days = no window: the predicate keeps the task drawable.
    expect(isWithinWindow(parseWindowDays("[1,2,"), "09:00", "17:00", new Date())).toBe(true);
  });
});
