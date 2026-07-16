import { describe, expect, it } from "vitest";
import {
  DIVERGENCE,
  MIN_SAMPLE,
  biasStatement,
  estimateHint,
  hintText,
  roundSuggestion,
} from "./estimationCoach";

// Pure decision logic for estimation coaching (#55, ADR-27). Everything here
// is advice-only: none of these functions may ever be handed a setter or a
// payload — the tests pin the *decision*, TaskForm passivity is pinned E2E.

const bias = (taskCount: number, ratio: number) => ({ taskCount, ratio });

describe("estimateHint", () => {
  it("returns null without category history", () => {
    expect(estimateHint(undefined, 30)).toBeNull();
  });

  it("gates on the minimum sample", () => {
    expect(estimateHint(bias(MIN_SAMPLE - 1, 1.5), 30)).toBeNull();
    expect(estimateHint(bias(MIN_SAMPLE, 1.5), 30)).not.toBeNull();
  });

  it("returns null while no usable estimate is entered", () => {
    expect(estimateHint(bias(5, 1.5), null)).toBeNull();
    expect(estimateHint(bias(5, 1.5), 0)).toBeNull();
    expect(estimateHint(bias(5, 1.5), -10)).toBeNull();
    expect(estimateHint(bias(5, 1.5), Number.NaN)).toBeNull();
  });

  it("stays silent inside the divergence band, strictly beyond it fires", () => {
    // |ratio - 1| must EXCEED the band — 1.25/0.75 are exactly on it.
    expect(estimateHint(bias(5, 1), 30)).toBeNull();
    expect(estimateHint(bias(5, 1 + DIVERGENCE), 30)).toBeNull();
    expect(estimateHint(bias(5, 1 - DIVERGENCE), 30)).toBeNull();
    expect(estimateHint(bias(5, 1.26), 30)).not.toBeNull();
    expect(estimateHint(bias(5, 0.74), 30)).not.toBeNull();
  });

  it("suggests entered × ratio rounded to the nearest 5", () => {
    expect(estimateHint(bias(5, 1.5), 30)).toEqual({ suggestedMinutes: 45, ratio: 1.5 });
    expect(estimateHint(bias(5, 1.4), 30)).toEqual({ suggestedMinutes: 40, ratio: 1.4 }); // 42 → 40
    expect(estimateHint(bias(5, 1.5), 33)).toEqual({ suggestedMinutes: 50, ratio: 1.5 }); // 49.5 → 50
    expect(estimateHint(bias(5, 0.5), 45)).toEqual({ suggestedMinutes: 25, ratio: 0.5 }); // 22.5 → 25
  });

  it("never suggests below 5 minutes", () => {
    // 10 × 0.2 = 2 → nearest-5 would be 0; a "~0 min" suggestion is nonsense.
    expect(estimateHint(bias(5, 0.2), 10)).toEqual({ suggestedMinutes: 5, ratio: 0.2 });
  });

  it("stays silent when the ROUNDED suggestion IS the entered value (#103)", () => {
    // A 5 in the field is the ONLY input this can happen to, and it is worth
    // knowing why: roundSuggestion always returns a multiple of 5 that is at
    // least 5, so it can only ever equal a multiple-of-5 input — and for 10
    // and up, the ±25% divergence band already excludes every ratio that
    // would round back (10 × 1.26 = 12.6 → 15). At 5 the floor swallows the
    // whole low half instead, so both tails collapse onto the input:
    // divergence the user can read, advice they cannot use.
    expect(estimateHint(bias(5, 0.05), 5)).toBeNull(); // 0.25 → floored to 5
    expect(estimateHint(bias(5, 0.5), 5)).toBeNull(); // 2.5 → floored to 5
    expect(estimateHint(bias(5, 0.74), 5)).toBeNull(); // 3.7 → floored to 5
    expect(estimateHint(bias(5, 1.26), 5)).toBeNull(); // 6.3 → rounds back to 5
    expect(estimateHint(bias(5, 1.49), 5)).toBeNull(); // 7.45 → rounds back to 5
  });

  it("still fires wherever the rounded suggestion differs at all", () => {
    // The gate is the number actually shown, not the size of the input — a 4
    // that history says is really 5+ is still worth saying once…
    expect(estimateHint(bias(5, 1.4), 4)).toEqual({ suggestedMinutes: 5, ratio: 1.4 });
    // …and 5 itself starts advising again the moment the suggestion moves.
    expect(estimateHint(bias(5, 1.5), 5)).toEqual({ suggestedMinutes: 10, ratio: 1.5 });
    expect(estimateHint(bias(5, 1.5), 10)).toEqual({ suggestedMinutes: 15, ratio: 1.5 });
    expect(estimateHint(bias(5, 0.5), 20)).toEqual({ suggestedMinutes: 10, ratio: 0.5 });
  });
});

describe("roundSuggestion", () => {
  it("rounds to the nearest 5 with a floor of 5", () => {
    expect(roundSuggestion(42)).toBe(40);
    expect(roundSuggestion(42.5)).toBe(45);
    expect(roundSuggestion(5)).toBe(5);
    expect(roundSuggestion(2)).toBe(5);
    expect(roundSuggestion(0)).toBe(5);
  });
});

describe("hintText", () => {
  it("names the suggestion, the ratio and the category", () => {
    expect(hintText({ suggestedMinutes: 45, ratio: 1.5 }, "Uni")).toBe(
      "history suggests ~45 min (you track 1.5× your Uni estimates)",
    );
  });
});

describe("biasStatement", () => {
  it("returns null below the minimum sample — no placeholder line", () => {
    expect(biasStatement({ name: "Uni", taskCount: MIN_SAMPLE - 1, ratio: 1.4 })).toBeNull();
  });

  it("tells an under-estimator to pad", () => {
    expect(biasStatement({ name: "Uni", taskCount: 6, ratio: 1.4 })).toBe(
      "Uni: tracked 1.4× estimated over 6 tasks — pad your Uni estimates.",
    );
  });

  it("tells an over-estimator to trim", () => {
    expect(biasStatement({ name: "Chores", taskCount: 4, ratio: 0.6 })).toBe(
      "Chores: tracked 0.6× estimated over 4 tasks — your Chores estimates run high, trim them.",
    );
  });

  it("keeps the accurate band short and positive (band inclusive, like the server)", () => {
    expect(biasStatement({ name: "Uni", taskCount: 3, ratio: 1 })).toBe(
      "Uni: estimates on point over 3 tasks.",
    );
    expect(biasStatement({ name: "Uni", taskCount: 3, ratio: 0.9 })).toContain("on point");
    expect(biasStatement({ name: "Uni", taskCount: 3, ratio: 1.1 })).toContain("on point");
    expect(biasStatement({ name: "Uni", taskCount: 3, ratio: 1.11 })).toContain("pad");
    expect(biasStatement({ name: "Uni", taskCount: 3, ratio: 0.89 })).toContain("run high");
  });
});
