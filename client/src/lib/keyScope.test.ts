import { describe, expect, it } from "vitest";
import {
  globalKeyInert,
  isEditableTarget,
  isPaletteChord,
  isSpaceActivationTarget,
} from "./keyScope";

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

// Space is the standard activation key for a focused button: the global
// timer toggle must yield there — otherwise pressing Space on a focused
// button both hijacks the timer and cancels the activation the user meant.
describe("isSpaceActivationTarget", () => {
  it("buttons, links, summary and ARIA buttons own their space key", () => {
    expect(isSpaceActivationTarget({ tagName: "BUTTON" })).toBe(true);
    expect(isSpaceActivationTarget({ tagName: "A" })).toBe(true);
    expect(isSpaceActivationTarget({ tagName: "SUMMARY" })).toBe(true);
    expect(isSpaceActivationTarget({ tagName: "DIV", role: "button" })).toBe(true);
  });

  it("body, plain containers and a missing target leave space to the shortcut", () => {
    expect(isSpaceActivationTarget({ tagName: "BODY" })).toBe(false);
    expect(isSpaceActivationTarget({ tagName: "DIV" })).toBe(false);
    expect(isSpaceActivationTarget({ tagName: "DIV", role: "listbox" })).toBe(false);
    expect(isSpaceActivationTarget(null)).toBe(false);
    expect(isSpaceActivationTarget(undefined)).toBe(false);
  });
});

// The palette chord is platform-split: Cmd+K on macOS (Ctrl+K there is the
// native kill-to-end-of-line editing command), Ctrl+K everywhere else.
describe("isPaletteChord", () => {
  const chord = (over: Partial<import("./keyScope").ChordInfo>) => ({
    key: "k",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });

  it("Ctrl+K matches on non-Mac; Cmd+K matches on Mac", () => {
    expect(isPaletteChord(chord({ ctrlKey: true }), false)).toBe(true);
    expect(isPaletteChord(chord({ metaKey: true }), true)).toBe(true);
  });

  it("on Mac, Ctrl+K stays the native kill-line command — never the palette", () => {
    expect(isPaletteChord(chord({ ctrlKey: true }), true)).toBe(false);
    expect(isPaletteChord(chord({ metaKey: true, ctrlKey: true }), true)).toBe(false);
  });

  it("Shift and Alt disqualify (Firefox devtools Ctrl+Shift+K, AltGr layouts)", () => {
    expect(isPaletteChord(chord({ ctrlKey: true, shiftKey: true, key: "K" }), false)).toBe(false);
    expect(isPaletteChord(chord({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isPaletteChord(chord({ metaKey: true, shiftKey: true, key: "K" }), true)).toBe(false);
  });

  it("uppercase K (CapsLock) still matches; other keys and a bare k never do", () => {
    expect(isPaletteChord(chord({ ctrlKey: true, key: "K" }), false)).toBe(true);
    expect(isPaletteChord(chord({ ctrlKey: true, key: "j" }), false)).toBe(false);
    expect(isPaletteChord(chord({}), false)).toBe(false);
    expect(isPaletteChord(chord({ metaKey: true }), false)).toBe(false);
  });
});
