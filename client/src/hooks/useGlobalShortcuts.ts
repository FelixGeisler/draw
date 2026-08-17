import { useEffect, useRef } from "react";
import { globalKeyInert, isPaletteChord, isSpaceActivationTarget } from "../lib/keyScope";

/**
 * The ONE global keydown listener (#243, ADR-68). Every decision that can be
 * data-in/data-out lives in lib/keyScope (inertness) and lib/paletteNav
 * (commands) with unit specs; this hook only reads the event and dispatches.
 *
 * Two tiers of key:
 * - The palette CHORD (Ctrl+K, or Cmd+K on a Mac — isPaletteChord) is exempt
 *   from the typing rule: it must toggle the palette even while typing in an
 *   input. preventDefault always — Ctrl+K is a browser key (search-box focus
 *   in Chrome/Firefox). It is NOT exempt from foreign overlays: the palette's
 *   togglePalette refuses to open under a focus/victory session (z 85 < 90 —
 *   an invisible dialog must never steal focus).
 * - The single keys (n / d / space / ?) are inert while typing in any form
 *   control or contenteditable, during IME composition, and while any modal
 *   is open. "Any modal" is read off the `inert` attribute useModalFocus
 *   puts on #root — every current and future dialog opts in by construction,
 *   no overlay registry to maintain. Space additionally yields to a focused
 *   button/link (isSpaceActivationTarget): it is their native activation key.
 */

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform);

export interface GlobalShortcutHandlers {
  togglePalette: () => void;
  openSheet: () => void;
  capture: () => void;
  gotoDraw: () => void;
  /**
   * Returns whether anything could actually toggle (a running timer or a
   * current draw). false keeps space's browser default — page scroll — so an
   * idle deck never eats the key for nothing.
   */
  toggleTimer: () => boolean;
}

export function useGlobalShortcuts(handlers: GlobalShortcutHandlers) {
  // Re-registering the window listener per render would drop keys mid-press;
  // a ref keeps one listener reading the latest closures.
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.repeat) return;
      if (isPaletteChord(e, IS_MAC)) {
        e.preventDefault();
        ref.current.togglePalette();
        return;
      }
      // A modified letter is somebody else's shortcut (Ctrl+N: new window).
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      const targetInfo = target
        ? {
            tagName: target.tagName,
            isContentEditable: target instanceof HTMLElement && target.isContentEditable,
            role: target.getAttribute("role"),
          }
        : null;
      const inert = globalKeyInert({
        target: targetInfo,
        isComposing: e.isComposing,
        overlayOpen: document.getElementById("root")?.hasAttribute("inert") ?? false,
      });
      if (inert) return;
      switch (e.key) {
        case "n":
          e.preventDefault();
          ref.current.capture();
          break;
        case "d":
          e.preventDefault();
          ref.current.gotoDraw();
          break;
        case " ":
          // A focused button/link owns its space key (native activation).
          if (isSpaceActivationTarget(targetInfo)) break;
          if (ref.current.toggleTimer()) e.preventDefault();
          break;
        case "?":
          e.preventDefault();
          ref.current.openSheet();
          break;
      }
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, []);
}
