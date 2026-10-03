import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CurrentTimer, ForestTree } from "../lib/forest";
import {
  FinishedTree,
  GrowingTree,
  forestTreePlacement,
  formatForestDuration,
} from "./SessionForest";

const done: ForestTree = {
  id: 2,
  startedAt: "2026-01-02T03:04:05.006Z",
  endedAt: "2026-01-02T03:05:10.006Z",
  endReason: "done",
};

const stopped: ForestTree = { ...done, id: 1, endReason: "stop" };

const entry: CurrentTimer["entry"] = {
  id: 3,
  taskId: 7,
  startedAt: "2026-01-02T03:04:05.006Z",
  endedAt: null,
};

describe("Session forest presentation", () => {
  it("renders equal-footprint leafy Living and bare-branched Dead radio cells with decorative art", () => {
    const living = renderToStaticMarkup(createElement(FinishedTree, { tree: done }));
    const dead = renderToStaticMarkup(createElement(FinishedTree, { tree: stopped }));
    expect(living).toContain("forest-tree living");
    expect(living).toContain("forest-leaves");
    expect(living).toContain("Living");
    expect(dead).toContain("forest-tree dead");
    expect(dead).toContain("forest-branches");
    expect(dead).toContain("Dead");
    for (const markup of [living, dead]) {
      expect(markup).toContain('type="radio"');
      expect(markup).toContain('name="forest-tree-selection"');
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain("Ended");
      expect(markup).toContain("Duration 1m 5s");
      expect(markup).not.toContain("forest-ground");
    }
  });

  it("renders Growing from the persisted entry without accepting task data or estimate-driven maturity", () => {
    const markup = renderToStaticMarkup(createElement(GrowingTree, {
      entry,
      now: Date.parse(entry.startedAt) + 120_000,
    }));
    expect(markup).toContain("Growing");
    expect(markup).toContain("Duration 2m 0s");
    expect(markup).toMatch(/scale\(0\.737[0-9]+\)/);
    expect(markup).not.toContain("taskId");
    expect(markup).not.toContain("effortMinutes");
  });

  it("maps positive safe ids to exactly three stable silhouettes and bounded offsets", () => {
    const placements = Array.from({ length: 60 }, (_, index) => forestTreePlacement(index + 1));
    expect(new Set(placements.map((placement) => placement.variant))).toEqual(new Set([0, 1, 2]));
    expect(placements.every(({ offsetX }) => offsetX >= -8 && offsetX <= 8)).toBe(true);
    expect(placements.every(({ offsetY }) => offsetY >= 0 && offsetY <= 6)).toBe(true);
    expect(forestTreePlacement(37)).toEqual(forestTreePlacement(37));
    expect(() => forestTreePlacement(0)).toThrow("Invalid forest tree id");
    expect(() => forestTreePlacement(Number.MAX_SAFE_INTEGER + 1)).toThrow("Invalid forest tree id");
  });

  it("keeps transparent cells on one terrain owner without card or isolated-ground styling", () => {
    const css = readFileSync(new URL("./SessionForest.css", import.meta.url), "utf8");
    const cellRule = css.match(/\.forest-tree\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(cellRule).not.toMatch(/(?:border|border-radius|background|box-shadow)\s*:/);
    expect(css.match(/\.forest-world\s*\{[^}]*background:/g)).toHaveLength(2); // default + sole mobile breakpoint
    expect(css).not.toContain(".forest-ground");
    expect(css).not.toMatch(/\.forest-tree\.dead[^}]*\{[^}]*(?:opacity|color|filter)\s*:/s);
    expect(css).not.toMatch(/\.forest-tree\.living[^}]*\{[^}]*(?:opacity|color|filter)\s*:/s);
  });

  it("keeps zero duration visible and gates every transition behind no-preference", () => {
    expect(formatForestDuration(0)).toBe("0s");
    const css = readFileSync(new URL("./SessionForest.css", import.meta.url), "utf8");
    const beforeMotion = css.split("@media (prefers-reduced-motion: no-preference)")[0];
    expect(beforeMotion).not.toMatch(/(?:transition|animation)\s*:/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*no-preference\)[\s\S]*--forest-growth-duration:\s*1s;[\s\S]*transition:\s*transform var\(--forest-growth-duration\) linear;/);
    expect(css).not.toMatch(/prefers-reduced-motion:\s*reduce/);
  });
});
