import confetti from "canvas-confetti";

/**
 * The app-wide motion gate (#148): confetti is skipped ENTIRELY under
 * `prefers-reduced-motion: reduce` — the moment itself (dismissed card,
 * XP note, trophy, overlay) is the celebration then. Exported on its own
 * for choreographed call sites (VictoryOverlay's timed cannons) that must
 * decide once, up front, whether to schedule anything at all.
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Fire one confetti burst — unless the user asked for reduced motion.
 * Every celebration goes through here rather than importing canvas-confetti
 * directly, so no call site can forget the gate again (#148: the DrawPage
 * ✓ Done predated the convention and did exactly that).
 */
export function celebrate(options: confetti.Options): void {
  if (prefersReducedMotion()) return;
  confetti(options);
}
