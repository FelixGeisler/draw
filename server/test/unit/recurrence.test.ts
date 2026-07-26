import { describe, expect, it } from "vitest";
import { isAwaitingNextOccurrence, nextOccurrence } from "../../src/services/recurrence.js";

// Issue #205 (ADR-6 amended): a recurring task's due_date is its NEXT
// OCCURRENCE — completing schedules the following one, and the deck keeps the
// card out until that day arrives. Both halves live in one module because
// they are one invariant: what the completion writes is what the deck waits
// for, in the same (UTC) clock. Every expectation below is a fixed string, so
// this file is deterministic in any timezone.

describe("nextOccurrence", () => {
  it("advances the completion's UTC date by the interval", () => {
    expect(nextOccurrence(new Date("2026-07-26T10:00:00.000Z"), 4)).toBe("2026-07-30");
    expect(nextOccurrence(new Date("2026-07-26T10:00:00.000Z"), 1)).toBe("2026-07-27");
  });

  it("crosses month and year boundaries", () => {
    expect(nextOccurrence(new Date("2026-07-30T08:00:00.000Z"), 4)).toBe("2026-08-03");
    expect(nextOccurrence(new Date("2026-12-30T08:00:00.000Z"), 7)).toBe("2027-01-06");
  });

  it("uses the UTC date of a late-evening completion (23:5x boundary)", () => {
    expect(nextOccurrence(new Date("2026-07-31T23:55:00.000Z"), 4)).toBe("2026-08-04");
    expect(nextOccurrence(new Date("2026-07-31T00:05:00.000Z"), 4)).toBe("2026-08-04");
  });

  it("keeps the interval whole across a DST transition", () => {
    // Europe/Berlin springs forward on 2026-03-29 (01:00 UTC). The pre-#205
    // arithmetic was `next.setDate(next.getDate() + n)` on a Date, formatted
    // with `toISOString()`: setDate preserves the LOCAL wall-clock time, so
    // the +1h shift pushed the instant across UTC midnight backwards and the
    // due date landed on 2026-04-01 — a day early — on any machine running in
    // a spring-forward zone (verified with TZ=Europe/Berlin). Date-only UTC
    // string math has no wall clock to preserve, so the answer is the same
    // everywhere.
    expect(nextOccurrence(new Date("2026-03-29T00:30:00.000Z"), 4)).toBe("2026-04-02");
    // …and the same across the autumn fall-back (2026-10-25).
    expect(nextOccurrence(new Date("2026-10-25T00:30:00.000Z"), 4)).toBe("2026-10-29");
  });
});

describe("isAwaitingNextOccurrence", () => {
  const now = new Date("2026-07-26T12:00:00.000Z");

  it("keeps a recurring task out of the deck until its occurrence arrives", () => {
    expect(isAwaitingNextOccurrence(4, "2026-07-30", now)).toBe(true);
    expect(isAwaitingNextOccurrence(4, "2026-07-27", now)).toBe(true);
  });

  it("lets it back in on the due day and after (boundary)", () => {
    expect(isAwaitingNextOccurrence(4, "2026-07-26", now)).toBe(false);
    expect(isAwaitingNextOccurrence(4, "2026-07-25", now)).toBe(false);
  });

  it("never gates a NON-recurring task — doing something before it is due is the point", () => {
    expect(isAwaitingNextOccurrence(null, "2026-12-24", now)).toBe(false);
    expect(isAwaitingNextOccurrence(undefined, "2026-12-24", now)).toBe(false);
    expect(isAwaitingNextOccurrence(0, "2026-12-24", now)).toBe(false);
  });

  it("never gates a recurring task without a due date — there is no schedule to wait for", () => {
    expect(isAwaitingNextOccurrence(4, null, now)).toBe(false);
    expect(isAwaitingNextOccurrence(4, undefined, now)).toBe(false);
  });

  it("agrees with nextOccurrence: what a completion writes is what the deck waits for", () => {
    const due = nextOccurrence(now, 4);
    expect(isAwaitingNextOccurrence(4, due, now)).toBe(true);
    // The morning of the occurrence, the card is back — with no write.
    expect(isAwaitingNextOccurrence(4, due, new Date(`${due}T00:00:00.000Z`))).toBe(false);
  });
});
