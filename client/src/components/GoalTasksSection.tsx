import { useState } from "react";
import type { Task } from "../api/types";
import { useTasks, useUpdateTask } from "../hooks/useTasks";
import { filterByTitle, LINK_SEARCH_THRESHOLD, linkableTasks } from "../lib/goalTasks";
import { TaskBadges } from "./TaskBadges";

/**
 * Collapsible Tasks section of a GoalCard (#87), shaped like MaterialsSection:
 * the goal's open root tasks with badges, per-row unlink, a link-existing
 * picker, and a collapsed done count. Subtasks never appear individually —
 * they follow their parent's goal (PATCH cascade, #76). All writes go through
 * the existing PATCH /api/tasks/:id; the server owns the unlink semantics
 * (impact reset to neutral + subtask cascade, ADR-4/#74/#82), and
 * useUpdateTask's invalidation refreshes goal progress counts (PR #34).
 */
export function GoalTasksSection({ goalId }: { goalId: number }) {
  const openTasks = useTasks({ status: "open", goalId });
  const doneTasks = useTasks({ status: "done", goalId });
  const updateTask = useUpdateTask();
  const [picking, setPicking] = useState(false);
  // One announcement slot: the unlinked row disappears from this list, so the
  // feedback ("impact reset") must outlive the row itself.
  const [notice, setNotice] = useState<string | null>(null);

  async function unlink(task: Task) {
    // No confirm — fully reversible via the picker right below.
    await updateTask.mutateAsync({ id: task.id, goalId: null });
    setNotice(`"${task.title}" moved to no goal — impact reset to neutral.`);
  }

  const doneCount = doneTasks.data?.length ?? 0;

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 13, color: "var(--text-dim)" }}>
          📋 Tasks toward this goal
        </strong>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setPicking((p) => !p)}
          title="Attach an existing goal-less task to this goal"
        >
          🔗 Link existing
        </button>
      </div>
      <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
        {openTasks.data?.map((t) => (
          <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ flex: 1 }}>{t.title}</span>
            <TaskBadges task={t} />
            <button
              style={{ padding: "2px 8px" }}
              onClick={() => unlink(t)}
              disabled={updateTask.isPending}
              title="Unlink from this goal — the task moves to the goal-less pool and its impact resets to neutral"
            >
              ✕
            </button>
          </div>
        ))}
        {openTasks.data?.length === 0 && (
          <span style={{ fontSize: 13, color: "var(--text-dim)" }}>
            No open tasks yet — add one or link an existing task.
          </span>
        )}
      </div>
      {doneCount > 0 && (
        <div style={{ marginTop: 6, fontSize: 13, color: "var(--text-dim)" }}>
          ✓ {doneCount} done
        </div>
      )}
      {notice && (
        <div role="status" style={{ marginTop: 6, fontSize: 13, color: "var(--text-dim)" }}>
          {notice}
        </div>
      )}
      {picking && <LinkTaskPicker goalId={goalId} onClose={() => setPicking(false)} />}
    </div>
  );
}

/**
 * Own component so the all-open-tasks query only runs while the picker is
 * open. Candidates are open goal-less ROOT tasks (lib/goalTasks.ts) — moving
 * a task between goals stays a Tasks-page edit, and subtasks are never
 * offered. Linking a broken-down parent cascades the goal to its open
 * subtasks server-side.
 */
function LinkTaskPicker({ goalId, onClose }: { goalId: number; onClose: () => void }) {
  const allOpen = useTasks({ status: "open" });
  const updateTask = useUpdateTask();
  const [query, setQuery] = useState("");

  const candidates = linkableTasks(allOpen.data ?? []);
  const shown = filterByTitle(candidates, query);

  return (
    <div
      style={{
        marginTop: 8,
        padding: 8,
        border: "1px solid var(--border)",
        borderRadius: 6,
        display: "grid",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 13, color: "var(--text-dim)" }}>
          Link an existing task
        </strong>
        <span style={{ flex: 1 }} />
        <button style={{ padding: "2px 8px" }} onClick={onClose} title="Close the picker">
          Close
        </button>
      </div>
      {candidates.length > LINK_SEARCH_THRESHOLD && (
        <input
          autoFocus
          placeholder="Search goal-less tasks…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ fontSize: 13 }}
        />
      )}
      {shown.map((t) => (
        <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <span style={{ flex: 1 }}>{t.title}</span>
          <TaskBadges task={t} />
          <button
            style={{ padding: "2px 8px" }}
            disabled={updateTask.isPending}
            onClick={() => updateTask.mutate({ id: t.id, goalId })}
            title={`Attach "${t.title}" to this goal`}
          >
            + Link
          </button>
        </div>
      ))}
      {candidates.length === 0 && (
        <span style={{ fontSize: 13, color: "var(--text-dim)" }}>
          No open goal-less tasks to link — every open task already belongs to a goal.
        </span>
      )}
      {candidates.length > 0 && shown.length === 0 && (
        <span style={{ fontSize: 13, color: "var(--text-dim)" }}>No title matches the search.</span>
      )}
    </div>
  );
}
