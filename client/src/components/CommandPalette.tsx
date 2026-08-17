import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useModalFocus } from "../hooks/useModalFocus";
import { useGlobalShortcuts } from "../hooks/useGlobalShortcuts";
import { useSearch } from "../hooks/useSearch";
import type { SearchGoal, SearchTask } from "../hooks/useSearch";
import { useCurrentTimer, useStartTimer, useStopTimer } from "../hooks/useTimer";
import { useCurrentDraw } from "../hooks/useDraw";
import {
  commandForEntry,
  moveSelection,
  timerToggleCommand,
  type PaletteAction,
  type PaletteCommand,
  type PaletteEntry,
} from "../lib/paletteNav";
import "./CommandPalette.css";

/**
 * Command palette + global shortcuts (#243, ADR-68). Mounted once in the app
 * shell (App.tsx, the AchievementToast "globally mounted, renders null until
 * triggered" pattern) so Ctrl+K reaches every page. All keyboard DECISIONS
 * are pure functions in lib/paletteNav and lib/keyScope; this file only wires
 * DOM events, TanStack Query and the router to them.
 */

/** The fixed actions: the empty-query list, and name-matched otherwise. The
 *  palette doubles as the shortcut discovery surface, so each action that has
 *  a global key wears it as its meta column. */
const ACTIONS: { action: PaletteAction; label: string; keyHint: string }[] = [
  { action: "draw", label: "Draw a card", keyHint: "d" },
  { action: "capture", label: "Capture a task", keyHint: "n" },
  { action: "toggle-timer", label: "Start/stop timer", keyHint: "space" },
  { action: "goto-goals", label: "Go to Goals", keyHint: "" },
  { action: "goto-stats", label: "Go to Stats", keyHint: "" },
  { action: "goto-settings", label: "Go to Settings", keyHint: "" },
];

/**
 * Focus an element that may not exist yet. Deferred by construction: a
 * command's target often mounts on the page the command just navigated to
 * (the capture form waits for categories), and the palette's own unmount
 * cleanup (useModalFocus) restores focus to the trigger — a synchronous
 * focus here would be stolen right back by that cleanup. 40 × 50 ms rides
 * out a cold page's data fetch; if the element never shows, nothing happens.
 */
function focusWhenPresent(selector: string, tries = 40) {
  window.setTimeout(() => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) el.focus();
    else if (tries > 1) focusWhenPresent(selector, tries - 1);
  }, 50);
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const navigate = useNavigate();
  // Space and the "Start/stop timer" action resolve against the two
  // server-persisted facts (lib/paletteNav.timerToggleCommand). Both queries
  // are already app-wide cadences: TimerBar holds ["timer"] alive, and
  // ["draw","current"] polls at the same 60 s the DrawPage uses.
  const timer = useCurrentTimer();
  const currentDraw = useCurrentDraw();
  const startTimer = useStartTimer();
  const stopTimer = useStopTimer();

  function runCommand(cmd: PaletteCommand): boolean {
    switch (cmd.type) {
      case "none":
        return false;
      case "navigate":
        navigate(cmd.to);
        return true;
      case "goto-draw":
        // Navigate and FOCUS the deck — never deal (ADR-68): a draw is a
        // commitment (#88), a stray keypress must not gamble for the user.
        navigate("/");
        focusWhenPresent(".draw-face.front");
        return true;
      case "capture":
        navigate("/tasks");
        focusWhenPresent('[data-testid="capture-form"] input');
        return true;
      case "toggle-timer":
        return runCommand(
          timerToggleCommand(timer.data?.task.id ?? null, currentDraw.data?.task.id ?? null),
        );
      case "stop-timer":
        stopTimer.mutate();
        return true;
      case "start-task-timer":
        startTimer.mutate(cmd.taskId);
        return true;
      case "open-task":
        // TasksPage consumes this router state: flips "show done" when
        // needed, scrolls the row into view and flashes it once.
        navigate("/tasks", { state: { focusTaskId: cmd.taskId, showDone: cmd.showDone } });
        return true;
      case "open-goal":
        navigate("/goals");
        return true;
    }
  }

  function execute(cmd: PaletteCommand) {
    setOpen(false);
    runCommand(cmd);
  }

  useGlobalShortcuts({
    togglePalette: () => {
      setSheetOpen(false);
      setOpen((o) => !o);
    },
    openSheet: () => setSheetOpen(true),
    capture: () => runCommand({ type: "capture" }),
    gotoDraw: () => runCommand({ type: "goto-draw" }),
    toggleTimer: () =>
      runCommand(
        timerToggleCommand(timer.data?.task.id ?? null, currentDraw.data?.task.id ?? null),
      ),
  });

  return (
    <>
      {open && <PaletteDialog onClose={() => setOpen(false)} onExecute={execute} />}
      {sheetOpen && <ShortcutSheet onClose={() => setSheetOpen(false)} />}
    </>
  );
}

/** One selectable row plus what its rendering needs beyond the entry. */
interface PaletteRow {
  entry: PaletteEntry;
  group: "action" | "task" | "goal";
  label: string;
  keyHint?: string;
  task?: SearchTask;
  goal?: SearchGoal;
}

