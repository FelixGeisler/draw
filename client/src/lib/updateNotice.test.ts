import { describe, expect, it } from "vitest";
import {
  UPDATE_NOTICE_KEY,
  parseUpdateNotice,
  serializeUpdateNotice,
  shouldReloadAfterApply,
} from "./updateNotice";

// Post-update notice (#247): the sessionStorage flag that survives the
// apply-flow reload and pays exactly one "Updated to X" line, plus the
// poll's reload decision. Pure functions over raw strings — no DOM, no
// storage stub (the deckScope.test.ts pattern).
//
// SPEC-FIRST: lib/updateNotice.ts is a TODO-throwing skeleton, so the
// behavioral tests are `it.fails`. WHEN IMPLEMENTING #247: flip every
// `it.fails` to `it`. The key-constant test is green already and stays `it`.

describe("UPDATE_NOTICE_KEY", () => {
  it("is namespaced, since storage is shared with anything else on the origin", () => {
    expect(UPDATE_NOTICE_KEY).toBe("draw.updateNotice");
  });
});

describe("serializeUpdateNotice / parseUpdateNotice", () => {
  it.fails("round-trips the version the toast will announce", () => {
    expect(parseUpdateNotice(serializeUpdateNotice("1.2.0"))).toBe("1.2.0");
  });

  it.fails("nothing stored means nothing to announce", () => {
    // The everyday reload path: no flag, no toast, no reload loop.
    expect(parseUpdateNotice(null)).toBeNull();
    expect(parseUpdateNotice("")).toBeNull();
    expect(parseUpdateNotice("   ")).toBeNull();
  });

  it.fails("a corrupt flag must not toast gibberish", () => {
    // sessionStorage is shared with anything on the origin — an unrelated
    // writer or a stale format must degrade to silence, never to a broken
    // "Updated to undefined" toast.
    for (const raw of ["{}", "[object Object]", "null", "undefined"]) {
      expect(parseUpdateNotice(raw)).toBeNull();
    }
  });
});

describe("shouldReloadAfterApply", () => {
  it.fails("reloads only when the server reports a DIFFERENT version", () => {
    expect(shouldReloadAfterApply("1.0.0", "1.1.0")).toBe(true);
  });

  it.fails("the same version is never a reason to reload — no reload loops", () => {
    expect(shouldReloadAfterApply("1.0.0", "1.0.0")).toBe(false);
  });

  it.fails("a failed poll tick (container mid-restart) never reloads", () => {
    // While Watchtower swaps the container, GET /api/update fails or hangs;
    // the poll keeps calm and keeps polling, up to its 5-minute budget.
    expect(shouldReloadAfterApply("1.0.0", null)).toBe(false);
  });
});
