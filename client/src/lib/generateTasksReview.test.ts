import { describe, expect, it } from "vitest";
import type { GeneratedTask } from "../hooks/useAi";
import {
  commitLeaves,
  defaultParentTitle,
  defaultUmbrella,
  formatDuration,
  provenance,
  setAllIncluded,
  setItemImpact,
  setItemIncluded,
  setPartIncluded,
  summarize,
  toReviewItems,
  type ReviewItem,
} from "./generateTasksReview";

let nextId = 1;
function generated(overrides: Partial<GeneratedTask> = {}): GeneratedTask {
  const id = nextId++;
  return {
    label: String(id),
    title: `Solve exercise ${id}`,
    points: null,
    statedMinutes: null,
    estimatedMinutes: 20,
    suggestedImpact: 3,
    rationale: `Ex. ${id} per the PDF`,
    parts: [],
    impact: 3,
    impactSource: "model",
    ...overrides,
  };
}

function items(...overrides: Partial<GeneratedTask>[]): ReviewItem[] {
  return toReviewItems(overrides.map(generated));
}

describe("toReviewItems", () => {
  it("prefers the material's statedMinutes over the model estimate for the exercise total", () => {
    const [stated, estimated] = items(
      { statedMinutes: 45, estimatedMinutes: 10 },
      { statedMinutes: null, estimatedMinutes: 25 },
    );
    expect(stated.minutes).toBe(45);
    expect(estimated.minutes).toBe(25);
  });

  it("starts everything included and keeps parts grouped under their exercise", () => {
    const [item] = items({
      parts: [
        { title: "part a", minutes: 30 },
        { title: "part b", minutes: 30 },
      ],
    });
    expect(item.included).toBe(true);
    expect(item.parts.map((p) => p.included)).toEqual([true, true]);
  });

  it("rounds a fractional stated total to a whole minute >= 1 for the editable field", () => {
    const [item] = items({ statedMinutes: 0.5 });
    expect(item.minutes).toBe(1);
  });
});

describe("group-check coupling", () => {
  const parted = () =>
    items(
      {},
      {
        parts: [
          { title: "part a", minutes: 30 },
          { title: "part b", minutes: 30 },
        ],
      },
    );

  it("unchecking an exercise unchecks all its parts", () => {
    const next = setItemIncluded(parted(), 1, false);
    expect(next[1].included).toBe(false);
    expect(next[1].parts.every((p) => !p.included)).toBe(true);
    // Neighbours untouched.
    expect(next[0].included).toBe(true);
  });

  it("re-checking an exercise re-checks its parts", () => {
    const next = setItemIncluded(setItemIncluded(parted(), 1, false), 1, true);
    expect(next[1].parts.every((p) => p.included)).toBe(true);
  });

  it("unchecking the last included part unchecks the exercise", () => {
    let next = setPartIncluded(parted(), 1, 0, false);
    expect(next[1].included).toBe(true); // one part still in
    next = setPartIncluded(next, 1, 1, false);
    expect(next[1].included).toBe(false);
  });

  it("re-including any part re-includes the exercise", () => {
    const next = setPartIncluded(setItemIncluded(parted(), 1, false), 1, 1, true);
    expect(next[1].included).toBe(true);
    expect(next[1].parts.map((p) => p.included)).toEqual([false, true]);
  });

  it("select all / none flips every exercise and part", () => {
    const none = setAllIncluded(parted(), false);
    expect(none.every((i) => !i.included && i.parts.every((p) => !p.included))).toBe(true);
    const all = setAllIncluded(none, true);
    expect(all.every((i) => i.included && i.parts.every((p) => p.included))).toBe(true);
  });

  it("select all / none holds at the acceptance criterion's 40-exercise scale", () => {
    // A realistic exam import: 40 exercises, every third one split into parts.
    const exam = toReviewItems(
      Array.from({ length: 40 }, (_, i) =>
        generated(
          i % 3 === 0
            ? { parts: [{ title: `${i} part a`, minutes: 20 }, { title: `${i} part b`, minutes: 20 }] }
            : {},
        ),
      ),
    );
    expect(exam).toHaveLength(40);
    const none = setAllIncluded(exam, false);
    expect(none.every((i) => !i.included && i.parts.every((p) => !p.included))).toBe(true);
    expect(commitLeaves(none, null)).toEqual([]);
    const all = setAllIncluded(none, true);
    expect(all.every((i) => i.included && i.parts.every((p) => p.included))).toBe(true);
    // 14 split exercises commit as 2 parts each, 26 as single leaves.
    expect(commitLeaves(all, null)).toHaveLength(14 * 2 + 26);
  });
});

