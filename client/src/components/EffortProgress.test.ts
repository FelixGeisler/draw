import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EffortProgress } from "./EffortProgress";

describe("EffortProgress", () => {
  it("renders exact visible text, accessible completed values, and completed-direction fill", () => {
    const markup = renderToStaticMarkup(
      createElement(EffortProgress, {
        progress: { total: 50, remaining: 30, completed: 20, pct: 0.4 },
      }),
    );

    expect(markup).toContain("20/50 min complete");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="Effort progress"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="50"');
    expect(markup).toContain('aria-valuenow="20"');
    expect(markup).toContain('style="width:40%"');
  });
});
