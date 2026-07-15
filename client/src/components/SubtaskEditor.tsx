import { useState } from "react";
import type { NewSubtask, Task } from "../api/types";

interface Row extends NewSubtask {
  key: number;
}

interface Props {
  maxEffort: number;
  /** Pre-set from the parent so re-opening the editor keeps the choice (#23). */
  initialOrderMode?: Task["subtaskOrderMode"];
  onAccept: (
    subtasks: NewSubtask[],
    orderMode: Task["subtaskOrderMode"],
  ) => void | Promise<unknown>;
  onCancel: () => void;
}

let nextKey = 1;
const emptyRow = (): Row => ({ key: nextKey++, title: "", effortMinutes: null });

export function SubtaskEditor({ maxEffort, initialOrderMode, onAccept, onCancel }: Props) {
  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow()]);
  const [inOrder, setInOrder] = useState(initialOrderMode === "sequential");

  function update(key: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  const valid = rows.filter((r) => r.title.trim());

  return (
    <div className="panel" style={{ marginTop: 8, display: "grid", gap: 8 }}>
      <strong>Break it down (each step ≤ {maxEffort} min)</strong>
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
      <label
        style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--text-dim)", fontSize: 13 }}
        title="Sequential mode: only the first open step enters the deck; the rest queue up behind it"
      >
        <input type="checkbox" checked={inOrder} onChange={(e) => setInOrder(e.target.checked)} />
        Do in order — draw only the next open step
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setRows((rs) => [...rs, emptyRow()])}>+ Step</button>
        <span style={{ flex: 1 }} />
        <button onClick={onCancel}>Cancel</button>
        <button
          className="primary"
          disabled={valid.length === 0}
          onClick={() =>
            onAccept(
              valid.map(({ title, effortMinutes }) => ({ title: title.trim(), effortMinutes })),
              inOrder ? "sequential" : "parallel",
            )
          }
        >
          Add {valid.length} subtask{valid.length === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}
