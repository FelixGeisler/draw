import { useEffect, useRef, type RefObject } from "react";

/**
 * Modal focus management (PR #105 review), shared by FocusOverlay and
 * VictoryOverlay: focus moves INTO the dialog on mount and back to the
 * trigger on exit, and the app root is `inert` while the dialog is open —
 * the caller's portal to document.body keeps the dialog itself outside the
 * inert subtree. That inerts the covered page for keyboard AND pointer, so
 * Tab cycles the dialog's own controls only instead of blindly operating
 * invisible background buttons. `inert` is baseline in every evergreen
 * browser (Chrome 102+, Firefox 112+, Safari 15.5+) — this local-first
 * app's whole target range.
 *
 * Escape handling stays with each caller: the two dialogs mean different
 * things by it ("leave the view, timer keeps running" vs "close the
 * celebration").
 *
 * `inert` is held by COUNT, not set/remove (#243 review): dialogs can
 * overlap for a commit (the shortcut sheet swapping into the palette), and
 * a naive removeAttribute from the first closer would hand the covered page
 * back to keyboard and pointer while the second dialog is still open.
 */
let inertHolders = 0;

export function useModalFocus(): RefObject<HTMLDivElement | null> {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    const root = document.getElementById("root");
    inertHolders += 1;
    root?.setAttribute("inert", "");
    dialogRef.current?.focus();
    return () => {
      inertHolders -= 1;
      // Un-inert BEFORE restoring — an inert element refuses focus.
      if (inertHolders === 0) root?.removeAttribute("inert");
      // The trigger may be gone by exit time (the action that opened the
      // dialog may have unmounted its own row); restoring is best-effort,
      // never a crash.
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return dialogRef;
}
