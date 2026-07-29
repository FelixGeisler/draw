import { useMemo, useState } from "react";
import {
  useCategories,
  useCreateTask,
  useReorderSubtask,
  useSettings,
  useTasks,
  useUpdateTask,
} from "../hooks/useTasks";
import { useGoals } from "../hooks/useGoals";
import { useDeckScope } from "../DeckScopeContext";
import { TaskForm } from "../components/TaskForm";
import { TaskRow } from "../components/TaskRow";
import { TaskDndContext, TaskDragOverlay, useTaskDnd } from "../components/TaskDnd";
import { classifyTask, flattenOpen, groupSiblings, type DrawGroup } from "../lib/drawable";
import type { Task } from "../api/types";

/**
 * Triage strip (#151): only the ACTIONABLE eligibility groups get a section —
 * each row offers the one thing that moves it into the deck (estimate inline,
 * break down / split in place). The passive states (ready, queued, scheduled)
 * dissolved with the Capture page: TaskBadges already wears them per row in
 * the category groups below, and a group that offers nothing to do is a
 * to-do list about the to-do list.
 */
const TRIAGE: { key: DrawGroup; title: string; hint: string }[] = [
  {
    key: "needs-estimate",
    title: "⏱ Needs an estimate",
    hint: "Add minutes so they can enter the deck.",
  },
  {
    key: "too-big",
    title: "🐘 Too big — break these down",
    hint: "Over the limit. Split them into small steps.",
  },
];

