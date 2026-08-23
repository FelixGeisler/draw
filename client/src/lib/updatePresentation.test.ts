import { describe, expect, it } from "vitest";
import { currentVersionLabel } from "./updatePresentation";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("currentVersionLabel", () => {
  it("shows only the package version for stable builds, even with a SHA", () => {
    expect(
      currentVersionLabel({ current: "1.2.3", buildChannel: "stable", buildSha: SHA }),
    ).toBe("Draw 1.2.3");
  });

  it("appends the first 12 SHA characters for edge and local builds", () => {
    expect(
      currentVersionLabel({ current: "1.2.3", buildChannel: "edge", buildSha: SHA }),
    ).toBe("Draw 1.2.3 · Edge 0123456789ab");
    expect(
      currentVersionLabel({ current: "2.3.4-rc.1", buildChannel: "local", buildSha: SHA }),
    ).toBe("Draw 2.3.4-rc.1 · Local 0123456789ab");
  });

  it("adds no fallback text when edge or local SHA identity is unavailable", () => {
    expect(
      currentVersionLabel({ current: "1.2.3", buildChannel: "edge", buildSha: null }),
    ).toBe("Draw 1.2.3");
    expect(
      currentVersionLabel({ current: "1.2.3", buildChannel: "local", buildSha: null }),
    ).toBe("Draw 1.2.3");
  });
});
