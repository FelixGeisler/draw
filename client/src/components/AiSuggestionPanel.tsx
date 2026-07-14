import { useState } from "react";
import type { Material } from "../api/types";
import { useMaterials } from "../hooks/useGoals";
import {
  useAiBreakdown,
  useAiEstimate,
  useAiPlanGoal,
  type AiSubtask,
  type PlanTask,
} from "../hooks/useAi";

// ---------------------------------------------------------------------------
// Shared pieces

function MaterialPicker({
  materials,
  selected,
  onToggle,
}: {
  materials: Material[];
  selected: Set<number>;
  onToggle: (id: number) => void;
}) {
  if (materials.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 13, color: "var(--text-dim)" }}>Include materials as context:</span>
      {materials.map((m) => (
        <label key={m.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={selected.has(m.id)} onChange={() => onToggle(m.id)} />
          {m.kind === "file" ? `📄 ${m.filename}` : `📝 ${m.noteText?.slice(0, 60)}…`}
        </label>
      ))}
    </div>
  );
}

interface SuggestionRow<T extends AiSubtask> {
  data: T;
  included: boolean;
}

function SuggestionList<T extends AiSubtask>({
  rows,
  setRows,
  extra,
}: {
  rows: SuggestionRow<T>[];
  setRows: (rows: SuggestionRow<T>[]) => void;
  extra?: (row: T) => React.ReactNode;
}) {
  function update(index: number, patch: Partial<SuggestionRow<T>> | { data: T }) {
    setRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {rows.map((row, i) => (
        <div key={i} style={{ display: "grid", gap: 2, opacity: row.included ? 1 : 0.45 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={row.included}
              onChange={() => update(i, { included: !row.included })}
            />
            <input
              value={row.data.title}
              onChange={(e) => update(i, { data: { ...row.data, title: e.target.value } })}
              style={{ flex: 1, fontSize: 14 }}
            />
            <input
              type="number"
              min={1}
              value={row.data.effortMinutes}
              onChange={(e) =>
                update(i, { data: { ...row.data, effortMinutes: Number(e.target.value) } })
              }
              style={{ width: 66 }}
              title="minutes"
            />
            <span title={`Impact ${row.data.impact}/5`} style={{ color: "var(--warn)", fontSize: 12 }}>
              {"★".repeat(row.data.impact)}
            </span>
            {extra?.(row.data)}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: 26 }}>
            {row.data.rationale}
          </div>
        </div>
      ))}
    </div>
  );
}

