import { describe, expect, it } from "vitest";
import { canonicalPositiveInteger, consumePushLanding } from "./pushLanding";

const location = (search: string, state: unknown = null, hash = "#place") => ({
  pathname: "/tasks",
  search,
  hash,
  state,
});

describe("Push durable landings", () => {
  it("accepts only canonical positive safe integers", () => {
    expect(canonicalPositiveInteger("1")).toBe(1);
    expect(canonicalPositiveInteger(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of ["", "0", "01", "+1", "-1", "1.0", "1e2", "9007199254740992", " 1"])
      expect(canonicalPositiveInteger(value)).toBeNull();
  });

  it("consumes task-owned keys while preserving unrelated raw order, hash and state", () => {
    const result = consumePushLanding(location(
      "?before=a%20b&focus=42&middle=x&showDone=1&after=z",
      { focusTaskId: 7, showDone: false, modal: "kept" },
    ), "task");
    expect(result).toEqual({
      destination: "/tasks?before=a%20b&middle=x&after=z#place",
      state: { modal: "kept" },
      focusId: 42,
      showDone: true,
      hadUrlFocus: true,
      consumed: true,
    });
  });

  it("gives every present URL focus precedence over palette state, including invalid input", () => {
    for (const search of [
      "?focus=0", "?focus=01", "?focus=%31", "?focus=1&focus=2", "?f%6Fcus=1",
      "?focus=1.0", "?focus=1e2", "?focus=%2B1", "?focus=9007199254740992",
    ]) {
      const result = consumePushLanding(location(search, { focusTaskId: 9, showDone: true }), "task");
      expect(result.focusId, search).toBeNull();
      expect(result.showDone, search).toBe(false);
      expect(result.destination, search).toBe("/tasks#place");
      expect(result.state, search).toBeNull();
    }
  });

  it("accepts showDone only once, literally, and only beside a valid focus", () => {
    expect(consumePushLanding(location("?focus=2&showDone=1"), "task").showDone).toBe(true);
    for (const search of [
      "?focus=2", "?focus=2&showDone=0", "?focus=2&showDone=%31",
      "?focus=2&showDone=1&showDone=1", "?showDone=1",
    ]) expect(consumePushLanding(location(search), "task").showDone, search).toBe(false);
  });

  it("uses and consumes palette fields only when the URL has no focus", () => {
    const result = consumePushLanding(location("?keep=1&showDone=1", {
      focusTaskId: 8,
      showDone: true,
      other: 3,
    }), "task");
    expect(result.focusId).toBe(8);
    expect(result.showDone).toBe(true);
    expect(result.destination).toBe("/tasks?keep=1#place");
    expect(result.state).toEqual({ other: 3 });
  });

  it("goals own only focus and leave showDone untouched", () => {
    const result = consumePushLanding({
      pathname: "/goals",
      search: "?showDone=1&focus=12&tail=yes",
      hash: "#goal",
      state: { focusGoalId: 2, overlay: true },
    }, "goal");
    expect(result.focusId).toBe(12);
    expect(result.destination).toBe("/goals?showDone=1&tail=yes#goal");
    expect(result.state).toEqual({ overlay: true });
  });

  it("does nothing when neither URL nor palette has an owned field", () => {
    const state = { untouched: true };
    expect(consumePushLanding(location("?x=1", state), "task")).toMatchObject({
      consumed: false,
      focusId: null,
      destination: "/tasks?x=1#place",
      state,
    });
  });
});
