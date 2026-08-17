// #243 command palette — the key-inertness predicate for the GLOBAL
// single-key shortcuts (n / d / space / ?). Pure data-in/data-out: the client
// unit suite has no DOM, so callers summarize the keyboard event's target
// instead of passing the element itself. The colocated spec (keyScope.test.ts)
// is the contract. Wire-up (reading event.target / isComposing / overlay state
// and calling these) lives in the useGlobalShortcuts hook.

/** Plain summary of a keydown's target — what the predicate needs, no DOM. */
export interface KeyTargetInfo {
  /** DOM tagName. Uppercase from real elements, but matched case-insensitively. */
  tagName?: string;
  /** HTMLElement.isContentEditable — true anywhere inside a contenteditable region. */
  isContentEditable?: boolean;
  /** The element's role attribute, for ARIA-button widgets. */
  role?: string | null;
}

export interface GlobalKeyContext {
  target: KeyTargetInfo | null | undefined;
  /** KeyboardEvent.isComposing — an IME composition session is in progress. */
  isComposing?: boolean;
  /** Any modal/overlay is open: palette, focus, victory, shortcut sheet. */
  overlayOpen?: boolean;
}

/**
 * True when the target is a form control or editable region: input, textarea,
 * select, or contenteditable. Single-letter shortcuts must never fire there.
 */
export function isEditableTarget(target: KeyTargetInfo | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * True when Space belongs to the focused element, not the global timer
 * shortcut: button, link, summary, or an ARIA button. Space is the standard
 * activation key for a focused button — firing the timer there would both
 * hijack the timer AND (via preventDefault) cancel the activation the
 * keyboard user meant. Only space needs this carve-out; the letters (n/d/?)
 * have no native meaning on a focused button and stay live, matching
 * GitHub/Linear-style shortcut scoping.
 */
export function isSpaceActivationTarget(target: KeyTargetInfo | null | undefined): boolean {
  if (!target) return false;
  const tag = target.tagName?.toUpperCase();
  if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY") return true;
  return target.role?.toLowerCase() === "button";
}

/**
 * True when the global single-key shortcuts must do NOTHING: editable target,
 * IME composition in progress, or any modal/overlay open.
 */
export function globalKeyInert(ctx: GlobalKeyContext): boolean {
  return Boolean(ctx.isComposing) || Boolean(ctx.overlayOpen) || isEditableTarget(ctx.target);
}

/** The modifier bits of a keydown, platform-independently summarized. */
export interface ChordInfo {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The palette chord: Cmd+K on macOS, Ctrl+K everywhere else — never both
 * interchangeably. On a Mac, Ctrl+K is the system-wide kill-to-end-of-line
 * editing command in every text field, so capturing it would break native
 * editing (the VS Code/Slack convention is metaKey-only there). Shift and
 * Alt disqualify: Ctrl+Shift+K is the Firefox web console, and AltGr
 * (Ctrl+Alt) is how European layouts type plain characters.
 */
export function isPaletteChord(e: ChordInfo, isMac: boolean): boolean {
  if (e.altKey || e.shiftKey) return false;
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && e.key.toLowerCase() === "k";
}
