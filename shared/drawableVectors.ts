/**
 * Shared deck-eligibility test vectors (issue #19, ADR-16).
 *
 * The drawable predicate exists twice by design (ADR-2 mirrors, one per tier):
 *   - server: `drawService.ts` candidate WHERE clause + `isRestorable()`
 *   - client: `classifyTask()` in `client/src/lib/drawable.ts`
 *
 * Both test suites run these exact vectors — `server/test/unit/drawable-vectors.test.ts`
 * and `client/src/lib/drawable.test.ts` — so a change to one side that is not
 * mirrored on the other fails a suite instead of drifting silently. This file
 * must stay dependency-free: it is imported across both workspaces (NodeNext
 * on the server, bundler resolution on the client).
 */

/** The fixed instant "now" that every vector's deferredUntil relates to. */
export const VECTOR_NOW = "2026-07-14T12:00:00.000Z";

export interface DrawableVector {
  name: string;
  hasOpenChildren: 0 | 1;
  blocked: boolean;
  deferredUntil: string | null;
  effortMinutes: number | null;
  maxEffort: number;
  /** classifyTask group; the task is in the deck iff this is "ready". */
  expected: "ready" | "needs-estimate" | "too-big" | "container" | "snoozed";
}

export const DRAWABLE_VECTORS: DrawableVector[] = [
  {
    name: "estimated open leaf within the limit is ready",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    effortMinutes: 20,
    maxEffort: 30,
    expected: "ready",
  },
  {
    name: "effort exactly at the limit stays in the deck (boundary)",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    effortMinutes: 30,
    maxEffort: 30,
    expected: "ready",
  },
  {
    name: "one minute over the limit is too big",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    effortMinutes: 31,
    maxEffort: 30,
    expected: "too-big",
  },
  {
    name: "no estimate keeps the task out of the deck",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    effortMinutes: null,
    maxEffort: 30,
    expected: "needs-estimate",
  },
  {
    name: "open children make a container regardless of effort",
    hasOpenChildren: 1,
    blocked: false,
    deferredUntil: null,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "container",
  },
  {
    name: "a blocked task is snoozed indefinitely",
    hasOpenChildren: 0,
    blocked: true,
    deferredUntil: null,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "snoozed",
  },
  {
    name: "deferredUntil in the future snoozes the task",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: "2026-07-14T13:00:00.000Z",
    effortMinutes: 10,
    maxEffort: 30,
    expected: "snoozed",
  },
  {
    name: "an expired deferredUntil re-enters the deck with no write",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: "2026-07-14T11:00:00.000Z",
    effortMinutes: 10,
    maxEffort: 30,
    expected: "ready",
  },
  {
    name: "deferredUntil exactly now counts as woken (boundary)",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: "2026-07-14T12:00:00.000Z",
    effortMinutes: 10,
    maxEffort: 30,
    expected: "ready",
  },
  {
    name: "blocked wins over a missing estimate (precedence)",
    hasOpenChildren: 0,
    blocked: true,
    deferredUntil: null,
    effortMinutes: null,
    maxEffort: 30,
    expected: "snoozed",
  },
  {
    name: "a future snooze wins over an oversized estimate (precedence)",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: "2026-08-01T00:00:00.000Z",
    effortMinutes: 99,
    maxEffort: 30,
    expected: "snoozed",
  },
  {
    name: "container wins over blocked (precedence)",
    hasOpenChildren: 1,
    blocked: true,
    deferredUntil: null,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "container",
  },
  {
    name: "an expired snooze does not shield an oversized task",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: "2026-07-13T12:00:00.000Z",
    effortMinutes: 45,
    maxEffort: 30,
    expected: "too-big",
  },
  {
    name: "blocked alone suffices even when the snooze already expired",
    hasOpenChildren: 0,
    blocked: true,
    deferredUntil: "2026-07-14T11:00:00.000Z",
    effortMinutes: 10,
    maxEffort: 30,
    expected: "snoozed",
  },
  {
    name: "a custom draw limit is respected",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    effortMinutes: 45,
    maxEffort: 60,
    expected: "ready",
  },
];
