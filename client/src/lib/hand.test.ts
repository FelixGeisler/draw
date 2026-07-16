import { describe, expect, it } from "vitest";
import { handCardState, handEffortMinutes } from "./hand";

// The daily hand's client-side rules (#59, ADR-34). handCardState carries the
// #88 commitment line into the strip: one card on the table, and no playing
// over it.

describe("handCardState", () => {
  it("the current draw's card is in play — never offered again", () => {
    expect(handCardState(7, 7, false)).toBe("in-play");
    // Even if the deck were somehow reported idle, identity wins: a card that
    // IS the current draw is on the table, not a fresh play.
    expect(handCardState(7, 7, true)).toBe("in-play");
  });

  it("an idle deck makes every other card playable", () => {
    expect(handCardState(1, null, true)).toBe("playable");
    expect(handCardState(1, 2, true)).toBe("playable");
  });

  it("locks the rest while a card is on the table — playing would be a re-roll (#88)", () => {
    // The server 409s on exactly this; the strip must not offer it first.
    expect(handCardState(1, 2, false)).toBe("locked");
  });

  it("locks even with no current draw when the deck is not idle (mid-shuffle)", () => {
    // The DrawPage reports deckIdle=false while shuffling, before the pointer
    // lands: a click through the animation must not race the reveal.
    expect(handCardState(1, null, false)).toBe("locked");
  });

  it("never returns 'playable' for two different cards at once, for any deck state", () => {
    // The invariant behind the rule: with a card on the table, nothing else
    // is playable — whatever the ids.
    const hand = [1, 2, 3];
    for (const current of [null, 1, 2, 3]) {
      for (const idle of [true, false]) {
        const playable = hand.filter((id) => handCardState(id, current, idle) === "playable");
        if (current != null) expect(playable).toEqual(idle ? hand.filter((i) => i !== current) : []);
      }
    }
  });
});

describe("handEffortMinutes", () => {
  it("sums the estimates of what is still in the hand", () => {
    expect(handEffortMinutes([{ effortMinutes: 20 }, { effortMinutes: 25 }, { effortMinutes: 30 }])).toBe(75);
  });

  it("an empty hand is zero minutes — a played-out plan, not a crash", () => {
    expect(handEffortMinutes([])).toBe(0);
  });

  it("tolerates a card whose estimate was cleared after the deal", () => {
    // It is pruned on the next read; until then it must not poison the total
    // with a NaN.
    expect(handEffortMinutes([{ effortMinutes: 20 }, { effortMinutes: null }])).toBe(20);
  });
});