function EstimateGate({
  estimate,
  onConfirm,
  running,
}: {
  estimate: { inputTokens: number; estimatedUsd: number } | null;
  onConfirm: () => void;
  running: boolean;
}) {
  if (!estimate) return null;
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13 }}>
      <span>
        ~{estimate.inputTokens.toLocaleString()} input tokens ≈ ${estimate.estimatedUsd.toFixed(2)}
      </span>
      <button className="primary" onClick={onConfirm} disabled={running}>
        {running ? "Thinking…" : "Ask Claude"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breakdown panel (for a task)

export function AiBreakdownPanel({
  taskId,
  goalId,
  onAccept,
  onClose,
}: {
  taskId: number;
  goalId: number | null;
  onAccept: (subtasks: { title: string; effortMinutes: number; impact: number }[]) => Promise<unknown>;
  onClose: () => void;
}) {
  const materials = useMaterials(goalId ?? -1);
  const estimate = useAiEstimate();
  const run = useAiBreakdown();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [rows, setRows] = useState<SuggestionRow<AiSubtask>[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const materialList = goalId ? (materials.data ?? []) : [];

  async function doEstimate() {
    setError(null);
    try {
      await estimate.mutateAsync({ taskId, materialIds: [...selected] });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function doRun() {
    setError(null);
    try {
      const result = await run.mutateAsync({ taskId, materialIds: [...selected] });
      setRows(result.subtasks.map((data) => ({ data, included: true })));
      setNote(result.approachNote);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 8, display: "grid", gap: 10, borderColor: "var(--accent)" }}>
      <strong>✨ AI breakdown</strong>
      {!rows && (
        <>
          <MaterialPicker
            materials={materialList}
            selected={selected}
            onToggle={(id) =>
              setSelected((s) => {
                const next = new Set(s);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
          />
          {!estimate.data && (
            <button onClick={doEstimate} disabled={estimate.isPending} style={{ justifySelf: "start" }}>
              {estimate.isPending ? "Estimating…" : "Estimate cost"}
            </button>
          )}
          <EstimateGate estimate={estimate.data ?? null} onConfirm={doRun} running={run.isPending} />
        </>
      )}
      {note && <p style={{ margin: 0, fontSize: 13, color: "var(--text-dim)" }}>💡 {note}</p>}
      {rows && <SuggestionList rows={rows} setRows={setRows} />}
      <div style={{ display: "flex", gap: 8 }}>
        <span style={{ flex: 1 }} />
        <button onClick={onClose}>Close</button>
        {rows && (
          <button
            className="primary"
            onClick={async () => {
              const accepted = rows
                .filter((r) => r.included && r.data.title.trim())
                .map((r) => ({
                  title: r.data.title.trim(),
                  effortMinutes: r.data.effortMinutes,
                  impact: r.data.impact,
                }));
              if (accepted.length > 0) await onAccept(accepted);
              onClose();
            }}
          >
            Add {rows.filter((r) => r.included).length} subtasks
          </button>
        )}
      </div>
      {error && <div style={{ color: "var(--danger)", fontSize: 13 }}>{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backward-planning panel (for a goal)

const PHASE_COLORS: Record<PlanTask["phase"], string> = {
  now: "var(--ok)",
  next: "var(--warn)",
  later: "var(--text-dim)",
};

export function AiPlanPanel({
  goalId,
  onAccept,
  onClose,
}: {
  goalId: number;
  onAccept: (tasks: { title: string; effortMinutes: number; impact: number }[]) => Promise<unknown>;
  onClose: () => void;
}) {
  const materials = useMaterials(goalId);
  const estimate = useAiEstimate();
  const run = useAiPlanGoal();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [userNotes, setUserNotes] = useState("");
  const [rows, setRows] = useState<SuggestionRow<PlanTask>[] | null>(null);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function doEstimate() {
    setError(null);
    try {
      await estimate.mutateAsync({ goalId, materialIds: [...selected] });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function doRun() {
    setError(null);
    try {
      const result = await run.mutateAsync({
        goalId,
        materialIds: [...selected],
        userNotes: userNotes.trim() || undefined,
      });
      setRows(result.tasks.map((data) => ({ data, included: true })));
      setAnalysis(result.outcomeAnalysis);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 12, display: "grid", gap: 10, borderColor: "var(--accent)" }}>
      <strong>✨ Plan backward from the outcome</strong>
      {!rows && (
        <>
          <MaterialPicker
            materials={materials.data ?? []}
            selected={selected}
            onToggle={(id) =>
              setSelected((s) => {
                const next = new Set(s);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
          />
          <input
            placeholder="Anything Claude should know for this session? (optional)"
            value={userNotes}
            onChange={(e) => setUserNotes(e.target.value)}
            style={{ fontSize: 13 }}
          />
          {!estimate.data && (
            <button onClick={doEstimate} disabled={estimate.isPending} style={{ justifySelf: "start" }}>
              {estimate.isPending ? "Estimating…" : "Estimate cost"}
            </button>
          )}
          <EstimateGate estimate={estimate.data ?? null} onConfirm={doRun} running={run.isPending} />
        </>
      )}
      {analysis && (
        <div
          className="panel"
          style={{ background: "var(--bg)", borderColor: "var(--accent)", fontSize: 14 }}
        >
          🔍 <strong>What actually gets measured:</strong> {analysis}
        </div>
      )}
      {rows && (
        <SuggestionList
          rows={rows}
          setRows={setRows}
          extra={(t) => (
            <span className="chip" style={{ color: PHASE_COLORS[t.phase], fontSize: 11 }}>
              {t.phase}
            </span>
          )}
        />
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <span style={{ flex: 1 }} />
        <button onClick={onClose}>Close</button>
        {rows && (
          <button
            className="primary"
            onClick={async () => {
              const accepted = rows
                .filter((r) => r.included && r.data.title.trim())
                .map((r) => ({
                  title: r.data.title.trim(),
                  effortMinutes: r.data.effortMinutes,
                  impact: r.data.impact,
                }));
              if (accepted.length > 0) await onAccept(accepted);
              onClose();
            }}
          >
            Add {rows.filter((r) => r.included).length} tasks
          </button>
        )}
      </div>
      {error && <div style={{ color: "var(--danger)", fontSize: 13 }}>{error}</div>}
    </div>
  );
}
