import { useState } from "react";
import type { Task } from "../api/types";
import { useTasks, useUpdateTask } from "../hooks/useTasks";
import { isSearchable, linkableTasks, shownCandidates } from "../lib/goalTasks";
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
  const [error, setError] = useState<string | null>(null);

  async function unlink(task: Task) {
    // No confirm — fully reversible via the picker right below.
    setError(null);
    try {
      const res = await updateTask.mutateAsync({ id: task.id, goalId: null });
      // Derive the announcement from the response instead of asserting it:
      // on a stale row (goal already gone via another tab) the PATCH degrades
      // to a no-op resend of goalId: null, which deliberately preserves
      // grandfathered non-neutral ratings (PR #74) — claiming "impact reset"
      // there would be false.
      setNotice(
        res.task.goalId == null && res.task.impact === 3
          ? `"${task.title}" moved to no goal — impact reset to neutral.`
          : `"${task.title}" moved to no goal.`,
      );
    } catch (e) {
      // api.patch throws on any non-2xx and nothing above catches mutateAsync
      // rejections — without this the failure would be a silent unhandled
      // rejection (same error surface as MaterialsSection).
      setError((e as Error).message);
    }
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
          onClick={() => {
            // Toggling the picker retires the unlink notice — "moved to no
            // goal" must not linger under a list that may re-link the task.
            setNotice(null);
            setPicking((p) => !p);
          }}
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
      {error && (
        <div style={{ marginTop: 6, fontSize: 13, color: "var(--danger)" }}>{error}</div>
      )}
      {/* Always-mounted live region: screen readers only reliably announce a
          role="status" whose container pre-exists its text — one that mounts
          together with its content is skipped by several of them, and this
          line is the whole feedback for a row that just left the list. */}
      <div
        role="status"
        style={{ marginTop: notice ? 6 : 0, fontSize: 13, color: "var(--text-dim)" }}
      >
        {notice}
      </div>
      {picking && (
        <LinkTaskPicker
          goalId={goalId}
          onClose={() => setPicking(false)}
          // Re-linking a just-unlinked task makes the lingering "moved to no
          // goal" line contradict the list right above it.
          onLinked={() => setNotice(null)}
        />
      )}
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
function LinkTaskPicker({
  goalId,
  onClose,
  onLinked,
}: {
  goalId: number;
  onClose: () => void;
  onLinked: () => void;
}) {
  const allOpen = useTasks({ status: "open" });
  const updateTask = useUpdateTask();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const candidates = linkableTasks(allOpen.data ?? []);
  // The query applies ONLY while the search box is rendered: linking tasks
  // away can shrink the pool to LINK_SEARCH_THRESHOLD, unmounting the box
  // while the query state survives — the list must not stay filtered by an
  // invisible, unclearable query (PR #89 review; pinned in goalTasks.test.ts).
  const searchable = isSearchable(candidates);
  const shown = shownCandidates(candidates, query);

  async function link(task: Task) {
    setError(null);
    try {
      await updateTask.mutateAsync({ id: task.id, goalId });
      onLinked();
    } catch (e) {
      setError((e as Error).message);
    }
  }

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
      {searchable && (
        <input
          autoFocus
          placeholder="Search goal-less tasks…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ fontSize: 13 }}
        />
      )}
      {error && <div style={{ color: "var(--danger)", fontSize: 13 }}>{error}</div>}
      {shown.map((t) => (
        <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <span style={{ flex: 1 }}>{t.title}</span>
          <TaskBadges task={t} />
          <button
            style={{ padding: "2px 8px" }}
            disabled={updateTask.isPending}
            onClick={() => link(t)}
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
