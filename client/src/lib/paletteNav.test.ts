import { describe, expect, it } from "vitest";
import {
  commandForEntry,
  moveSelection,
  timerToggleCommand,
  type PaletteEntry,
} from "./paletteNav";

// #243 command palette: ArrowUp/ArrowDown/Enter/Ctrl+Enter semantics as pure
// functions. The CommandPalette component only forwards events here, so these
// tests ARE the keyboard contract the E2E spec then proves end to end.
describe("moveSelection", () => {
  it("an empty list has no selection, whatever the input", () => {
    expect(moveSelection(0, -1, 1)).toBe(-1);
    expect(moveSelection(0, 0, 1)).toBe(-1);
    expect(moveSelection(0, 3, -1)).toBe(-1);
  });

  it("enters the list at the near end from 'nothing selected'", () => {
    expect(moveSelection(3, -1, 1)).toBe(0); // ArrowDown → first
    expect(moveSelection(3, -1, -1)).toBe(2); // ArrowUp → last
  });

  it("moves within the list", () => {
    expect(moveSelection(3, 0, 1)).toBe(1);
    expect(moveSelection(3, 1, 1)).toBe(2);
    expect(moveSelection(3, 2, -1)).toBe(1);
  });

  it("wraps at both ends", () => {
    expect(moveSelection(3, 2, 1)).toBe(0);
    expect(moveSelection(3, 0, -1)).toBe(2);
  });

  it("a single-entry list always lands on that entry", () => {
    // Load-bearing for the E2E spec: with exactly one result, ArrowDown
    // selects it whether or not something was selected before.
    expect(moveSelection(1, -1, 1)).toBe(0);
    expect(moveSelection(1, 0, 1)).toBe(0);
    expect(moveSelection(1, 0, -1)).toBe(0);
  });

  it("an out-of-range index (results shrank under the cursor) re-enters at the near end", () => {
    expect(moveSelection(2, 5, 1)).toBe(0);
    expect(moveSelection(2, 5, -1)).toBe(1);
  });
});

describe("commandForEntry", () => {
  const openTask: PaletteEntry = { kind: "task", id: 7, status: "open" };
  const doneTask: PaletteEntry = { kind: "task", id: 9, status: "done" };
  const goal: PaletteEntry = { kind: "goal", id: 4 };

  it("Enter on an open task opens it on /tasks without touching 'show done'", () => {
    expect(commandForEntry(openTask, false)).toEqual({
      type: "open-task",
      taskId: 7,
      showDone: false,
    });
  });

  it("Enter on a done task opens it with 'show done' enabled", () => {
    expect(commandForEntry(doneTask, false)).toEqual({
      type: "open-task",
      taskId: 9,
      showDone: true,
    });
  });

  it("Ctrl+Enter on an open task starts its timer", () => {
    expect(commandForEntry(openTask, true)).toEqual({ type: "start-task-timer", taskId: 7 });
  });

  it("Ctrl+Enter on a done task falls back to opening it (the server 409s a done start)", () => {
    expect(commandForEntry(doneTask, true)).toEqual({
      type: "open-task",
      taskId: 9,
      showDone: true,
    });
  });

  it("Enter on a goal opens /goals; Ctrl changes nothing for goals", () => {
    expect(commandForEntry(goal, false)).toEqual({ type: "open-goal", goalId: 4 });
    expect(commandForEntry(goal, true)).toEqual({ type: "open-goal", goalId: 4 });
  });

  it("actions map to their commands; Ctrl changes nothing for actions", () => {
    const cases: [PaletteEntry, ReturnType<typeof commandForEntry>][] = [
      // 'draw' navigates and focuses the deck — it must NEVER deal a card
      // (a draw is a commitment; see the #243 ADR).
      [{ kind: "action", action: "draw" }, { type: "goto-draw" }],
      [{ kind: "action", action: "capture" }, { type: "capture" }],
      [{ kind: "action", action: "toggle-timer" }, { type: "toggle-timer" }],
      [{ kind: "action", action: "goto-goals" }, { type: "navigate", to: "/goals" }],
      [{ kind: "action", action: "goto-stats" }, { type: "navigate", to: "/stats" }],
      [{ kind: "action", action: "goto-settings" }, { type: "navigate", to: "/settings" }],
    ];
    for (const [entry, command] of cases) {
      expect(commandForEntry(entry, false)).toEqual(command);
      expect(commandForEntry(entry, true)).toEqual(command);
    }
  });
});

describe("timerToggleCommand", () => {
  it("a running timer is stopped — running wins over a persisted draw", () => {
    expect(timerToggleCommand(7, null)).toEqual({ type: "stop-timer" });
    expect(timerToggleCommand(7, 9)).toEqual({ type: "stop-timer" });
  });

  it("no timer but a persisted current draw → start the drawn task's timer", () => {
    expect(timerToggleCommand(null, 9)).toEqual({ type: "start-task-timer", taskId: 9 });
  });

  it("neither running timer nor current draw → no-op, never a gamble or an error", () => {
    expect(timerToggleCommand(null, null)).toEqual({ type: "none" });
  });
});
