/**
 * Shared deck-eligibility test vectors (issue #19, ADR-17; issue #23, ADR-18).
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

/**
 * Availability-window spec relative to "now" (#33, ADR-20). Windows are
 * evaluated on the LOCAL wall clock, but the vectors must be deterministic in
 * every timezone the suites run in — so instead of fixed weekdays and times,
 * a vector carries offsets that both suites materialize against the same
 * instant with `materializeWindow()`.
 */
export interface WindowSpec {
  /** Day offsets from now's local weekday (0 = same day, 1 = tomorrow, …). */
  dayOffsets: number[];
  /** Start/end as minute offsets from now's local time-of-day, clamped to [0, 1440]. */
  startOffsetMinutes: number;
  endOffsetMinutes: number;
}

/** A window that contains `now` on any machine (today, ±60 minutes, clamped). */
export const IN_WINDOW: WindowSpec = { dayOffsets: [0], startOffsetMinutes: -60, endOffsetMinutes: 60 };
/** A window on a different weekday — always excludes `now`, and always valid (end > start). */
export const OUT_OF_WINDOW: WindowSpec = { dayOffsets: [1], startOffsetMinutes: -60, endOffsetMinutes: 60 };

export function materializeWindow(
  spec: WindowSpec,
  now: Date,
): { windowDays: number[]; windowStart: string; windowEnd: string } {
  const windowDays = [...new Set(spec.dayOffsets.map((o) => (now.getDay() + o + 7) % 7))].sort(
    (a, b) => a - b,
  );
  const minutes = now.getHours() * 60 + now.getMinutes();
  const clamp = (m: number) => Math.max(0, Math.min(1440, m));
  const fmt = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; // 1440 → "24:00"
  return {
    windowDays,
    windowStart: fmt(clamp(minutes + spec.startOffsetMinutes)),
    windowEnd: fmt(clamp(minutes + spec.endOffsetMinutes)),
  };
}

export interface DrawableVector {
  name: string;
  hasOpenChildren: 0 | 1;
  /**
   * Parent lifecycle (#111, ADR-32): ANY non-archived child — done ones
   * included — keeps a parent out of the deck; only archived-out or
   * moved-away children revive it as a leaf. Optional: absent means "same as
   * hasOpenChildren" (an open child is non-archived by definition, and the
   * pre-#111 vectors never modeled done children). Both suites materialize
   * it with `?? hasOpenChildren`.
   */
  hasNonArchivedChildren?: 0 | 1;
  blocked: boolean;
  deferredUntil: string | null;
  /**
   * Sequential hold-back (#23, ADR-18): an older open sibling under a
   * 'sequential' parent. Derived in SQL on the server (`heldBackSql`),
   * delivered to the client as the 0/1 `heldBack` task field.
   */
  heldBack: 0 | 1;
  /** Availability window (#33, ADR-20); absent = no window. */
  window?: WindowSpec;
  /**
   * Recurrence schedule (#205, ADR-6 amended): `dueDate` is the task's next
   * occurrence, and a RECURRING task sleeps until that day — a non-recurring
   * one stays drawable however far off its due date is. Absent = neither
   * field set. Dates are compared on the LOCAL calendar day, so the vectors
   * below sit whole days away from VECTOR_NOW (or on it, where every offset
   * from UTC-12 to UTC+14 still reads them as arrived): the expectations hold
   * in every timezone the two suites may run in.
   */
  recurEveryDays?: number | null;
  dueDate?: string | null;
  effortMinutes: number | null;
  maxEffort: number;
  /** classifyTask group; the task is in the deck iff this is "ready". */
  expected: "ready" | "needs-estimate" | "too-big" | "container" | "snoozed" | "queued" | "scheduled";
}

