import { describe, expect, it } from "vitest";
import {
  DARK_INK,
  LIGHT_INK,
  artByTask,
  batchArtKey,
  contrastRatio,
  liveTrackedMinutes,
  parseHexColor,
  relativeLuminance,
  svgDataUri,
  typeLineInk,
} from "./cardFrame";

describe("color parsing and WCAG math", () => {
  it("parses #rrggbb and #rgb, rejects everything else", () => {
    expect(parseHexColor("#4f8cff")).toEqual([0x4f, 0x8c, 0xff]);
    expect(parseHexColor("#fff")).toEqual([255, 255, 255]);
    expect(parseHexColor(" #FFB64F ")).toEqual([0xff, 0xb6, 0x4f]);
    expect(parseHexColor("red")).toBeNull();
    expect(parseHexColor("#12345")).toBeNull();
    expect(parseHexColor("rgb(1,2,3)")).toBeNull();
    expect(parseHexColor("")).toBeNull();
  });

  it("computes the WCAG anchors: black 0, white 1, 21:1 between them", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 3);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 3); // symmetric
  });
});

describe("typeLineInk — the deterministic pill-text choice (#114)", () => {
  it("pale category colors get dark ink", () => {
    // The app's warn orange, and pale pastels a user might pick.
    for (const pale of ["#ffb64f", "#ffe082", "#a5d6a7", "#e0e0e0", "#fff"]) {
      expect(typeLineInk(pale)).toBe(DARK_INK);
    }
  });

  it("dark category colors get light ink", () => {
    for (const dark of ["#4a3aa7", "#1b1e27", "#8b0000", "#2c3040", "#000"]) {
      expect(typeLineInk(dark)).toBe(LIGHT_INK);
    }
  });

  it("always picks the HIGHER-contrast ink — checked against the raw ratios", () => {
    // The three seeded category colors plus mid-tones where eyeballing fails.
    for (const color of ["#4f8cff", "#a06bff", "#3fbf7f", "#808080", "#e34948"]) {
      const ink = typeLineInk(color);
      const other = ink === DARK_INK ? LIGHT_INK : DARK_INK;
      expect(contrastRatio(color, ink)).toBeGreaterThanOrEqual(contrastRatio(color, other));
      // Determinism: same input, same answer.
      expect(typeLineInk(color)).toBe(ink);
    }
  });

  it("falls back to light ink for malformed colors (hand-edited DB)", () => {
    expect(typeLineInk("chartreuse")).toBe(LIGHT_INK);
    expect(typeLineInk("")).toBe(LIGHT_INK);
  });
});

describe("liveTrackedMinutes — the DEF stat's live tick (#115)", () => {
  const NOW = Date.parse("2026-07-15T12:00:00Z");

  it("returns the server base while no timer runs on the card", () => {
    expect(liveTrackedMinutes(25, null, NOW)).toBe(25);
    expect(liveTrackedMinutes(0, null, NOW)).toBe(0);
  });

  it("adds the running entry's elapsed WHOLE minutes on top of the base", () => {
    const startedAt = new Date(NOW - 4.7 * 60_000).toISOString();
    expect(liveTrackedMinutes(25, startedAt, NOW)).toBe(29); // floor(4.7) = 4
    expect(liveTrackedMinutes(0, startedAt, NOW)).toBe(4);
  });

  it("a just-started timer adds nothing yet", () => {
    expect(liveTrackedMinutes(10, new Date(NOW).toISOString(), NOW)).toBe(10);
    expect(liveTrackedMinutes(10, new Date(NOW - 59_000).toISOString(), NOW)).toBe(10);
  });

  it("clamps clock skew (startedAt in the future) and garbage to the base", () => {
    expect(liveTrackedMinutes(10, new Date(NOW + 60_000).toISOString(), NOW)).toBe(10);
    expect(liveTrackedMinutes(10, "not a date", NOW)).toBe(10);
  });
});

describe("batch art plumbing (#114)", () => {
  it("batchArtKey dedupes and sorts, so completion order cannot mint new cache entries", () => {
    expect(batchArtKey([3, 1, 2])).toBe("1,2,3");
    expect(batchArtKey([5, 5, 5])).toBe("5"); // recurring task, multiple completions
    expect(batchArtKey([2, 10])).toBe("2,10"); // numeric, not lexicographic
    expect(batchArtKey([])).toBe("");
  });

  it("artByTask maps the batch response to a per-card lookup; misses stay absent", () => {
    const map = artByTask([
      { taskId: 4, svg: "<svg>a</svg>" },
      { taskId: 9, svg: "<svg>b</svg>" },
    ]);
    expect(map.get(4)).toBe("<svg>a</svg>");
    expect(map.get(9)).toBe("<svg>b</svg>");
    expect(map.has(5)).toBe(false); // never generated -> gradient face
    expect(artByTask(undefined).size).toBe(0); // query not settled / failed
  });

  it("svgDataUri renders via the sanctioned img contract, URI-encoded", () => {
    const uri = svgDataUri(`<svg viewBox="0 0 300 420"></svg>`);
    expect(uri.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(uri).not.toContain('"'); // encoded, safe inside src="..."
    expect(decodeURIComponent(uri.split(",")[1])).toBe(`<svg viewBox="0 0 300 420"></svg>`);
  });
});
