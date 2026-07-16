import { describe, expect, it } from "vitest";
import { heldCardResolved, resolveDrawnCard } from "./drawnCard";
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

  it("the #118 bug: the hold releases once the held card is resolved elsewhere", () => {
    // Deleted/completed from the TimerBar, the Tasks page, MCP or a second
    // tab: the pointer was already forfeit by the edit, so ONLY this verdict
    // can dismiss the card — without it the hold stood until a reload and
    // every on-page resolution 404'd.
    expect(
      resolveDrawnCard({
        shuffling: false,
        serverTask: null,
        sessionTask: card,
        editedOutOfDeck: true,
        heldCardResolved: true,
      }),
    ).toBeNull();
    // The hold still outranks a stale pointer while the card is unresolved.
    expect(
      resolveDrawnCard({
        shuffling: false,
        serverTask: null,
        sessionTask: card,
        editedOutOfDeck: true,
        heldCardResolved: false,
      }),
    ).toBe(card);
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

// Issue #118: the released-hold verdict. The held card forfeited its pointer,
// so the tasks list is the only server view left that can speak for it.
describe("heldCardResolved", () => {
  const open = { id: 7, status: "open" };
  const root = (subtasks: { id: number; status: string }[]) => ({
    id: 99,
    status: "open",
    subtasks,
  });

  it("still open in the list: unresolved — the #88 hold stands", () => {
    expect(heldCardResolved([open], 7)).toBe(false);
    // Held cards are typically open-but-too-big (the everyday out-of-deck
    // edit), so this is the case that must NOT release.
    expect(heldCardResolved([{ id: 1, status: "open" }, open], 7)).toBe(false);
  });

  it("gone from the list: deleted elsewhere — the stuck-card bug (#118)", () => {
    expect(heldCardResolved([], 7)).toBe(true);
    expect(heldCardResolved([{ id: 1, status: "open" }], 7)).toBe(true);
  });

  it("present but no longer open: completed or archived elsewhere", () => {
    expect(heldCardResolved([{ id: 7, status: "done" }], 7)).toBe(true);
    expect(heldCardResolved([{ id: 7, status: "archived" }], 7)).toBe(true);
  });

  it("a held SUBTASK is judged by its own row, not its root's", () => {
    // The drawn card can be a subtask: the list nests non-archived children
    // under their root, so the search must descend. The root here is open —
    // reading the root's status instead would never release.
    expect(heldCardResolved([root([{ id: 7, status: "open" }])], 7)).toBe(false);
    expect(heldCardResolved([root([{ id: 7, status: "done" }])], 7)).toBe(true);
    // Archived subtasks drop out of the nested list entirely → resolved.
    expect(heldCardResolved([root([{ id: 8, status: "open" }])], 7)).toBe(true);
  });

  it("query not settled: never a verdict — a hiccup must not drop the card", () => {
    // Releasing on a missing answer would be exactly the hidden re-roll #88
    // bans: the card would vanish on any transient fetch failure.
    expect(heldCardResolved(undefined, 7)).toBe(false);
  });
});