const GROUP_LABEL = { action: "Actions", task: "Tasks", goal: "Goals" } as const;

function PaletteDialog({
  onClose,
  onExecute,
}: {
  onClose: () => void;
  onExecute: (cmd: PaletteCommand) => void;
}) {
  // Modal contract (useModalFocus): #root inert, focus restored to the
  // trigger on close. Escape is caller-owned — handled in onKeyDown below.
  const dialogRef = useModalFocus();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [index, setIndex] = useState(-1);

  // useModalFocus focused the dialog container; the input is the palette's
  // real entry point. Declared after useModalFocus, so it runs after.
  useEffect(() => inputRef.current?.focus(), []);

  // ~150 ms debounce before the server round-trip; the Actions group filters
  // on the raw query so it keeps up with every keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query), 150);
    return () => window.clearTimeout(t);
  }, [query]);

  const search = useSearch(debounced);

  const rows = useMemo<PaletteRow[]>(() => {
    const q = query.trim().toLowerCase();
    const out: PaletteRow[] = [];
    for (const a of ACTIONS) {
      if (q === "" || a.label.toLowerCase().includes(q)) {
        out.push({
          entry: { kind: "action", action: a.action },
          group: "action",
          label: a.label,
          keyHint: a.keyHint,
        });
      }
    }
    if (q !== "" && search.data) {
      for (const t of search.data.tasks) {
        out.push({
          entry: { kind: "task", id: t.id, status: t.status },
          group: "task",
          label: t.title,
          task: t,
        });
      }
      for (const g of search.data.goals) {
        out.push({ entry: { kind: "goal", id: g.id }, group: "goal", label: g.title, goal: g });
      }
    }
    return out;
  }, [query, search.data]);

  // A new query invalidates the cursor; moveSelection re-enters at the near
  // end on the next arrow key (its out-of-range contract).
  useEffect(() => setIndex(-1), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => moveSelection(rows.length, i, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => moveSelection(rows.length, i, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[index];
      if (row) onExecute(commandForEntry(row.entry, e.ctrlKey || e.metaKey));
    }
  }

  return createPortal(
    // Portal to document.body: outside #root so the root-level inert cannot
    // swallow the dialog itself (the FocusOverlay precedent).
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        className="palette"
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          data-testid="palette-input"
          className="palette-input"
          placeholder="Search tasks, goals, actions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div ref={listRef} className="palette-list" role="listbox" aria-label="Results">
          {rows.map((row, i) => {
            const header = i === 0 || rows[i - 1].group !== row.group;
            const key = `${row.group}:${row.entry.kind === "action" ? row.entry.action : row.entry.id}`;
            return (
              <Fragment key={key}>
                {header && <div className="palette-group">{GROUP_LABEL[row.group]}</div>}
                <div
                  data-testid="palette-result"
                  role="option"
                  aria-selected={i === index}
                  className={i === index ? "palette-row selected" : "palette-row"}
                  onClick={() => onExecute(commandForEntry(row.entry, false))}
                >
                  {row.task && (
                    <span
                      className="dot"
                      style={{ background: row.task.categoryColor }}
                      title={row.task.categoryName}
                    />
                  )}
                  {row.goal && <span aria-hidden="true">🎯</span>}
                  <span className="palette-label">{row.label}</span>
                  {/* Done tasks are included but visibly marked (#243). */}
                  {row.task?.status === "done" && <span className="palette-done">done</span>}
                  <span className="palette-meta">
                    {row.keyHint}
                    {row.task &&
                      [
                        row.task.goalTitle ?? "",
                        row.task.effortMinutes != null ? `${row.task.effortMinutes} min` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    {row.goal &&
                      `${row.goal.status} · ${row.goal.openTaskCount} open task${
                        row.goal.openTaskCount === 1 ? "" : "s"
                      }`}
                  </span>
                </div>
              </Fragment>
            );
          })}
          {query.trim() !== "" && rows.length === 0 && (
            <div className="palette-empty">Nothing matches</div>
          )}
        </div>
        <div className="palette-hint">
          ↑↓ move · Enter open · Ctrl+Enter start timer · Esc close
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Every global key, in one place — what "?" promises (#243). */
const SHORTCUTS: [string, string][] = [
  ["Ctrl+K", "Open or close the command palette"],
  ["n", "Capture a task — jumps to Tasks and focuses quick capture"],
  ["d", "Go to the Draw page — never deals a card"],
  ["Space", "Stop the running timer, or start one on the current card"],
  ["?", "This shortcut sheet"],
  ["Esc", "Close the palette or this sheet"],
];

function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const dialogRef = useModalFocus();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        data-testid="shortcut-sheet"
        className="palette shortcut-sheet"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="sheet-title">Keyboard shortcuts</h2>
        <dl className="sheet-list">
          {SHORTCUTS.map(([keys, what]) => (
            <Fragment key={keys}>
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{what}</dd>
            </Fragment>
          ))}
        </dl>
        <div className="palette-hint">Esc closes</div>
      </div>
    </div>,
    document.body,
  );
}