describe("summarize", () => {
  it("aggregates exercises, leaves, points, minutes and split count", () => {
    const s = summarize(
      items(
        { points: 8, statedMinutes: 20 },
        {
          points: 12,
          statedMinutes: 60,
          parts: [
            { title: "a", minutes: 30 },
            { title: "b", minutes: 30 },
          ],
        },
        { points: null, estimatedMinutes: 25 },
      ),
    );
    expect(s).toEqual({ exerciseCount: 3, leafCount: 4, points: 20, minutes: 105, splitCount: 1 });
  });

  it("excludes unchecked exercises and unchecked parts", () => {
    let list = items(
      { points: 8, statedMinutes: 20 },
      {
        points: 12,
        statedMinutes: 60,
        parts: [
          { title: "a", minutes: 30 },
          { title: "b", minutes: 30 },
        ],
      },
    );
    list = setItemIncluded(list, 0, false);
    list = setPartIncluded(list, 1, 1, false);
    expect(summarize(list)).toEqual({
      exerciseCount: 1,
      leafCount: 1,
      points: 12,
      minutes: 30,
      splitCount: 1,
    });
  });

  it("reports null points when no included exercise carries any (model-rated set)", () => {
    expect(summarize(items({}, {})).points).toBeNull();
  });

  it("keeps a 0-point exercise as 0, not null", () => {
    expect(summarize(items({ points: 0 })).points).toBe(0);
  });
});

describe("formatDuration", () => {
  it("formats minutes, whole hours, and mixed durations", () => {
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(120)).toBe("2h");
    expect(formatDuration(760)).toBe("12h 40m");
    expect(formatDuration(0)).toBe("0m");
  });
});

describe("provenance", () => {
  it("cites label, points, minutes and source file", () => {
    const [item] = items({ label: "7", points: 8, statedMinutes: 45 });
    expect(provenance(item, "Probeklausur_2023.pdf")).toBe(
      "Exercise 7 · 8 pts · ~45 min · Probeklausur_2023.pdf",
    );
  });

  it("omits the pieces the material does not provide", () => {
    const [item] = items({ label: null, points: null, estimatedMinutes: 25 });
    expect(provenance(item, null)).toBe("~25 min");
  });
});

