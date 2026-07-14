import { useState } from "react";
import type { Category, Goal, NewTask, Task } from "../api/types";
import { useCreateSubtasks, useDeleteTask, useUpdateTask } from "../hooks/useTasks";
import { useAiStatus } from "../hooks/useAi";
import { TaskBadges } from "./TaskBadges";
import { TaskForm } from "./TaskForm";
import { SubtaskEditor } from "./SubtaskEditor";
import { AiBreakdownPanel } from "./AiSuggestionPanel";

interface Props {
  task: Task;
  categories: Category[];
  goals?: Goal[];
  maxEffort: number;
  depth?: number;
}

export function TaskRow({ task, categories, goals, maxEffort, depth = 0 }: Props) {
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const createSubtasks = useCreateSubtasks();
  const aiStatus = useAiStatus();
  const [breakingDown, setBreakingDown] = useState(false);
  const [aiPanel, setAiPanel] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);

  const category = categories.find((c) => c.id === task.categoryId);
  const hasSubtasks = (task.subtasks?.length ?? 0) > 0;
  const done = task.status === "done";

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
              onClose={() => setAiPanel(false)}
              onAccept={async (subtasks) => {
                await createSubtasks.mutateAsync({ parentId: task.id, subtasks });
                setBreakingDown(false);
              }}
            />
          )}
          <SubtaskEditor
            maxEffort={maxEffort}
            onCancel={() => setBreakingDown(false)}
            onAccept={async (subtasks) => {
              await createSubtasks.mutateAsync({ parentId: task.id, subtasks });
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
          />
        ))}
    </div>
  );
}