export const DRAWABLE_VECTORS: DrawableVector[] = [
  {
    name: "estimated open leaf within the limit is ready",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    effortMinutes: 20,
    maxEffort: 30,
    expected: "ready",
  },
  {
    name: "effort exactly at the limit stays in the deck (boundary)",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    effortMinutes: 30,
    maxEffort: 30,
    expected: "ready",
  },
  {
    name: "one minute over the limit is too big",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    effortMinutes: 31,
    maxEffort: 30,
    expected: "too-big",
  },
  {
    name: "no estimate keeps the task out of the deck",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    effortMinutes: null,
    maxEffort: 30,
    expected: "needs-estimate",
  },
  {
    name: "open children make a container regardless of effort",
    hasOpenChildren: 1,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "container",
  },
  {
    name: "a blocked task is snoozed indefinitely",
    hasOpenChildren: 0,
    blocked: true,
    deferredUntil: null,
    heldBack: 0,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "snoozed",
  },
  {
    name: "deferredUntil in the future snoozes the task",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: "2026-07-14T13:00:00.000Z",
    heldBack: 0,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "snoozed",
  },
  {
    name: "an expired deferredUntil re-enters the deck with no write",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: "2026-07-14T11:00:00.000Z",
    heldBack: 0,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "ready",
  },
  {
    name: "deferredUntil exactly now counts as woken (boundary)",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: "2026-07-14T12:00:00.000Z",
    heldBack: 0,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "ready",
  },
  {
    name: "blocked wins over a missing estimate (precedence)",
    hasOpenChildren: 0,
    blocked: true,
    deferredUntil: null,
    heldBack: 0,
    effortMinutes: null,
    maxEffort: 30,
    expected: "snoozed",
  },
  {
    name: "a future snooze wins over an oversized estimate (precedence)",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: "2026-08-01T00:00:00.000Z",
    heldBack: 0,
    effortMinutes: 99,
    maxEffort: 30,
    expected: "snoozed",
  },
  {
    name: "container wins over blocked (precedence)",
    hasOpenChildren: 1,
    blocked: true,
    deferredUntil: null,
    heldBack: 0,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "container",
  },
  {
    name: "an expired snooze does not shield an oversized task",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: "2026-07-13T12:00:00.000Z",
    heldBack: 0,
    effortMinutes: 45,
    maxEffort: 30,
    expected: "too-big",
  },
  {
    name: "blocked alone suffices even when the snooze already expired",
    hasOpenChildren: 0,
    blocked: true,
    deferredUntil: "2026-07-14T11:00:00.000Z",
    heldBack: 0,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "snoozed",
  },
  {
    name: "a custom draw limit is respected",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    effortMinutes: 45,
    maxEffort: 60,
    expected: "ready",
  },
  // --- Sequential hold-back (#23, ADR-18). Precedence:
  // container → snoozed → queued → needs-estimate → too-big → ready.
  {
    name: "a held-back sequential sibling is queued, not ready",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 1,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "queued",
  },
  {
    name: "blocked wins over queued — an explicit snooze outranks the derived queue position",
    hasOpenChildren: 0,
    blocked: true,
    deferredUntil: null,
    heldBack: 1,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "snoozed",
  },
  {
    name: "a future snooze on a held-back sibling still shows snoozed (precedence)",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: "2026-07-14T13:00:00.000Z",
    heldBack: 1,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "snoozed",
  },
  {
    name: "queued wins over a missing estimate — estimating can wait until it surfaces",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 1,
    effortMinutes: null,
    maxEffort: 30,
    expected: "queued",
  },
  {
    name: "queued wins over an oversized estimate (precedence)",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 1,
    effortMinutes: 99,
    maxEffort: 30,
    expected: "queued",
  },
  {
    name: "container wins over queued (precedence)",
    hasOpenChildren: 1,
    blocked: false,
    deferredUntil: null,
    heldBack: 1,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "container",
  },
  {
    name: "an expired snooze on a held-back sibling leaves it queued, not ready",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: "2026-07-14T11:00:00.000Z",
    heldBack: 1,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "queued",
  },
  // --- Availability windows (#33, ADR-20). Precedence:
  // container → snoozed → queued → scheduled → needs-estimate → too-big → ready.
  {
    name: "a task inside its availability window stays ready",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    window: IN_WINDOW,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "ready",
  },
  {
    name: "a task outside its window is scheduled, not ready",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    window: OUT_OF_WINDOW,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "scheduled",
  },
  {
    name: "scheduled wins over a missing estimate — estimating can wait for the window",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    window: OUT_OF_WINDOW,
    effortMinutes: null,
    maxEffort: 30,
    expected: "scheduled",
  },
  {
    name: "scheduled wins over an oversized estimate (precedence)",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    window: OUT_OF_WINDOW,
    effortMinutes: 99,
    maxEffort: 30,
    expected: "scheduled",
  },
  {
    name: "an in-window task over the limit is still too big — the window shields nothing",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    window: IN_WINDOW,
    effortMinutes: 99,
    maxEffort: 30,
    expected: "too-big",
  },
  {
    name: "blocked wins over scheduled — an explicit snooze outranks the schedule",
    hasOpenChildren: 0,
    blocked: true,
    deferredUntil: null,
    heldBack: 0,
    window: OUT_OF_WINDOW,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "snoozed",
  },
  {
    name: "a future snooze on an out-of-window card shows snoozed (precedence)",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: "2026-07-14T13:00:00.000Z",
    heldBack: 0,
    window: OUT_OF_WINDOW,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "snoozed",
  },
  {
    name: "queued wins over scheduled — a queued sibling outranks its schedule",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 1,
    window: OUT_OF_WINDOW,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "queued",
  },
  {
    name: "container wins over scheduled (precedence)",
    hasOpenChildren: 1,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    window: OUT_OF_WINDOW,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "container",
  },
  // --- Parent lifecycle (#111, ADR-32): the subtasks own the estimate for
  // as long as any non-archived one exists — even all-done.
  {
    name: "an all-done breakdown keeps the parent out of the deck — its own estimate stays inert",
    hasOpenChildren: 0,
    hasNonArchivedChildren: 1,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "container",
  },
  {
    name: "all children archived: the parent is a leaf again on its stored estimate",
    hasOpenChildren: 0,
    hasNonArchivedChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "ready",
  },
  // --- Recurrence schedule (#205, ADR-6 amended): a recurring task's due
  // date is its next occurrence and it sleeps until that day, joining the
  // "scheduled" group — the card returns on its own, the user did not snooze
  // it. Precedence is the window's: container → snoozed → queued →
  // scheduled → needs-estimate → too-big → ready.
  {
    name: "a recurring task whose next occurrence is still ahead is scheduled, not ready",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    recurEveryDays: 4,
    dueDate: "2026-08-01",
    effortMinutes: 10,
    maxEffort: 30,
    expected: "scheduled",
  },
  {
    name: "a recurring task due today is back in the deck (boundary)",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    recurEveryDays: 4,
    dueDate: "2026-07-14",
    effortMinutes: 10,
    maxEffort: 30,
    expected: "ready",
  },
  {
    name: "a recurring task past its occurrence stays drawable — a missed chore does not vanish",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    recurEveryDays: 4,
    dueDate: "2026-07-01",
    effortMinutes: 10,
    maxEffort: 30,
    expected: "ready",
  },
  {
    name: "a NON-recurring task with a future due date stays drawable — doing it early is the point",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    recurEveryDays: null,
    dueDate: "2026-08-01",
    effortMinutes: 10,
    maxEffort: 30,
    expected: "ready",
  },
  {
    name: "a recurring task with no due date has no schedule to wait for and stays drawable",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    recurEveryDays: 4,
    dueDate: null,
    effortMinutes: 10,
    maxEffort: 30,
    expected: "ready",
  },
  {
    name: "a sleeping recurring task over the limit is still scheduled (precedence)",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 0,
    recurEveryDays: 4,
    dueDate: "2026-08-01",
    effortMinutes: 99,
    maxEffort: 30,
    expected: "scheduled",
  },
  {
    name: "a snoozed sleeping recurring task shows snoozed — the explicit action outranks the schedule",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: "2026-07-14T13:00:00.000Z",
    heldBack: 0,
    recurEveryDays: 4,
    dueDate: "2026-08-01",
    effortMinutes: 10,
    maxEffort: 30,
    expected: "snoozed",
  },
  {
    name: "queued wins over the next occurrence — the queue explains the exclusion better",
    hasOpenChildren: 0,
    blocked: false,
    deferredUntil: null,
    heldBack: 1,
    recurEveryDays: 4,
    dueDate: "2026-08-01",
    effortMinutes: 10,
    maxEffort: 30,
    expected: "queued",
  },
];

