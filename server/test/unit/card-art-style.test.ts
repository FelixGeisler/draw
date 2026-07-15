import { describe, expect, it } from "vitest";
import {
  ARCHETYPES,
  buildCardArtPrompt,
  DENSITIES,
  FOCALS,
  HARMONIES,
  selectCardArtStyle,
} from "../../src/services/cardArtStyle.js";

// #113: the fix for "all cards look the same" is structural, so it is pinned
// structurally — deterministic per-task style selection and genuinely
// distinct directive content. Visual quality itself is user-validated against
// the live API (#91 checklist), never here.

describe("style axes are real choices", () => {
  it("offers at least 5 named archetypes plus multiple harmonies/densities/focals", () => {
    expect(ARCHETYPES.length).toBeGreaterThanOrEqual(5);
    expect(HARMONIES.length).toBeGreaterThanOrEqual(2);
    expect(DENSITIES.length).toBeGreaterThanOrEqual(3);
    expect(FOCALS.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps every archetype directive substantial and pairwise distinct", () => {
    const directives = ARCHETYPES.map((a) => a.directive);
    expect(new Set(directives).size).toBe(ARCHETYPES.length);
    expect(new Set(ARCHETYPES.map((a) => a.name)).size).toBe(ARCHETYPES.length);
    for (const d of directives) expect(d.length).toBeGreaterThan(120); // a real recipe, not a label
  });

  it("keeps harmony, density and focal directives pairwise distinct too", () => {
    expect(new Set(HARMONIES.map((h) => h.line("#4f8cff"))).size).toBe(HARMONIES.length);
    expect(new Set(DENSITIES.map((d) => d.directive)).size).toBe(DENSITIES.length);
    expect(new Set(FOCALS.map((f) => f.directive)).size).toBe(FOCALS.length);
  });

  it("never asks for constructs the sanitizer strips", () => {
    const all = [
      ...ARCHETYPES.map((a) => a.directive),
      ...HARMONIES.map((h) => h.line("#4f8cff")),
      ...DENSITIES.map((d) => d.directive),
      ...FOCALS.map((f) => f.directive),
    ].join("\n");
    expect(all).not.toMatch(/<text|<tspan|<style|<image|<script|animate|foreignObject|https?:/i);
  });

  it("biases every focal placement upward — the TCG art window (#115) is portrait", () => {
    for (const f of FOCALS) {
      expect(f.directive).toMatch(/upper|rising/i);
    }
  });
});

describe("deterministic selection", () => {
  it("the same task id always yields the same style", () => {
    for (const id of [1, 7, 42, 113, 9999]) {
      expect(selectCardArtStyle(id)).toEqual(selectCardArtStyle(id));
    }
  });

  // The mapping is part of a task's visual identity: the at-most-once cache
  // and the regenerate path both rely on it never moving for an existing id.
  // If this test breaks, existing cards would silently change character on
  // regenerate — change the axes only by APPENDING new entries.
  it("pins the id -> style mapping for sample ids", () => {
    const names = (id: number) => {
      const s = selectCardArtStyle(id);
      return [s.archetype.name, s.harmony.name, s.density.name, s.focal.name];
    };
    expect(names(1)).toEqual(["contour lines", "split-complementary", "dense", "rising diagonal"]);
    expect(names(2)).toEqual(["brush strokes", "analogous", "sparse", "high off-corner"]);
    expect(names(3)).toEqual(["prismatic shards", "split-complementary", "medium", "upper-third band"]);
    expect(names(7)).toEqual(["constellation", "split-complementary", "sparse", "upper-third band"]);
    expect(names(42)).toEqual(["prismatic shards", "split-complementary", "sparse", "upper-center"]);
    expect(names(113)).toEqual(["prismatic shards", "split-complementary", "dense", "rising diagonal"]);
  });

  it("reaches every archetype, harmony, density and focal across realistic ids", () => {
    const seen = {
      archetypes: new Set<string>(),
      harmonies: new Set<string>(),
      densities: new Set<string>(),
      focals: new Set<string>(),
    };
    for (let id = 1; id <= 300; id++) {
      const s = selectCardArtStyle(id);
      seen.archetypes.add(s.archetype.name);
      seen.harmonies.add(s.harmony.name);
      seen.densities.add(s.density.name);
      seen.focals.add(s.focal.name);
    }
    expect(seen.archetypes.size).toBe(ARCHETYPES.length);
    expect(seen.harmonies.size).toBe(HARMONIES.length);
    expect(seen.densities.size).toBe(DENSITIES.length);
    expect(seen.focals.size).toBe(FOCALS.length);
  });

  it("neighboring ids do not move in lockstep across the axes", () => {
    // With one shared hash all axes would flip together; salted hashes keep
    // them independent. Loose bound: among 50 consecutive ids, adjacent pairs
    // must not always change (or always keep) all axes at once.
    let identicalAxes = 0;
    for (let id = 100; id < 150; id++) {
      const a = selectCardArtStyle(id);
      const b = selectCardArtStyle(id + 1);
      if (a.harmony.name === b.harmony.name) identicalAxes++;
    }
    expect(identicalAxes).toBeGreaterThan(0); // harmony sometimes survives an id step
    expect(identicalAxes).toBeLessThan(50); // …and sometimes changes
  });
});

describe("buildCardArtPrompt (the built prompt, no API call needed)", () => {
  const input = {
    taskId: 7,
    title: "Solve exam exercise 3",
    category: "Uni",
    color: "#8bc34a",
    goalTitle: "Pass the algorithms exam",
  };

  it("contains the task facts, the archetype directive, the harmony line with the category color, and a composition directive", () => {
    const prompt = buildCardArtPrompt(input);
    const style = selectCardArtStyle(7);

    expect(prompt).toContain("Task: Solve exam exercise 3");
    expect(prompt).toContain("Category: Uni (category color: #8bc34a)");
    expect(prompt).toContain("Part of goal: Pass the algorithms exam");

    expect(prompt).toContain(`Style archetype — ${style.archetype.name}: ${style.archetype.directive}`);
    expect(prompt).toContain(style.harmony.line("#8bc34a"));
    expect(prompt).toMatch(/Palette harmony — /);
    expect(prompt).toContain("#8bc34a"); // the harmony line references the category color
    expect(prompt).toContain(style.density.directive);
    expect(prompt).toContain(style.focal.directive);

    expect(prompt).toContain("Return the complete SVG markup in the svg field.");
  });

  it("is stable for the same input and omits the goal line when unlinked", () => {
    expect(buildCardArtPrompt(input)).toBe(buildCardArtPrompt(input));
    const bare = buildCardArtPrompt({ ...input, goalTitle: null });
    expect(bare).not.toContain("Part of goal");
  });

  it("different task ids produce different style directives (spot check)", () => {
    // ids 2 and 3 map to different archetypes per the pinned table above.
    const a = buildCardArtPrompt({ ...input, taskId: 2 });
    const b = buildCardArtPrompt({ ...input, taskId: 3 });
    expect(a).not.toBe(b);
    expect(a).toContain("brush strokes");
    expect(b).toContain("prismatic shards");
  });
});
