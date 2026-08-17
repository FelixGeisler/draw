import { useEffect, useRef } from "react";
import { globalKeyInert } from "../lib/keyScope";

/**
 * The ONE global keydown listener (#243, ADR-68). Every decision that can be
 * data-in/data-out lives in lib/keyScope (inertness) and lib/paletteNav
 * (commands) with unit specs; this hook only reads the event and dispatches.
 *
 * Two tiers of key:
 * - Ctrl+K / Cmd+K is a CHORD and exempt from inertness: it must toggle the
 *   palette even while typing in an input. preventDefault always — Ctrl+K is
 *   a browser key (search-box focus in Chrome/Firefox).
 * - The single keys (n / d / space / ?) are inert while typing in any form
 *   control or contenteditable, during IME composition, and while any modal
 *   is open. "Any modal" is read off the `inert` attribute useModalFocus
 *   puts on #root — every current and future dialog opts in by construction,
 *   no overlay registry to maintain.
 */
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
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ref.current.togglePalette();
        return;
      }
      // A modified letter is somebody else's shortcut (Ctrl+N: new window).
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      const inert = globalKeyInert({
        target: target
          ? {
              tagName: target.tagName,
              isContentEditable: target instanceof HTMLElement && target.isContentEditable,
            }
          : null,
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