// ---------------------------------------------------------------------------
// Availability-window predicate vectors (#33, ADR-20). The pure predicate
// exists twice by design, like the eligibility predicate above:
//   - server: `isWithinWindow()` in drawService.ts
//   - client: `isWithinWindow()` in client/src/lib/drawable.ts
// Windows are LOCAL wall-clock, so these vectors pin `now` as local date
// components (year, month 1–12, day, hour, minute) — deterministic in every
// timezone, unlike an ISO instant. 2026-07-12/13/14 are Sun/Mon/Tue.

export interface WindowPredicateVector {
  name: string;
  /** Local components for `new Date(y, m - 1, d, hh, mm)`. */
  now: [y: number, m: number, d: number, hh: number, mm: number];
  days: number[];
  start: string;
  end: string;
  expected: boolean;
}

export const WINDOW_VECTORS: WindowPredicateVector[] = [
  {
    name: "weekday in the set, time inside the range",
    now: [2026, 7, 13, 10, 0], // Mon 10:00
    days: [1, 2, 3, 4, 5],
    start: "08:00",
    end: "12:00",
    expected: true,
  },
  {
    name: "weekday outside the set keeps the task out even at a matching time",
    now: [2026, 7, 12, 10, 0], // Sun 10:00
    days: [1, 2, 3, 4, 5],
    start: "08:00",
    end: "12:00",
    expected: false,
  },
  {
    name: "start is inclusive",
    now: [2026, 7, 13, 8, 0],
    days: [1],
    start: "08:00",
    end: "12:00",
    expected: true,
  },
  {
    name: "one minute before start is outside",
    now: [2026, 7, 13, 7, 59],
    days: [1],
    start: "08:00",
    end: "12:00",
    expected: false,
  },
  {
    name: "end is exclusive",
    now: [2026, 7, 13, 12, 0],
    days: [1],
    start: "08:00",
    end: "12:00",
    expected: false,
  },
  {
    name: "the last minute before end is inside",
    now: [2026, 7, 13, 11, 59],
    days: [1],
    start: "08:00",
    end: "12:00",
    expected: true,
  },
  {
    name: "00:00–24:00 covers the first minute of the day",
    now: [2026, 7, 13, 0, 0],
    days: [1],
    start: "00:00",
    end: "24:00",
    expected: true,
  },
  {
    name: "00:00–24:00 covers the last minute of the day",
    now: [2026, 7, 13, 23, 59],
    days: [1],
    start: "00:00",
    end: "24:00",
    expected: true,
  },
  {
    // Weekday and time must be read off the SAME local instant: a Monday
    // 22:00–24:00 window does not leak into the small hours of Tuesday.
    name: "near midnight: local Tue 00:10 is outside a Mon 22:00–24:00 window",
    now: [2026, 7, 14, 0, 10], // Tue 00:10
    days: [1],
    start: "22:00",
    end: "24:00",
    expected: false,
  },
  {
    name: "near midnight: the same local Tue 00:10 is inside a Tue 00:00–01:00 window",
    now: [2026, 7, 14, 0, 10],
    days: [2],
    start: "00:00",
    end: "01:00",
    expected: true,
  },
];
