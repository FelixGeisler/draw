import { describe, expect, it } from "vitest";
import { isAwaitingNextOccurrence, nextOccurrence } from "../../src/services/recurrence.js";

// Issue #205 (ADR-6 amended): a recurring task's due_date is its NEXT
// OCCURRENCE — completing schedules the following one, and the deck keeps the
// card out until that day arrives. Both halves live in one module because
// they are one invariant: what the completion writes is what the deck waits
// for, on the same (user-local) calendar.
//
// These cases only bite where the local and UTC days can differ, so the suite
// pins TZ=Europe/Berlin (server/vitest.config.ts) — GitHub runners are UTC,
// where both the DST bug and a UTC-anchored schedule look correct. The rules
// that must hold in EVERY zone pass `offsetMinutes` explicitly instead (the
// ADR-21 localDayOf pattern), so they are pinned twice over.

describe("the suite runs in the deployment timezone", () => {
  // Guard for the tests below: without the pin they would pass against the
  // very arithmetic they exist to reject. Berlin is +01:00 in winter,
  // +02:00 in summer.
  it("is Europe/Berlin, so local and UTC days can disagree", () => {
    expect(new Date("2026-07-14T12:00:00.000Z").getTimezoneOffset()).toBe(-120);
    expect(new Date("2026-01-14T12:00:00.000Z").getTimezoneOffset()).toBe(-60);
  });
});

describe("nextOccurrence", () => {
  it("advances the completion's calendar day by the interval", () => {
    expect(nextOccurrence(new Date("2026-07-26T10:00:00.000Z"), 4)).toBe("2026-07-30");
    expect(nextOccurrence(new Date("2026-07-26T10:00:00.000Z"), 1)).toBe("2026-07-27");
  });

  it("crosses month and year boundaries", () => {
    expect(nextOccurrence(new Date("2026-07-30T08:00:00.000Z"), 4)).toBe("2026-08-03");
    expect(nextOccurrence(new Date("2026-12-30T08:00:00.000Z"), 7)).toBe("2027-01-06");
  });

  it("counts from the USER'S day, not the UTC one, for a late-night completion", () => {
    // 00:30 local on 2026-07-15 in Berlin (UTC+2) — UTC still says the 14th.
    const lateNight = new Date("2026-07-14T22:30:00.000Z");
    // A daily chore done after midnight is due TOMORROW, not "today" — which
    // is what the UTC anchor wrote, putting the card back in the deck at
    // 02:00 the same night (the #205 symptom surviving).
    expect(nextOccurrence(lateNight, 1)).toBe("2026-07-16");
    expect(nextOccurrence(lateNight, 3)).toBe("2026-07-18");
    // Explicit offsets pin the same rule on any machine: at +13 (Pacific
    // summer) 11:30 UTC is already the next calendar day…
    expect(nextOccurrence(new Date("2026-07-14T11:30:00.000Z"), 1, 13 * 60)).toBe("2026-07-16");
    // …while the same instant is still the 14th at UTC and west of it.
    expect(nextOccurrence(new Date("2026-07-14T11:30:00.000Z"), 1, 0)).toBe("2026-07-15");
    expect(nextOccurrence(new Date("2026-07-14T11:30:00.000Z"), 1, -5 * 60)).toBe("2026-07-15");
  });

  it("keeps the interval whole across a DST transition", () => {
    // Berlin springs forward on 2026-03-29 (01:00 UTC). The pre-#205
    // arithmetic was `next.setDate(next.getDate() + n)` on a Date, formatted
    // with `toISOString()`: setDate preserves the LOCAL wall-clock time, so
    // the +1h shift pushed the instant back across UTC midnight and the due
    // date landed on 2026-04-01 — a day early. Date-only string math has no
    // wall clock to preserve.
    expect(nextOccurrence(new Date("2026-03-29T00:30:00.000Z"), 4)).toBe("2026-04-02");
    // Fall-back (2026-10-25, 01:00 UTC): 00:30 UTC is already the 25th
    // locally, and four days later is the 29th.
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

  it("wakes the card at the USER'S midnight, not UTC's", () => {
    // 00:30 local on the 27th in Berlin: a card due the 27th is available —
    // a UTC compare would keep it asleep for two more hours.
    const justAfterLocalMidnight = new Date("2026-07-26T22:30:00.000Z");
    expect(isAwaitingNextOccurrence(4, "2026-07-27", justAfterLocalMidnight)).toBe(false);
    // …and one due the 28th is still asleep at that moment.
    expect(isAwaitingNextOccurrence(4, "2026-07-28", justAfterLocalMidnight)).toBe(true);
    // The same instant judged from other zones (explicit offsets, so this
    // holds on any machine).
    expect(isAwaitingNextOccurrence(4, "2026-07-27", justAfterLocalMidnight, 0)).toBe(true);
    expect(isAwaitingNextOccurrence(4, "2026-07-27", justAfterLocalMidnight, 13 * 60)).toBe(false);
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

  it("agrees with nextOccurrence: a fresh completion always sleeps the full interval", () => {
    // The write and the read must never disagree — in any zone, at any hour,
    // including the late-night completion the UTC anchor got wrong: right
    // after completing, the card is out of the deck; it returns on the day
    // that was written, and not before.
    for (const offset of [-11 * 60, -5 * 60, 0, 2 * 60, 13 * 60]) {
      for (const iso of [
        "2026-07-26T12:00:00.000Z",
        "2026-07-26T22:30:00.000Z",
        "2026-07-26T00:10:00.000Z",
        "2026-03-29T00:30:00.000Z",
      ]) {
        const at = new Date(iso);
        const due = nextOccurrence(at, 4, offset);
        expect(isAwaitingNextOccurrence(4, due, at, offset)).toBe(true);
        // Noon of the occurrence day, in that same zone: back in the deck.
        const arrived = new Date(`${due}T12:00:00.000Z`);
        expect(isAwaitingNextOccurrence(4, due, arrived, offset)).toBe(false);
      }
    }
  });
});
