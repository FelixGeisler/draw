import { describe, expect, it } from "vitest";
import { resolveDrawnCard } from "./drawnCard";
import { resolveDrawView } from "./focusView";

// The standing drawn card is derived from the server-persisted current draw
// (issue #110, extending ADR-29) — these tests pin the whole input matrix,
// each case named after the real flow it stands for.

const card = { id: 7, title: "drawn card" };
const other = { id: 8, title: "drawn from a second tab" };

describe("resolveDrawnCard", () => {
  it("shuffle animation keeps the card face-down, whatever the cache says", () => {
    expect(
      resolveDrawnCard({ shuffling: true, serverTask: card, sessionTask: card, editedOutOfDeck: false }),
    ).toBeNull();
    expect(
      resolveDrawnCard({ shuffling: true, serverTask: null, sessionTask: null, editedOutOfDeck: false }),
    ).toBeNull();
  });

  it("restore after reload (#25): the persisted draw IS the card, no session state needed", () => {
    expect(
      resolveDrawnCard({ shuffling: false, serverTask: card, sessionTask: null, editedOutOfDeck: false }),
    ).toBe(card);
  });

  it("the #110 bug: pointer cleared elsewhere → the card leaves, session snapshot or not", () => {
    // Completed from the TimerBar / Tasks page / MCP: the server pointer is
    // gone; the stale session snapshot must not keep the card standing.
    expect(
      resolveDrawnCard({ shuffling: false, serverTask: null, sessionTask: card, editedOutOfDeck: false }),
    ).toBeNull();
    expect(
      resolveDrawnCard({ shuffling: false, serverTask: null, sessionTask: null, editedOutOfDeck: false }),
    ).toBeNull();
  });

  it("replaced from another surface: the persisted draw outranks the session snapshot", () => {
    expect(
      resolveDrawnCard({ shuffling: false, serverTask: other, sessionTask: card, editedOutOfDeck: false }),
    ).toBe(other);
  });

  it("query not settled yet: the just-drawn response must not blank out", () => {
    expect(
      resolveDrawnCard({ shuffling: false, serverTask: undefined, sessionTask: card, editedOutOfDeck: false }),
    ).toBe(card);
    // ...and with nothing drawn either, the deck is idle.
    expect(
      resolveDrawnCard({ shuffling: false, serverTask: undefined, sessionTask: null, editedOutOfDeck: false }),
    ).toBeNull();
  });

  it("edited out of the deck (#88): the session holds the card past the lazily cleared pointer", () => {
    // The server clears the forfeited pointer on its next GET and returns
    // null — but the sanctioned escape keeps the card on screen with the
    // resolve hint until it is resolved on-page, never a hidden re-roll.
    expect(
      resolveDrawnCard({ shuffling: false, serverTask: null, sessionTask: card, editedOutOfDeck: true }),
    ).toBe(card);
    // Even a not-yet-refetched (stale) pointer does not override the hold:
    // the session's write-back is the newest truth for the held card.
    expect(
      resolveDrawnCard({ shuffling: false, serverTask: card, sessionTask: card, editedOutOfDeck: true }),
    ).toBe(card);
  });

  it("edited out of the deck but resolved on-page: nothing holds, the deck is idle", () => {
    expect(
      resolveDrawnCard({ shuffling: false, serverTask: null, sessionTask: null, editedOutOfDeck: true }),
    ).toBeNull();
  });

  it("composes with resolveDrawView: a card completed elsewhere collapses focus to idle", () => {
    // The overlay derives from the SAME resolved card — when the pointer
    // dies, the whole tower (card + focus) falls together, never a dead
    // overlay counting down over an already-completed task (ADR-29).
    const shown = resolveDrawnCard({
      shuffling: false,
      serverTask: null,
      sessionTask: card,
      editedOutOfDeck: false,
    });
    expect(resolveDrawView(shown?.id ?? null, card.id, false)).toBe("idle");
  });
});