describe("commitLeaves", () => {
  it("commits a partless exercise as one leaf and a split exercise as flat part-leaves", () => {
    const leaves = commitLeaves(
      items(
        { label: "1", points: 8, statedMinutes: 20, impact: 2, impactSource: "points" },
        {
          label: "2",
          points: 12,
          statedMinutes: 60,
          impact: 5,
          impactSource: "points",
          parts: [
            { title: "Solve 2 (part 1/2)", minutes: 30 },
            { title: "Solve 2 (part 2/2)", minutes: 30 },
          ],
        },
      ),
      "exam.pdf",
    );
    expect(leaves).toHaveLength(3);
    expect(leaves[0]).toMatchObject({ effortMinutes: 20, impact: 2 });
    expect(leaves[0].description).toBe("Exercise 1 · 8 pts · ~20 min · exam.pdf");
    // Part leaves inherit the exercise's impact and provenance, keep own minutes.
    expect(leaves[1]).toMatchObject({ title: "Solve 2 (part 1/2)", effortMinutes: 30, impact: 5 });
    expect(leaves[2].description).toBe("Exercise 2 · 12 pts · ~60 min · exam.pdf");
  });

  it("edited titles and minutes land verbatim in the leaves; provenance keeps citing the material", () => {
    const list = items({ label: "3", statedMinutes: 20 });
    list[0].title = "  Prove the mean value theorem  ";
    list[0].minutes = 35;
    const [leaf] = commitLeaves(list, "exam.pdf");
    expect(leaf.title).toBe("Prove the mean value theorem");
    expect(leaf.effortMinutes).toBe(35);
    // The description is an audit trail of the SOURCE — the user's effort
    // edit must not rewrite what the material said.
    expect(leaf.description).toBe("Exercise 3 · ~20 min · exam.pdf");
  });

  it("rounds edited decimal minutes to the integers the API accepts (#84)", () => {
    const list = items(
      { statedMinutes: 20 },
      {
        parts: [
          { title: "part a", minutes: 30 },
          { title: "part b", minutes: 30 },
        ],
      },
    );
    // The editable fields bypass form `step` validation — decimals and a
    // cleared-to-0 field must still commit as positive integers.
    list[0].minutes = 12.5;
    list[1].parts[0].minutes = 7.4;
    list[1].parts[1].minutes = 0;
    const leaves = commitLeaves(list, null);
    expect(leaves.map((l) => l.effortMinutes)).toEqual([13, 7, 1]);
  });

  it("excludes unchecked exercises, unchecked parts, and blank titles", () => {
    let list = items(
      {},
      {
        parts: [
          { title: "keep", minutes: 30 },
          { title: "drop", minutes: 30 },
        ],
      },
      { title: "   " },
    );
    list = setItemIncluded(list, 0, false);
    list = setPartIncluded(list, 1, 1, false);
    const leaves = commitLeaves(list, null);
    expect(leaves.map((l) => l.title)).toEqual(["keep"]);
  });

  it("returns no leaves when everything is deselected", () => {
    expect(commitLeaves(setAllIncluded(items({}, {}), false), null)).toEqual([]);
  });
});

describe("defaultParentTitle", () => {
  it("derives the umbrella title from the goal, not the source file (#161)", () => {
    expect(defaultParentTitle("Machine Learning")).toBe("Machine Learning — generated plan");
  });

  it("trims and never returns an empty title", () => {
    expect(defaultParentTitle("  Pass the exam  ")).toBe("Pass the exam — generated plan");
    expect(defaultParentTitle("   ")).toBe("Generated tasks");
  });
});

describe("defaultUmbrella", () => {
  it("defaults ON at >= 5 accepted leaves, OFF below (#161)", () => {
    expect(defaultUmbrella(4)).toBe(false);
    expect(defaultUmbrella(5)).toBe(true);
    expect(defaultUmbrella(0)).toBe(false);
    expect(defaultUmbrella(40)).toBe(true);
  });
});

describe("setItemImpact", () => {
  it("sets the exercise impact and marks it touched, leaving neighbours alone", () => {
    const list = items({ impact: 2, impactSource: "model" }, { impact: 3, impactSource: "model" });
    expect(list[0].impactTouched).toBe(false);
    const next = setItemImpact(list, 0, 5);
    expect(next[0].impact).toBe(5);
    expect(next[0].impactTouched).toBe(true);
    // The neighbour's rating and its untouched flag are untouched.
    expect(next[1].impact).toBe(3);
    expect(next[1].impactTouched).toBe(false);
  });

  it("carries the corrected impact into the committed leaf", () => {
    const next = setItemImpact(items({ impact: 2, impactSource: "points" }), 0, 4);
    expect(commitLeaves(next, null)[0].impact).toBe(4);
  });
});
