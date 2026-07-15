import { useState } from "react";
import type { Category, Goal, NewTask, Task } from "../api/types";
import { useCreateSubtasks, useDeleteTask, useUpdateTask } from "../hooks/useTasks";
import { useAiStatus } from "../hooks/useAi";
import { isSnoozed } from "../lib/drawable";
import { sequentialLockedByRecurrence } from "../lib/orderMode";
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
}

export function TaskRow({ task, categories, goals, maxEffort, depth = 0, parentOrderMode }: Props) {
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const createSubtasks = useCreateSubtasks();
  const aiStatus = useAiStatus();
  const [breakingDown, setBreakingDown] = useState(false);
  const [aiPanel, setAiPanel] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [snoozing, setSnoozing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [orderModeError, setOrderModeError] = useState<string | null>(null);

  const category = categories.find((c) => c.id === task.categoryId);
  const hasSubtasks = (task.subtasks?.length ?? 0) > 0;
  const done = task.status === "done";
  const snoozed = !done && isSnoozed(task);
  // Recurring × sequential guard (#66, ADR-23): a recurring subtask locks the
  // switch to 'do in order' — on the flip button and in both breakdown editors.
  const sequentialLocked = sequentialLockedByRecurrence(task.subtasks, task.subtaskOrderMode);

  function snooze(patch: { deferredUntil?: string; blocked?: boolean }) {
    updateTask.mutate({ id: task.id, ...patch });
    setSnoozing(false);
  }

  async function saveEdit(patch: NewTask) {
    await updateTask.mutateAsync({ id: task.id, ...patch });
    setEditing(false);
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
        <TaskBadges task={task} />
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
        {/* Done rows are not editable — reopen first (matches the checkbox flow). */}
        {!done && (
          <button
            onClick={() => {
              setBreakingDown(false);
              setAiPanel(false);
              setSnoozing(false);
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
      {snoozing && !snoozed && (
        <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
          <SnoozeMenu
            onSnooze={(iso) => snooze({ deferredUntil: iso })}
            onBlock={() => snooze({ blocked: true })}
          />
        </div>
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
