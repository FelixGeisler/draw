import { describe, expect, it } from "vitest";
import { splitPartsError } from "../../src/routes/tasks.js";

// Issue #108: pure whole-body validation for POST /api/tasks/:id/split —
// any invalid part fails the entire request before a single row is written
// (the route only opens its transaction on null). The integration suite
// covers the same guards over HTTP; this pins the pure matrix cheaply.

describe("splitPartsError", () => {
  it("accepts two well-formed parts (description optional)", () => {
    expect(
      splitPartsError([
        { title: "part 1", effortMinutes: 25 },
        { title: "part 2", effortMinutes: 20, description: "second half" },
      ]),
    ).toBeNull();
  });

  it("rejects non-arrays and fewer than 2 parts — one part is a rename, not a split", () => {
    expect(splitPartsError(undefined)).toMatch(/at least 2 parts/);
    expect(splitPartsError("parts")).toMatch(/at least 2 parts/);
    expect(splitPartsError([])).toMatch(/at least 2 parts/);
    expect(splitPartsError([{ title: "only", effortMinutes: 10 }])).toMatch(/at least 2 parts/);
  });

  it("rejects non-object parts", () => {
    expect(splitPartsError([{ title: "ok", effortMinutes: 5 }, "nope"])).toMatch(/must be an object/);
    expect(splitPartsError([{ title: "ok", effortMinutes: 5 }, null])).toMatch(/must be an object/);
    expect(splitPartsError([{ title: "ok", effortMinutes: 5 }, [1]])).toMatch(/must be an object/);
  });

  it("requires a non-empty title on every part", () => {
    expect(splitPartsError([{ effortMinutes: 5 }, { title: "b", effortMinutes: 5 }])).toMatch(
      /needs a title/,
    );
    expect(
      splitPartsError([
        { title: "   ", effortMinutes: 5 },
        { title: "b", effortMinutes: 5 },
      ]),
    ).toMatch(/non-empty string/);
    expect(
      splitPartsError([
        { title: 7, effortMinutes: 5 },
        { title: "b", effortMinutes: 5 },
      ]),
    ).toMatch(/non-empty string/);
  });

  it("requires a positive integer effortMinutes on every part — unlike the batch, estimates are mandatory", () => {
    expect(splitPartsError([{ title: "a" }, { title: "b", effortMinutes: 5 }])).toMatch(
      /needs effortMinutes/,
    );
    expect(
      splitPartsError([
        { title: "a", effortMinutes: null },
        { title: "b", effortMinutes: 5 },
      ]),
    ).toMatch(/needs effortMinutes/);
    for (const bad of [0, -5, 2.5, "20"]) {
      expect(
        splitPartsError([
          { title: "a", effortMinutes: bad },
          { title: "b", effortMinutes: 5 },
        ]),
      ).toMatch(/positive integer/);
    }
  });

  it("has deliberately no upper cap — a part may exceed max_draw_effort and be split again", () => {
    expect(
      splitPartsError([
        { title: "still huge", effortMinutes: 500 },
        { title: "small", effortMinutes: 5 },
      ]),
    ).toBeNull();
  });

  it("rejects a malformed description", () => {
    expect(
      splitPartsError([
        { title: "a", effortMinutes: 5, description: 42 },
        { title: "b", effortMinutes: 5 },
      ]),
    ).toMatch(/description must be a string/);
  });
});
