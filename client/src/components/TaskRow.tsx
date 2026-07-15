import { useState } from "react";
import type { Category, Goal, NewTask, Task } from "../api/types";
import { useCreateSubtasks, useDeleteTask, useSplitTask, useUpdateTask } from "../hooks/useTasks";
import { useAiStatus } from "../hooks/useAi";
import { classifyTask, isSnoozed } from "../lib/drawable";
import { sequentialLockedByRecurrence } from "../lib/orderMode";
import { reparentTargets } from "../lib/reparent";
import { evenSplitPlan } from "../lib/splitPlan";
import { TaskBadges } from "./TaskBadges";
import { SnoozeMenu } from "./SnoozeMenu";
import { TaskForm } from "./TaskForm";
import { SubtaskEditor } from "./SubtaskEditor";
import { AiBreakdownPanel } from "./AiSuggestionPanel";

interface Props {
  task: Task;
  categories: Category[];
  goals?: Goal[];
  maxEffort: number;
  depth?: number;
  /**
   * The parent's subtaskOrderMode when this row is a subtask (#66, ADR-23):
   * under a 'sequential' parent the edit form hides the recurrence field —
   * a recurring step would gate its siblings forever, and the API rejects it.
   */
  parentOrderMode?: Task["subtaskOrderMode"];
  /**
   * Every root task on the page (#100) — the "Move under…" picker's candidate
   * pool. Only passed to root rows; subtask rows get "Promote to top-level"
   * instead and need no targets.
   */
  rootTasks?: Task[];
}

