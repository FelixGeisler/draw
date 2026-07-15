import { useState } from "react";
import type { Material, Task } from "../api/types";
import { useMaterials } from "../hooks/useGoals";
import { useCreateSubtasks, useCreateTask, useDeleteTask } from "../hooks/useTasks";
import {
  useAiBreakdown,
  useAiEstimate,
  useAiGenerateTasks,
  useAiPlanGoal,
  type AiSubtask,
  type PlanTask,
} from "../hooks/useAi";
import {
  commitLeaves,
  defaultParentTitle,
  formatDuration,
  setAllIncluded,
  setItemIncluded,
  setPartIncluded,
  summarize,
  toReviewItems,
  type ReviewItem,
  type ReviewPart,
} from "../lib/generateTasksReview";

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
  onAccept: (
    subtasks: { title: string; effortMinutes: number; impact: number }[],
    orderMode: Task["subtaskOrderMode"],
  ) => Promise<unknown>;
  onClose: () => void;
}) {
  const materials = useMaterials(goalId ?? -1);
  const estimate = useAiEstimate();
  const run = useAiBreakdown();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [rows, setRows] = useState<SuggestionRow<AiSubtask>[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // "Do in order" (#23): defaulted from the model's orderMatters judgment —
  // its subtasks already come in execution sequence — flippable before accept.
  const [inOrder, setInOrder] = useState(false);
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
      setInOrder(result.orderMatters);
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
      {rows && (
        <label
          style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--text-dim)", fontSize: 13 }}
          title="Sequential mode: only the first open step enters the deck; the rest queue up behind it"
        >
          <input type="checkbox" checked={inOrder} onChange={(e) => setInOrder(e.target.checked)} />
          Do in order — draw only the next open step
        </label>
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
              if (accepted.length > 0) await onAccept(accepted, inOrder ? "sequential" : "parallel");
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

// ---------------------------------------------------------------------------
// Generate-tasks panel (for a goal, #29): transcribe materials into an
// umbrella parent + flat leaves. Nothing is written until the user commits;
// the commit is one POST /api/tasks (parent) plus one transactional subtasks
// batch, with a compensating parent delete if the batch fails (ADR-16).

function aiErrorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  // The 503 body is a machine code; the panel owes the user a way forward.
  return message === "ai_not_configured"
    ? "Claude AI is not configured — add your API key in Settings."
    : message;
}

export function AiGenerateTasksPanel({
  goalId,
  categoryId,
  onClose,
}: {
  goalId: number;
  categoryId: number;
  onClose: () => void;
}) {
  const materials = useMaterials(goalId);
  const estimate = useAiEstimate();
  const run = useAiGenerateTasks();
  const createTask = useCreateTask();
  const createSubtasks = useCreateSubtasks();
  const deleteTask = useDeleteTask();

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [instruction, setInstruction] = useState("");
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [overview, setOverview] = useState<string | null>(null);
  const [oversized, setOversized] = useState(false);
  const [parentTitle, setParentTitle] = useState("");
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Provenance names the material only when the source is unambiguous.
  const fileNames = (materials.data ?? [])
    .filter((m) => selected.has(m.id) && m.kind === "file" && m.filename)
    .map((m) => m.filename as string);
  const sourceName = fileNames.length === 1 ? fileNames[0] : null;

  const summary = items ? summarize(items) : null;
  const leaves = items ? commitLeaves(items, sourceName) : [];

  function updateItem(index: number, patch: Partial<Pick<ReviewItem, "title" | "minutes">>) {
    setItems((prev) => prev && prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function updatePart(
    index: number,
    partIndex: number,
    patch: Partial<Pick<ReviewPart, "title" | "minutes">>,
  ) {
    setItems(
      (prev) =>
        prev &&
        prev.map((item, i) =>
          i === index
            ? {
                ...item,
                parts: item.parts.map((p, j) => (j === partIndex ? { ...p, ...patch } : p)),
              }
            : item,
        ),
    );
  }

  async function doEstimate() {
    setError(null);
    try {
      await estimate.mutateAsync({
        goalId,
        materialIds: [...selected],
        instruction: instruction.trim(),
      });
    } catch (e) {
      setError(aiErrorMessage(e));
    }
  }

  async function doRun() {
    setError(null);
    try {
      const result = await run.mutateAsync({
        goalId,
        materialIds: [...selected],
        instruction: instruction.trim(),
      });
      setItems(toReviewItems(result.tasks));
      setOverview(result.sourceOverview);
      setOversized(result.oversizedParts);
      setParentTitle(defaultParentTitle(fileNames, instruction));
    } catch (e) {
      setError(aiErrorMessage(e));
    }
  }

  async function doCommit() {
    if (!items || leaves.length === 0 || !parentTitle.trim()) return;
    setError(null);
    setCommitting(true);
    try {
      // Umbrella parent first: an unestimated container — never drawn while
      // children are open, remaining effort aggregates from the leaves.
      const parent = await createTask.mutateAsync({
        title: parentTitle.trim(),
        categoryId,
        goalId,
        effortMinutes: null,
      });
      try {
        // One transactional batch; leaves inherit category/goal from the parent.
        await createSubtasks.mutateAsync({ parentId: parent.id, subtasks: leaves });
      } catch (e) {
        // No half-imported state: cascade-delete the just-created parent. If
        // the cleanup fails too (server/network down), say so — a leftover
        // parent would otherwise sit on the Tasks page unexplained.
        try {
          await deleteTask.mutateAsync(parent.id);
        } catch {
          setError(
            `${aiErrorMessage(e)} — cleanup also failed, so the empty parent "${parentTitle.trim()}" may remain on the Tasks page; delete it there.`,
          );
          return;
        }
        throw e;
      }
      onClose();
    } catch (e) {
      setError(aiErrorMessage(e));
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div
      className="panel"
      style={{ marginTop: 12, display: "grid", gap: 10, borderColor: "var(--accent)" }}
    >
      <strong>✨ Generate tasks from materials</strong>
      {!items && (
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
          <textarea
            required
            rows={2}
            placeholder="Create one task per exercise of the test exam — points as impact, stated time as effort"
            title="What should Claude extract?"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            style={{ fontSize: 13, resize: "vertical" }}
          />
          {!estimate.data && (
            <button
              onClick={doEstimate}
              disabled={estimate.isPending || !instruction.trim()}
              style={{ justifySelf: "start" }}
            >
              {estimate.isPending ? "Estimating…" : "Estimate cost"}
            </button>
          )}
          <EstimateGate estimate={estimate.data ?? null} onConfirm={doRun} running={run.isPending} />
        </>
      )}
      {items && summary && (
        <>
          {/* The backstop against extraction infidelity: spot-check these
              numbers against the real material before committing. */}
          <div style={{ fontSize: 14 }}>
            <strong>{summary.exerciseCount} exercises</strong>
            {summary.points != null && <> · {summary.points} pts</>}
            <> · ≈{formatDuration(summary.minutes)}</>
            {summary.splitCount > 0 && <> · {summary.splitCount} split into parts</>}
          </div>
          {overview && (
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-dim)" }}>📄 {overview}</p>
          )}
          {oversized && (
            <div style={{ fontSize: 13, color: "var(--warn)" }}>
              ⚠ Some parts are longer than your draw limit — they will sit in “Too big” until
              broken down further.
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setItems(setAllIncluded(items, true))}>Select all</button>
            <button onClick={() => setItems(setAllIncluded(items, false))}>Select none</button>
          </div>
          <div style={{ display: "grid", gap: 8, maxHeight: "50vh", overflowY: "auto" }}>
            {items.map((item, i) => (
              <div key={i} style={{ display: "grid", gap: 2, opacity: item.included ? 1 : 0.45 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={item.included}
                    title={`Include exercise ${item.label ?? i + 1}`}
                    onChange={(e) => setItems(setItemIncluded(items, i, e.target.checked))}
                  />
                  {item.parts.length === 0 ? (
                    <>
                      <input
                        value={item.title}
                        onChange={(e) => updateItem(i, { title: e.target.value })}
                        style={{ flex: 1, fontSize: 14 }}
                        title="Exercise title"
                      />
                      <input
                        type="number"
                        min={1}
                        value={item.minutes}
                        onChange={(e) => updateItem(i, { minutes: Number(e.target.value) })}
                        style={{ width: 66 }}
                        title="minutes"
                      />
                    </>
                  ) : (
                    <>
                      <span style={{ flex: 1, fontSize: 14 }}>{item.title}</span>
                      <span
                        style={{ fontSize: 12, color: "var(--text-dim)", whiteSpace: "nowrap" }}
                        title="committed as the parts below"
                      >
                        Σ {item.parts.filter((p) => p.included).reduce((sum, p) => sum + p.minutes, 0)}m
                      </span>
                    </>
                  )}
                  {item.points != null && (
                    <span className="chip" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                      {item.points} pts
                    </span>
                  )}
                  <span
                    title={`Impact ${item.impact}/5${item.impactSource === "model" ? " (model estimate)" : " (from points)"}`}
                    style={{ color: "var(--warn)", fontSize: 12, whiteSpace: "nowrap" }}
                  >
                    {"★".repeat(item.impact)}
                    {item.impactSource === "model" && (
                      <span style={{ color: "var(--text-dim)" }}> (model estimate)</span>
                    )}
                  </span>
                </div>
                {/* Audit line: every points/minutes claim must be checkable against the PDF. */}
                <div style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: 26 }}>
                  {item.rationale}
                </div>
                {item.parts.map((p, j) => (
                  <div
                    key={j}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      marginLeft: 26,
                      opacity: p.included ? 1 : 0.45,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={p.included}
                      title={`Include part ${j + 1} of exercise ${item.label ?? i + 1}`}
                      onChange={(e) => setItems(setPartIncluded(items, i, j, e.target.checked))}
                    />
                    <input
                      value={p.title}
                      onChange={(e) => updatePart(i, j, { title: e.target.value })}
                      style={{ flex: 1, fontSize: 13 }}
                      title="Part title"
                    />
                    <input
                      type="number"
                      min={1}
                      value={p.minutes}
                      onChange={(e) => updatePart(i, j, { minutes: Number(e.target.value) })}
                      style={{ width: 66 }}
                      title="minutes"
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
            <span style={{ color: "var(--text-dim)" }}>
              Added under one umbrella task (kept out of the draw while its parts are open):
            </span>
            <input
              value={parentTitle}
              onChange={(e) => setParentTitle(e.target.value)}
              title="Umbrella task title"
            />
          </label>
        </>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <span style={{ flex: 1 }} />
        <button onClick={onClose}>Close</button>
        {items && (
          <button
            className="primary"
            onClick={doCommit}
            disabled={committing || leaves.length === 0 || !parentTitle.trim()}
          >
            {committing ? "Adding…" : `Add ${leaves.length} tasks`}
          </button>
        )}
      </div>
      {error && <div style={{ color: "var(--danger)", fontSize: 13 }}>{error}</div>}
    </div>
  );
}
