import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CurrentTimer, ForestTree } from "../lib/forest";
import { ForestTreeCard, GrowingTreeCard, formatForestDuration } from "./SessionForest";

const done: ForestTree = {
  id: 2,
  startedAt: "2026-01-02T03:04:05.006Z",
  endedAt: "2026-01-02T03:05:10.006Z",
  endReason: "done",
};

const stopped: ForestTree = { ...done, id: 1, endReason: "stop" };

const timer: CurrentTimer = {
  entry: { id: 3, taskId: 7, startedAt: "2026-01-02T03:04:05.006Z", endedAt: null },
  task: {
    id: 7,
    title: "Private task title must not render in the forest",
    categoryId: 1,
    impact: 3,
    effortMinutes: 1,
    goalId: null,
    status: "open",
  },
};

describe("Session forest presentation", () => {
  it("renders equal-card leafy Living and bare-branched Dead silhouettes with text, time and duration", () => {
    const living = renderToStaticMarkup(createElement(ForestTreeCard, { tree: done }));
    const dead = renderToStaticMarkup(createElement(ForestTreeCard, { tree: stopped }));
    expect(living).toContain("forest-tree living");
    expect(living).toContain("forest-leaves");
    expect(living).toContain("Living");
    expect(dead).toContain("forest-tree dead");
    expect(dead).toContain("forest-branches");
    expect(dead).toContain("Dead");
    for (const markup of [living, dead]) {
      expect(markup).toContain("aria-hidden=\"true\"");
      expect(markup).toContain("Ended");
      expect(markup).toContain("1m 5s");
    }
  });

  it("renders Growing from persisted start without task text or estimate-driven maturity", () => {
    const markup = renderToStaticMarkup(createElement(GrowingTreeCard, {
      timer,
      now: Date.parse(timer.entry.startedAt) + 120_000,
    }));
    expect(markup).toContain("Growing tree.");
    expect(markup).toContain("2m 0s");
    expect(markup).toMatch(/scale\(0\.737[0-9]+\)/);
    expect(markup).not.toContain(timer.task.title);
    expect(markup).not.toContain("effortMinutes");
  });

  it("keeps zero duration visible and freezes visual motion under reduced motion", () => {
    expect(formatForestDuration(0)).toBe("0s");
    const css = readFileSync(new URL("./SessionForest.css", import.meta.url), "utf8");
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(css).toMatch(/\.forest-tree-growth\s*\{[\s\S]*?transition:\s*none;[\s\S]*?animation:\s*none;/);
  });
});
