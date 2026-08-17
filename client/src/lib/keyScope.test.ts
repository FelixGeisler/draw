import { describe, expect, it } from "vitest";
import { globalKeyInert, isEditableTarget } from "./keyScope";

// #243 command palette: the global single-key shortcuts (n/d/space/?) must be
// completely inert while the user is typing, composing via an IME, or inside
// any modal. These tests pin the predicate as pure data — the DOM wiring in
// useGlobalShortcuts merely feeds it.
describe("isEditableTarget", () => {
  it("input, textarea and select are editable", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
  });

  it("tagName matching is case-insensitive (defensive against non-HTML casings)", () => {
    expect(isEditableTarget({ tagName: "input" })).toBe(true);
    expect(isEditableTarget({ tagName: "Select" })).toBe(true);
  });

  it("contenteditable regions are editable regardless of tag", () => {
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "SPAN", isContentEditable: true })).toBe(true);
  });

  it("buttons, links, body and plain containers are not editable", () => {
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget({ tagName: "A" })).toBe(false);
    expect(isEditableTarget({ tagName: "BODY" })).toBe(false);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: false })).toBe(false);
  });

  it("a missing target (keydown on window/document) is not editable", () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
    expect(isEditableTarget({})).toBe(false);
  });
});

describe("globalKeyInert", () => {
  it("typing in a form control makes global keys inert", () => {
    expect(globalKeyInert({ target: { tagName: "INPUT" } })).toBe(true);
    expect(globalKeyInert({ target: { tagName: "TEXTAREA" } })).toBe(true);
    expect(globalKeyInert({ target: { tagName: "SELECT" } })).toBe(true);
    expect(globalKeyInert({ target: { tagName: "DIV", isContentEditable: true } })).toBe(true);
  });

  it("IME composition makes global keys inert even outside form controls", () => {
    // KeyboardEvent.isComposing — a composed sequence must never trigger keys.
    expect(globalKeyInert({ target: { tagName: "BODY" }, isComposing: true })).toBe(true);
  });

  it("an open modal/overlay makes global keys inert", () => {
    // Palette, focus overlay, victory overlay, shortcut sheet — each owns its
    // own keys while open; the globals must not fire underneath.
    expect(globalKeyInert({ target: { tagName: "BODY" }, overlayOpen: true })).toBe(true);
  });

  it("plain focus on the page leaves global keys live", () => {
    expect(globalKeyInert({ target: { tagName: "BODY" } })).toBe(false);
    expect(globalKeyInert({ target: { tagName: "BUTTON" } })).toBe(false);
    expect(globalKeyInert({ target: null })).toBe(false);
    expect(
      globalKeyInert({ target: { tagName: "DIV" }, isComposing: false, overlayOpen: false }),
    ).toBe(false);
  });

  it("stacked conditions stay inert (editable target during composition)", () => {
    expect(globalKeyInert({ target: { tagName: "INPUT" }, isComposing: true })).toBe(true);
    expect(globalKeyInert({ target: { tagName: "INPUT" }, overlayOpen: true })).toBe(true);
  });
});
