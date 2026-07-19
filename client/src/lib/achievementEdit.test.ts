import { describe, expect, it } from "vitest";
import {
  buildAchievementPatch,
  partitionAchievements,
  resetAchievementPatch,
} from "./achievementEdit";

// Pure helpers for the achievement display-customization UI (#177, ADR-44).
// The card editor and the collection split are the two testable pieces the
// component leans on; the DOM wiring around them is thin.

describe("buildAchievementPatch", () => {
  it("keeps trimmed text overrides and passes the hidden flag through", () => {
    expect(
      buildAchievementPatch({ title: "  My hundred  ", description: " Hit 100 ", hidden: true }),
    ).toEqual({ title: "My hundred", description: "Hit 100", hidden: true });
  });

  it("maps a blank or whitespace-only field to null — 'use the server default'", () => {
    // Clearing an input in the editor must RESET that field, not store a blank
    // override that would leave the card face empty.
    expect(buildAchievementPatch({ title: "", description: "   ", hidden: false })).toEqual({
      title: null,
      description: null,
      hidden: false,
    });
  });

  it("lets one field be overridden while the other resets to default", () => {
    expect(buildAchievementPatch({ title: "Renamed", description: "", hidden: false })).toEqual({
      title: "Renamed",
      description: null,
      hidden: false,
    });
  });
});

describe("resetAchievementPatch", () => {
  it("clears both text overrides and un-hides", () => {
    // The server deletes the now-all-default row, reverting the card to its
    // shipped title/description and returning it to the main collection.
    expect(resetAchievementPatch()).toEqual({ title: null, description: null, hidden: false });
  });
});

describe("partitionAchievements", () => {
  const a = { key: "a", hidden: false };
  const b = { key: "b", hidden: true };
  const c = { key: "c", hidden: false };
  const d = { key: "d", hidden: true };

  it("splits hidden cards out of the main collection, preserving order in each bucket", () => {
    const { visible, hidden } = partitionAchievements([a, b, c, d]);
    expect(visible).toEqual([a, c]);
    expect(hidden).toEqual([b, d]);
  });

  it("returns an empty hidden bucket when nothing is hidden", () => {
    const { visible, hidden } = partitionAchievements([a, c]);
    expect(visible).toEqual([a, c]);
    expect(hidden).toEqual([]);
  });

  it("returns an empty visible bucket when everything is hidden", () => {
    const { visible, hidden } = partitionAchievements([b, d]);
    expect(visible).toEqual([]);
    expect(hidden).toEqual([b, d]);
  });
});
