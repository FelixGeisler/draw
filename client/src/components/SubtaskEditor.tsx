import { useState } from "react";
import type { NewSubtask, Task } from "../api/types";

interface Row extends NewSubtask {
  key: number;
}

interface Props {
  maxEffort: number;
  /** Pre-set from the parent so re-opening the editor keeps the choice (#23). */
  initialOrderMode?: Task["subtaskOrderMode"];
  /**
   * Recurring × sequential guard (#66, ADR-23): the parent already has a
   * recurring subtask, so the API would reject a switch to 'do in order' —
   * the toggle is disabled with the reason instead of failing on accept.
   */
  sequentialLocked?: boolean;
  /**
   * Split-in-place variant (#108) — the same editor, not a second one:
   * `heading` replaces the breakdown title, `initialRows` pre-fill the
   * deterministic even split, `minRows` gates accept (a split needs >= 2
   * parts — one part is a rename), `requireMinutes` makes unestimated rows
   * not count (the split endpoint requires every part estimated), and
   * `hideOrderToggle` drops "Do in order" — parts join the parent's existing
   * mode, there is nothing to choose.
   */
  heading?: string;
  initialRows?: NewSubtask[];
  minRows?: number;
  requireMinutes?: boolean;
  hideOrderToggle?: boolean;
  acceptLabel?: (count: number) => string;
  onAccept: (
    subtasks: NewSubtask[],
    orderMode: Task["subtaskOrderMode"],
  ) => void | Promise<unknown>;
  onCancel: () => void;
}

let nextKey = 1;
const emptyRow = (): Row => ({ key: nextKey++, title: "", effortMinutes: null });

export function SubtaskEditor({
  maxEffort,
  initialOrderMode,
  sequentialLocked,
  heading,
  initialRows,
  minRows = 1,
  requireMinutes,
  hideOrderToggle,
  acceptLabel,
  onAccept,
  onCancel,
}: Props) {
  const [rows, setRows] = useState<Row[]>(() =>
    initialRows?.length
      ? initialRows.map((r) => ({ key: nextKey++, title: r.title, effortMinutes: r.effortMinutes ?? null }))
      : [emptyRow(), emptyRow()],
  );
  const [inOrder, setInOrder] = useState(initialOrderMode === "sequential");
  const [error, setError] = useState<string | null>(null);

  function update(key: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  const valid = rows.filter((r) => r.title.trim() && (!requireMinutes || r.effortMinutes != null));

  return (
    <div className="panel" style={{ marginTop: 8, display: "grid", gap: 8 }}>
      <strong>{heading ?? `Break it down (each step ≤ ${maxEffort} min)`}</strong>
      {rows.map((row) => (
        <div key={row.key} style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="Small, concrete step…"
            value={row.title}
            onChange={(e) => update(row.key, { title: e.target.value })}
            style={{ flex: 1 }}
          />
          <input
            type="number"
            min={1}
            max={maxEffort}
            placeholder="min"
            value={row.effortMinutes ?? ""}
            onChange={(e) =>
              update(row.key, { effortMinutes: e.target.value ? Number(e.target.value) : null })
            }
            style={{ width: 76 }}
          />
          <button onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}>✕</button>
        </div>
      ))}
      {!hideOrderToggle && (
        <label
          style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--text-dim)", fontSize: 13 }}
          title={
            sequentialLocked
              ? "Unavailable: a recurring subtask never closes and would gate the steps behind it forever — remove its ↻ recurrence first"
              : "Sequential mode: only the first open step enters the deck; the rest queue up behind it"
          }
        >
          <input
            type="checkbox"
            checked={inOrder}
            disabled={sequentialLocked}
            onChange={(e) => setInOrder(e.target.checked)}
          />
          Do in order — draw only the next open step
        </label>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setRows((rs) => [...rs, emptyRow()])}>+ Step</button>
        <span style={{ flex: 1 }} />
        <button onClick={onCancel}>Cancel</button>
        <button
          className="primary"
          disabled={valid.length < minRows}
          onClick={async () => {
            setError(null);
            try {
              // This is a plain button, not a form submit, so the inputs'
              // `step` validation never runs — round to the integer minutes
              // the API wants (#84); a cleared-to-0 field clamps to 1, like
              // the generate-tasks review's commitLeaves.
              await onAccept(
                valid.map(({ title, effortMinutes }) => ({
                  title: title.trim(),
                  effortMinutes:
                    effortMinutes == null ? null : Math.max(1, Math.round(effortMinutes)),
                })),
                inOrder ? "sequential" : "parallel",
              );
            } catch (e) {
              // Surface the rejection instead of letting it vanish — the
              // editor stays open with the rows kept for the user to correct.
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          {acceptLabel
            ? acceptLabel(valid.length)
            : `Add ${valid.length} subtask${valid.length === 1 ? "" : "s"}`}
        </button>
      </div>
      {error && (
        <div role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>
          {error}
        </div>
      )}
    </div>
  );
}