export function TasksPage() {
  const categories = useCategories();
  const goals = useGoals();
  const settings = useSettings();
  const [showDone, setShowDone] = useState(false);
  const tasks = useTasks({ status: showDone ? "all" : "open" });
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const reorderSubtask = useReorderSubtask();

  const maxEffort = Number(settings.data?.max_draw_effort ?? 30);
  // Work mode (#214): one scope for the whole page. Applied to the ROOTS, so
  // everything downstream — the tree, the triage strip, the snoozed section,
  // the reparent targets and the drag-and-drop map — narrows from one place
  // and cannot disagree with itself. Filtering by the root's category is right
  // even for subtasks: a subtask always shares its parent's category (the
  // #44 cascade keeps them in step), so a scoped tree never hides a step
  // whose parent is visible.
  const { scope } = useDeckScope();
  const allRoots = tasks.data ?? [];
  const roots = scope == null ? allRoots : allRoots.filter((t) => t.categoryId === scope);

  // Not-deck-ready triage (#151): classify every open task (roots and
  // subtasks) with the same lib/drawable predicate the draw pool mirrors.
  const open = flattenOpen(roots);
  const grouped = new Map<DrawGroup, Task[]>();
  for (const t of open) {
    const g = classifyTask(t, maxEffort);
    if (g === "needs-estimate" || g === "too-big") {
      grouped.set(g, [...(grouped.get(g) ?? []), t]);
    }
  }

  // Snoozed/blocked roots leave the main view but stay findable below.
  // classifyTask (not bare isSnoozed) keeps blocked containers in the main
  // list — their open subtasks are still visible, in the deck, and workable.
  const isSnoozedRoot = (t: Task) =>
    t.status === "open" && classifyTask(t, maxEffort) === "snoozed";
  const snoozedRoots = roots.filter(isSnoozedRoot);

  // Drag-and-drop reorganize (#101): the pointer alternative to the #100
  // menu — the drop issues the same PATCH parentId, judged by the same
  // eligibility rules. The map resolves hit-tested row ids back to tasks.
  //
  // Deliberately built from the UNSCOPED list (#214). It is a lookup table,
  // not a source of targets: only rendered rows can be dragged or dropped on,
  // so the scope already bounds the gesture. Scoping the map too would only
  // break the parentOrderMode lookup below for a strip row whose parent sits
  // outside the scope.
  const taskById = useMemo(() => {
    const byId = new Map<number, Task>();
    for (const t of tasks.data ?? []) {
      byId.set(t.id, t);
      for (const s of t.subtasks ?? []) byId.set(s.id, s);
    }
    return byId;
  }, [tasks.data]);
  const dnd = useTaskDnd({
    taskById: (id) => taskById.get(id),
    reparent: (id, parentId) => updateTask.mutateAsync({ id, parentId }),
    reorder: (id, beforeId) => reorderSubtask.mutateAsync({ id, beforeId }),
  });

  const triageRow = (t: Task, key: DrawGroup) => (
    <TaskRow
      key={t.id}
      task={t}
      categories={categories.data!}
      goals={goals.data}
      maxEffort={maxEffort}
      rootTasks={roots}
      estimateInput={key === "needs-estimate"}
      // A strip row must offer exactly what its tree rendering offers ("show
      // what's editable"): a sequential parent's subtask hides the ↻
      // recurrence field in the tree, so it must hide it here too — the
      // PATCH would only ever 400 (ADR-23 guard).
      parentOrderMode={
        t.parentId != null ? taskById.get(t.parentId)?.subtaskOrderMode : undefined
      }
      // depth stays 0 ON PURPOSE, category dot included: in the tree the
      // parent row wears the dot for its subtasks, but the strip is a flat
      // cross-category worklist where no parent row is visible — here the
      // dot carries information instead of duplicating it.
    />
  );

  return (
    <div className={dnd.dragging ? "content dnd-active" : "content"}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <h1 style={{ flex: 1 }}>Tasks</h1>
        <label style={{ color: "var(--text-dim)", display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          show done
        </label>
      </div>
      {/* Quick capture (#151, formerly the Capture page): pinned on top, so
          the rapid-entry ritual survives the merge — autoFocus, title-only
          Enter submit, fields reset, focus kept for the next thought. */}
      <div className="panel" data-testid="capture-form">
        {categories.data && (
          <TaskForm
            // Remount on a scope change so the select picks up the new default
            // (#214) — capturing into a category the page is not showing would
            // make the new task vanish on submit.
            key={scope ?? "all"}
            autoFocus
            categories={categories.data}
            goals={goals.data}
            defaultCategoryId={scope}
            onSubmit={(t) => createTask.mutateAsync(t)}
          />
        )}
      </div>
      {/* Triage rows are full TaskRows OUTSIDE the DnD provider: every action
          is available in place, but the strip is a worklist, not a second
          tree — reorganizing happens on the category groups below. */}
      <div data-testid="triage-strip">
        {categories.data &&
          TRIAGE.map(({ key, title, hint }) => {
            const items = grouped.get(key) ?? [];
            if (items.length === 0) return null;
            // Sibling leaves collapse under their parent (#30): a 40-leaf
            // import is one header row, not 40 rows drowning the section.
            const { flat, clusters } = groupSiblings(items, roots);
            return (
              <section key={key} style={{ marginTop: 24 }}>
                <h3 style={{ marginBottom: 4 }}>
                  {title}{" "}
                  <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>({items.length})</span>
                </h3>
                <p style={{ color: "var(--text-dim)", marginTop: 0, fontSize: 13 }}>{hint}</p>
                <div className="panel" style={{ padding: "0 8px" }}>
                  {flat.map((t) => triageRow(t, key))}
                  {clusters.map(({ parent, items: siblings }) => (
                    <details key={parent.id}>
                      <summary
                        style={{
                          cursor: "pointer",
                          padding: "8px 0",
                          borderBottom: "1px solid var(--border)",
                        }}
                      >
                        📂 {parent.title}{" "}
                        <span style={{ color: "var(--text-dim)" }}>({siblings.length})</span>
                      </summary>
                      <div style={{ paddingLeft: 20 }}>{siblings.map((t) => triageRow(t, key))}</div>
                    </details>
                  ))}
                </div>
              </section>
            );
          })}
      </div>
      <TaskDndContext.Provider value={dnd}>
        <div data-testid="task-tree">
          {dnd.dropError && (
            <div role="alert" style={{ padding: "8px 0", color: "var(--danger)", fontSize: 13 }}>
              {dnd.dropError}
            </div>
          )}
          {categories.data?.map((cat) => {
            const catTasks = roots.filter((t) => t.categoryId === cat.id && !isSnoozedRoot(t));
            if (catTasks.length === 0) return null;
            return (
              <section key={cat.id} style={{ marginTop: 20 }}>
                <h3>
                  <span className="dot" style={{ background: cat.color, marginRight: 8 }} />
                  {cat.name}
                </h3>
                <div className="panel" style={{ padding: "0 8px" }}>
                  {catTasks.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      categories={categories.data!}
                      goals={goals.data}
                      maxEffort={maxEffort}
                      // Reparent targets (#100) used to span ALL categories,
                      // since adoption moves the task into the target's
                      // category anyway. Scoped since #214: in work mode,
                      // offering a Household parent would move the task
                      // straight out of the view you are working in.
                      rootTasks={roots}
                    />
                  ))}
                </div>
              </section>
            );
          })}
          {snoozedRoots.length > 0 && (
            <details style={{ marginTop: 24 }}>
              <summary style={{ cursor: "pointer", color: "var(--text-dim)" }}>
                💤 Snoozed ({snoozedRoots.length})
              </summary>
              <div className="panel" style={{ padding: "0 8px", marginTop: 8 }}>
                {snoozedRoots.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    categories={categories.data ?? []}
                    goals={goals.data}
                    maxEffort={maxEffort}
                    rootTasks={roots}
                  />
                ))}
              </div>
            </details>
          )}
        </div>
      </TaskDndContext.Provider>
      {/* An empty scoped page must name its cause (#214). "Nothing here" in
          front of a full task list is the one way work mode can actively
          mislead — the strip above says which mode you are in, but the empty
          state is where the question gets asked. */}
      {roots.length === 0 && (
        <p style={{ color: "var(--text-dim)" }}>
          {allRoots.length > 0
            ? "Nothing in this category — capture something above, or clear work mode to see the rest."
            : "Nothing here — capture something above."}
        </p>
      )}
      <TaskDragOverlay dnd={dnd} />
    </div>
  );
}