export function TaskRow({
  task,
  categories,
  goals,
  maxEffort,
  depth = 0,
  parentOrderMode,
  rootTasks,
}: Props) {
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const createSubtasks = useCreateSubtasks();
  const splitTask = useSplitTask();
  const aiStatus = useAiStatus();
  const [breakingDown, setBreakingDown] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [aiPanel, setAiPanel] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [snoozing, setSnoozing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [orderModeError, setOrderModeError] = useState<string | null>(null);
  const [movingUnder, setMovingUnder] = useState(false);
  const [moveTargetId, setMoveTargetId] = useState("");
  const [reparentError, setReparentError] = useState<string | null>(null);

  const category = categories.find((c) => c.id === task.categoryId);
  const hasSubtasks = (task.subtasks?.length ?? 0) > 0;
  const done = task.status === "done";
  const snoozed = !done && isSnoozed(task);
  // Recurring × sequential guard (#66, ADR-23): a recurring subtask locks the
  // switch to 'do in order' — on the flip button and in both breakdown editors.
  const sequentialLocked = sequentialLockedByRecurrence(task.subtasks, task.subtaskOrderMode);
  // Reparent targets (#100): shared rule source with the drag-and-drop
  // follow-up (#101). Only root leaf rows offer "Move under…" — a task with
  // subtasks cannot become a subtask itself (ADR-16).
  const moveTargets =
    !done && task.parentId == null && !hasSubtasks && rootTasks
      ? reparentTargets(task, rootTasks)
      : [];
  // Split-in-place (#108): where root rows show Break down, an open subtask
  // row that classifies too-big offers Split — a subtask cannot be broken
  // down further (ADR-16), so it is replaced by its parts as siblings.
  const splittable = !done && task.parentId != null && classifyTask(task, maxEffort) === "too-big";

  function snooze(patch: { deferredUntil?: string; blocked?: boolean }) {
    updateTask.mutate({ id: task.id, ...patch });
    setSnoozing(false);
  }

  async function saveEdit(patch: NewTask) {
    await updateTask.mutateAsync({ id: task.id, ...patch });
    setEditing(false);
  }

  async function reparent(parentId: number | null) {
    setReparentError(null);
    try {
      await updateTask.mutateAsync({ id: task.id, parentId });
      setMovingUnder(false);
      setMoveTargetId("");
    } catch (e) {
      // Server 400s (validation matrix) surface inline as the backstop, like
      // the order-mode flip does.
      setReparentError((e as Error).message);
    }
  }

  return (
    <div style={{ marginLeft: depth * 24 }}>
      {editing ? (
        <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
          <TaskForm
            key={task.id}
            categories={categories}
            // Subtasks follow their parent's goal — no goal select for them.
            goals={task.parentId == null ? goals : undefined}
            initial={task}
            autoFocus
            submitLabel="Save"
            // No recurrence on steps of an in-order breakdown (#66, ADR-23).
            hideRecur={parentOrderMode === "sequential"}
            onSubmit={saveEdit}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 10px",
          borderBottom: "1px solid var(--border)",
          opacity: done ? 0.5 : 1,
        }}
      >
        <input
          type="checkbox"
          checked={done}
          title={task.hasOpenChildren ? "Complete all subtasks first" : done ? "Reopen" : "Complete"}
          onChange={() =>
            updateTask.mutate({ id: task.id, status: done ? "open" : "done" })
          }
        />
        {hasSubtasks && (
          <button
            onClick={() => setExpanded((e) => !e)}
            style={{ padding: "0 6px", border: "none", background: "none" }}
          >
            {expanded ? "▾" : "▸"}
          </button>
        )}
        <span style={{ textDecoration: done ? "line-through" : "none", flex: 1 }}>
          {category && depth === 0 && (
            <span className="dot" style={{ background: category.color, marginRight: 8 }} />
          )}
          {task.title}
        </span>
        {/* Subtasks follow their parent's goal (#76) — repeating the parent's
            goal chip on every step would be noise, so only root rows get it. */}
        <TaskBadges task={task} goals={task.parentId == null ? goals : undefined} />
        {snoozed ? (
          // Wake = deferredUntil now, not null (ADR-17): the retained value
          // becomes the wake timestamp, so staleness counts from here.
          <button
            onClick={() => snooze({ deferredUntil: new Date().toISOString(), blocked: false })}
            title="Put this task back in the deck"
          >
            Wake
          </button>
        ) : (
          !done && (
            <button onClick={() => setSnoozing((s) => !s)} title="Take this task out of the deck">
              💤
            </button>
          )
        )}
        {/* Sequential subtask mode (#23): flip "do in order" after the fact.
            Held-back siblings wear the ⏳ queued chip via TaskBadges. A
            recurring subtask locks the switch to sequential (#66, ADR-23);
            the server 400 is still surfaced below as a backstop (e.g. an
            archived recurring subtask is not in this list but blocks too). */}
        {!done && hasSubtasks && (
          <button
            disabled={sequentialLocked}
            onClick={async () => {
              setOrderModeError(null);
              try {
                await updateTask.mutateAsync({
                  id: task.id,
                  subtaskOrderMode:
                    task.subtaskOrderMode === "sequential" ? "parallel" : "sequential",
                });
              } catch (e) {
                setOrderModeError((e as Error).message);
              }
            }}
            title={
              sequentialLocked
                ? "Cannot draw in order: a recurring subtask never closes and would gate the steps behind it forever — remove its ↻ recurrence first"
                : task.subtaskOrderMode === "sequential"
                  ? "Subtasks are drawn in order — click to allow any order"
                  : "Subtasks are drawn in any order — click to draw them in the listed order"
            }
          >
            {task.subtaskOrderMode === "sequential" ? "→ in order" : "⇄ any order"}
          </button>
        )}
        {!done && task.parentId == null && (
          <button onClick={() => setBreakingDown((b) => !b)} title="Split into small steps">
            Break down
          </button>
        )}
        {splittable && (
          <button
            onClick={() => {
              setSnoozing(false);
              setMovingUnder(false);
              setSplitting((s) => !s);
            }}
            title="Too big to draw — replace this step with smaller parts at the same level"
          >
            Split
          </button>
        )}
        {/* Reparent (#100): this menu is THE reparent control — drag-and-drop
            arrives as an alternative input in #101, reusing lib/reparent.ts.
            Plain buttons and a native select keep both actions keyboard-
            operable by construction. */}
        {moveTargets.length > 0 && (
          <button
            onClick={() => {
              setBreakingDown(false);
              setSnoozing(false);
              setReparentError(null);
              setMovingUnder((m) => !m);
            }}
            title="Move under another task (it becomes a subtask)"
          >
            Move under…
          </button>
        )}
        {!done && task.parentId != null && (
          <button onClick={() => reparent(null)} title="Promote to top-level">
            ⤴
          </button>
        )}
        {/* Done rows are not editable — reopen first (matches the checkbox flow). */}
        {!done && (
          <button
            onClick={() => {
              setBreakingDown(false);
              setSplitting(false);
              setAiPanel(false);
              setSnoozing(false);
              setMovingUnder(false);
              setEditing(true);
            }}
            title="Edit"
          >
            ✎
          </button>
        )}
        <button
          onClick={() => {
            if (confirm(`Delete "${task.title}"${hasSubtasks ? " and its subtasks" : ""}?`)) {
              deleteTask.mutate(task.id);
            }
          }}
          title="Delete"
        >
          🗑
        </button>
      </div>
      )}
      {orderModeError && (
        <div role="alert" style={{ padding: "4px 10px", color: "var(--danger)", fontSize: 13 }}>
          {orderModeError}
        </div>
      )}
      {movingUnder && !editing && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <label htmlFor={`move-under-${task.id}`} style={{ color: "var(--text-dim)", fontSize: 13 }}>
            Move under
          </label>
          <select
            id={`move-under-${task.id}`}
            value={moveTargetId}
            onChange={(e) => setMoveTargetId(e.target.value)}
          >
            <option value="">choose a task…</option>
            {/* Blocked targets stay listed but disabled WITH their reason —
                the rule is visible instead of the option silently missing. */}
            {moveTargets.map(({ target, blockReason }) => (
              <option key={target.id} value={target.id} disabled={blockReason != null}>
                {target.title}
                {blockReason ? ` — ${blockReason}` : ""}
              </option>
            ))}
          </select>
          <button disabled={moveTargetId === ""} onClick={() => reparent(Number(moveTargetId))}>
            Move
          </button>
          <button
            onClick={() => {
              setMovingUnder(false);
              setMoveTargetId("");
              setReparentError(null);
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {reparentError && (
        <div role="alert" style={{ padding: "4px 10px", color: "var(--danger)", fontSize: 13 }}>
          {reparentError}
        </div>
      )}
      {snoozing && !snoozed && (
        <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
          <SnoozeMenu
            onSnooze={(iso) => snooze({ deferredUntil: iso })}
            onBlock={() => snooze({ blocked: true })}
          />
        </div>
      )}
      {/* Split-in-place (#108): the SubtaskEditor pattern reused — retitled,
          without the "Do in order" toggle (parts join the parent's existing
          mode), pre-filled with the deterministic even split, min 2 parts.
          The AI suggest reuses the breakdown endpoint (taskContext works for
          any task id); only the ACCEPT differs — it calls the split endpoint,
          replacing this row with its parts as siblings. */}
      {splitting && (
        <>
          {aiStatus.data?.configured && !aiPanel && (
            <button
              style={{ margin: "8px 0 0", borderColor: "var(--accent)" }}
              onClick={() => setAiPanel(true)}
            >
              ✨ Suggest with AI
            </button>
          )}
          {aiPanel && (
            <AiBreakdownPanel
              taskId={task.id}
              goalId={task.goalId}
              hideOrderToggle
              acceptLabel={(n) => `Split into ${n} part${n === 1 ? "" : "s"}`}
              onClose={() => setAiPanel(false)}
              onAccept={async (parts) => {
                // Sibling-replacement semantics on accept: the split endpoint,
                // never createSubtasks (per-part impact stays out of scope —
                // parts inherit the original's rating).
                await splitTask.mutateAsync({
                  id: task.id,
                  parts: parts.map(({ title, effortMinutes }) => ({ title, effortMinutes })),
                });
                setSplitting(false);
              }}
            />
          )}
          <SubtaskEditor
            maxEffort={maxEffort}
            heading={`Split into parts — they replace this step at the same level (drawable ≤ ${maxEffort} min, bigger parts can be split again)`}
            initialRows={evenSplitPlan(task.title, task.effortMinutes ?? 0, maxEffort)}
            minRows={2}
            requireMinutes
            hideOrderToggle
            acceptLabel={(n) => `Split into ${n} part${n === 1 ? "" : "s"}`}
            onCancel={() => setSplitting(false)}
            onAccept={async (parts) => {
              await splitTask.mutateAsync({
                id: task.id,
                // requireMinutes gates accept, so effortMinutes is present.
                parts: parts.map(({ title, effortMinutes }) => ({
                  title,
                  effortMinutes: effortMinutes!,
                })),
              });
              setSplitting(false);
            }}
          />
        </>
      )}
      {breakingDown && (
        <>
          {aiStatus.data?.configured && !aiPanel && (
            <button
              style={{ margin: "8px 0 0", borderColor: "var(--accent)" }}
              onClick={() => setAiPanel(true)}
            >
              ✨ Suggest with AI
            </button>
          )}
          {aiPanel && (
            <AiBreakdownPanel
              taskId={task.id}
              goalId={task.goalId}
              // A re-breakdown seeds from the persisted mode (#67); only a
              // fresh parent lets the model's orderMatters pre-set the toggle.
              initialOrderMode={hasSubtasks ? task.subtaskOrderMode : undefined}
              sequentialLocked={sequentialLocked}
              onClose={() => setAiPanel(false)}
              onAccept={async (subtasks, orderMode) => {
                await createSubtasks.mutateAsync({ parentId: task.id, subtasks, orderMode });
                setBreakingDown(false);
              }}
            />
          )}
          <SubtaskEditor
            maxEffort={maxEffort}
            initialOrderMode={task.subtaskOrderMode}
            sequentialLocked={sequentialLocked}
            onCancel={() => setBreakingDown(false)}
            onAccept={async (subtasks, orderMode) => {
              await createSubtasks.mutateAsync({ parentId: task.id, subtasks, orderMode });
              setBreakingDown(false);
            }}
          />
        </>
      )}
      {expanded &&
        task.subtasks?.map((s) => (
          <TaskRow
            key={s.id}
            task={s}
            categories={categories}
            goals={goals}
            maxEffort={maxEffort}
            depth={depth + 1}
            parentOrderMode={task.subtaskOrderMode}
          />
        ))}
    </div>
  );
}
