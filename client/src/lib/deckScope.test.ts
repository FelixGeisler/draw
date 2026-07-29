import { describe, expect, it } from "vitest";
import { DECK_SCOPE_KEY, resolveDeckScope, serializeDeckScope } from "./deckScope";

// Work mode (#214): the stored deck scope is one category id, remembered per
// device. These pin the resolution rules — the interesting ones are all about
// refusing to leave the app filtered to a category that is not there.

describe("resolveDeckScope", () => {
  const KNOWN = [1, 2, 3];

  it("resolves a stored id that still exists", () => {
    expect(resolveDeckScope("2", KNOWN)).toBe(2);
  });

  it("treats nothing stored as the whole deck", () => {
    expect(resolveDeckScope(null, KNOWN)).toBeUndefined();
    expect(resolveDeckScope("", KNOWN)).toBeUndefined();
  });

  it("drops an id whose category is gone", () => {
    // Deleting a category from Settings must not leave the app filtered to
    // nothing, with no chip left to click off.
    expect(resolveDeckScope("99", KNOWN)).toBeUndefined();
  });

  it("keeps the scope while the category list is still loading", () => {
    // An empty list is "not fetched yet", not "no categories exist" — pruning
    // against it would drop a valid scope on every single reload.
    expect(resolveDeckScope("2", [])).toBe(2);
  });

  it("rejects anything that is not a positive integer id", () => {
    for (const raw of ["abc", "0", "-1", "1.5", "NaN", " ", "[]", "{}"]) {
      expect(resolveDeckScope(raw, KNOWN)).toBeUndefined();
    }
  });
});

describe("serializeDeckScope", () => {
  it("round-trips an id", () => {
    expect(resolveDeckScope(serializeDeckScope(3), [1, 2, 3])).toBe(3);
  });

  it("returns null for the whole deck, so the key is removed rather than set to a string", () => {
    // Storing "undefined" would come back as an unparseable value forever.
    expect(serializeDeckScope(undefined)).toBeNull();
  });
});

describe("DECK_SCOPE_KEY", () => {
  it("is namespaced, since localStorage is shared with anything else on the origin", () => {
    expect(DECK_SCOPE_KEY).toBe("draw.deckScope");
  });
});
