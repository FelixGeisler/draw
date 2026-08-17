// #243 command palette — the key-inertness predicate for the GLOBAL
// single-key shortcuts (n / d / space / ?). Pure data-in/data-out: the client
// unit suite has no DOM, so callers summarize the keyboard event's target
// instead of passing the element itself. The colocated spec (keyScope.test.ts)
// is the contract; these bodies are TEST-FIRST SKELETONS that land with the
// implementation. Wire-up (reading event.target / isComposing / overlay state
// and calling these) lives in the useGlobalShortcuts hook.

/** Plain summary of a keydown's target — what the predicate needs, no DOM. */
export interface KeyTargetInfo {
  /** DOM tagName. Uppercase from real elements, but matched case-insensitively. */
  tagName?: string;
  /** HTMLElement.isContentEditable — true anywhere inside a contenteditable region. */
  isContentEditable?: boolean;
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
  void target;
  throw new Error("TODO #243: implement isEditableTarget");
}

/**
 * True when the global single-key shortcuts must do NOTHING: editable target,
 * IME composition in progress, or any modal/overlay open.
 */
export function globalKeyInert(ctx: GlobalKeyContext): boolean {
  void ctx;
  throw new Error("TODO #243: implement globalKeyInert");
}
